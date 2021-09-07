use anyhow::{anyhow, Result};
use num_bigint::{BigInt, BigUint};

use super::{ VariableInfo };

pub fn format_object(
    varinfo: &VariableInfo
) -> Result<String> {
    match varinfo.tag {
        gimli::DW_TAG_base_type => {
            let name = varinfo.name.clone();
            let byte_size = varinfo.byte_size;
            let encoding = varinfo.encoding;
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&varinfo.memory_slice.memory_slice[0..(byte_size as usize)]);

            match encoding {
                gimli::DW_ATE_signed => {
                    let value = BigInt::from_signed_bytes_le(&bytes);
                    Ok(format!("({}){}", name, value))
                }
                gimli::DW_ATE_unsigned => {
                    let value = BigUint::from_bytes_le(&bytes);
                    Ok(format!("({}){}", name, value))
                }
                gimli::DW_ATE_boolean => {
                    let value = match bytes[0] {
                        0 => false,
                        _ => true
                    };
                    Ok(format!("({}){}", name, value))
                }
                gimli::DW_ATE_float => {
                    match byte_size {
                        4 => {
                            let value = f32::from_le_bytes([ bytes[0], bytes[1], bytes[2], bytes[3] ]);
                            Ok(format!("({}){}", name, value))
                        }
                        8 => {
                            let value = f64::from_le_bytes([ bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7] ]);
                            Ok(format!("({}){}", name, value))
                        }
                        _ => unimplemented!()
                    }
                }
                _ => unimplemented!(),
            }
        }
        gimli::DW_TAG_class_type | gimli::DW_TAG_structure_type => {
            Ok(varinfo.name.clone())
        }
        _ => Err(anyhow!("unsupported DIE type")),
    }
}
