// SPDX-License-Identifier: AGPL-3.0-only
//! `usage`: what each agent account may still use and what was used over a range, two reads answered as one value
//! and never added together.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::{input, Answer, Refused, Tool};
use crate::host::Host;

const NAME: &str = "usage";

pub const TOOL: Tool =
    Tool { name: NAME, listed: include_str!("../../record/tools/usage.json"), call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

/// Both answers pass through in the bytes the host wrote them, which is what keeps the text byte for byte.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Out {
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub accounts: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub used: Box<RawValue>,
}

#[derive(Deserialize)]
struct Accounts {
    accounts: Box<RawValue>,
}

#[derive(Deserialize)]
struct Used {
    used: Box<RawValue>,
}

async fn call(host: std::sync::Arc<Host>, arguments: serde_json::Value) -> Result<Answer, Refused> {
    let In { range, by } = input(NAME, arguments)?;
    let client = host.client().await?;
    let mut asked = Map::new();
    asked.insert("range".to_owned(), Value::from(range.unwrap_or_else(|| "day".to_owned())));
    asked.insert("split".to_owned(), Value::from(by.unwrap_or_else(|| "agent".to_owned())));
    let (accounts, used) =
        tokio::try_join!(client.request::<Accounts>("usage.accounts", Map::new()), client.request::<Used>("usage.used", asked))?;
    Ok(Answer::json(&Out { accounts: accounts.accounts, used: used.used }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
    }
}
