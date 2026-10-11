// SPDX-License-Identifier: AGPL-3.0-only
//! `conversations`: the conversations the agents kept in a project's folder outside wsp, as the host listed them.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::{entry_in, input, Answer, Refused, Tool};
use crate::host::Host;
use crate::zod::{self, Schema};

const NAME: &str = "conversations";

const LISTED: &str = include_str!(concat!(env!("OUT_DIR"), "/record/tools/conversations.json"));

pub const TOOL: Tool = Tool { name: NAME, listed: LISTED, call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Out {
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub rows: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub held: Box<RawValue>,
}

#[derive(Deserialize)]
struct Listed {
    rows: Option<Box<RawValue>>,
    held: Option<Box<RawValue>>,
}

async fn call(host: std::sync::Arc<Host>, arguments: serde_json::Value) -> Result<Answer, Refused> {
    let In { project, agent } = input(NAME, arguments)?;
    let client = host.client().await?;
    let mut asked = Map::new();
    if let Some(project) = project {
        asked.insert("project".to_owned(), Value::from(project));
    }
    if let Some(agent) = agent {
        asked.insert("agent".to_owned(), Value::from(agent));
    }
    let listed = client.request::<Listed>("conversations.list", asked).await?;
    // Each row and line as the TypeScript tool's zod parse leaves it: the schema's keys in its order.
    let root = Schema::output_of(entry_in(LISTED, host.cloud()).unwrap_or_default());
    let parse = |field: &str, given: Option<Box<RawValue>>| given.and_then(|given| zod::parsed(root.field(field)?, &root, &given));
    let rows = parse("rows", listed.rows).ok_or_else(|| super::agents::unread(NAME))?;
    let held = parse("held", listed.held).ok_or_else(|| super::agents::unread(NAME))?;
    Ok(Answer::json(&Out { rows, held }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
    }
}
