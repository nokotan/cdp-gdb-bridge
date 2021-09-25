use anyhow::Result;
use gimli;
use regex::{Regex,Captures};

pub(crate) fn clone_string_attribute<R: gimli::Reader>(
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

pub(crate) fn convert_from_windows_stype_path(
    path: &String
) -> String {
    let backslash_escaped = path.replace("\\", "/");
    let regex = Regex::new("^([A-Za-z]):/");
    regex.unwrap().replace_all(
        &backslash_escaped, 
        |captured: &Captures| {
            format!("{}:/", captured[1].to_lowercase())
        }
    ).into_owned()
}

pub(crate) fn is_absolute_path(path: &str) -> bool {
    let regex = Regex::new("^([A-Za-z]):/").unwrap();
    path.starts_with("/") | regex.is_match(path)
}

pub(crate) fn normalize_path(
    path: &String
) -> String {
    let splited = path.split("/");
    let mut stack = Vec::new();

    for component in splited {
        match component {
            ".." => {
                stack.pop();
            },
            "." | "" => {
                // nothing to do
            }
            other => {
                stack.push(other)
            }
        }
    }

    stack.join("/")
}
