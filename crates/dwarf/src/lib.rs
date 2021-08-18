use wasm_bindgen::prelude::*;
use wasm_bindgen::*;
use object::*;
use std::{borrow, path, result};
use std::cell::*;
use std::rc::*;

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

#[wasm_bindgen]
pub struct DwarfLineAddressMappingWeakRef {
    data: Weak<RefCell<DwarfLineAddressMapping>>
}

pub struct DwarfAddressFileMapping {
    address: u32,
    file: String,
    line: u32
}

#[wasm_bindgen]
pub struct DwarfAddressFileMappingWeakRef {
    data: Weak<RefCell<DwarfAddressFileMapping>>
}

#[wasm_bindgen]
impl DwarfAddressFileMappingWeakRef {
    pub fn line(&self) -> u32 {
        self.data.upgrade().unwrap().borrow().line
    }

    pub fn file(&self) -> String {
        self.data.upgrade().unwrap().borrow().file.clone()
    }
}

#[wasm_bindgen]
impl DwarfLineAddressMappingWeakRef {
    pub fn line(&self) -> u32 {
        self.data.upgrade().unwrap().borrow().line
    }

    pub fn address(&self) -> u32 {
        self.data.upgrade().unwrap().borrow().address
    }
}



pub struct DwarfSourceFile {
    data: Vec<Rc<RefCell<DwarfLineAddressMapping>>>,
    file: String
}

#[wasm_bindgen]
pub struct DwarfSourceFileWeakRef {
    data: Weak<RefCell<DwarfSourceFile>>
}

#[wasm_bindgen]
impl DwarfSourceFileWeakRef {
    pub fn size(&self) -> usize {
        self.data.upgrade().unwrap().borrow().data.len()
    }

    pub fn at(&self, index: usize) -> DwarfLineAddressMappingWeakRef {
        DwarfLineAddressMappingWeakRef {
            data: Rc::downgrade(&self.data.upgrade().unwrap().borrow().data[index])
        }
    }

    pub fn filename(&self) -> String {
        self.data.upgrade().unwrap().borrow().file.clone()
    }

    pub fn find_address_from_line(&self, line: u32) -> Option<DwarfLineAddressMappingWeakRef> {
        match self.data.upgrade().unwrap().borrow().data.iter().find(|x| 
            x.borrow().line == line
        )
        {
            Some(x) => Option::from(DwarfLineAddressMappingWeakRef { data: Rc::downgrade(x) }),
            None => Option::None
        }
    }
}



#[wasm_bindgen]
pub struct DwarfDebugSymbolContainer {
    data: Vec<Rc<RefCell<DwarfSourceFile>>>,
    rev_data: Vec<Rc<RefCell<DwarfAddressFileMapping>>>
}

#[wasm_bindgen]
impl DwarfDebugSymbolContainer {
    pub fn new() -> DwarfDebugSymbolContainer {
        DwarfDebugSymbolContainer {
           data: Vec::new(),
           rev_data: Vec::new()
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
pub fn read_dwarf(data: &[u8]) -> DwarfDebugSymbolContainer {
    read_dwarf_internal(data).unwrap()
}

pub fn read_dwarf_internal(data: &[u8]) -> result::Result<DwarfDebugSymbolContainer, gimli::Error> {
    let object = match object::File::parse(data) {
        Ok(x) => x,
        Err(e) => { console_log!("Err! {}", e); std::process::exit(-1) }
    };
    let endian = gimli::RunTimeEndian::Little;

    // Load a section and return as `Cow<[u8]>`.
    let load_section = |id: gimli::SectionId| -> result::Result<borrow::Cow<[u8]>, gimli::Error> {
        match object.section_by_name(id.name()) {
            Some(ref section) => Ok(section
                .uncompressed_data()
                .unwrap_or(borrow::Cow::Borrowed(&[][..]))),
            None => Ok(borrow::Cow::Borrowed(&[][..])),
        }
    };

    let base_address = object.section_by_name("<code>").unwrap().file_range().unwrap().0 as u32;

    // Load all of the sections.
    let dwarf_cow = gimli::Dwarf::load(&load_section)?;

    // Borrow a `Cow<[u8]>` to create an `EndianSlice`.
    let borrow_section: &dyn for<'a> Fn(
        &'a borrow::Cow<[u8]>,
    ) -> gimli::EndianSlice<'a, gimli::RunTimeEndian> =
        &|section| gimli::EndianSlice::new(&*section, endian);

    // Create `EndianSlice`s for all of the sections.
    let dwarf = dwarf_cow.borrow(&borrow_section);

    // Iterate over the compilation units.
    let mut iter = dwarf.units();
    let mut files = DwarfDebugSymbolContainer::new();

    while let Some(header) = iter.next()? {
        let unit = dwarf.unit(header)?;

        // Get the line program for the compilation unit.
        if let Some(program) = unit.line_program.clone() {
            let comp_dir = if let Some(ref dir) = unit.comp_dir {
                path::PathBuf::from(dir.to_string_lossy().into_owned())
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
                            path.push(dwarf.attr_string(&unit, dir)?.to_string_lossy().as_ref());
                        }
                        path.push(
                            dwarf
                                .attr_string(&unit, file.path_name())?
                                .to_string_lossy()
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
    }

    Ok(files)
}
