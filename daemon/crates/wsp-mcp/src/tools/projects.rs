// SPDX-License-Identifier: AGPL-3.0-only
//! `projects`: every project this host holds, as the host listed them.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Map;

use super::{input, Answer, Refused, Tool};
use crate::host::Host;

const NAME: &str = "projects";

pub const TOOL: Tool =
    Tool { name: NAME, listed: include_str!("../../record/tools/projects.json"), call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Out {
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub projects: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Projects {
    projects: Vec<Box<RawValue>>,
}

async fn call(host: std::sync::Arc<Host>, arguments: serde_json::Value) -> Result<Answer, Refused> {
    let In {} = input(NAME, arguments)?;
    let client = host.client().await?;
    let listed = client.request::<Projects>("projects.list", Map::new()).await?;
    Ok(Answer::json(&Out { projects: listed.projects }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
    }
}
