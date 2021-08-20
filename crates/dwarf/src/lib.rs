use wasm_bindgen::prelude::*;
use wasm_bindgen::*;
use object::{
    Object, ObjectSection
};
use gimli::{
    EndianRcSlice, LittleEndian, 
    Unit, UnitOffset, Reader, AttributeValue, DebuggingInformationEntry,
    UnitSectionOffset, UnitHeader
};
use std::{borrow, path};
use anyhow::{anyhow, Result};
use std::cell::RefCell;
use std::rc::{Rc, Weak};

mod format;
mod utils;
mod wasm_bindings;

use crate::wasm_bindings::{ 
    DwarfLineAddressMappingWeakRef, 
    DwarfAddressFileMappingWeakRef,
    DwarfSourceFileWeakRef
 };

type DwarfReader = EndianRcSlice<LittleEndian>;
type Dwarf = gimli::Dwarf<DwarfReader>;

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

pub struct DwarfLineAddressMapping {
    line: u32,
    address: u32
}

pub struct DwarfAddressFileMapping {
    file: String,
    line: u32,
    address: u32
}

pub struct DwarfSourceFile {
    data: Vec<Rc<RefCell<DwarfLineAddressMapping>>>,
    file: String
}

impl DwarfSourceFile {
    pub fn new(filename: &String) -> DwarfSourceFile {
        DwarfSourceFile {
            data: Vec::new(),
            file: filename.clone()
        }
    }
}



pub struct SymbolVariable
{
    name: Option<String>,
    content: VariableContent,
    ty_offset: Option<usize>,
}

enum VariableContent {
    Location(gimli::AttributeValue<DwarfReader>),
    ConstValue(Vec<u8>),
    Unknown { debug_info: String },
}

pub enum WasmLoc {
    Local(u64),
    Global(u64),
    Stack(u64),
}

#[wasm_bindgen]
pub struct VariableInfo {
    name: String,
    type_name: String,
}

pub struct DwarfFunction {
    name: Option<String>,
    code_range: std::ops::Range<u64>,
    unit_id: gimli::UnitSectionOffset,
    entry_id: UnitOffset<<DwarfReader as Reader>::Offset>,
    encoding: gimli::Encoding,
    frame_base: Option<WasmLoc>,
}

#[wasm_bindgen]
pub struct VariableInfoVector {
    data: Vec<VariableInfo>
}

#[wasm_bindgen]
impl VariableInfoVector {
    pub fn size(&self) -> usize {
        self.data.len()
    }

    pub fn at_name(&self, index: usize) -> String {
        self.data[index].name.clone()
    }

    pub fn at_type_name(&self, index: usize) -> String {
        self.data[index].type_name.clone()
    }
}



#[wasm_bindgen]
pub struct DwarfDebugSymbolContainer {
    data: Vec<Rc<RefCell<DwarfSourceFile>>>,
    rev_data: Vec<Rc<RefCell<DwarfAddressFileMapping>>>,

    functions: Vec<DwarfFunction>,
    buffer: Rc<[u8]>
}

#[wasm_bindgen]
impl DwarfDebugSymbolContainer {
    pub fn new(data: &[u8]) -> DwarfDebugSymbolContainer {
        DwarfDebugSymbolContainer {
           data: Vec::new(),
           rev_data: Vec::new(),
           functions: Vec::new(),
           buffer: Rc::from(data)
        }
    }

    pub fn size(&self) -> usize {
        self.data.len()
    }

    pub fn at(&self, index: usize) -> DwarfSourceFileWeakRef {
        DwarfSourceFileWeakRef {
            data: Rc::downgrade(&self.data[index])
        }
    }

    pub fn find_file(&self, filepath: String) -> Option<DwarfSourceFileWeakRef> {
        match self.data.iter().find(|x| 
                x.borrow().file == filepath || x.borrow().file.rsplit('/').next().unwrap() == filepath
            )
        {
            Some(x) => Option::from(DwarfSourceFileWeakRef { data: Rc::downgrade(x) }),
            None => Option::None
        }
    }

    pub fn find_file_from_address(&self, address: u32) -> Option<DwarfAddressFileMappingWeakRef> {
        match self.rev_data.iter().find(|x| 
            x.borrow().address == address
        )
        {
            Some(x) => Option::from(DwarfAddressFileMappingWeakRef { data: Rc::downgrade(x) }),
            None => Option::None
        }
    }

    pub fn variable_name_list(&self, code_offset: usize) -> Option<VariableInfoVector> {
        match variable_name_list_impl(self, code_offset) {
            Ok(x) => x,
            Err(e) => {
                console_log!("{}", e);
                None
            }
        }
    }
}



#[wasm_bindgen]
pub fn read_dwarf(data: &[u8]) -> DwarfDebugSymbolContainer {
    read_dwarf_internal(data).unwrap()
}

pub fn load_dwarf_files(data: &[u8], files: &mut DwarfDebugSymbolContainer) -> Result<()> {
    let object = object::File::parse(data)?;
    let base_address = object.section_by_name("<code>").unwrap().file_range().unwrap().0 as u32;

    let dwarf = parse_dwarf(data)?;

    // Iterate over the compilation units.
    let mut iter = dwarf.units();

    while let Some(header) = iter.next()? {
        let unit = dwarf.unit(header)?;

        // Get the line program for the compilation unit.
        if let Some(program) = unit.line_program.clone() {
            let comp_dir = if let Some(ref dir) = unit.comp_dir {
                path::PathBuf::from(dir.to_string_lossy()?.into_owned())
            } else {
                path::PathBuf::new()
            };

            // Iterate over the line program rows.
            let mut rows = program.rows();
            while let Some((header, row)) = rows.next_row()? {
                if row.end_sequence() {
                    // End of sequence indicates a possible gap in addresses.
                } else {
                    // Determine the path. Real applications should cache this for performance.
                    let mut path = path::PathBuf::new();
                    if let Some(file) = row.file(header) {
                        path = comp_dir.clone();
                        if let Some(dir) = file.directory(header) {
                            path.push(dwarf.attr_string(&unit, dir)?.to_string_lossy()?.as_ref());
                        }
                        path.push(
                            dwarf
                                .attr_string(&unit, file.path_name())?
                                .to_string_lossy()?
                                .as_ref(),
                        );
                    }

                    // Determine line/column. DWARF line/column is never 0, so we use that
                    // but other applications may want to display this differently.
                    let line = match row.line() {
                        Some(line) => line.get(),
                        None => 0,
                    };

                    match files.data.iter().position(|x| x.borrow().file == path.to_str().unwrap()) {
                        Some(x) => {
                            files.data[x].borrow_mut().data.push(Rc::new(RefCell::new(DwarfLineAddressMapping {
                                line: line as u32,
                                address: row.address() as u32 + base_address
                            })))
                        },
                        None => {
                            let mut data: Vec<Rc<RefCell<DwarfLineAddressMapping>>> = Vec::new();

                            data.push(Rc::new(RefCell::new(DwarfLineAddressMapping {
                                line: line as u32,
                                address: row.address() as u32 + base_address
                            })));
                            
                            files.data.push(Rc::new(RefCell::new(DwarfSourceFile {
                                data,
                                file: String::from(path.to_str().unwrap())
                            })))
                        }
                    }

                    files.rev_data.push(Rc::new(RefCell::new({
                        DwarfAddressFileMapping {
                            address: row.address() as u32 + base_address,
                            line: line as u32,
                            file: String::from(path.to_str().unwrap())
                        }
                    })))
                }
            }    
        }
    };

    return Ok(());
}

pub fn load_dwarf_functions(data: &[u8], files: &mut DwarfDebugSymbolContainer) -> Result<()>  {
    let dwarf = parse_dwarf(data)?;

    // Iterate over the compilation units.
    let mut iter = dwarf.units();

    while let Some(header) = iter.next()? {
        let unit_offset = header.offset();
        let unit = dwarf.unit(header)?;    
        let mut trees = unit.entries_tree(None).unwrap();
        let mut children = trees.root().unwrap().children();

        while let Ok(Some(child)) = children.next() {
            match read_subprogram_header(
                &child,
                &dwarf, 
                &unit, 
                unit_offset) 
            {
                Ok(x) => {
                    match x {
                        Some(x) => files.functions.push(
                            x
                        ),
                        None => {}
                    }
                }
                Err(_) => {}
            }
        }
    };

    return Ok(());
}

pub fn read_dwarf_internal(data: &[u8]) -> Result<DwarfDebugSymbolContainer> {
    
    let mut files = DwarfDebugSymbolContainer::new(data);
    load_dwarf_files(data, &mut files)?;
    load_dwarf_functions(data, &mut files)?;

    Ok(files)
}

fn clone_string_attribute<R: gimli::Reader>(
    dwarf: &gimli::Dwarf<R>,
    unit: &gimli::Unit<R, R::Offset>,
    attr: gimli::AttributeValue<R>,
) -> Result<String> {
    Ok(dwarf
        .attr_string(unit, attr)?
        .to_string()?
        .as_ref()
        .to_string())
}

#[allow(non_camel_case_types)]
enum DwAtWasm {
    DW_OP_WASM_location = 0xed,
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

fn read_subprogram_header(
    node: &gimli::EntriesTreeNode<DwarfReader>,
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader, <DwarfReader as Reader>::Offset>,
    unit_offset: gimli::UnitSectionOffset,
) -> Result<Option<DwarfFunction>> {
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

        DwarfFunction {
            code_range: low_pc..high_pc,
            name,
            encoding: unit.encoding(),
            unit_id: unit_offset,
            entry_id: node.entry().offset(),
            frame_base,
        }
    } else {
        return Ok(None);
    };
    Ok(Some(subroutine))
}

fn subroutine_variables(
    dwarf: &gimli::Dwarf<DwarfReader>,
    unit: &Unit<DwarfReader>,
    subroutine: &DwarfFunction,
) -> Result<Vec<SymbolVariable>> {
    let mut tree = unit.entries_tree(Some(subroutine.entry_id))?;
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

fn transform_variable(
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
    let borrow_section =
        |section: &Rc<[u8]>| -> gimli::EndianRcSlice<gimli::LittleEndian> { gimli::EndianRcSlice::new(section.clone(), endian) };

    // Create `EndianSlice`s for all of the sections.
    Ok(dwarf_cow.borrow(&borrow_section))
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
    if let Some(attr) = root.entry().attr_value(gimli::DW_AT_name)? {
        clone_string_attribute(dwarf, unit, attr)
    } else {
        Err(anyhow!(format!("failed to seek at {:?}", type_offset)))
    }
}

pub enum FrameBase {
    WasmFrameBase(u64),
    RBP(u64),
}

fn display_variable(
    container: &DwarfDebugSymbolContainer,
    code_offset: usize,
    frame_base: FrameBase,
    memory: &[u8],
    name: String,
) -> Result<()> {
    let offset = &(code_offset as u64);
    let subroutine = match container
        .functions
        .iter()
        .filter(|s| s.code_range.contains(offset))
        .next()
    {
        Some(s) => s,
        None => return Err(anyhow!("failed to determine subroutine")),
    };
    let dwarf = parse_dwarf(&container.buffer)?;
    let header = match header_from_offset(&dwarf, subroutine.unit_id)? {
        Some(header) => header,
        None => {
            return Ok(());
        }
    };

    let unit = dwarf.unit(header)?;
    let variables = subroutine_variables(&dwarf, &unit, &subroutine)?;

    let var = match variables
        .iter()
        .filter(|v| {
            if let Some(vname) = v.name.clone() {
                vname == name
            } else {
                false
            }
        })
        .next()
    {
        Some(v) => v,
        None => {
            return Err(anyhow!("'{}' is not valid variable name", name));
        }
    };
    let piece = match var.content {
        VariableContent::Location(location) => match location {
            AttributeValue::Exprloc(expr) => {
                evaluate_variable_location(subroutine.encoding, frame_base, expr)?
            }
            AttributeValue::LocationListsRef(_listsref) => unimplemented!("listsref"),
            _ => panic!(),
        },
        VariableContent::ConstValue(ref _bytes) => unimplemented!(),
        VariableContent::Unknown { ref debug_info } => {
            unimplemented!("Unknown variable content found {}", debug_info)
        }
    };

    let piece = match piece.iter().next() {
        Some(p) => p,
        None => {
            println!("failed to get piece of variable");
            return Ok(());
        }
    };

    if let Some(offset) = var.ty_offset {
        use format::format_object;
        match piece.location {
            gimli::Location::Address { address } => {
                let mut tree = unit.entries_tree(Some(UnitOffset(offset)))?;
                let root = tree.root()?;
                println!(
                    "{}",
                    format_object(
                        root,
                        &memory[(address as usize)..],
                        subroutine.encoding,
                        &dwarf,
                        &unit
                    )?
                );
            }
            _ => unimplemented!(),
        }
    } else {
        println!("no explicit type");
    }
    Ok(())
}

fn variable_name_list_impl(container: &DwarfDebugSymbolContainer, code_offset: usize) -> Result<Option<VariableInfoVector>> {
    let object = object::File::parse(&*container.buffer)?;
    let base_address = object.section_by_name("<code>").unwrap().file_range().unwrap().0 as u32;

    let offset = (code_offset - base_address as usize) as u64;
    let subroutine = match container
        .functions
        .iter()
        .filter(|s| s.code_range.contains(&offset))
        .next()
    {
        Some(s) => s,
        None => return Err(anyhow!("failed to determine subroutine")),
    };
    let dwarf = parse_dwarf(&*container.buffer)?;
    let header = match header_from_offset(&dwarf, subroutine.unit_id)? {
        Some(header) => header,
        None => {
            return Err(anyhow!("header?"));
        }
    };

    let unit = dwarf.unit(header)?;
    let variables = subroutine_variables(&dwarf, &unit, &subroutine)?;

    Ok(Some(VariableInfoVector { data: variables
        .iter()
        .map(|var| {
            let mut v = VariableInfo {
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
        .collect()
    }))
}

use gimli::Expression;
fn evaluate_variable_location<R: gimli::Reader>(
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