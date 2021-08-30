use gimli::{
    UnitOffset, Unit,
    AttributeValue, UnitSectionOffset
};
use anyhow::{anyhow, Result};
use std::rc::{Rc};

use super::{ DwarfReader, DwarfReaderOffset, VariableInfo, parse_dwarf, header_from_offset, unit_type_name };
use super::variables::{ FrameBase, VariableContent, subroutine_variables, evaluate_variable_location };
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
        gimli::DW_TAG_subprogram | gimli::DW_TAG_lexical_block => (),
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

pub struct Variable {
    pub name: String,
    pub type_name: String,
}

pub struct DwarfSubroutineMap {
    pub subroutines: Vec<Subroutine>,
    pub buffer: Rc<[u8]>,
}

impl DwarfSubroutineMap {

    pub fn variable_name_list(&self, code_offset: usize) -> Result<Vec<Variable>> {
        let offset = code_offset as u64;
        let subroutine = match self
            .subroutines
            .iter()
            .filter(|s| s.pc.contains(&offset))
            .next()
        {
            Some(s) => s,
            None => return Err(anyhow!("failed to determine subroutine")),
        };
        let dwarf = parse_dwarf(&self.buffer)?;
        let header = match header_from_offset(&dwarf, subroutine.unit_offset)? {
            Some(header) => header,
            None => {
                return Ok(vec![]);
            }
        };

        let unit = dwarf.unit(header)?;
        let variables = subroutine_variables(&dwarf, &unit, &subroutine, offset)?;

        Ok(variables
            .iter()
            .map(|var| {
                let mut v = Variable {
                    name: "<<not parsed yet>>".to_string(),
                    type_name: "<<not parsed yet>>".to_string(),
                };
                if let Some(name) = var.name.clone() {
                    v.name = name;
                }
                if let Ok(ty_name) = unit_type_name(&dwarf, &unit, var.ty_offset) {
                    v.type_name = ty_name;
                }
                v
            })
            .collect())
    }

    pub fn get_frame_base(&self, code_offset: usize) -> Result<Option<WasmLoc>> {
        let offset = &(code_offset as u64);
        let subroutine = match self
            .subroutines
            .iter()
            .filter(|s| s.pc.contains(offset))
            .next()
        {
            Some(s) => s,
            None => return Err(anyhow!("failed to determine subroutine")),
        };
        return Ok(subroutine.frame_base.clone());
    }
    pub fn display_variable(
        &self,
        code_offset: usize,
        frame_base: FrameBase,
        name: &String,
    ) -> Result<Option<VariableInfo>> {
        let offset = code_offset as u64;
        let subroutine = match self
            .subroutines
            .iter()
            .filter(|s| s.pc.contains(&offset))
            .next()
        {
            Some(s) => s,
            None => return Err(anyhow!("failed to determine subroutine")),
        };
        let dwarf = parse_dwarf(&self.buffer)?;
        let header = match header_from_offset(&dwarf, subroutine.unit_offset)? {
            Some(header) => header,
            None => {
                return Ok(None);
            }
        };

        let unit = dwarf.unit(header)?;
        let mut variables = subroutine_variables(&dwarf, &unit, &subroutine, offset)?;

        let var_index = match variables
            .iter()
            .position(|v| {
                if let Some(vname) = v.name.clone() {
                    vname == *name
                } else {
                    false
                }
            })
        {
            Some(v) => v,
            None => {
                return Err(anyhow!("'{}' is not valid variable name", name));
            }
        };

        let var = variables.remove(var_index);
        let mut calculated_address = 0;

        for content in var.contents {

            match content {
                VariableContent::Location(location) => match location {
                    AttributeValue::Exprloc(expr) => {
                        let piece = evaluate_variable_location(subroutine.encoding, &frame_base, expr)?;
                        let piece = match piece.iter().next() {
                            Some(p) => p,
                            None => {
                                println!("failed to get piece of variable");
                                return Ok(None);
                            }
                        };
            
                        match piece.location {
                            gimli::Location::Address { address } => { calculated_address += address; },
                            _ => unimplemented!(),
                        };
                    }
                    AttributeValue::LocationListsRef(_listsref) => unimplemented!("listsref"),
                    AttributeValue::Data1(b) => {
                        calculated_address += b as u64;
                    },
                    AttributeValue::Data2(b) => {
                        calculated_address += b as u64;
                    },
                    AttributeValue::Data4(b) => {
                        calculated_address += b as u64;
                    },
                    AttributeValue::Data8(b) => {
                        calculated_address += b as u64;
                    },
                    AttributeValue::Sdata(b) => {
                        calculated_address = (calculated_address as i64 + b) as u64;
                    },
                    AttributeValue::Udata(b) => {
                        calculated_address += b;
                    },
                    _ => panic!(),
                },
                VariableContent::ConstValue(ref _bytes) => unimplemented!(),
                VariableContent::Unknown { ref debug_info } => {
                    unimplemented!("Unknown variable content found {}", debug_info)
                }
            };        
        }
        

        if let Some(offset) = var.ty_offset {
            let mut tree = unit.entries_tree(Some(UnitOffset(offset)))?;
            let root = tree.root()?;
            
            return match create_variable_info(root, calculated_address, &dwarf, &unit) {
                Ok(x) => Ok(Some(x)),
                Err(_) => Ok(None)
            };    
        } else {
            println!("no explicit type");
        }
        Ok(None)
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

fn create_variable_info<R: gimli::Reader>(
    node: gimli::EntriesTreeNode<R>,
    address: u64,
    dwarf: &gimli::Dwarf<R>,
    unit: &Unit<R>,
) -> Result<VariableInfo> {
    match node.entry().tag() {
        gimli::DW_TAG_base_type => {
            let entry = node.entry();
            let name = match entry.attr_value(gimli::DW_AT_name)? {
                Some(attr) => clone_string_attribute(dwarf, unit, attr)?,
                None => "<no type name>".to_string(),
            };
            let byte_size = entry
                .attr_value(gimli::DW_AT_byte_size)?
                .and_then(|attr| attr.udata_value())
                .ok_or(anyhow!("Failed to get byte_size"))?;
            let encoding = entry
                .attr_value(gimli::DW_AT_encoding)?
                .and_then(|attr| match attr {
                    gimli::AttributeValue::Encoding(encoding) => Some(encoding),
                    _ => None,
                })
                .ok_or(anyhow!("Failed to get type encoding"))?;

            Ok(VariableInfo {
                address: address as usize,
                byte_size: byte_size as usize,
                name,
                encoding,
                tag: gimli::DW_TAG_base_type,
                memory_slice: Vec::new()
            })
        }
        gimli::DW_TAG_class_type | gimli::DW_TAG_structure_type => {
            let entry = node.entry();
            let tag = entry.tag();
            let type_name = match entry.attr_value(gimli::DW_AT_name)? {
                Some(attr) => clone_string_attribute(dwarf, unit, attr)?,
                None => "<no type name>".to_string(),
            };
            let byte_size = entry
                .attr_value(gimli::DW_AT_byte_size)?
                .and_then(|attr| attr.udata_value())
                .ok_or(anyhow!("Failed to get byte_size"))?;
            let mut children = node.children();
            let mut members = vec![];
            while let Some(child) = children.next()? {
                match child.entry().tag() {
                    gimli::DW_TAG_member => {
                        let name = match child.entry().attr_value(gimli::DW_AT_name)? {
                            Some(attr) => clone_string_attribute(dwarf, unit, attr)?,
                            None => "<no member name>".to_string(),
                        };
                        // let ty = match entry.attr_value(gimli::DW_AT_type)? {
                        //     Some(gimli::AttributeValue::UnitRef(ref offset)) => offset.0,
                        //     _ => return Err(anyhow!("Failed to get type offset")),
                        // };
                        members.push(name);
                    }
                    _ => continue,
                }
            }
            
            Ok(VariableInfo {
                address: address as usize,
                byte_size: byte_size as usize,
                name: format!("{} {{ {} }}", type_name, members.join(", ")),
                encoding: gimli::DW_ATE_signed,
                tag,
                memory_slice: Vec::new()
            })
        }
        _ => Err(anyhow!("unsupported DIE type")),
    }
}
