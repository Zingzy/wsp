// SPDX-License-Identifier: AGPL-3.0-only
//! `setup`: the cloud setup as the app's modal reads it, parsed as the TypeScript tool parses it before it answers.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Map;

use super::agents::unread;
use super::{entry_in, input, Answer, Refused, Tool};
use crate::host::Host;
use crate::zod::{self, Schema};

const NAME: &str = "setup";

const LISTED: &str = include_str!("../../record/tools/setup.json");

pub const TOOL: Tool = Tool { name: NAME, listed: LISTED, call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Out {
    #[cfg_attr(test, schemars(with = "serde_json::Map<String, serde_json::Value>"))]
    pub setup: Box<RawValue>,
}

#[derive(Deserialize)]
struct Setup {
    setup: Option<Box<RawValue>>,
}

async fn call(host: std::sync::Arc<Host>, arguments: serde_json::Value) -> Result<Answer, Refused> {
    let In {} = input(NAME, arguments)?;
    let client = host.client().await?;
    let reply = client.request::<Setup>("init.get", Map::new()).await?;
    let root = Schema::output_of(entry_in(LISTED, host.cloud()).unwrap_or_default());
    let setup = reply.setup.and_then(|given| zod::parsed(root.field("setup")?, &root, &given)).ok_or_else(|| unread(NAME))?;
    Ok(Answer::json(&Out { setup }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
    }
}
