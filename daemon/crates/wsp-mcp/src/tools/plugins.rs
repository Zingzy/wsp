// SPDX-License-Identifier: AGPL-3.0-only
//! `plugins_disable` and `plugins_enable`: one agent's plugin turned off or on on one computer or where a thread runs,
//! answering its row as the TypeScript tool's parse leaves it, and a line saying what its next turn does.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::target::{self, agent_name};
use super::{entry_in, input, Answer, Refused, Tool};
use crate::host::Host;
use crate::record::{self, fill};
use crate::zod::{self, Schema};

const DISABLE_LISTED: &str = include_str!(concat!(env!("OUT_DIR"), "/record/tools/plugins_disable.json"));
const ENABLE_LISTED: &str = include_str!(concat!(env!("OUT_DIR"), "/record/tools/plugins_enable.json"));

pub const DISABLE: Tool =
    Tool { name: "plugins_disable", listed: DISABLE_LISTED, call: |host, args| Box::pin(toggle(host, args, "plugins_disable", false)) };
pub const ENABLE: Tool =
    Tool { name: "plugins_enable", listed: ENABLE_LISTED, call: |host, args| Box::pin(toggle(host, args, "plugins_enable", true)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ToggleIn {
    pub plugin: String,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ToggleOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub plugin: Box<RawValue>,
}

#[derive(Deserialize)]
struct Reply {
    plugin: Option<Box<RawValue>>,
}

/// What the line reads off the row.
#[derive(Deserialize)]
struct Row {
    id: String,
    agent: String,
    on: bool,
}

async fn toggle(host: Arc<Host>, arguments: Value, tool: &'static str, turn_on: bool) -> Result<Answer, Refused> {
    let ToggleIn { plugin, agent, thread, on } = input(tool, arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let usage = target::usage(&words, tool);
    let aimed = target::target(&client, &words, thread.as_deref(), on.as_deref(), &usage, None, tool, host.cloud()).await?;
    let mut turning = Map::new();
    turning.insert("target".to_owned(), aimed);
    turning.insert("agent".to_owned(), Value::from(agent));
    turning.insert("plugin".to_owned(), Value::from(plugin));
    turning.insert("on".to_owned(), Value::Bool(turn_on));
    let reply: Reply = client.request("plugins.toggle", turning).await?;
    let listed = if turn_on { ENABLE_LISTED } else { DISABLE_LISTED };
    let root = Schema::output_of(entry_in(listed, host.cloud()).unwrap_or_default());
    let row =
        reply.plugin.and_then(|given| zod::parsed(root.field("plugin")?, &root, &given)).ok_or_else(|| super::agents::unread(tool))?;
    let read: Row = serde_json::from_str(row.get()).map_err(|_| super::agents::unread(tool))?;
    let line = fill(
        if read.on { &words.plugin_turned_on } else { &words.plugin_turned_off },
        &[("id", &read.id), ("agent", &agent_name(&words, &read.agent))],
    );
    Ok(Answer::text(line, &ToggleOut { plugin: row }))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<ToggleIn, ToggleOut>(DISABLE.listed);
        to_the_record::<ToggleIn, ToggleOut>(ENABLE.listed);
    }
}
