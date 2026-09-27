// SPDX-License-Identifier: AGPL-3.0-only
//! `computers`: every computer this host holds and what each cloud spent today, two reads answered as one value.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Map;

use super::{input, Answer, Refused, Tool};
use crate::host::Host;

const NAME: &str = "computers";

pub const TOOL: Tool =
    Tool { name: NAME, listed: include_str!("../../record/tools/computers.json"), call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {}

/// The rows pass through in the bytes the host wrote them, which is what keeps the text byte for byte.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Out {
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub computers: Vec<Box<RawValue>>,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub spend: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Places {
    places: Vec<Box<RawValue>>,
}

async fn call(host: std::sync::Arc<Host>, arguments: serde_json::Value) -> Result<Answer, Refused> {
    let In {} = input(NAME, arguments)?;
    let client = host.client().await?;
    let (listed, spent) =
        tokio::try_join!(client.request::<Places>("places.list", Map::new()), client.request::<Places>("cost.spend", Map::new()))?;
    Ok(Answer::json(&Out { computers: listed.places, spend: spent.places }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
    }
}
