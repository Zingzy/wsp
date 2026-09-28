// SPDX-License-Identifier: AGPL-3.0-only
//! A reply the TypeScript tool runs through a zod schema's parse before it answers, parsed the same way here against
//! the JSON Schema its recorded entry lists for that value: an object comes out with its fields in the schema's order
//! and none it does not name, a union as the first of its branches that parses, and everything else as the host's
//! own bytes. None where zod's parse would throw. Only the keywords the recorded output schemas use are read.

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Value;

/// A JSON object read with its fields in the order they were written, each value its raw bytes.
pub struct Ordered(pub Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct InOrder;
        impl<'de> Visitor<'de> for InOrder {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered, A::Error> {
                let mut fields = Vec::new();
                while let Some(field) = map.next_entry::<String, Box<RawValue>>()? {
                    fields.push(field);
                }
                Ok(Ordered(fields))
            }
        }
        deserializer.deserialize_map(InOrder)
    }
}

impl Ordered {
    pub fn get(&self, key: &str) -> Option<&RawValue> {
        self.0.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_ref())
    }
}

/// The part of a JSON Schema this reads, its properties in the order the entry lists them, which is zod's order.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    #[serde(default, rename = "$ref")]
    reference: Option<String>,
    #[serde(default)]
    any_of: Option<Vec<Schema>>,
    #[serde(default, rename = "type")]
    kind: Option<Kinds>,
    #[serde(default)]
    properties: Option<Properties>,
    #[serde(default)]
    required: Vec<String>,
    #[serde(default)]
    additional_properties: Option<Additional>,
    #[serde(default)]
    items: Option<Box<Schema>>,
    #[serde(default, rename = "enum")]
    words: Option<Vec<Value>>,
    #[serde(default, rename = "const")]
    only: Option<Value>,
    #[serde(default)]
    minimum: Option<f64>,
    #[serde(default)]
    maximum: Option<f64>,
    #[serde(default)]
    exclusive_minimum: Option<f64>,
    #[serde(default)]
    exclusive_maximum: Option<f64>,
    #[serde(default)]
    min_items: Option<usize>,
    #[serde(default)]
    max_items: Option<usize>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Kinds {
    One(String),
    Several(Vec<String>),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Additional {
    Allowed(#[allow(dead_code)] bool),
    Each(Box<Schema>),
}

pub struct Properties(Vec<(String, Schema)>);

impl<'de> Deserialize<'de> for Properties {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct InOrder;
        impl<'de> Visitor<'de> for InOrder {
            type Value = Properties;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a map of fields")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Properties, A::Error> {
                let mut fields = Vec::new();
                while let Some(field) = map.next_entry::<String, Schema>()? {
                    fields.push(field);
                }
                Ok(Properties(fields))
            }
        }
        deserializer.deserialize_map(InOrder)
    }
}

impl Schema {
    /// The output schema of a tool's entry.
    pub fn output_of(entry: &str) -> Schema {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Listed {
            output_schema: Schema,
        }
        serde_json::from_str::<Listed>(entry).map(|l| l.output_schema).unwrap_or_default()
    }

    /// The schema of one field of an object schema.
    pub fn field(&self, name: &str) -> Option<&Schema> {
        self.properties.as_ref()?.0.iter().find(|(key, _)| key == name).map(|(_, schema)| schema)
    }

    /// The schema a `$ref` names, read down from this one as the root.
    fn at(&self, pointer: &str) -> Option<&Schema> {
        let mut steps = pointer.strip_prefix("#")?.split('/').skip(1);
        let mut at = self;
        while let Some(step) = steps.next() {
            at = match step {
                "properties" => at.field(steps.next()?)?,
                "items" => at.items.as_deref()?,
                "anyOf" => at.any_of.as_ref()?.get(steps.next()?.parse::<usize>().ok()?)?,
                "additionalProperties" => match at.additional_properties.as_ref()? {
                    Additional::Each(each) => each,
                    Additional::Allowed(_) => return None,
                },
                _ => return None,
            };
        }
        Some(at)
    }
}

/// `schema.parse(value)` as zod gives it back, in compact JSON; `root` is the schema a `$ref` points into.
pub fn parsed(schema: &Schema, root: &Schema, value: &RawValue) -> Option<Box<RawValue>> {
    RawValue::from_string(parse(schema, root, value)?).ok()
}

fn parse(schema: &Schema, root: &Schema, value: &RawValue) -> Option<String> {
    if let Some(pointer) = &schema.reference {
        return parse(root.at(pointer)?, root, value);
    }
    if let Some(branches) = &schema.any_of {
        return branches.iter().find_map(|branch| parse(branch, root, value));
    }
    let text = value.get();
    let kinds: Vec<&str> = match &schema.kind {
        Some(Kinds::One(one)) => vec![one.as_str()],
        Some(Kinds::Several(several)) => several.iter().map(String::as_str).collect(),
        None => return Some(text.to_owned()),
    };
    let kind = kind_of(text);
    if !kinds.iter().any(|k| *k == kind || (*k == "integer" && kind == "number")) {
        return None;
    }
    let listed = |given: &Value| schema.words.as_ref().is_none_or(|w| w.contains(given)) && schema.only.as_ref().is_none_or(|c| c == given);
    match kind {
        "object" => object(schema, root, value),
        "array" => array(schema, root, value),
        "string" | "boolean" => listed(&serde_json::from_str(text).ok()?).then(|| text.to_owned()),
        "number" => number(schema, &kinds, text).then(|| text.to_owned()),
        _ => Some(text.to_owned()),
    }
}

fn kind_of(text: &str) -> &'static str {
    match text.trim_start().as_bytes().first() {
        Some(b'{') => "object",
        Some(b'[') => "array",
        Some(b'"') => "string",
        Some(b't' | b'f') => "boolean",
        Some(b'n') => "null",
        _ => "number",
    }
}

fn number(schema: &Schema, kinds: &[&str], text: &str) -> bool {
    let Ok(n) = text.parse::<f64>() else { return false };
    let integer_only = !kinds.contains(&"number");
    !(integer_only && n.fract() != 0.0)
        && schema.minimum.is_none_or(|b| n >= b)
        && schema.maximum.is_none_or(|b| n <= b)
        && schema.exclusive_minimum.is_none_or(|b| n > b)
        && schema.exclusive_maximum.is_none_or(|b| n < b)
}

fn object(schema: &Schema, root: &Schema, value: &RawValue) -> Option<String> {
    let fields: Ordered = serde_json::from_str(value.get()).ok()?;
    let mut out = Vec::new();
    if let Some(properties) = &schema.properties {
        for (key, field) in &properties.0 {
            match fields.get(key) {
                Some(given) => out.push((key.as_str(), parse(field, root, given)?)),
                None if schema.required.contains(key) => return None,
                None => {}
            }
        }
    } else if let Some(Additional::Each(each)) = &schema.additional_properties {
        for (key, given) in &fields.0 {
            out.push((key.as_str(), parse(each, root, given)?));
        }
    } else {
        return Some(value.get().to_owned());
    }
    let written: Vec<String> = out.into_iter().map(|(key, v)| format!("{}:{v}", serde_json::to_string(key).unwrap_or_default())).collect();
    Some(format!("{{{}}}", written.join(",")))
}

fn array(schema: &Schema, root: &Schema, value: &RawValue) -> Option<String> {
    let items: Vec<Box<RawValue>> = serde_json::from_str(value.get()).ok()?;
    if schema.min_items.is_some_and(|b| items.len() < b) || schema.max_items.is_some_and(|b| items.len() > b) {
        return None;
    }
    let parsed: Option<Vec<String>> = items
        .iter()
        .map(|item| schema.items.as_deref().map_or_else(|| Some(item.get().to_owned()), |each| parse(each, root, item)))
        .collect();
    Some(format!("[{}]", parsed?.join(",")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(schema: &str, value: &str) -> Option<String> {
        let schema: Schema = serde_json::from_str(schema).unwrap();
        let raw = RawValue::from_string(value.to_owned()).unwrap();
        parsed(&schema, &schema, &raw).map(|p| p.get().to_owned())
    }

    #[test]
    fn an_object_takes_the_schemas_order_and_drops_what_it_does_not_name() {
        let schema = r#"{ "type": "object", "properties": { "b": { "type": "number" }, "a": { "type": "string", "enum": ["x"] }, "c": { "type": "boolean" } }, "required": ["a"], "additionalProperties": false }"#;
        assert_eq!(run(schema, r#"{"z":1,"a":"x","b":1.50}"#).as_deref(), Some(r#"{"b":1.50,"a":"x"}"#));
        assert_eq!(run(schema, r#"{"a":"y"}"#), None);
        assert_eq!(run(schema, r#"{"b":1}"#), None);
    }

    #[test]
    fn a_union_is_its_first_branch_that_parses_and_a_ref_reads_the_root() {
        let schema = r##"{ "type": "object", "properties": {
            "t": { "anyOf": [{ "type": "object", "properties": { "p": { "type": "string" } }, "required": ["p"], "additionalProperties": false }, { "type": "object", "properties": { "w": { "type": "string" } }, "required": ["w"], "additionalProperties": false }] },
            "k": { "type": "object", "additionalProperties": { "type": "boolean" } },
            "again": { "$ref": "#/properties/k" },
            "n": { "anyOf": [{ "type": "integer", "minimum": 0 }, { "type": "null" }] }
        }, "additionalProperties": false }"##;
        assert_eq!(
            run(schema, r#"{"n":null,"again":{"2":true},"k":{"b":true,"a":false},"t":{"w":"x","p":3}}"#).as_deref(),
            Some(r#"{"t":{"w":"x"},"k":{"b":true,"a":false},"again":{"2":true},"n":null}"#)
        );
        assert_eq!(run(schema, r#"{"n":1.5}"#), None);
    }
}
