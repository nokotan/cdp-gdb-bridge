use wasm_bindgen::prelude::*;
use wasm_bindgen::*;
use object::{
    Object, ObjectSection
};
use gimli::{
    Unit, UnitOffset, Reader, AttributeValue,
};
use std::{path};
use anyhow::{anyhow, Result};
use std::cell::RefCell;
use std::rc::{Rc};

mod format;
mod utils;
mod wasm_bindings;
mod dwarf;

use crate::wasm_bindings::{  
    DwarfAddressFileMappingWeakRef,
    DwarfSourceFileWeakRef,
    WasmValueVector, Value
};

use crate::dwarf::*;
use crate::utils::{ clone_string_attribute };
use crate::format::{ format_object };

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



#[wasm_bindgen]
pub struct Variable {
    name: String,
    type_name: String,
}

#[wasm_bindgen]
pub struct VariableVector {
    data: Vec<Variable>
}

#[wasm_bindgen]
impl VariableVector {
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
pub struct VariableInfo {
    pub address: usize,
    pub byte_size: usize,

    name: String,
    memory_slice: Vec<u8>,

    tag: gimli::DwTag,
    encoding: gimli::DwAte,
}

#[wasm_bindgen]
impl VariableInfo {
    pub fn set_memory_slice(&mut self, data: &[u8]) {
        self.memory_slice = data.to_vec();
    }

    pub fn print(&self) {
        match print_variable_info_impl(self) {
            Ok(()) => {},
            Err(_) => { console_log!("print failed!"); }
        };
    }
}



#[wasm_bindgen]
pub struct DwarfDebugSymbolContainer {
    data: Vec<Rc<RefCell<DwarfSourceFile>>>,
    rev_data: Vec<Rc<RefCell<DwarfAddressFileMapping>>>,

    subroutines: Vec<Subroutine>,
    buffer: Rc<[u8]>
}

#[wasm_bindgen]
impl DwarfDebugSymbolContainer {
    pub fn new(data: &[u8]) -> DwarfDebugSymbolContainer {
        DwarfDebugSymbolContainer {
           data: Vec::new(),
           rev_data: Vec::new(),
           subroutines: Vec::new(),
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

    pub fn variable_name_list(&self, code_offset: usize) -> Option<VariableVector> {
        match variable_name_list_impl(self, code_offset) {
            Ok(x) => Some(VariableVector{ data: x }),
            Err(_) => None
        }
    }

    pub fn get_variable_info(&self, 
        opts: String,
        locals: &WasmValueVector,
        globals: &WasmValueVector,
        stacks: &WasmValueVector,
        code_offset: usize) -> Option<VariableInfo> {

        match get_variable_info_impl(self, &opts, locals, globals, stacks, code_offset) {
            Ok(x) => x,
            Err(e) => { console_log!("{}", e); None }
        }
    }
}



#[wasm_bindgen]
pub fn read_dwarf(data: &[u8]) -> DwarfDebugSymbolContainer {
    let mut files = DwarfDebugSymbolContainer::new(data);

    load_dwarf_files(data, &mut files).unwrap();
    load_dwarf_functions(data, &mut files).unwrap();

    files
}

fn load_dwarf_files(data: &[u8], files: &mut DwarfDebugSymbolContainer) -> Result<()> {
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

    Ok(())
}

fn load_dwarf_functions(data: &[u8], files: &mut DwarfDebugSymbolContainer) -> Result<()>  {
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
                        Some(x) => files.subroutines.push(
                            x
                        ),
                        None => {}
                    }
                }
                Err(_) => {}
            }
        }
    };

    Ok(())
}

fn variable_name_list_impl(container: &DwarfDebugSymbolContainer, code_offset: usize) -> Result<Vec<Variable>> {
    let object = object::File::parse(&*container.buffer)?;
    let base_address = object.section_by_name("<code>").unwrap().file_range().unwrap().0 as u32;

    let offset = (code_offset - base_address as usize) as u64;
    let subroutine = match container
        .subroutines
        .iter()
        .filter(|s| s.pc.contains(&offset))
        .next()
    {
        Some(s) => s,
        None => return Err(anyhow!("failed to determine subroutine")),
    };
    let dwarf = parse_dwarf(&*container.buffer)?;
    let header = match header_from_offset(&dwarf, subroutine.unit_offset)? {
        Some(header) => header,
        None => {
            return Err(anyhow!("header?"));
        }
    };

    let unit = dwarf.unit(header)?;
    let variables = subroutine_variables(&dwarf, &unit, &subroutine)?;

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
        .collect()
    )
}

fn get_variable_info_impl(
    container: &DwarfDebugSymbolContainer,
    opts: &String,
    locals: &WasmValueVector,
    globals: &WasmValueVector,
    stacks: &WasmValueVector,
    code_offset: usize) -> Result<Option<VariableInfo>> {

    let object = object::File::parse(&*container.buffer)?;
    let base_address = object.section_by_name("<code>").unwrap().file_range().unwrap().0 as usize;

    let code_offset = code_offset - base_address;

    let frame_base = match get_frame_base_impl(container, code_offset)? {
        Some(loc) => {
            let offset = match loc {
                WasmLoc::Global(idx) => globals.data
                    .get(*idx as usize)
                    .ok_or(anyhow!("failed to get base global"))?,
                WasmLoc::Local(idx) => locals.data
                    .get(*idx as usize)
                    .ok_or(anyhow!("failed to get base local"))?,
                WasmLoc::Stack(idx) => stacks.data
                    .get(*idx as usize)
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
    
    display_variable_info_impl(
        container,
        code_offset,
        frame_base,
        opts
    )
}

fn get_frame_base_impl(container: &DwarfDebugSymbolContainer, code_offset: usize) -> Result<&Option<WasmLoc>> {
    let offset = &(code_offset as u64);
    let subroutine = match container
        .subroutines
        .iter()
        .filter(|s| s.pc.contains(offset))
        .next()
    {
        Some(s) => s,
        None => return Err(anyhow!("failed to determine subroutine")),
    };

    Ok(&subroutine.frame_base)
}

fn display_variable_info_impl(
    container: &DwarfDebugSymbolContainer,
    code_offset: usize,
    frame_base: FrameBase,
    name: &String,
) -> Result<Option<VariableInfo>> {
    let offset = code_offset as u64;
    let subroutine = match container
        .subroutines
        .iter()
        .filter(|s| s.pc.contains(&offset))
        .next()
    {
        Some(s) => s,
        None => return Err(anyhow!("failed to determine subroutine")),
    };
    let dwarf = parse_dwarf(&container.buffer)?;
    let header = match header_from_offset(&dwarf, subroutine.unit_offset)? {
        Some(header) => header,
        None => {
            return Ok(None);
        }
    };

    let unit = dwarf.unit(header)?;
    let mut variables = subroutine_variables(&dwarf, &unit, &subroutine)?;

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
            return Ok(None);
        }
    };

    if let Some(offset) = var.ty_offset {
        match piece.location {
            gimli::Location::Address { address } => {
                let mut tree = unit.entries_tree(Some(UnitOffset(offset)))?;
                let root = tree.root()?;
                
                return match create_variable(root, address, &dwarf, &unit) {
                    Ok(x) => Ok(Some(x)),
                    Err(_) => Ok(None)
                };
            }
            _ => unimplemented!(),
        }
    } else {
        println!("no explicit type");
    }
    Ok(None)
}

fn create_variable<R: gimli::Reader>(
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
            let type_name = match entry.attr_value(gimli::DW_AT_name)? {
                Some(attr) => clone_string_attribute(dwarf, unit, attr)?,
                None => "<no type name>".to_string(),
            };
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
                byte_size: 0,
                name: format!("{} {{\n{}\n}}", type_name, members.join(",\n")),
                encoding: gimli::DW_ATE_signed,
                tag: gimli::DW_TAG_class_type,
                memory_slice: Vec::new()
            })
        }
        _ => Err(anyhow!("unsupported DIE type")),
    }
}

fn print_variable_info_impl(varinfo: &VariableInfo) -> Result<()> {
    console_log!(
        "{}",
        format_object(
            varinfo
        )?
    );

    Ok(())
}