// SPDX-License-Identifier: AGPL-3.0-only
//! A call's arguments held to the tool's recorded input schema before the tool runs, each issue worded as zod words
//! it on the TypeScript server, where the SDK refuses the call the same way: in the schema's field order, one line an
//! issue, each ending ` at <path>`. Only the keywords the tools' inputs use are read; a test holds every recorded
//! entry to that set, and tests/refusals.json holds the words to what the TypeScript server answered.

use std::fmt;

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Number, Value};

/// The part of a JSON Schema this reads. `properties` keeps the order the entry lists the fields in, which is the
/// order zod meets them and so the order of its issues.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    #[serde(default, rename = "type")]
    kind: Option<Kind>,
    #[serde(default)]
    properties: Fields,
    #[serde(default)]
    required: Vec<String>,
    #[serde(default)]
    items: Option<Box<Schema>>,
    #[serde(default)]
    min_items: Option<u64>,
    #[serde(default, rename = "enum")]
    words: Option<Vec<String>>,
    #[serde(default)]
    minimum: Option<Number>,
    #[serde(default)]
    exclusive_minimum: Option<Number>,
    #[serde(default)]
    maximum: Option<Number>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Kind {
    One(String),
    Either(Vec<String>),
}

#[derive(Default)]
struct Fields(Vec<(String, Schema)>);

impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct InOrder;
        impl<'de> Visitor<'de> for InOrder {
            type Value = Fields;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a map of fields")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Fields, A::Error> {
                let mut fields = Vec::new();
                while let Some(field) = map.next_entry::<String, Schema>()? {
                    fields.push(field);
                }
                Ok(Fields(fields))
            }
        }
        deserializer.deserialize_map(InOrder)
    }
}

enum Step<'a> {
    Key(&'a str),
    Index(usize),
}

/// A tool's entry's input schema, read once per call.
pub fn input_schema(listed: &str) -> Schema {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Listed {
        input_schema: Schema,
    }
    serde_json::from_str::<Listed>(listed).map(|l| l.input_schema).unwrap_or_default()
}

/// Every issue with these arguments, in the order zod finds them; none when the tool takes them.
pub fn issues(schema: &Schema, arguments: &Value) -> Vec<String> {
    let mut said = Vec::new();
    check(schema, arguments, &mut Vec::new(), &mut said);
    said
}

fn check<'a>(schema: &'a Schema, value: &'a Value, path: &mut Vec<Step<'a>>, said: &mut Vec<String>) {
    let mut say = |line: String, path: &[Step]| said.push(if path.is_empty() { line } else { format!("{line} at {}", dotted(path)) });
    if let Some(words) = &schema.words {
        let options = words.iter().map(|w| format!("'{w}'")).collect::<Vec<_>>().join(" | ");
        match value.as_str() {
            None => say(format!("Expected {options}, received {}", kind(value)), path),
            Some(word) if !words.iter().any(|w| w == word) => {
                say(format!("Invalid enum value. Expected {options}, received '{word}'"), path)
            }
            Some(_) => {}
        }
        return;
    }
    let t = match &schema.kind {
        Some(Kind::Either(either)) => {
            if !either.iter().any(|t| takes(t, value)) {
                say("Invalid input".to_owned(), path);
            }
            return;
        }
        Some(Kind::One(t)) => t.as_str(),
        None => return,
    };
    match t {
        "string" | "boolean" if !takes(t, value) => say(format!("Expected {t}, received {}", kind(value)), path),
        "integer" | "number" => {
            let Some(n) = value.as_f64() else { return say(format!("Expected number, received {}", kind(value)), path) };
            if t == "integer" && n.fract() != 0.0 {
                say("Expected integer, received float".to_owned(), path);
            }
            if let Some(least) = beyond(&schema.minimum, |n, b| n < b, n) {
                say(format!("Number must be greater than or equal to {least}"), path);
            }
            if let Some(above) = beyond(&schema.exclusive_minimum, |n, b| n <= b, n) {
                say(format!("Number must be greater than {above}"), path);
            }
            if let Some(most) = beyond(&schema.maximum, |n, b| n > b, n) {
                say(format!("Number must be less than or equal to {most}"), path);
            }
        }
        "array" => {
            let Some(items) = value.as_array() else { return say(format!("Expected array, received {}", kind(value)), path) };
            if let Some(least) = schema.min_items.filter(|least| (items.len() as u64) < *least) {
                say(format!("Array must contain at least {least} element(s)"), path);
            }
            if let Some(each) = &schema.items {
                for (at, item) in items.iter().enumerate() {
                    path.push(Step::Index(at));
                    check(each, item, path, said);
                    path.pop();
                }
            }
        }
        "object" => {
            let Some(given) = value.as_object() else { return say(format!("Expected object, received {}", kind(value)), path) };
            for (name, field) in &schema.properties.0 {
                path.push(Step::Key(name));
                match given.get(name) {
                    Some(value) => check(field, value, path, said),
                    None if schema.required.contains(name) => said.push(format!("Required at {}", dotted(path))),
                    None => {}
                }
                path.pop();
            }
        }
        _ => {}
    }
}

/// The bound a number is past, by the comparison that bound makes.
fn beyond(bound: &Option<Number>, past: fn(f64, f64) -> bool, n: f64) -> Option<&Number> {
    bound.as_ref().filter(|b| b.as_f64().is_some_and(|b| past(n, b)))
}

fn takes(t: &str, value: &Value) -> bool {
    match t {
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "integer" => value.as_f64().is_some_and(|n| n.fract() == 0.0),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => false,
    }
}

/// What zod calls the type it was given.
fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// A path as the SDK prints it: the first key bare, each later key after a dot, each index in brackets.
fn dotted(path: &[Step]) -> String {
    let mut out = String::new();
    for step in path {
        match step {
            Step::Key(key) if out.is_empty() => out.push_str(key),
            Step::Key(key) => {
                out.push('.');
                out.push_str(key);
            }
            Step::Index(at) => out.push_str(&format!("[{at}]")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde::Deserialize;

    use super::*;
    use crate::tools::input_refusal;

    /// The keywords this reads, and the ones it may pass over because they say nothing about what is taken.
    const READ: &[&str] = &["type", "properties", "required", "items", "minItems", "enum", "minimum", "maximum", "exclusiveMinimum"];
    const PASSED_OVER: &[&str] = &["$schema", "description", "additionalProperties"];

    fn crate_file(rel: &str) -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)).unwrap()
    }

    #[derive(Deserialize)]
    struct Refusal {
        tool: String,
        arguments: Value,
        text: String,
    }

    #[test]
    fn every_recorded_refusal_is_worded_as_the_typescript_server_worded_it() {
        let recorded: Vec<Refusal> = serde_json::from_str(&crate_file("tests/refusals.json")).unwrap();
        assert!(!recorded.is_empty());
        for refusal in recorded {
            // Recorded with the cloud off, which is the state the suite runs the TypeScript server in.
            let listed = crate_file(&format!("record/tools/{}.json", refusal.tool));
            let said = issues(&input_schema(crate::tools::entry_in(&listed, false).unwrap()), &refusal.arguments);
            assert_eq!(input_refusal(&refusal.tool, &said.join("\n")), refusal.text, "{} {}", refusal.tool, refusal.arguments);
        }
    }

    fn keywords<'a>(schema: &'a Value, into: &mut Vec<&'a str>) {
        let Some(fields) = schema.as_object() else { return };
        for (key, value) in fields {
            into.push(key);
            match key.as_str() {
                "properties" => value.as_object().into_iter().flatten().for_each(|(_, field)| keywords(field, into)),
                "items" => keywords(value, into),
                _ => {}
            }
        }
    }

    #[test]
    fn every_recorded_input_schema_uses_only_the_keywords_this_reads() {
        for file in std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("record/tools")).unwrap() {
            let listed: Value = serde_json::from_str(&std::fs::read_to_string(file.unwrap().path()).unwrap()).unwrap();
            for entry in [&listed["cloudOff"], &listed["cloudOn"]].into_iter().filter(|entry| !entry.is_null()) {
                let mut used = Vec::new();
                keywords(&entry["inputSchema"], &mut used);
                for keyword in used {
                    assert!(
                        READ.contains(&keyword) || PASSED_OVER.contains(&keyword),
                        "{}: {keyword} is not read; add it with a refusal it words",
                        entry["name"]
                    );
                }
            }
        }
    }
}
