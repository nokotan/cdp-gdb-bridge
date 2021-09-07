use gimli::{
    Unit, Reader, AttributeValue, DebuggingInformationEntry,
    Expression, UnitOffset, UnitSectionOffset
};
use anyhow::{anyhow, Result};
use std::rc::{Rc};

use super::{ 
    DwarfReader, DwarfReaderOffset, VariableInfo, MemorySlice, VariableEvaluationResult, 
    parse_dwarf, header_from_offset, unit_type_name };
use super::utils::{ clone_string_attribute };
use super::wasm_bindings::{ WasmValueVector };

pub struct VariableName {
    pub name: String,
    pub type_name: String,
}

pub struct SymbolVariable
{
    pub name: Option<String>,
    pub contents: Vec<VariableExpression>,
    pub ty_offset: Option<usize>,
}

#[derive(Clone)]
pub enum VariableExpression {
    Location(gimli::AttributeValue<DwarfReader>),
    ConstValue(Vec<u8>),
    Pointer,
    Unknown { debug_info: String },
}

#[derive(Clone)]
pub enum VariableLocation {
    Address(u64),
    Offset(i64),
    Pointer
}

pub enum FrameBase {
    WasmFrameBase(u64),
    WasmDataBase(u64),
    RBP(u64),
}

/**
 * find all variables in unit entry
 */
pub fn variables_in_unit_entry(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader>,
    entry_offset: Option<UnitOffset<DwarfReaderOffset>>,
    code_offset: u64
) -> Result<Vec<SymbolVariable>> {
    let mut tree = unit.entries_tree(entry_offset)?;
    let root = tree.root()?;
    let mut variables = vec![];
    variables_in_unit_entry_recursive(root, dwarf, unit, code_offset, &mut variables)?;
    Ok(variables)
}

fn variables_in_unit_entry_recursive(
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
                let mut var = transform_variable(&dwarf, &unit, child.entry())?;
                structure_variable_recursive(child, dwarf, unit, &mut var, variables)?;
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
                        variables_in_unit_entry_recursive(child, dwarf, unit, code_offset, variables)?;
                    }
                }
            }
            _ => continue,
        }
    }
    Ok(())
}

fn structure_variable_recursive(
    node: gimli::EntriesTreeNode<DwarfReader>,
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader>,
    parent_variable: &mut SymbolVariable,
    variables: &mut Vec<SymbolVariable>
) -> Result<()> {

    match node.entry().tag() {
        gimli::DW_TAG_class_type | gimli::DW_TAG_structure_type => {
            let mut children = node.children();

            while let Some(child) = children.next()? {
                match child.entry().tag() {
                    gimli::DW_TAG_member => {
                        let mut var = transform_variable(&dwarf, &unit, child.entry())?;

                        let mut contents = parent_variable.contents.clone();
                        contents.append(&mut var.contents);

                        let mut var = SymbolVariable {
                            name: Some(format!(
                                "{}.{}", 
                                parent_variable.name.clone().unwrap_or("<unnamed>".to_string()), 
                                var.name.unwrap_or("<unnamed>".to_string())
                            )),
                            contents,
                            ty_offset: var.ty_offset
                        };

                        if let Some(offset) = var.ty_offset {
                            let mut tree = unit.entries_tree(Some(UnitOffset(offset)))?;
                            let root = tree.root()?;
                            structure_variable_recursive(root, dwarf, unit, &mut var, variables)?;
                        }
                        
                        variables.push(var);
                    },
                    _ => continue
                }  
            }
        },
        gimli::DW_TAG_pointer_type | gimli::DW_TAG_reference_type => {
            parent_variable.contents.push(VariableExpression::Pointer);

            if let Some(AttributeValue::UnitRef(ref offset)) = node.entry().attr_value(gimli::DW_AT_type)? {          
                if node.entry().offset() != *offset {
                    let mut tree = unit.entries_tree(Some(UnitOffset(offset.0)))?;
                    let root = tree.root()?;
                    structure_variable_recursive(root, dwarf, unit, parent_variable, variables)?;
                }
            } 
        },
        _ => {
            if let Some(AttributeValue::UnitRef(ref offset)) = node.entry().attr_value(gimli::DW_AT_type)? {          
                if node.entry().offset() != *offset {
                    let mut tree = unit.entries_tree(Some(UnitOffset(offset.0)))?;
                    let root = tree.root()?;
                    structure_variable_recursive(root, dwarf, unit, parent_variable, variables)?;
                }
            } 
        }
    }

    Ok(())
}

fn transform_variable(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    entry: &DebuggingInformationEntry<DwarfReader>,
) -> Result<SymbolVariable> {
    let mut content = VariableExpression::Unknown {
        debug_info: "".to_string(), //format!("{:?}", entry.attrs()),
    };
    let mut has_explicit_location = false;
    if let Some(location) = entry.attr_value(gimli::DW_AT_location)? {
        content = VariableExpression::Location(location);
        has_explicit_location = true;
    } else if let Some(location) = entry.attr_value(gimli::DW_AT_data_member_location)? {
        content = VariableExpression::Location(location);
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
            content = VariableExpression::ConstValue(bytes);
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
        ty_offset: ty
    })
}



pub fn evaluate_variable_from_string(
    name: &String,
    variables: &Vec<SymbolVariable>,
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    frame_base: FrameBase
) -> Result<Option<VariableInfo>> {
    let name = name.replace("->", ".");
    let this_name = format!("this.{}", name);

    let var = match variables
        .iter()
        .filter(|v| {
            if let Some(vname) = v.name.clone() {
                vname == name || vname == this_name
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
    let mut calculated_address = Vec::new();

    for content in &var.contents {

        match content {
            VariableExpression::Location(location) => match location {
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
                        gimli::Location::Address { address } => { calculated_address.push(VariableLocation::Address(address)); },
                        _ => unimplemented!(),
                    };
                }
                AttributeValue::LocationListsRef(_listsref) => unimplemented!("listsref"),
                AttributeValue::Sdata(b) => {
                    calculated_address.push(VariableLocation::Offset(*b));
                },
                AttributeValue::Udata(b) => {
                    calculated_address.push(VariableLocation::Offset(*b as i64));
                },
                _ => panic!(),
            },
            VariableExpression::ConstValue(ref _bytes) => unimplemented!(),
            VariableExpression::Pointer => {
                calculated_address.push(VariableLocation::Pointer);
            },
            VariableExpression::Unknown { ref debug_info } => {
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

fn evaluate_variable_location<R: gimli::Reader>(
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
                    return Err(anyhow!("unexpected occurrence of relocated_address"));
                }
            },
            ref x => Err(anyhow!("{:?}", x))?,
        }
    }
}

fn create_variable_info<R: gimli::Reader>(
    node: gimli::EntriesTreeNode<R>,
    address: Vec<VariableLocation>,
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
                .unwrap_or(unit.header.address_size() as u64);
            let encoding = entry
                .attr_value(gimli::DW_AT_encoding)?
                .and_then(|attr| match attr {
                    gimli::AttributeValue::Encoding(encoding) => Some(encoding),
                    _ => None,
                })
                .unwrap_or(gimli::constants::DW_ATE_unsigned);

            Ok(VariableInfo {
                address_expr: address,
                byte_size: byte_size as usize,
                name,
                encoding,
                tag: gimli::DW_TAG_base_type,
                memory_slice: MemorySlice::new(),
                state: VariableEvaluationResult::Ready
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
                address_expr: address,
                byte_size: byte_size as usize,
                name: format!("{} {{ {} }}", type_name, members.join(", ")),
                encoding: gimli::DW_ATE_signed,
                tag,
                memory_slice: MemorySlice::new(),
                state: VariableEvaluationResult::Ready
            })
        },
        _ => {
            match node.entry().attr_value(gimli::DW_AT_type)? {
                Some(AttributeValue::UnitRef(ref offset)) => {
                    let mut tree = unit.entries_tree(Some(UnitOffset(offset.0)))?;
                    let root = tree.root()?;

                    create_variable_info(root, address, dwarf, unit)
                },
                _ => Err(anyhow!("unsupported DIE type"))
            }
        }
    }
}



pub struct DwarfGlobalVariables {
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
        let variables = variables_in_unit_entry(&dwarf, &unit, None, 0)?;
        let list = variables.iter()
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

    fn display_variable(
        &self,
        unit_offset: UnitSectionOffset,
        frame_base: FrameBase,
        name: &String,
    ) -> Result<Option<VariableInfo>> {

        let dwarf = parse_dwarf(&self.buffer)?;
        let header = match header_from_offset(&dwarf, unit_offset)? {
            Some(header) => header,
            None => {
                return Ok(None);
            }
        };

        let unit = dwarf.unit(header)?;
        let variables = variables_in_unit_entry(&dwarf, &unit, None, 0)?;

        evaluate_variable_from_string(name, &variables, &dwarf, &unit, frame_base)
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
