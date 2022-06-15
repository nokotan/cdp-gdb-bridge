use super::sourcemap::{ColumnType, LineInfo};
use super::variables::VariableName;
use wasm_bindgen::prelude::*;
use wasm_bindgen::*;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Value {
    I32(i32),
    I64(i64),
    F32(f32),
    F64(f64),
}

#[wasm_bindgen]
pub struct WasmValue {
    pub(crate) value: Value,
}

#[wasm_bindgen]
impl WasmValue {
    pub fn from_i32(v: i32) -> WasmValue {
        WasmValue {
            value: Value::I32(v),
        }
    }

    pub fn from_i64(v: i64) -> WasmValue {
        WasmValue {
            value: Value::I64(v),
        }
    }

    pub fn from_f32(v: f32) -> WasmValue {
        WasmValue {
            value: Value::F32(v),
        }
    }

    pub fn from_f64(v: f64) -> WasmValue {
        WasmValue {
            value: Value::F64(v),
        }
    }
}

#[wasm_bindgen]
pub struct WasmValueVector {
    pub(crate) data: Vec<WasmValue>,
}

#[wasm_bindgen]
impl WasmValueVector {
    pub fn new() -> WasmValueVector {
        WasmValueVector { data: Vec::new() }
    }

    pub fn push(&mut self, v: WasmValue) {
        self.data.push(v);
    }
}

#[wasm_bindgen]
pub struct WasmLineInfo {
    pub(crate) filepath: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
}

#[wasm_bindgen]
impl WasmLineInfo {
    pub fn new(filepath: String, line: Option<usize>, column: Option<usize>) -> Self {
        Self {
            filepath,
            line,
            column,
        }
    }

    pub fn file(&self) -> String {
        self.filepath.clone()
    }

    pub(crate) fn from_line_info(info: &LineInfo) -> Self {
        Self {
            filepath: info.filepath.clone(),
            line: info.line.map(|x| x as usize),
            column: match info.column {
                ColumnType::Column(x) => Some(x as usize),
                ColumnType::LeftEdge => None,
            },
        }
    }

    pub(crate) fn into_line_info(info: &WasmLineInfo) -> LineInfo {
        LineInfo {
            filepath: info.filepath.clone(),
            line: info.line.map(|x| x as u64),
            column: match info.column {
                Some(x) => ColumnType::Column(x as u64),
                None => ColumnType::LeftEdge,
            },
        }
    }
}

#[wasm_bindgen]
pub struct VariableVector {
    data: Vec<VariableName>,
}

#[wasm_bindgen]
impl VariableVector {
    pub(crate) fn from_vec(data: Vec<VariableName>) -> Self {
        Self { data }
    }

    pub fn size(&self) -> usize {
        self.data.len()
    }

    pub fn at_name(&self, index: usize) -> String {
        self.data[index].name.clone()
    }

    pub fn at_display_name(&self, index: usize) -> String {
        self.data[index].display_name.clone()
    }

    pub fn at_type_name(&self, index: usize) -> String {
        self.data[index].type_name.clone()
    }

    pub fn at_group_id(&self, index: usize) -> i32 {
        self.data[index].group_id
    }

    pub fn at_chile_group_id(&self, index: usize) -> Option<i32> {
        self.data[index].child_group_id
    }
}
