use anyhow::{anyhow, Result};
use gimli::{Reader, Unit, UnitSectionOffset};

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use super::utils::{
    clone_string_attribute, convert_from_windows_style_path, is_absolute_path, normalize_path,
};
use super::{DwarfDebugData, DwarfReader, DwarfReaderOffset};

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ColumnType {
    LeftEdge,
    Column(u64),
}

#[derive(Clone)]
pub struct LineInfo {
    pub file_path: String,
    pub line: Option<u64>,
    pub column: ColumnType,
}

type FileIndex = usize;

struct FileAddressMap {
    line_number: u64,
    address: u64,
}

struct File {
    file_index: FileIndex,
    column: ColumnType,
    line_number: Option<u64>,
}

struct UnitSourceMap {
    address_to_file: Vec<(u64, File)>,
    file_to_address: Vec<(FileIndex, Vec<FileAddressMap>)>,
}

pub struct UnitFiles {
    unit_offset: UnitSectionOffset,
    paths: Vec<std::path::PathBuf>,
}

struct DwarfUnitSourceMap {
    address_to_file: Vec<(u64, File)>,
    file_to_address: Vec<(String, Vec<FileAddressMap>)>,
    paths: Vec<std::path::PathBuf>,
}

fn transform_unit_debug_line(
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    dwarf: &gimli::Dwarf<DwarfReader>,
) -> Result<DwarfUnitSourceMap> {

    let paths = transform_debug_line_files(unit, dwarf)?;
    let source_map = transform_debug_line_address(unit, dwarf)?;

    let file_to_address: Vec<_> = source_map.file_to_address.into_iter().map(
        |(index, files)| (transform_file_index(index, &paths), files)
    ).collect();

    Ok(DwarfUnitSourceMap {
        paths,
        address_to_file: source_map.address_to_file,
        file_to_address
    })
}

pub fn transform_debug_line(
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    dwarf: &gimli::Dwarf<DwarfReader>
) -> Result<UnitFiles> {

    let paths = transform_debug_line_files(unit, dwarf)?;

    Ok(UnitFiles {
        paths,
        unit_offset: unit.header.offset()
    })
}

fn transform_debug_line_files(
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    dwarf: &gimli::Dwarf<DwarfReader>,
) -> Result<Vec<PathBuf>> {

    let mut entries = unit.entries();
    let root = match entries.next_dfs()? {
        Some((_, entry)) => entry,
        None => return Err(anyhow!("Unit entry is not found")),
    };
    let offset = match root.attr_value(gimli::DW_AT_stmt_list)? {
        Some(gimli::AttributeValue::DebugLineRef(offset)) => offset,
        _ => return Err(anyhow!("Debug line offset is not found")),
    };
    let debug_line = &dwarf.debug_line;
    let program = debug_line
        .program(offset, unit.header.address_size(), None, None)
        .expect("parsable debug_line");

    let header = program.header();

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    if header.version() <= 4 {
        dirs.push("./".to_string());
    }

    for dir in header.include_directories() {
        dirs.push(clone_string_attribute(dwarf, unit, dir.clone()).expect("parsable dir string"));
    }

    if header.version() <= 4 {
        let folder_name = match root.attr_value(gimli::DW_AT_comp_dir)? {
            Some(attr) => clone_string_attribute(dwarf, unit, attr)?,
            None => String::from(""),
        };

        let file_name = match root.attr_value(gimli::DW_AT_name)? {
            Some(attr) => clone_string_attribute(dwarf, unit, attr)?,
            None => String::from("unknown"),
        };

        let path = match is_absolute_path(&file_name) {
            true => file_name,
            false => format!("{}/{}", folder_name, file_name),
        };
        let path = convert_from_windows_style_path(&path);
        let path = normalize_path(&path);

        files.push(PathBuf::from(&path));
    }

    for file_entry in header.file_names() {
        let dir = &dirs[file_entry.directory_index() as usize];
        let dir = convert_from_windows_style_path(dir);

        let dir_path = Path::new(&dir);
        let path = clone_string_attribute(dwarf, unit, file_entry.path_name())?;
        let mut path = dir_path.join(convert_from_windows_style_path(&path));

        if !is_absolute_path(path.to_str().unwrap_or_default()) {
            if let Some(ref comp_dir) = unit.comp_dir {
                let comp_dir = String::from_utf8(comp_dir.to_slice()?.to_vec()).unwrap_or_default();
                let comp_dir = convert_from_windows_style_path(&comp_dir);
                path = Path::new(&comp_dir).join(path);
            }
        }

        files.push(PathBuf::from(&normalize_path(
            &path.to_string_lossy().into_owned(),
        )));
    }
    
    Ok(files)
}

fn transform_debug_line_address(
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    dwarf: &gimli::Dwarf<DwarfReader>,
) -> Result<UnitSourceMap> {
    let mut entries = unit.entries();
    let root = match entries.next_dfs()? {
        Some((_, entry)) => entry,
        None => return Err(anyhow!("Unit entry is not found")),
    };
    let offset = match root.attr_value(gimli::DW_AT_stmt_list)? {
        Some(gimli::AttributeValue::DebugLineRef(offset)) => offset,
        _ => return Err(anyhow!("Debug line offset is not found")),
    };
    let debug_line = &dwarf.debug_line;
    let program = debug_line
        .program(offset, unit.header.address_size(), None, None)
        .expect("parsable debug_line");
    let header = program.header();

    let mut address_sorted_rows = BTreeMap::new();
    let mut file_sorted_rows = BTreeMap::new();

    if header.version() <= 4 {
        file_sorted_rows.insert(0, BTreeMap::new());
    }

    let mut rows = program.rows();

    while let Some((_, row)) = rows.next_row()? {
        let file = File {
            file_index: row.file_index() as usize,
            line_number: row.line().map(|line| line.get()),
            column: match row.column() {
                gimli::ColumnType::Column(c) => ColumnType::Column(c.get()),
                gimli::ColumnType::LeftEdge => ColumnType::LeftEdge,
            },
        };
        address_sorted_rows.insert(row.address(), file);

        let file_index = row.file_index() as usize;

        if let None = file_sorted_rows.get(&file_index) {
            file_sorted_rows.insert(file_index, BTreeMap::new());
        }

        file_sorted_rows.get_mut(&file_index).unwrap().insert(
            match row.line() {
                Some(line) => line.get(),
                None => 0,
            },
            row.address(),
        );
    }
    let address_sorted_rows: Vec<_> = address_sorted_rows.into_iter().collect();
    let mapped_file_sorted_rows: Vec<(usize, Vec<FileAddressMap>)> = file_sorted_rows
        .into_iter()
        .map(|file| (file.0, file.1.into_iter().map(|(line, address)| FileAddressMap { line_number: line, address }).collect()))
        .collect();
    Ok(UnitSourceMap {
        address_to_file: address_sorted_rows,
        file_to_address: mapped_file_sorted_rows,
    })
}



fn transform_file_index(file_index: usize, paths: &Vec<std::path::PathBuf>) -> String {
    match paths.get(file_index as usize) {
        Some(x) => match x.to_str() {
            Some(x) => x.to_string(),
            None => String::from("??? (stringify failed)"),
        },
        None => String::from("??? (index out of range)"),
    }
}

pub struct DwarfSourceMap {
    /// Source files -> Unit Offset mapping table
    file_sorted_unit_offsets: Vec<(String, UnitSectionOffset)>,

    /// Unit Offset -> Debug Line mapping table
    units_parsed: BTreeMap<UnitSectionOffset, DwarfUnitSourceMap>,

    directory_map: RefCell<HashMap<String, String>>,

    dwarf_data: DwarfDebugData,
}

impl DwarfSourceMap {
    pub fn new(units: Vec<UnitFiles>, dwarf_data: DwarfDebugData) -> Self {
        let mut files = BTreeMap::new();
       
        for unit in units {
            for path in unit.paths {
                files.insert(path.to_string_lossy().to_string(), unit.unit_offset.clone());
            }
        }

        Self {
            file_sorted_unit_offsets: files.into_iter().collect(),
            units_parsed: BTreeMap::new(),
            directory_map: RefCell::new(HashMap::new()),
            dwarf_data,
        }
    }

    pub fn set_directory_map(&self, from: String, to: String) {
        self.directory_map.borrow_mut().insert(from, to);
    }

    fn update_unit_debug_info<'a>(&'a mut self, unit_offset: &UnitSectionOffset) -> Result<&'a DwarfUnitSourceMap> {
        
        match self.units_parsed.get(unit_offset) {
            Some(_) => {}
            None => {
                let (dwarf, unit) = self.dwarf_data.unit_offset(unit_offset.clone())?.unwrap();
                let debug_line = transform_unit_debug_line(&unit, &dwarf)?;

                self.units_parsed.insert(unit_offset.clone(), debug_line);
            }
        };

        Ok(self.units_parsed.get(&unit_offset).unwrap())
    }

    pub fn find_line_info(&mut self, unit_offset: &UnitSectionOffset, address: usize) -> Option<LineInfo> {
 
        let unit = self.update_unit_debug_info(unit_offset).expect("dwarf parse error");
        
        let file_info = match unit.address_to_file
            .binary_search_by_key(&(address as u64), |i| i.0)
        {
            Ok(i) => &unit.address_to_file[i].1,
            Err(i) => {
                if i > 0 {
                    &unit.address_to_file[i - 1].1
                } else {
                    return None;
                }
            }
        };

        let mut file_info = LineInfo {
            file_path: unit.paths[file_info.file_index].to_string_lossy().to_string(),
            line: file_info.line_number.clone(),
            column: file_info.column.clone(),
        };

        for (from, to) in self.directory_map.borrow().iter() {
            file_info.file_path = file_info.file_path.replace(from, to);
        }

        Some(file_info)
    }

    pub fn find_address(&mut self, file: &LineInfo) -> Option<usize> {

        let escaped_filename = convert_from_windows_style_path(&file.file_path);
        let escaped_filename = normalize_path(&escaped_filename);

        let unit_offset = match self
            .file_sorted_unit_offsets
            .binary_search_by(|i| i.0.cmp(&escaped_filename)) {
                Ok(i) => &self.file_sorted_unit_offsets[i].1,
                Err(_) => {
                    return None;
                }
            }.clone();
        let unit = self.update_unit_debug_info(&unit_offset).expect("dwarf parse error");

        let line_vec = match unit
            .file_to_address
            .binary_search_by(|i| i.0.cmp(&escaped_filename))
        {
            Ok(i) => &unit.file_to_address[i].1,
            Err(_) => {
                return None;
            }
        };

        match line_vec.binary_search_by_key(&file.line.unwrap_or_default(), |i| i.line_number) {
            Ok(i) => Some(line_vec[i].address as usize),
            Err(i) => {
                if i > 0 {
                    Some(line_vec[i - 1].address as usize)
                } else {
                    None
                }
            }
        }
    }
}
