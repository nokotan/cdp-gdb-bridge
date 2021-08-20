use wasm_bindgen::prelude::*;
use std::cell::RefCell;
use std::rc::{Rc, Weak};
use super::{
    DwarfLineAddressMapping, DwarfAddressFileMapping, DwarfSourceFile
};



#[wasm_bindgen]
pub struct DwarfLineAddressMappingWeakRef {
    data: Weak<RefCell<DwarfLineAddressMapping>>
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
