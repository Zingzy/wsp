// SPDX-License-Identifier: AGPL-3.0-only
//! `computers`: every computer this host holds, every add not yet set up, and what each cloud spent today, two reads
//! answered as one value;
//! `computers_set`: what the person sets on one of them, answered as its row.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Number, Value};

use super::target::place_id;
use super::workspace::agents_asked;
use super::{entry_in, held_field, input, input_refusal, refused_field, Answer, Refused, Tool};
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
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub pending: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Places {
    places: Vec<Box<RawValue>>,
    #[serde(default)]
    pending: Vec<Box<RawValue>>,
}

async fn call(host: std::sync::Arc<Host>, arguments: serde_json::Value) -> Result<Answer, Refused> {
    let In {} = input(NAME, arguments)?;
    let client = host.client().await?;
    let (listed, spent) =
        tokio::try_join!(client.request::<Places>("places.list", Map::new()), client.request::<Places>("cost.spend", Map::new()))?;
    Ok(Answer::json(&Out { computers: listed.places, spend: spent.places, pending: listed.pending }))
}

const SET_NAME: &str = "computers_set";

const SET_LISTED: &str = include_str!("../../record/tools/computers_set.json");

pub const SET: Tool = Tool { name: SET_NAME, listed: SET_LISTED, call: |host, args| Box::pin(set(host, args)) };

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
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub nap: Option<Number>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub turn_limit: Option<Number>,
    #[serde(default)]
    pub spawn: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub max_machines: Option<Number>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub max_depth: Option<Number>,
    #[serde(default)]
    pub recipe: Option<String>,
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
    let SetIn { computer, threads, machines, spend, nap, turn_limit, spawn, max_machines, max_depth, recipe, reset } =
        input(SET_NAME, arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let mut frame = Map::new();
    let place = place_id(&client, &words, &computer).await?;
    // The recipe first, as the command line does: a setting refused after it leaves the computer following it.
    let followed = match recipe {
        Some(recipe) => {
            let mut follow = Map::new();
            follow.insert("placeId".to_owned(), Value::from(place.clone()));
            follow.insert("recipe".to_owned(), Value::from(recipe));
            Some(client.request::<Placed>("places.follow", follow).await?.place)
        }
        None => None,
    };
    frame.insert("placeId".to_owned(), Value::from(place));
    for (key, value) in [("threads", threads), ("machines", machines), ("spendPerDayUsd", spend)] {
        if let Some(n) = value {
            frame.insert(key.to_owned(), Value::Number(n));
        }
    }
    if let Some(minutes) = &nap {
        let window = nap_asked(entry_in(SET_LISTED, host.cloud()).unwrap_or_default(), minutes).map_err(Refused::Input)?;
        frame.insert("napMs".to_owned(), window);
    }
    if let Some(hours) = &turn_limit {
        let limit = turn_limit_asked(entry_in(SET_LISTED, host.cloud()).unwrap_or_default(), hours).map_err(Refused::Input)?;
        frame.insert("turnLimitMs".to_owned(), limit);
    }
    if let Some(asked) = agents_asked(spawn.as_deref(), max_machines.as_ref(), max_depth.as_ref())
        .map_err(|word| refused_field(SET_NAME, SET_LISTED, host.cloud(), "spawn", Value::from(word)))?
    {
        frame.insert("spawn".to_owned(), Value::Object(asked));
    }
    if let Some(reset) = reset.filter(|r| !r.is_empty()) {
        frame.insert("reset".to_owned(), Value::from(reset));
    }
    if let Some(place) = followed.filter(|_| frame.len() == 1) {
        return Ok(Answer::json(&SetOut { computer: place }));
    }
    let Placed { place } = client.request("places.set", frame).await?;
    Ok(Answer::json(&SetOut { computer: place }))
}

/// The nap window a call names in minutes, held to the entry's range in its own words: none of them never naps, the
/// rule napMsOf keeps on the host's side.
fn nap_asked(entry: &str, minutes: &Number) -> Result<Value, String> {
    held_field(SET_NAME, entry, "nap", &Value::Number(minutes.clone()))?;
    let Some(m) = minutes.as_u64() else { return Err(input_refusal(SET_NAME, &format!("nap cannot be read as {minutes}"))) };
    Ok(if m == 0 { Value::Null } else { Value::from(m * 60_000) })
}

/// The turn limit a call names in hours, held to the entry's range in its own words: none of them is no limit, the
/// rule turnLimitMsOf keeps on the host's side.
fn turn_limit_asked(entry: &str, hours: &Number) -> Result<Value, String> {
    held_field(SET_NAME, entry, "turn_limit", &Value::Number(hours.clone()))?;
    let Some(h) = hours.as_u64() else { return Err(input_refusal(SET_NAME, &format!("turn_limit cannot be read as {hours}"))) };
    Ok(if h == 0 { Value::Null } else { Value::from(h * 3_600_000) })
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Number, Value};

    use super::super::{entry_in, held_field};
    use super::{nap_asked, turn_limit_asked, SET};

    fn minutes(v: Value) -> Number {
        v.as_number().unwrap().clone()
    }

    /// What the TypeScript server refused this call with, off the record.
    fn recorded(arguments: Value) -> String {
        let all: Vec<Value> = serde_json::from_str(include_str!("../../tests/refusals.json")).unwrap();
        let found = all.iter().find(|r| r["tool"] == "computers_set" && r["arguments"] == arguments).expect("a recorded refusal");
        found["text"].as_str().unwrap().to_owned()
    }

    #[test]
    fn a_nap_is_whole_minutes_in_range_or_none_and_anything_else_is_refused_in_the_inputs_words() {
        let entry = entry_in(SET.listed, false).unwrap();
        assert_eq!(nap_asked(entry, &minutes(json!(0))).unwrap(), Value::Null);
        assert_eq!(nap_asked(entry, &minutes(json!(45))).unwrap(), json!(2_700_000));
        for given in [json!(2.5), json!(-1), json!(181)] {
            let refused = nap_asked(entry, &minutes(given.clone())).expect_err(&format!("{given} was taken"));
            assert_eq!(refused, recorded(json!({ "computer": "attic", "nap": given })));
        }
    }

    #[test]
    fn a_turn_limit_is_whole_hours_in_range_or_none_and_anything_else_is_refused_in_the_inputs_words() {
        let entry = entry_in(SET.listed, false).unwrap();
        assert_eq!(turn_limit_asked(entry, &minutes(json!(0))).unwrap(), Value::Null);
        assert_eq!(turn_limit_asked(entry, &minutes(json!(12))).unwrap(), json!(43_200_000));
        for given in [json!(1.5), json!(-1), json!(25)] {
            let refused = turn_limit_asked(entry, &minutes(given.clone())).expect_err(&format!("{given} was taken"));
            assert_eq!(refused, recorded(json!({ "computer": "attic", "turn_limit": given })));
        }
    }

    #[test]
    fn a_spawn_word_past_the_check_is_refused_in_the_inputs_words() {
        let entry = entry_in(SET.listed, false).unwrap();
        assert_eq!(
            held_field("computers_set", entry, "spawn", &json!("yes")).unwrap_err(),
            recorded(json!({ "computer": "attic", "spawn": "yes" }))
        );
        assert_eq!(held_field("computers_set", entry, "spawn", &json!("on")), Ok(()));
    }

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
        super::super::held::to_the_record::<super::SetIn, super::SetOut>(super::SET.listed);
    }
}
