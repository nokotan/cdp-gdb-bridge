/**
 * Original Source:
 * 
 * MIT License
 * Copyright (c) 2020 Yuta Saito
 * https://github.com/kateinoigakukun/wasminspect/crates/debugger/dwarf/mod.rs
 */
 
use wasm_bindgen::prelude::*;
use object::{
    Object, ObjectSection
};
use gimli::{
    EndianRcSlice, LittleEndian, 
    Unit, UnitOffset, Reader, AttributeValue, DebuggingInformationEntry,
    UnitSectionOffset, UnitHeader
};
use anyhow::{anyhow, Result};
use std::rc::{Rc};

use super::utils::{ clone_string_attribute };

pub type DwarfReader = EndianRcSlice<LittleEndian>;
pub type Dwarf = gimli::Dwarf<DwarfReader>;


#[wasm_bindgen]
extern "C" {
    // Use `js_namespace` here to bind `console.log(..)` instead of just
    // `log(..)`
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

macro_rules! console_log {
    // Note that this is using the `log` function imported above during
    // `bare_bones`
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}



pub fn parse_dwarf(data: &[u8]) -> Result<Dwarf> {
    let object = object::File::parse(data)?;
    let endian = gimli::LittleEndian;

    // Load a section and return as `Cow<[u8]>`.
    let load_section = |id: gimli::SectionId| -> Result<Rc<[u8]>> {
        match object.section_by_name(id.name()) {
            Some(ref section) => Ok(Rc::from(section.data().unwrap_or(&[][..]))),
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

pub fn transform_variable(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, <DwarfReader as Reader>::Offset>,
    entry: &DebuggingInformationEntry<DwarfReader>,
) -> Result<SymbolVariable> {
    let mut content = VariableContent::Unknown {
        debug_info: "".to_string(), //format!("{:?}", entry.attrs()),
    };
    let mut has_explicit_location = false;
    if let Some(location) = entry.attr_value(gimli::DW_AT_location)? {
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
        content,
        ty_offset: ty,
    })
}

pub struct SymbolVariable
{
    pub name: Option<String>,
    pub content: VariableContent,
    pub ty_offset: Option<usize>,
}

pub enum VariableContent {
    Location(gimli::AttributeValue<DwarfReader>),
    ConstValue(Vec<u8>),
    Unknown { debug_info: String },
}

pub struct Subroutine {
    pub name: Option<String>,
    pub pc: std::ops::Range<u64>,
    pub unit_offset: gimli::UnitSectionOffset,
    pub entry_offset: UnitOffset<<DwarfReader as Reader>::Offset>,
    pub encoding: gimli::Encoding,
    pub frame_base: Option<WasmLoc>,
}

#[allow(non_camel_case_types)]
enum DwAtWasm {
    DW_OP_WASM_location = 0xed,
}

pub enum WasmLoc {
    Local(u64),
    Global(u64),
    Stack(u64),
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

pub fn read_subprogram_header(
    node: &gimli::EntriesTreeNode<DwarfReader>,
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, <DwarfReader as Reader>::Offset>,
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

pub enum FrameBase {
    WasmFrameBase(u64),
    RBP(u64),
}

use gimli::Expression;
pub fn evaluate_variable_location<R: gimli::Reader>(
    encoding: gimli::Encoding,
    base: FrameBase,
    expr: Expression<R>,
) -> Result<Vec<gimli::Piece<R>>> {
    let mut evaluation = expr.evaluation(encoding);
    if let FrameBase::RBP(base) = base {
        evaluation.set_initial_value(base);
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
                    result = evaluation.resume_with_frame_base(base)?;
                } else {
                    return Err(anyhow!("unexpected occurrence of DW_AT_frame_base"));
                }
            }
            ref x => Err(anyhow!("{:?}", x))?,
        }
    }
}

pub fn header_from_offset<R: gimli::Reader>(
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

pub fn subroutine_variables(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader>,
    subroutine: &Subroutine,
) -> Result<Vec<SymbolVariable>> {
    let mut tree = unit.entries_tree(Some(subroutine.entry_offset))?;
    let root = tree.root()?;
    let mut children = root.children();
    let mut variables = vec![];
    while let Some(child) = children.next()? {
        match child.entry().tag() {
            gimli::DW_TAG_variable | gimli::DW_TAG_formal_parameter => {
                let var = transform_variable(&dwarf, &unit, child.entry())?;
                variables.push(var);
            }
            gimli::DW_TAG_lexical_block => {
                console_log!("not implemented: variable in block")
            }
            _ => continue,
        }
    }
    Ok(variables)
}


pub fn unit_type_name<R: gimli::Reader>(
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
    if let Some(attr) = root.entry().attr_value(gimli::DW_AT_name)? {
        clone_string_attribute(dwarf, unit, attr)
    } else {
        Err(anyhow!(format!("failed to seek at {:?}", type_offset)))
    }
}
