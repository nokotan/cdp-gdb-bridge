use gimli::{
    Unit, Reader, AttributeValue, DebuggingInformationEntry,
    Expression, UnitOffset, UnitSectionOffset
};
use anyhow::{anyhow, Result};
use std::rc::{Rc};

use super::{ DwarfReader, DwarfReaderOffset, VariableInfo, parse_dwarf, header_from_offset, unit_type_name };
use super::subroutine::{ Subroutine };
use super::utils::{ clone_string_attribute };
use super::wasm_bindings::{ WasmValueVector, Value };

pub struct VariableName {
    pub name: String,
    pub type_name: String,
}

pub struct SymbolVariable
{
    pub name: Option<String>,
    pub contents: Vec<VariableContent>,
    pub ty_offset: Option<usize>,
    pub unit_offset: Option<UnitSectionOffset<DwarfReaderOffset>>
}

#[derive(Clone)]
pub enum VariableContent {
    Location(gimli::AttributeValue<DwarfReader>),
    ConstValue(Vec<u8>),
    Unknown { debug_info: String },
}

pub enum FrameBase {
    WasmFrameBase(u64),
    WasmDataBase(u64),
    RBP(u64),
}

pub fn transform_global_variable(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    unit_offset: UnitSectionOffset<DwarfReaderOffset>,
) -> Result<Vec<SymbolVariable>> {
    let mut tree = unit.entries_tree(None)?;
    let mut children = tree.root()?.children();
    let mut variables = vec![];

    while let Some(child) = children.next()? {
        match child.entry().tag() {
            gimli::DW_TAG_variable => {
                let attr = child.entry().attr_value(gimli::DW_AT_declaration)?;

                if let Some(AttributeValue::Flag(flag)) = attr {
                    if flag {
                        continue
                    }
                }

                let var = transform_variable(&dwarf, &unit, child.entry(), Some(unit_offset))?;
                subroutine_structure_variables_rec(child, dwarf, unit, &var, &mut variables)?;
                variables.push(var);
            },
            _ => continue
        }
    }
   
    Ok(variables)
}

pub fn subroutine_variables(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader>,
    subroutine: &Subroutine,
    code_offset: u64
) -> Result<Vec<SymbolVariable>> {
    let mut tree = unit.entries_tree(Some(subroutine.entry_offset))?;
    let root = tree.root()?;
    let mut variables = vec![];
    subroutine_variables_rec(root, dwarf, unit, code_offset, &mut variables)?;
    Ok(variables)
}

fn subroutine_variables_rec(
    node: gimli::EntriesTreeNode<DwarfReader>,
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader>,
    code_offset: u64,
    variables: &mut Vec<SymbolVariable>
) -> Result<()> {

    let mut children = node.children();

    while let Some(child) = children.next()? {
        match child.entry().tag() {
            gimli::DW_TAG_variable | gimli::DW_TAG_formal_parameter => {
                let var = transform_variable(&dwarf, &unit, child.entry(), None)?;
                subroutine_structure_variables_rec(child, dwarf, unit, &var, variables)?;
                variables.push(var);
            }
            gimli::DW_TAG_lexical_block => {
                let low_pc_attr = child.entry().attr_value(gimli::DW_AT_low_pc)?;
                let high_pc_attr = child.entry().attr_value(gimli::DW_AT_high_pc)?;

                if let Some(AttributeValue::Addr(low_pc)) = low_pc_attr {
                    let high_pc = match high_pc_attr {
                        Some(AttributeValue::Udata(size)) => low_pc + size,
                        Some(AttributeValue::Addr(high_pc)) => high_pc,
                        Some(x) => unreachable!("high_pc can't be {:?}", x),
                        None => continue,
                    };

                    let code_range = low_pc..high_pc;

                    if code_range.contains(&code_offset) {
                        subroutine_variables_rec(child, dwarf, unit, code_offset, variables)?;
                    }
                }
            }
            _ => continue,
        }
    }
    Ok(())
}

fn subroutine_structure_variables_rec(
    node: gimli::EntriesTreeNode<DwarfReader>,
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader>,
    parent_variable: &SymbolVariable,
    variables: &mut Vec<SymbolVariable>
) -> Result<()> {

    match node.entry().tag() {
        gimli::DW_TAG_class_type | gimli::DW_TAG_structure_type => {
            let mut children = node.children();

            while let Some(child) = children.next()? {
                match child.entry().tag() {
                    gimli::DW_TAG_member => {
                        let mut var = transform_variable(&dwarf, &unit, child.entry(), None)?;

                        let mut contents = parent_variable.contents.clone();
                        contents.append(&mut var.contents);

                        let var = SymbolVariable {
                            name: Some(format!(
                                "{}.{}", 
                                parent_variable.name.clone().unwrap_or("<unnamed>".to_string()), 
                                var.name.unwrap_or("<unnamed>".to_string())
                            )),
                            contents,
                            ty_offset: var.ty_offset,
                            unit_offset: None
                        };

                        if let Some(offset) = var.ty_offset {
                            let mut tree = unit.entries_tree(Some(UnitOffset(offset)))?;
                            let root = tree.root()?;
                            subroutine_structure_variables_rec(root, dwarf, unit, &var, variables)?;
                        }
                        
                        variables.push(var);
                    },
                    _ => continue
                }  
            }
        },
        gimli::DW_TAG_pointer_type => {

        },
        _ => {
            if let Some(AttributeValue::UnitRef(ref offset)) = node.entry().attr_value(gimli::DW_AT_type)? {
                let mut tree = unit.entries_tree(Some(UnitOffset(offset.0)))?;
                let root = tree.root()?;
                subroutine_structure_variables_rec(root, dwarf, unit, parent_variable, variables)?;
            } 
        }
    }

    Ok(())
}

pub fn evaluate_variable_location<R: gimli::Reader>(
    encoding: gimli::Encoding,
    base: &FrameBase,
    expr: Expression<R>,
) -> Result<Vec<gimli::Piece<R>>> {
    let mut evaluation = expr.evaluation(encoding);
    if let FrameBase::RBP(base) = base {
        evaluation.set_initial_value(*base);
    }
    let mut result = evaluation.evaluate()?;
    use gimli::EvaluationResult;
    loop {
        if let EvaluationResult::Complete = result {
            return Ok(evaluation.result());
        }
        match result {
            EvaluationResult::RequiresFrameBase => {
                if let FrameBase::WasmFrameBase(base) = base {
                    result = evaluation.resume_with_frame_base(*base)?;
                } else {
                    return Err(anyhow!("unexpected occurrence of DW_AT_frame_base"));
                }
            },
            EvaluationResult::RequiresRelocatedAddress(addr) => {
                if let FrameBase::WasmDataBase(base) = base {
                    result = evaluation.resume_with_relocated_address(addr + *base)?;
                } else {
                    return Err(anyhow!("unexpected occurrence of DW_AT_frame_base"));
                }
            },
            ref x => Err(anyhow!("{:?}", x))?,
        }
    }
}

pub fn transform_variable(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    entry: &DebuggingInformationEntry<DwarfReader>,
    unit_offset: Option<UnitSectionOffset<DwarfReaderOffset>>,
) -> Result<SymbolVariable> {
    let mut content = VariableContent::Unknown {
        debug_info: "".to_string(), //format!("{:?}", entry.attrs()),
    };
    let mut has_explicit_location = false;
    if let Some(location) = entry.attr_value(gimli::DW_AT_location)? {
        content = VariableContent::Location(location);
        has_explicit_location = true;
    } else if let Some(location) = entry.attr_value(gimli::DW_AT_data_member_location)? {
        content = VariableContent::Location(location);
        has_explicit_location = true;
    }
    if let Some(constant) = entry.attr_value(gimli::DW_AT_const_value)? {
        if !has_explicit_location {
            // TODO: support big endian
            let bytes = match constant {
                AttributeValue::Block(block) => block.to_slice()?.to_vec(),
                AttributeValue::Data1(b) => vec![b],
                AttributeValue::Data2(b) => b.to_le_bytes().to_vec(),
                AttributeValue::Data4(b) => b.to_le_bytes().to_vec(),
                AttributeValue::Data8(b) => b.to_le_bytes().to_vec(),
                AttributeValue::Sdata(b) => b.to_le_bytes().to_vec(),
                AttributeValue::Udata(b) => b.to_le_bytes().to_vec(),
                AttributeValue::String(b) => b.to_slice()?.to_vec(),
                _ => unimplemented!(),
            };
            content = VariableContent::ConstValue(bytes);
        }
    }
    let name = match entry.attr_value(gimli::DW_AT_name)? {
        Some(name_attr) => Some(clone_string_attribute(dwarf, unit, name_attr)?),
        None => None,
    };

    let ty = match entry.attr_value(gimli::DW_AT_type)? {
        Some(AttributeValue::UnitRef(ref offset)) => Some(offset.0),
        _ => None,
    };

    Ok(SymbolVariable {
        name,
        contents: vec![ content ],
        ty_offset: ty,
        unit_offset
    })
}

pub struct DwarfGlobalVariables {
    pub variables: Vec<SymbolVariable>,
    pub buffer: Rc<[u8]>
}

impl DwarfGlobalVariables {
    pub fn variable_name_list(&self, unit_offset: UnitSectionOffset) -> Result<Vec<VariableName>> {
        let dwarf = parse_dwarf(&self.buffer)?;
        let header = match header_from_offset(&dwarf, unit_offset)? {
            Some(header) => header,
            None => {
                return Ok(vec![]);
            }
        };

        let unit = dwarf.unit(header)?;
        let list = self.variables.iter()
            .filter(|var| {
                var.unit_offset.is_some() && unit_offset == var.unit_offset.unwrap()
            })
            .map(|var| {
                let mut v = VariableName {
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
            }).collect();

        Ok(list)
    }

    pub fn display_variable(
        &self,
        unit_offset: UnitSectionOffset,
        frame_base: FrameBase,
        name: &String,
    ) -> Result<Option<VariableInfo>> {

        let var = match self.variables
            .iter()
            .filter(|v| {
                if let Some(vname) = v.name.clone() {
                    vname == *name
                } else {
                    false
                }
            }).next()
        {
            Some(v) => v,
            None => {
                return Err(anyhow!("'{}' is not valid variable name", name));
            }
        };
        let dwarf = parse_dwarf(&self.buffer)?;
        let header = match header_from_offset(&dwarf, var.unit_offset.unwrap())? {
            Some(header) => header,
            None => {
                return Ok(None);
            }
        };

        let unit = dwarf.unit(header)?;
        let mut calculated_address = 0;

        for content in &var.contents {

            match content {
                VariableContent::Location(location) => match location {
                    AttributeValue::Exprloc(expr) => {
                        let piece = evaluate_variable_location(unit.encoding(), &frame_base, expr.clone())?;
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
                        calculated_address += *b as u64;
                    },
                    AttributeValue::Data2(b) => {
                        calculated_address += *b as u64;
                    },
                    AttributeValue::Data4(b) => {
                        calculated_address += *b as u64;
                    },
                    AttributeValue::Data8(b) => {
                        calculated_address += *b as u64;
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
        }
        Ok(None)
    }

    pub fn get_variable_info(
        &self, 
        opts: &String,
        unit_offset: UnitSectionOffset,
        data_base: usize,
        globals: &WasmValueVector,
    ) -> Result<Option<VariableInfo>> {
        
        self.display_variable(
            unit_offset,
            FrameBase::WasmDataBase(data_base as u64),
            opts
        )
    }
}

pub fn create_variable_info<R: gimli::Reader>(
    node: gimli::EntriesTreeNode<R>,
    address: u64,
    dwarf: &gimli::Dwarf<R>,
    unit: &Unit<R>,
) -> Result<VariableInfo> {
    match node.entry().tag() {
        gimli::DW_TAG_base_type | gimli::DW_TAG_pointer_type => {
            let entry = node.entry();
            let name = match entry.attr_value(gimli::DW_AT_name)? {
                Some(attr) => clone_string_attribute(dwarf, unit, attr)?,
                None => "<no type name>".to_string(),
            };
            let byte_size = entry
                .attr_value(gimli::DW_AT_byte_size)?
                .and_then(|attr| attr.udata_value())
                .unwrap_or(unit.header.address_size() as u64);
            let encoding = entry
                .attr_value(gimli::DW_AT_encoding)?
                .and_then(|attr| match attr {
                    gimli::AttributeValue::Encoding(encoding) => Some(encoding),
                    _ => None,
                })
                .unwrap_or(gimli::constants::DW_ATE_unsigned);

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
