use gimli::{
    Unit, Reader, AttributeValue, DebuggingInformationEntry,
    Expression, UnitOffset
};
use anyhow::{anyhow, Result};

use super::{ DwarfReader, DwarfReaderOffset };
use super::subroutine::{ Subroutine };
use super::utils::{ clone_string_attribute };

pub struct SymbolVariable
{
    pub name: Option<String>,
    pub contents: Vec<VariableContent>,
    pub ty_offset: Option<usize>,
}

#[derive(Clone)]
pub enum VariableContent {
    Location(gimli::AttributeValue<DwarfReader>),
    ConstValue(Vec<u8>),
    Unknown { debug_info: String },
}

pub enum FrameBase {
    WasmFrameBase(u64),
    RBP(u64),
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
                let var = transform_variable(&dwarf, &unit, child.entry())?;

                if let Some(offset) = var.ty_offset {
                    let mut tree = unit.entries_tree(Some(UnitOffset(offset)))?;
                    let root = tree.root()?;
                    subroutine_structure_variables_rec(root, dwarf, unit, code_offset, &var, variables)?;
                }

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
    code_offset: u64,
    parent_variable: &SymbolVariable,
    variables: &mut Vec<SymbolVariable>
) -> Result<()> {
    let mut children = node.children();

    while let Some(child) = children.next()? {
        match child.entry().tag() {
            gimli::DW_TAG_member => {
                let mut var = transform_variable(&dwarf, &unit, child.entry())?;

                let mut contents = parent_variable.contents.clone();
                contents.append(&mut var.contents);

                let var = SymbolVariable {
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
                    subroutine_structure_variables_rec(root, dwarf, unit, code_offset, &var, variables)?;
                }
                
                variables.push(var);
            },
            _ => continue
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
            }
            ref x => Err(anyhow!("{:?}", x))?,
        }
    }
}

pub fn transform_variable(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    entry: &DebuggingInformationEntry<DwarfReader>,
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
    })
}
