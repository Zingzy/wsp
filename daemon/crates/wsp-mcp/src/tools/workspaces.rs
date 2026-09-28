// SPDX-License-Identifier: AGPL-3.0-only
//! `workspaces`: every workspace with its state as the sidebar reads it, the host's status rows as they came.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Map;

use super::{input, Answer, Refused, Tool};
use crate::host::Host;

const NAME: &str = "workspaces";

pub const TOOL: Tool =
    Tool { name: NAME, listed: include_str!("../../record/tools/workspaces.json"), call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Out {
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub workspaces: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Statuses {
    statuses: Vec<Box<RawValue>>,
}

async fn call(host: std::sync::Arc<Host>, arguments: serde_json::Value) -> Result<Answer, Refused> {
    let In {} = input(NAME, arguments)?;
    let client = host.client().await?;
    let listed = client.request::<Statuses>("status.list", Map::new()).await?;
    Ok(Answer::json(&Out { workspaces: listed.statuses }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
    }
}
