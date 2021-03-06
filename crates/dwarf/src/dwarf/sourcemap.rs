use anyhow::{anyhow, Result};
use gimli::{DebugLine, DebugLineOffset, DebuggingInformationEntry, LineRow, Reader, Unit};

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use super::utils::{
    clone_string_attribute, convert_from_windows_stype_path, is_absolute_path, normalize_path,
};
use super::{DwarfDebugData, DwarfReader, DwarfReaderOffset};

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ColumnType {
    LeftEdge,
    Column(u64),
}

#[derive(Clone)]
pub struct LineInfo {
    pub filepath: String,
    pub line: Option<u64>,
    pub column: ColumnType,
}

pub fn transform_debug_line(
    unit: &Unit<DwarfReader, DwarfReaderOffset>,
    root: &DebuggingInformationEntry<DwarfReader>,
    dwarf: &gimli::Dwarf<DwarfReader>,
    debug_line: &DebugLine<DwarfReader>,
) -> Result<DwarfUnitSourceMap> {
    let offset = match root.attr_value(gimli::DW_AT_stmt_list)? {
        Some(gimli::AttributeValue::DebugLineRef(offset)) => offset,
        _ => {
            return Err(anyhow!("Debug line offset is not found"));
        }
    };

    let program = debug_line
        .program(offset, unit.header.address_size(), None, None)
        .expect("parsable debug_line");

    let header = program.header();

    let sequence_base_index: usize;
    let mut dirs = vec![];
    let mut files = Vec::new();
    let mut file_sorted_rows = BTreeMap::new();

    if header.version() <= 4 {
        dirs.push("./".to_string());
        sequence_base_index = 1;
    } else {
        sequence_base_index = 0;
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
        let path = convert_from_windows_stype_path(&path);
        let path = normalize_path(&path);

        files.push(PathBuf::from(&path));
        file_sorted_rows.insert(0, BTreeMap::new());
    }

    for (file_index, file_entry) in header.file_names().iter().enumerate() {
        let dir = &dirs[file_entry.directory_index() as usize];
        let dir = convert_from_windows_stype_path(dir);

        let dir_path = Path::new(&dir);
        let path = clone_string_attribute(dwarf, unit, file_entry.path_name())?;
        let mut path = dir_path.join(convert_from_windows_stype_path(&path));

        if !is_absolute_path(path.to_str().unwrap_or_default()) {
            if let Some(ref comp_dir) = unit.comp_dir {
                let comp_dir = String::from_utf8(comp_dir.to_slice()?.to_vec()).unwrap_or_default();
                let comp_dir = convert_from_windows_stype_path(&comp_dir);
                path = Path::new(&comp_dir).join(path);
            }
        }

        files.push(PathBuf::from(&normalize_path(
            &path.to_string_lossy().into_owned(),
        )));
        file_sorted_rows.insert(file_index + sequence_base_index, BTreeMap::new());
    }

    let mut rows = program.rows();
    let mut sorted_rows = BTreeMap::new();
    while let Some((_, row)) = rows.next_row()? {
        sorted_rows.insert(row.address(), *row);

        match file_sorted_rows.get_mut(&(row.file_index() as usize)) {
            Some(x) => {
                x.insert(
                    match row.line() {
                        Some(x) => x.get(),
                        None => 0,
                    },
                    *row,
                );
            }
            None => {}
        }
    }
    let sorted_rows: Vec<_> = sorted_rows.into_iter().collect();
    let mapped_file_sorted_rows: Vec<(usize, Vec<(u64, LineRow)>)> = file_sorted_rows
        .into_iter()
        .map(|x| (x.0, x.1.into_iter().collect()))
        .collect();
    Ok(DwarfUnitSourceMap {
        address_sorted_rows: sorted_rows,
        file_sorted_rows: mapped_file_sorted_rows,
        paths: files,
    })
}

pub struct DwarfUnitSourceMap {
    address_sorted_rows: Vec<(u64, LineRow)>,
    file_sorted_rows: Vec<(usize, Vec<(u64, LineRow)>)>,
    paths: Vec<std::path::PathBuf>,
}

fn transform_lineinfo(row: &LineRow, paths: &Vec<std::path::PathBuf>) -> LineInfo {
    let filepath = paths[row.file_index() as usize].clone();
    LineInfo {
        filepath: filepath.to_str().unwrap_or_default().to_string(),
        line: if let Some(x) = row.line() { Some(x.get()) } else { None },
        column: match row.column() {
            gimli::ColumnType::Column(c) => ColumnType::Column(c.get()),
            gimli::ColumnType::LeftEdge => ColumnType::LeftEdge,
        },
    }
}
fn transform_file_index(file_index: usize, paths: &Vec<std::path::PathBuf>) -> String {
    match paths.get(file_index as usize) {
        Some(x) => match x.clone().to_str() {
            Some(x) => x.to_string(),
            None => String::from("??? (stringify failed)"),
        },
        None => String::from("??? (index out of range)"),
    }
}

pub struct DwarfSourceMap {
    /// Source files -> DebugLineOffsets mapping table
    file_sorted_entry_offsets: Vec<(String, DebugLineOffset)>,
    /// Source files -> LineRows by source lines mapping table
    file_sorted_rows: Vec<(String, Vec<(u64, LineRow)>)>,
    /// Code address -> Source files mapping table
    address_sorted_rows: Vec<(u64, LineInfo)>,

    directory_map: RefCell<HashMap<String, String>>,

    dwarf_data: DwarfDebugData,
}

impl DwarfSourceMap {
    pub fn new(units: Vec<DwarfUnitSourceMap>, dwarf_data: DwarfDebugData) -> Self {
        let mut address_rows = BTreeMap::new();
        let mut file_rows = BTreeMap::new();
        for unit in units {
            let path = unit.paths;

            for (addr, row) in &unit.address_sorted_rows {
                let line_info = transform_lineinfo(row, &path);
                address_rows.insert(*addr, line_info);
            }
            for (file_index, vec) in unit.file_sorted_rows {
                let file_name = transform_file_index(file_index, &path);
                file_rows.insert(file_name, vec);
            }
        }
        Self {
            file_sorted_entry_offsets: Vec::new(),
            address_sorted_rows: address_rows.into_iter().collect(),
            file_sorted_rows: file_rows.into_iter().collect(),
            directory_map: RefCell::new(HashMap::new()),
            dwarf_data,
        }
    }

    pub fn set_directory_map(&self, from: String, to: String) {
        self.directory_map.borrow_mut().insert(from, to);
    }

    fn update_file_sorted_rows(&mut self, _offset: DebugLineOffset) {}

    pub fn find_line_info(&self, offset: usize) -> Option<LineInfo> {
        let mut line_info = match self
            .address_sorted_rows
            .binary_search_by_key(&(offset as u64), |i| i.0)
        {
            Ok(i) => self.address_sorted_rows[i].1.clone(),
            Err(i) => {
                if i > 0 {
                    self.address_sorted_rows[i - 1].1.clone()
                } else {
                    return None;
                }
            }
        };
        for (from, to) in self.directory_map.borrow().iter() {
            line_info.filepath = line_info.filepath.replace(from, to);
        }
        Some(line_info)
    }

    pub fn find_address(&self, file: &LineInfo) -> Option<usize> {
        let escaped_filename = convert_from_windows_stype_path(&file.filepath);
        let escaped_filename = normalize_path(&escaped_filename);
        let line_vec = match self
            .file_sorted_rows
            .binary_search_by(|i| i.0.cmp(&escaped_filename))
        {
            Ok(i) => &self.file_sorted_rows[i].1,
            Err(_) => {
                return None;
            }
        };

        match line_vec.binary_search_by_key(&file.line.unwrap_or_default(), |i| i.0) {
            Ok(i) => Some(line_vec[i].1.address() as usize),
            Err(i) => {
                if i > 0 {
                    Some(line_vec[i - 1].1.address() as usize)
                } else {
                    None
                }
            }
        }
    }
}
