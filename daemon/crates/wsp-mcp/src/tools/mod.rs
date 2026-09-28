// SPDX-License-Identifier: AGPL-3.0-only
//! Every tool this server serves: its entry as the TypeScript server lists it, recorded under record/tools, and the
//! call that answers it through the host. CONTRIBUTING.md in this crate says how one is added.

mod computers;
mod create;
mod dropping;
mod exec;
mod home;
mod image;
mod machine;
mod named;
mod projects_change;
mod recipe;
mod said;
mod servers;
mod skills;
mod target;
mod thread;
mod turn;
mod wait;
pub(crate) mod workspace;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

use crate::failure::Failure;
use crate::host::Host;
use crate::json::js_line;

pub struct Tool {
    pub name: &'static str,
    /// The entries tools/list serves, as the TypeScript server lists them with WSP_CLOUD off and on: name,
    /// description, both schemas, and null in a state that lists no such tool.
    pub listed: &'static str,
    pub call: fn(Arc<Host>, Value) -> Call,
}

pub type Call = Pin<Box<dyn Future<Output = Result<Answer, Refused>> + Send>>;

pub const TOOLS: &[Tool] = &[
    computers::TOOL,
    skills::SEARCH,
    skills::SHOW,
    skills::ADD,
    skills::REMOVE,
    skills::DISABLE,
    skills::ENABLE,
    servers::TOOLS,
    servers::ADD,
    servers::REMOVE,
    servers::DISABLE,
    servers::ENABLE,
    servers::ADD_TOOLS,
    turn::RUN,
    turn::SEND,
    thread::RENAME,
    thread::FORGET,
    thread::ALLOW,
    thread::DENY,
    wait::WAIT,
    wait::RESTART,
    thread::STOP,
    exec::TOOL,
    recipe::RECIPE,
    recipe::SCAN,
    computers::TOOL,
    projects_change::ADD,
    projects_change::REMOVE,
    create::NEW,
    machine::AGENTS,
    machine::RENAME,
    machine::SNAPSHOT,
    create::FORK,
    home::BRING_BACK,
    machine::PAUSE,
    machine::WAKE,
    machine::REBUILD,
    image::IMAGE,
    image::BUILD,
    image::MOVE,
    image::REMOVE,
    dropping::FORGET,
    dropping::DELETE,
    home::EXPORT,
];

/// The tool of that name the state lists, with its entry there; none where that state lists no such tool, which the
/// TypeScript server does not register.
pub fn named(name: &str, cloud: bool) -> Option<(&'static Tool, &'static str)> {
    TOOLS.iter().filter(|tool| tool.name == name).find_map(|tool| Some((tool, entry_in(tool.listed, cloud)?)))
}

/// Every tool the state lists, by its entry there.
pub fn listed(cloud: bool) -> impl Iterator<Item = &'static str> {
    TOOLS.iter().filter_map(move |tool| entry_in(tool.listed, cloud))
}

/// A recorded file's entry for one state of WSP_CLOUD, in the bytes it was recorded in.
pub fn entry_in(listed: &str, cloud: bool) -> Option<&str> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entries<'a> {
        #[serde(borrow)]
        cloud_off: Option<&'a RawValue>,
        #[serde(borrow)]
        cloud_on: Option<&'a RawValue>,
    }
    let entries: Entries = serde_json::from_str(listed).ok()?;
    (if cloud { entries.cloud_on } else { entries.cloud_off }).map(RawValue::get)
}

/// What a tool answers with: the text the agent reads and the same value as the structured copy, compact JSON, and
/// whether the call is marked an error while still carrying that value.
pub struct Answer {
    pub text: String,
    pub structured: String,
    pub error: bool,
}

impl Answer {
    /// The text is the value as `jsonLine(value, 2)` writes it: asJson in packages/host/src/verbs.ts.
    pub fn json<T: Serialize>(value: &T) -> Answer {
        Answer { text: js_line(value, true), structured: serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()), error: false }
    }

    /// The text is a line of its own and the value rides beside it: asText in packages/host/src/verbs.ts.
    pub fn text<T: Serialize>(text: String, value: &T) -> Answer {
        Answer { text, structured: serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()), error: false }
    }

    /// The same, marked an error: a call that did nothing yet, or half of what it was asked, and says which.
    pub fn text_error<T: Serialize>(text: String, value: &T) -> Answer {
        Answer { error: true, ..Answer::text(text, value) }
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

    /// An `Option` field's type less the null schemars adds: a field the input may leave out is zod's optional,
    /// which takes no null.
    fn unnulled(typed: &Value, optional: bool) -> Value {
        match typed.as_array() {
            Some(types) if optional => {
                let kept: Vec<&Value> = types.iter().filter(|t| *t != "null").collect();
                if kept.len() == 1 {
                    kept[0].clone()
                } else {
                    Value::from(kept.into_iter().cloned().collect::<Vec<_>>())
                }
            }
            _ => typed.clone(),
        }
    }

    /// The struct's fields are every field some state lists, since a state that leaves one out is never handed it;
    /// each state's required set and each field's type hold as that state lists them.
    fn same_shape(side: &str, derived: &Value, listed: &[&Value]) {
        let ours = fields(derived);
        let mut theirs: Vec<String> = listed.iter().flat_map(|l| fields(l).into_iter().map(|(k, _)| k)).collect();
        theirs.sort();
        theirs.dedup();
        assert_eq!(ours.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(), theirs, "{side}: the fields");
        let optional = |name: &str| !required(derived).iter().any(|r| r == name);
        for listed in listed {
            assert_eq!(required(derived), required(listed), "{side}: the fields required");
            for (name, theirs) in fields(listed) {
                let ours = &ours.iter().find(|(k, _)| *k == name).unwrap().1;
                if let Some(typed) = ours.get("type") {
                    assert_eq!(&unnulled(typed, optional(&name)), &theirs["type"], "{side}.{name}: the type");
                }
            }
        }
    }

    /// Held to the entry of every state that lists the tool.
    pub fn to_the_record<In: JsonSchema, Out: JsonSchema>(listed: &str) {
        let entries: Vec<Value> = [false, true]
            .into_iter()
            .filter_map(|cloud| super::entry_in(listed, cloud))
            .map(|e| serde_json::from_str(e).unwrap())
            .collect();
        same_shape("input", &schema_of::<In>(), &entries.iter().map(|e| &e["inputSchema"]).collect::<Vec<_>>());
        same_shape("output", &schema_of::<Out>(), &entries.iter().map(|e| &e["outputSchema"]).collect::<Vec<_>>());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_its_recorded_entry_under_its_own_name() {
        for tool in TOOLS {
            let entries: Vec<&str> = [false, true].into_iter().filter_map(|cloud| entry_in(tool.listed, cloud)).collect();
            assert!(!entries.is_empty(), "{} is listed in neither state", tool.name);
            for entry in entries {
                assert_eq!(serde_json::from_str::<Value>(entry).unwrap()["name"], tool.name);
            }
        }
    }
}
