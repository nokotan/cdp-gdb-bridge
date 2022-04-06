use wasm_bindgen::prelude::*;
use gimli::{
    UnitOffset, Unit,
    AttributeValue, UnitSectionOffset
};
use anyhow::{anyhow, Result};
use std::rc::{Rc};

use super::{ DwarfReader, DwarfReaderOffset, VariableInfo, DwarfDebugData, unit_type_name, error };
use super::variables::{ FrameBase, VariableName, TypeDescripter, variables_in_unit_entry, evaluate_variable_from_string };
use super::utils::{ clone_string_attribute };
use super::wasm_bindings::{ WasmValueVector, Value };

#[derive(Clone)]
pub enum WasmLoc {
    Local(u64),
    Global(u64),
    Stack(u64),
}

#[allow(non_camel_case_types)]
enum DwAtWasm {
    DW_OP_WASM_location = 0xed,
}

pub struct Subroutine {
    pub name: Option<String>,
    pub pc: std::ops::Range<u64>,
    pub unit_offset: gimli::UnitSectionOffset,
    pub entry_offset: UnitOffset<DwarfReaderOffset>,
    pub encoding: gimli::Encoding,
    pub frame_base: Option<WasmLoc>,
}

pub fn transform_subprogram(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    unit_offset: UnitSectionOffset<DwarfReaderOffset>,
) -> Result<Vec<Subroutine>> {
    let mut tree = unit.entries_tree(None)?;
    let root = tree.root()?;
    let mut subroutines = vec![];
    transform_subprogram_rec(root, dwarf, unit, unit_offset, &mut subroutines)?;
    Ok(subroutines)
}

fn transform_subprogram_rec(
    node: gimli::EntriesTreeNode<DwarfReader>,
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    unit_offset: UnitSectionOffset<DwarfReaderOffset>,
    out_subroutines: &mut Vec<Subroutine>,
) -> Result<()> {
    let mut subroutine = read_subprogram_header(&node, dwarf, unit, unit_offset)?;
    let mut children = node.children();
    while let Some(child) = children.next()? {
        match child.entry().tag() {
            gimli::DW_TAG_variable | gimli::DW_TAG_formal_parameter => {
                continue;
            }
            _ => {
                transform_subprogram_rec(child, dwarf, unit, unit_offset, out_subroutines)?;
            }
        }
    }

    if let Some(subroutine) = subroutine.take() {
        out_subroutines.push(subroutine);
    }

    Ok(())
}

pub fn read_subprogram_header(
    node: &gimli::EntriesTreeNode<DwarfReader>,
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    unit_offset: gimli::UnitSectionOffset,
) -> Result<Option<Subroutine>> {
    match node.entry().tag() {
        gimli::DW_TAG_subprogram => (),
        _ => return Ok(None),
    };

    let name = match node.entry().attr_value(gimli::DW_AT_name)? {
        Some(attr) => Some(clone_string_attribute(dwarf, unit, attr)?),
        None => None,
    };

    let low_pc_attr = node.entry().attr_value(gimli::DW_AT_low_pc)?;
    let high_pc_attr = node.entry().attr_value(gimli::DW_AT_high_pc)?;
    let frame_base_attr = node.entry().attr_value(gimli::DW_AT_frame_base)?;

    let subroutine = if let Some(AttributeValue::Addr(low_pc)) = low_pc_attr {
        let high_pc = match high_pc_attr {
            Some(AttributeValue::Udata(size)) => low_pc + size,
            Some(AttributeValue::Addr(high_pc)) => high_pc,
            Some(x) => unreachable!("high_pc can't be {:?}", x),
            None => return Ok(None),
        };
        
        let size = high_pc - low_pc;

        if size <= 0 {
            return Ok(None);
        }

        let frame_base = if let Some(attr) = frame_base_attr {
            Some(read_wasm_location(attr)?)
        } else {
            None
        };

        Subroutine {
            pc: low_pc..high_pc,
            name,
            encoding: unit.encoding(),
            unit_offset: unit_offset,
            entry_offset: node.entry().offset(),
            frame_base,
        }
    } else {
        return Ok(None);
    };
    Ok(Some(subroutine))
}

fn read_wasm_location<R: gimli::Reader>(attr_value: AttributeValue<R>) -> Result<WasmLoc> {
    let mut bytes_reader = match attr_value {
        AttributeValue::Exprloc(ref expr) => expr.0.clone(),
        _ => Err(anyhow!("unexpected attribute kind: {:?}", attr_value))?,
    };

    if bytes_reader.is_empty() {
        Err(anyhow!("byte sequence should not be empty"))?
    }
    let magic = bytes_reader.read_u8()?;
    if magic != DwAtWasm::DW_OP_WASM_location as u8 {
        Err(anyhow!("invalid wasm location magic: {:?}", magic))?
    }
    let wasm_op = bytes_reader.read_u8()?;
    let loc = match wasm_op {
        0x00 => WasmLoc::Local(bytes_reader.read_uleb128()?),
        0x01 => WasmLoc::Global(bytes_reader.read_uleb128()?),
        0x02 => WasmLoc::Stack(bytes_reader.read_uleb128()?),
        0x03 => WasmLoc::Global(bytes_reader.read_u32()? as u64),
        _ => Err(anyhow!("invalid wasm location operation: {:?}", wasm_op))?,
    };
    Ok(loc)
}

pub struct DwarfSubroutineMap {
    pub subroutines: Vec<Subroutine>,
    pub dwarf_data: DwarfDebugData,
}

impl DwarfSubroutineMap {

    pub fn find_subroutine(&self, code_offset: usize) -> Result<&Subroutine> {
        let offset = code_offset as u64;

        match self
            .subroutines
            .iter()
            .filter(|s| s.pc.contains(&offset))
            .next()
        {
            Some(s) => Ok(s),
            None => return Err(anyhow!("failed to determine subroutine")),
        }
    }

    pub fn variable_name_list(&self, code_offset: usize, group_id: i32) -> Result<Vec<VariableName>> {
        let offset = code_offset as u64;
        let subroutine = self.find_subroutine(code_offset)?;

        let (dwarf, unit) = match self.dwarf_data.unit_offset(subroutine.unit_offset)? {
            Some(x) => x,
            None => { 
                return Ok(Vec::new());
            }
        };

        let entry_offset = subroutine.entry_offset;
        let variables = variables_in_unit_entry(&dwarf, &unit, Some(entry_offset), offset, group_id)?;

        Ok(variables
            .iter()
            .map(|var| {
                let mut v = VariableName {
                    name: "<<not parsed yet>>".to_string(),
                    type_name: "<<not parsed yet>>".to_string(),
                    group_id: var.group_id,
                    child_group_id: var.child_group_id
                };
                if let Some(name) = var.name.clone() {
                    v.name = name;
                }
                match &var.ty_offset {
                    TypeDescripter::TypeOffset(offset) => {
                        if let Ok(ty_name) = unit_type_name(&dwarf, &unit, Some(*offset)) {
                            v.type_name = ty_name;
                        }
                    },
                    TypeDescripter::Description(desc) => {
                        v.type_name = desc.clone();
                    }
                }
                v
            })
            .collect())
    }

    fn get_frame_base(&self, code_offset: usize) -> Result<Option<WasmLoc>> {
        let subroutine = self.find_subroutine(code_offset)?;
        return Ok(subroutine.frame_base.clone());
    }
    fn display_variable(
        &self,
        code_offset: usize,
        frame_base: FrameBase,
        name: &String,
    ) -> Result<Option<VariableInfo>> {
        let offset = code_offset as u64;
        let subroutine = self.find_subroutine(code_offset)?;
        let (dwarf, unit) = match self.dwarf_data.unit_offset(subroutine.unit_offset)? {
            Some(x) => x,
            None => { 
                return Ok(None);
            }
        };
        let entry_offset = subroutine.entry_offset;
        let variables = variables_in_unit_entry(&dwarf, &unit, Some(entry_offset), offset, 0)?;

        evaluate_variable_from_string(name, &variables, &dwarf, &unit, frame_base)
    }

    pub fn get_variable_info(
        &self, 
        opts: &String,
        locals: &WasmValueVector,
        globals: &WasmValueVector,
        stacks: &WasmValueVector,
        code_offset: usize) -> Result<Option<VariableInfo>> {
    
        let frame_base = match self.get_frame_base(code_offset)? {
            Some(loc) => {
                let offset = match loc {
                    WasmLoc::Global(idx) => globals.data
                        .get(idx as usize)
                        .ok_or(anyhow!("failed to get base global"))?,
                    WasmLoc::Local(idx) => locals.data
                        .get(idx as usize)
                        .ok_or(anyhow!("failed to get base local"))?,
                    WasmLoc::Stack(idx) => stacks.data
                        .get(idx as usize)
                        .ok_or(anyhow!("failed to get base stack"))?,
                };
                let offset = match offset.value {
                    Value::I32(v) => v as u64,
                    Value::I64(v) => v as u64,
                    _ => Err(anyhow!("unexpected frame base value: {:?}", offset.value))?,
                };
                FrameBase::WasmFrameBase(offset)
            }
            None => {
                return Err(anyhow!("failed to get base stack"));
                // let argument_count = debugger
                //     .current_frame()
                //     .ok_or(anyhow!("function frame not found"))?
                //     .argument_count;
                // let offset = locals
                //     .get(argument_count + 2)
                //     .ok_or(anyhow!("failed to get rbp"))?
                //     .clone();
                // let offset = match offset {
                //     WasmValue::I32(v) => v as u64,
                //     _ => Err(anyhow!("unexpected frame base value: {:?}", offset))?,
                // };
                // FrameBase::RBP(offset)
            }
        };
        
        self.display_variable(
            code_offset,
            frame_base,
            opts
        )
    }
}
