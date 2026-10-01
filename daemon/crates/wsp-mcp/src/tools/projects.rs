// SPDX-License-Identifier: AGPL-3.0-only
//! `projects`: every project this host holds, as the host listed them.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Map;

use super::{entry_in, input, Answer, Refused, Tool};
use crate::host::Host;
use crate::zod::{self, Schema};

const NAME: &str = "projects";

const LISTED: &str = include_str!("../../record/tools/projects.json");

pub const TOOL: Tool = Tool { name: NAME, listed: LISTED, call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Out {
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub projects: Vec<Box<RawValue>>,
    #[cfg_attr(test, schemars(with = "std::collections::BTreeMap<String, serde_json::Value>"))]
    pub defaults: Box<RawValue>,
}

#[derive(Deserialize)]
struct Projects {
    projects: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Defaults {
    defaults: Option<Box<RawValue>>,
}

async fn call(host: std::sync::Arc<Host>, arguments: serde_json::Value) -> Result<Answer, Refused> {
    let In {} = input(NAME, arguments)?;
    let client = host.client().await?;
    let listed = client.request::<Projects>("projects.list", Map::new()).await?;
    // What a new thread on each starts on, as the TypeScript tool's zod parse leaves it: each value in its order.
    let asked = client.request::<Defaults>("projects.defaults", Map::new()).await?;
    let root = Schema::output_of(entry_in(LISTED, host.cloud()).unwrap_or_default());
    let defaults =
        asked.defaults.and_then(|given| zod::parsed(root.field("defaults")?, &root, &given)).ok_or_else(|| super::agents::unread(NAME))?;
    Ok(Answer::json(&Out { projects: listed.projects, defaults }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
    }
}
