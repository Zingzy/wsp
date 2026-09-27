// SPDX-License-Identifier: AGPL-3.0-only
//! Every tool this server serves: its entry as the TypeScript server lists it, recorded under record/tools, and the
//! call that answers it through the host. CONTRIBUTING.md in this crate says how one is added.

mod computers;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::failure::Failure;
use crate::host::Host;
use crate::json::js_line;

pub struct Tool {
    pub name: &'static str,
    /// The entry tools/list serves, as the TypeScript server lists it: name, description, both schemas.
    pub listed: &'static str,
    pub call: fn(Arc<Host>, Value) -> Call,
}

pub type Call = Pin<Box<dyn Future<Output = Result<Answer, Refused>> + Send>>;

pub const TOOLS: &[Tool] = &[computers::TOOL];

pub fn named(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|tool| tool.name == name)
}

/// What a tool answers with: the text the agent reads and the same value as the structured copy, compact JSON.
pub struct Answer {
    pub text: String,
    pub structured: String,
}

impl Answer {
    /// The text is the value as `jsonLine(value, 2)` writes it: asJson in packages/host/src/verbs.ts.
    pub fn json<T: Serialize>(value: &T) -> Answer {
        Answer { text: js_line(value, true), structured: serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()) }
    }

    /// The text is a line of its own and the value rides beside it: asText in packages/host/src/verbs.ts.
    #[allow(dead_code)]
    pub fn text<T: Serialize>(text: String, value: &T) -> Answer {
        Answer { text, structured: serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()) }
    }
}

/// Why a call answers no value: arguments its input does not take, which the SDK refuses before a tool runs, or the
/// failure the tool met, which is the contract's failure object.
pub enum Refused {
    Input(String),
    Failed(Failure),
}

impl From<Failure> for Refused {
    fn from(failure: Failure) -> Self {
        Refused::Failed(failure)
    }
}

/// The SDK's own words for a call it refused before the tool ran.
pub fn input_refusal(tool: &str, why: &str) -> String {
    format!("MCP error -32602: Input validation error: Invalid arguments for tool {tool}: {why}")
}

/// A tool's arguments read as its input.
pub fn input<T: DeserializeOwned>(tool: &str, arguments: Value) -> Result<T, Refused> {
    serde_json::from_value(arguments).map_err(|e| Refused::Input(input_refusal(tool, &e.to_string())))
}

#[cfg(test)]
pub(crate) mod held {
    //! A tool's input and output structs held to the schemas its recorded entry lists: the same fields, the same ones
    //! required, and the same type wherever the struct types a field rather than passing a view through.

    use schemars::generate::SchemaSettings;
    use schemars::JsonSchema;
    use serde_json::Value;

    fn schema_of<T: JsonSchema>() -> Value {
        SchemaSettings::draft07().into_generator().into_root_schema_for::<T>().to_value()
    }

    fn fields(schema: &Value) -> Vec<(String, Value)> {
        let mut fields: Vec<(String, Value)> =
            schema["properties"].as_object().map(|p| p.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
        fields.sort_by(|a, b| a.0.cmp(&b.0));
        fields
    }

    fn required(schema: &Value) -> Vec<String> {
        let mut required: Vec<String> =
            schema["required"].as_array().map(|r| r.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        required.sort();
        required
    }

    fn same_shape(side: &str, derived: &Value, listed: &Value) {
        let (ours, theirs) = (fields(derived), fields(listed));
        let names = |f: &[(String, Value)]| f.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>();
        assert_eq!(names(&ours), names(&theirs), "{side}: the fields");
        assert_eq!(required(derived), required(listed), "{side}: the fields required");
        for ((name, ours), (_, theirs)) in ours.iter().zip(&theirs) {
            if ours.get("type").is_some() {
                assert_eq!(ours["type"], theirs["type"], "{side}.{name}: the type");
            }
        }
    }

    pub fn to_the_record<In: JsonSchema, Out: JsonSchema>(listed: &str) {
        let listed: Value = serde_json::from_str(listed).unwrap();
        same_shape("input", &schema_of::<In>(), &listed["inputSchema"]);
        same_shape("output", &schema_of::<Out>(), &listed["outputSchema"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_its_recorded_entry_under_its_own_name() {
        for tool in TOOLS {
            let listed: Value = serde_json::from_str(tool.listed).unwrap();
            assert_eq!(listed["name"], tool.name);
        }
    }
}
