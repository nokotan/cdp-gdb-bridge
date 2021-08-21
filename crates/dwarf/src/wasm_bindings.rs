use wasm_bindgen::prelude::*;
use wasm_bindgen::*;
use std::cell::RefCell;
use std::rc::{Rc, Weak};
use super::{
    DwarfLineAddressMapping, DwarfAddressFileMapping, DwarfSourceFile
};


#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Value {
    I32(i32),
    I64(i64),
    F32(f32),
    F64(f64),
}

#[wasm_bindgen]
pub struct WasmValue {
    pub(crate) value: Value
}

#[wasm_bindgen]
impl WasmValue {
    pub fn from_i32(v: i32) -> WasmValue {
        WasmValue {
            value: Value::I32(v)
        }
    }

    pub fn from_i64(v: i64) -> WasmValue {
        WasmValue {
            value: Value::I64(v)
        }
    }

    pub fn from_f32(v: f32) -> WasmValue {
        WasmValue {
            value: Value::F32(v)
        }
    }

    pub fn from_f64(v: f64) -> WasmValue {
        WasmValue {
            value: Value::F64(v)
        }
    }
}

#[wasm_bindgen]
pub struct WasmValueVector {
    pub(crate) data: Vec<WasmValue>
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
pub struct DwarfLineAddressMappingWeakRef {
    pub(crate) data: Weak<RefCell<DwarfLineAddressMapping>>
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



#[wasm_bindgen]
pub struct DwarfAddressFileMappingWeakRef {
    pub(crate) data: Weak<RefCell<DwarfAddressFileMapping>>
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
pub struct DwarfSourceFileWeakRef {
    pub(crate) data: Weak<RefCell<DwarfSourceFile>>
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
