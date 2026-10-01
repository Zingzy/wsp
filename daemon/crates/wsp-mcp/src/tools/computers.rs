// SPDX-License-Identifier: AGPL-3.0-only
//! `computers`: every computer this host holds and what each cloud spent today, two reads answered as one value;
//! `computers_set`: what the person sets on one of them, answered as its row.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Number, Value};

use super::target::place_id;
use super::{input, Answer, Refused, Tool};
use crate::host::Host;
use crate::record;

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

const SET_NAME: &str = "computers_set";

pub const SET: Tool =
    Tool { name: SET_NAME, listed: include_str!("../../record/tools/computers_set.json"), call: |host, args| Box::pin(set(host, args)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SetIn {
    pub computer: String,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub threads: Option<Number>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub machines: Option<Number>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub spend: Option<Number>,
    #[serde(default)]
    pub reset: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SetOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub computer: Box<RawValue>,
}

#[derive(Deserialize)]
struct Placed {
    place: Box<RawValue>,
}

async fn set(host: std::sync::Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let SetIn { computer, threads, machines, spend, reset } = input(SET_NAME, arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let mut frame = Map::new();
    frame.insert("placeId".to_owned(), Value::from(place_id(&client, &words, &computer).await?));
    for (key, value) in [("threads", threads), ("machines", machines), ("spendPerDayUsd", spend)] {
        if let Some(n) = value {
            frame.insert(key.to_owned(), Value::Number(n));
        }
    }
    if let Some(reset) = reset.filter(|r| !r.is_empty()) {
        frame.insert("reset".to_owned(), Value::from(reset));
    }
    let Placed { place } = client.request("places.set", frame).await?;
    Ok(Answer::json(&SetOut { computer: place }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
        super::super::held::to_the_record::<super::SetIn, super::SetOut>(super::SET.listed);
    }
}
