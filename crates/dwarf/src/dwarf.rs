use anyhow::{anyhow, Result};
use gimli::{
    AttributeValue, EndianRcSlice, LittleEndian, Reader, Unit, UnitHeader, UnitOffset,
    UnitSectionOffset,
};
use num_bigint::BigUint;
use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasmparser::{Parser, Payload};

pub mod sourcemap;
pub mod subroutine;
pub mod utils;
pub mod variables;
pub mod wasm_bindings;

mod format;

use crate::console_log;
use format::format_object;
use sourcemap::{transform_debug_line, DwarfSourceMap};
use subroutine::{transform_subprogram, DwarfSubroutineMap};
use utils::{clone_string_attribute, error};
use variables::{DwarfGlobalVariables, VariableLocation};

/// Dwarf reader definitions for wasm-dwarf-alanyser
pub type DwarfReader = EndianRcSlice<LittleEndian>;
pub type DwarfReaderOffset = <DwarfReader as Reader>::Offset;
pub type Dwarf = gimli::Dwarf<DwarfReader>;
pub type DwarfUnit = gimli::Unit<DwarfReader>;

/// Dwarf debug data utility
#[derive(Clone)]
pub struct DwarfDebugData {
    program_raw_data: HashMap<String, Rc<[u8]>>,
}

impl DwarfDebugData {
    /// Load webassembly binary and copy custom section data
    pub fn new(wasm_binary: &[u8]) -> Result<Self> {
        let parser = Parser::new(0);
        let mut sections = HashMap::new();

        for payload in parser.parse_all(wasm_binary) {
            match payload? {
                Payload::CustomSection { name, data, .. } => {
                    sections.insert(String::from(name), Rc::from(data));
                }
                _ => continue,
            }
        }

        Ok(Self {
            program_raw_data: sections,
        })
    }

    pub fn parse_dwarf(&self) -> Result<Dwarf> {
        let load_section = |id: gimli::SectionId| -> Result<DwarfReader> {
            let data = match self.program_raw_data.get(id.name()) {
                Some(section) => section.clone(),
                None => Rc::from(&[][..]),
            };

            Ok(EndianRcSlice::new(data, LittleEndian))
        };

        Dwarf::load(&load_section)
    }

    pub fn unit_offset(&self, offset: UnitSectionOffset) -> Result<Option<(Dwarf, DwarfUnit)>> {
        let dwarf = self.parse_dwarf()?;
        let header = match header_from_offset(&dwarf, offset)? {
            Some(header) => header,
            None => {
                return Ok(None);
            }
        };

        let unit = dwarf.unit(header)?;
        Ok(Some((dwarf, unit)))
    }
}

/// Parsed dwarf debug data container
pub struct DwarfDebugInfo {
    pub sourcemap: DwarfSourceMap,
    pub subroutine: DwarfSubroutineMap,
    pub global_variables: DwarfGlobalVariables,
}

pub fn transform_dwarf(buffer: &[u8]) -> Result<DwarfDebugInfo> {
    let dwarf_data = DwarfDebugData::new(buffer)?;
    let dwarf = dwarf_data.parse_dwarf()?;
    let mut headers = dwarf.units();
    let mut sourcemaps = Vec::new();
    let mut subroutines = Vec::new();
    let mut entry_num = 0;

    while let Some(header) = headers.next()? {
        let header_offset = header.offset();
        let unit = dwarf.unit(header)?;
        let mut entries = unit.entries();
        let root = match entries.next_dfs()? {
            Some((_, entry)) => entry,
            None => continue,
        };
        entry_num += 1;
        sourcemaps.push(transform_debug_line(
            &unit,
            root,
            &dwarf,
            &dwarf.debug_line,
        )?);
        subroutines.append(&mut transform_subprogram(&dwarf, &unit, header_offset)?);
    }

    console_log!("found {} entries", entry_num);

    Ok(DwarfDebugInfo {
        sourcemap: DwarfSourceMap::new(sourcemaps, dwarf_data.clone()),
        subroutine: DwarfSubroutineMap {
            subroutines,
            dwarf_data: dwarf_data.clone(),
        },
        global_variables: DwarfGlobalVariables { dwarf_data },
    })
}

fn header_from_offset<R: gimli::Reader>(
    dwarf: &gimli::Dwarf<R>,
    offset: UnitSectionOffset<R::Offset>,
) -> Result<Option<UnitHeader<R>>> {
    let mut headers = dwarf.units();
    while let Some(header) = headers.next()? {
        if header.offset() == offset {
            return Ok(Some(header));
        } else {
            continue;
        }
    }
    Ok(None)
}

fn unit_type_name<R: gimli::Reader>(
    dwarf: &gimli::Dwarf<R>,
    unit: &Unit<R>,
    type_offset: Option<R::Offset>,
) -> Result<String> {
    let type_offset = match type_offset {
        Some(offset) => offset,
        None => {
            return Ok("void".to_string());
        }
    };
    let mut tree = unit.entries_tree(Some(UnitOffset::<R::Offset>(type_offset)))?;
    let root = tree.root()?;

    match root.entry().tag() {
        gimli::DW_TAG_base_type | gimli::DW_TAG_class_type | gimli::DW_TAG_structure_type => {
            if let Some(attr) = root.entry().attr_value(gimli::DW_AT_name)? {
                clone_string_attribute(dwarf, unit, attr)
            } else {
                Ok(String::from("<no-type-name>"))
            }
        }
        _ => {
            if let Some(AttributeValue::UnitRef(ref offset)) =
                root.entry().attr_value(gimli::DW_AT_type)?
            {
                unit_type_name(dwarf, unit, Some(offset.0))
            } else {
                Err(anyhow!(format!("failed to seek at {:?}", type_offset)))
            }
        }
    }
}

#[wasm_bindgen]
#[derive(Clone)]
pub struct MemorySlice {
    pub address: usize,
    pub byte_size: usize,

    memory_slice: Vec<u8>,
}

#[wasm_bindgen]
impl MemorySlice {
    pub(crate) fn new() -> Self {
        Self {
            address: 0,
            byte_size: 0,
            memory_slice: Vec::new(),
        }
    }

    pub(crate) fn from_u8_vec(data: Vec<u8>) -> Self {
        Self {
            address: 0,
            byte_size: data.len(),
            memory_slice: data,
        }
    }

    pub fn set_memory_slice(&mut self, data: &[u8]) {
        self.memory_slice = data.to_vec();
    }
}

enum VariableEvaluationResult {
    Ready,
    Complete,
    RequireMemorySlice(MemorySlice),
}

#[wasm_bindgen]
pub struct VariableInfo {
    name: String,

    pub(crate) address_expr: Vec<VariableLocation>,
    pub(crate) byte_size: usize,
    pub(crate) memory_slice: MemorySlice,

    state: VariableEvaluationResult,

    tag: gimli::DwTag,
    encoding: gimli::DwAte,
}

#[wasm_bindgen]
impl VariableInfo {
    pub fn evaluate(&mut self) -> Option<String> {
        match self.state {
            VariableEvaluationResult::Ready => {}
            _ => {
                return None;
            }
        }

        if self.address_expr.is_empty() {
            self.state = VariableEvaluationResult::Complete;

            match format_object(self) {
                Ok(x) => Some(x),
                Err(_) => None,
            }
        } else {
            self.evaluate_internal();
            None
        }
    }

    pub fn resume_with_memory_slice(&mut self, memory: MemorySlice) -> Option<String> {
        match self.state {
            VariableEvaluationResult::RequireMemorySlice(_) => {}
            _ => {
                return None;
            }
        }

        if let Some(VariableLocation::Pointer) = self.address_expr.first() {
            self.address_expr.remove(0);
            self.address_expr.insert(
                0,
                VariableLocation::Address(
                    BigUint::from_bytes_le(&memory.memory_slice).to_u64_digits()[0],
                ),
            );
        }

        self.memory_slice = memory;

        if self.address_expr.is_empty() {
            self.state = VariableEvaluationResult::Complete;

            match format_object(self) {
                Ok(x) => Some(x),
                Err(_) => None,
            }
        } else {
            self.evaluate_internal();
            None
        }
    }

    fn evaluate_internal(&mut self) {
        let mut address = 0;
        let mut byte_size = self.byte_size;

        while !self.address_expr.is_empty() {
            match self.address_expr.remove(0) {
                VariableLocation::Address(addr) => {
                    address = addr;
                }
                VariableLocation::Offset(off) => address = (address as i64 + off) as u64,
                VariableLocation::Pointer => {
                    byte_size = 4;
                    self.address_expr.insert(0, VariableLocation::Pointer);
                    break;
                }
            }
        }

        let slice = MemorySlice {
            address: address as usize,
            byte_size,
            memory_slice: Vec::new(),
        };

        self.memory_slice = slice.clone();
        self.state = VariableEvaluationResult::RequireMemorySlice(slice);
    }

    pub fn is_required_memory_slice(&self) -> bool {
        match self.state {
            VariableEvaluationResult::RequireMemorySlice(_) => true,
            _ => false,
        }
    }

    pub fn is_completed(&self) -> bool {
        match self.state {
            VariableEvaluationResult::Complete => true,
            _ => false,
        }
    }

    pub fn required_memory_slice(&self) -> MemorySlice {
        self.memory_slice.clone()
    }
}
