use wasm_bindgen::prelude::*;
use wasmparser::{
    Parser, Payload
};
use std::collections::{HashMap};
use gimli::{
    EndianRcSlice, LittleEndian, 
    Unit, UnitOffset, Reader,
    UnitSectionOffset, UnitHeader,
    AttributeValue
};
use anyhow::{anyhow, Result};
use std::rc::{Rc};
use std::borrow::Borrow;
use num_bigint::{BigUint};

pub mod sourcemap;
pub mod subroutine;
pub mod variables;
pub mod wasm_bindings;

mod format;
mod utils;

use sourcemap::{ DwarfSourceMap, transform_debug_line };
use subroutine::{ DwarfSubroutineMap, transform_subprogram };
use variables::{ DwarfGlobalVariables, VariableLocation };
use format::{ format_object };
use utils::{ clone_string_attribute };

use wasm_bindgen::*;

#[wasm_bindgen]
extern "C" {
    // Use `js_namespace` here to bind `console.log(..)` instead of just
    // `log(..)`
    #[wasm_bindgen(js_namespace = console)]
    pub fn log(s: &str);
}

#[macro_export]
macro_rules! console_log {
    // Note that this is using the `log` function imported above during
    // `bare_bones`
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

pub type DwarfReader = EndianRcSlice<LittleEndian>;
pub type DwarfReaderOffset = <DwarfReader as Reader>::Offset;
pub type Dwarf = gimli::Dwarf<DwarfReader>;

pub fn parse_dwarf(data: &[u8]) -> Result<Dwarf> {
    let endian = gimli::LittleEndian;

    let parser = Parser::new(0);
    let mut sections = HashMap::new();
    for payload in parser.parse_all(data) {
        match payload? {
            Payload::CustomSection { name, data, .. } => {
                sections.insert(name, data);
            }
            _ => continue,
        }
    }

    // Load a section and return as `Cow<[u8]>`.
    let load_section = |id: gimli::SectionId| -> Result<Rc<[u8]>> {
        match sections.get(id.name()) {
            Some(section) => Ok(Rc::from(*section)),
            None => Ok(Rc::from(&[][..])),
        }
    };

    // Load all of the sections.
    let dwarf_cow = gimli::Dwarf::load(&load_section)?;

    // Borrow a `Cow<[u8]>` to create an `EndianSlice`.
    let borrow_section = |section: &Rc<[u8]>| -> gimli::EndianRcSlice<gimli::LittleEndian> { 
        gimli::EndianRcSlice::new(section.clone(), endian) 
    };

    // Create `EndianSlice`s for all of the sections.
    Ok(dwarf_cow.borrow(&borrow_section))
}

pub struct DwarfDebugInfo {
    pub sourcemap: DwarfSourceMap,
    pub subroutine: DwarfSubroutineMap,
    pub global_variables: DwarfGlobalVariables
}

pub fn transform_dwarf(buffer: Rc<[u8]>) -> Result<DwarfDebugInfo> {
    let dwarf = parse_dwarf(buffer.borrow())?;
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
        sourcemap: DwarfSourceMap::new(sourcemaps),
        subroutine: DwarfSubroutineMap {
            subroutines,
            buffer: buffer.clone(),
        },
        global_variables: DwarfGlobalVariables {
            buffer: buffer.clone(),
        }
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
    return Ok(None);
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
        },
        _ => {
            if let Some(AttributeValue::UnitRef(ref offset)) = root.entry().attr_value(gimli::DW_AT_type)? {
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
            memory_slice: Vec::new()
        }
    }

    pub fn set_memory_slice(&mut self, data: &[u8]) {
        self.memory_slice = data.to_vec();
    }
}

enum VariableEvaluationResult {
    Ready,
    Complete,
    RequireMemorySlice(MemorySlice)
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
            VariableEvaluationResult::Ready => {},
            _ => { return None; }
        }

        if self.address_expr.len() == 0 {
            self.state = VariableEvaluationResult::Complete;

            return match format_object(self) {
                Ok(x) => Some(x),
                Err(_) => None
            };
        } else {
            let mut address = 0;
            let mut byte_size = self.byte_size;

            while self.address_expr.len() != 0 {
                match self.address_expr.remove(0) {
                    VariableLocation::Address(addr) => { address = addr; },
                    VariableLocation::Offset(off) => { address = (address as i64 + off) as u64 },
                    VariableLocation::Pointer => {
                        byte_size = 4;
                        self.address_expr.insert(0, VariableLocation::Pointer);
                        break;
                    }
                }
            };

            let slice = MemorySlice {
                address: address as usize,
                byte_size,
                memory_slice: Vec::new()
            };

            self.memory_slice = slice.clone();
            self.state = VariableEvaluationResult::RequireMemorySlice(slice);

            return None;
        }
    }

    pub fn resume_with_memory_slice(&mut self, memory: MemorySlice) -> Option<String> {
        match self.state {
            VariableEvaluationResult::RequireMemorySlice(_) => {},
            _ => { return None; }
        }

        if let Some(VariableLocation::Pointer) = self.address_expr.first() {
            self.address_expr.remove(0);
            self.address_expr.insert(0, VariableLocation::Address(
                BigUint::from_bytes_le(&memory.memory_slice).to_u64_digits()[0]
            ));
        }

        self.memory_slice = memory;

        if self.address_expr.len() == 0 {
            self.state = VariableEvaluationResult::Complete;

            match format_object(self) {
                Ok(x) => Some(x),
                Err(_) => None
            }
        } else {
            let mut address = 0;
            let mut byte_size = self.byte_size;

            while self.address_expr.len() != 0 {
                match self.address_expr.remove(0) {
                    VariableLocation::Address(addr) => { address = addr; },
                    VariableLocation::Offset(off) => { address = (address as i64 + off) as u64 },
                    VariableLocation::Pointer => {
                        byte_size = 4;
                        break;
                    }
                }
            };

            self.state = VariableEvaluationResult::RequireMemorySlice(
                MemorySlice {
                    address: address as usize,
                    byte_size,
                    memory_slice: Vec::new()
                }
            );
            None
        }
    }

    pub fn is_required_memory_slice(&self) -> bool {
        match self.state {
            VariableEvaluationResult::RequireMemorySlice(_) => true,
            _ => false
        }
    }

    pub fn is_completed(&self) -> bool {
        match self.state {
            VariableEvaluationResult::Complete => true,
            _ => false
        }
    }

    pub fn required_memory_slice(&self) -> MemorySlice {
        self.memory_slice.clone()
    }
}
