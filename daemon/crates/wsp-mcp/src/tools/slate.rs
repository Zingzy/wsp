// SPDX-License-Identifier: AGPL-3.0-only
//! `slate_catalog`, `slate_write`, `slate_state` and `slate_read`: each forwards its arguments to one host op and
//! answers the op's text, so the compiler, the validator, the sketch and the catalog live on the host alone.

use std::fmt;
use std::sync::Arc;

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::named::thread_of;
use super::{input, turn_token_env, Answer, Refused, Tool};
use crate::client::Client;
use crate::failure::Failure;
use crate::host::Host;

pub const CATALOG: Tool = Tool {
    name: "slate_catalog",
    listed: include_str!("../../record/tools/slate_catalog.json"),
    call: |host, args| Box::pin(catalog(host, args)),
};
pub const WRITE: Tool =
    Tool { name: "slate_write", listed: include_str!("../../record/tools/slate_write.json"), call: |host, args| Box::pin(write(host, args)) };
pub const STATE: Tool =
    Tool { name: "slate_state", listed: include_str!("../../record/tools/slate_state.json"), call: |host, args| Box::pin(state(host, args)) };
pub const READ: Tool =
    Tool { name: "slate_read", listed: include_str!("../../record/tools/slate_read.json"), call: |host, args| Box::pin(read(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct CatalogIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct WriteIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_version: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct StateIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    pub values: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_version: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ReadIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketch: Option<bool>,
}

/// The catalog's answer: its text alone.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct CatalogOut {
    pub text: String,
}

/// The shape a write, a state and a read answer is held to: the version and the sketch named, the rest open.
#[cfg(test)]
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
struct Shape {
    version: i64,
    text: String,
    #[serde(flatten)]
    rest: Map<String, Value>,
}

/// The host's answer less its frame's own id and ok, every field in the bytes and the order the host wrote it.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(transparent)]
pub struct Out(#[cfg_attr(test, schemars(with = "Shape"))] pub Answered);

#[derive(Debug, Default)]
pub struct Answered(Vec<(String, Box<RawValue>)>);

impl Answered {
    fn text(&self) -> Option<String> {
        self.0.iter().find(|(k, _)| k == "text").and_then(|(_, v)| serde_json::from_str(v.get()).ok())
    }
}

impl<'de> Deserialize<'de> for Answered {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Answered;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Answered, A::Error> {
                let mut fields = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if key != "id" && key != "ok" {
                        fields.push((key, value));
                    }
                }
                Ok(Answered(fields))
            }
        }
        deserializer.deserialize_map(Fields)
    }
}

impl Serialize for Answered {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// Whose slate a call acts on, as `slateTarget` in packages/host/src/verbs.ts sends it: a thread named by id or
/// prefix, else the turn this server runs inside, else nothing, which the host reads off the caller's own token.
async fn target(host: &Host, client: &Client, thread: Option<String>) -> Result<Map<String, Value>, Failure> {
    let mut asked = Map::new();
    if let Some(named) = thread {
        asked.insert("threadId".to_owned(), Value::from(thread_of(client, &named).await?.runtime_id()));
    } else if let Some(token) = host.env().get(turn_token_env()).filter(|t| !t.is_empty()) {
        asked.insert("turnToken".to_owned(), Value::from(token.as_str()));
    }
    Ok(asked)
}

fn put<T: Into<Value>>(asked: &mut Map<String, Value>, key: &str, value: Option<T>) {
    if let Some(value) = value {
        asked.insert(key.to_owned(), value.into());
    }
}

async fn answered(client: &Client, op: &str, asked: Map<String, Value>) -> Result<Answer, Refused> {
    let answer = client.request::<Answered>(op, asked).await?;
    Ok(Answer::text(answer.text().unwrap_or_default(), &Out(answer)))
}

async fn catalog(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let CatalogIn { name } = input("slate_catalog", arguments)?;
    let client = host.client().await?;
    let mut asked = Map::new();
    put(&mut asked, "name", name);
    #[derive(Deserialize)]
    struct Said {
        text: String,
    }
    let said = client.request::<Said>("slates.catalog", asked).await?;
    Ok(Answer::text(said.text.clone(), &CatalogOut { text: said.text }))
}

async fn write(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let WriteIn { thread, text, document, check, if_version } = input("slate_write", arguments)?;
    let client = host.client().await?;
    let mut asked = target(&host, &client, thread).await?;
    put(&mut asked, "text", text);
    put(&mut asked, "document", document);
    put(&mut asked, "check", check);
    put(&mut asked, "ifVersion", if_version);
    answered(&client, "slates.write", asked).await
}

async fn state(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let StateIn { thread, values, if_version } = input("slate_state", arguments)?;
    let client = host.client().await?;
    let mut asked = target(&host, &client, thread).await?;
    asked.insert("values".to_owned(), Value::Object(values));
    put(&mut asked, "ifVersion", if_version);
    answered(&client, "slates.state", asked).await
}

async fn read(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ReadIn { thread, values, text, sketch } = input("slate_read", arguments)?;
    let client = host.client().await?;
    let mut asked = target(&host, &client, thread).await?;
    put(&mut asked, "values", values);
    put(&mut asked, "text", text);
    put(&mut asked, "sketch", sketch);
    answered(&client, "slates.read", asked).await
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::super::{entry_in, TOOLS};
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<CatalogIn, CatalogOut>(CATALOG.listed);
        to_the_record::<WriteIn, Out>(WRITE.listed);
        to_the_record::<StateIn, Out>(STATE.listed);
        to_the_record::<ReadIn, Out>(READ.listed);
    }

    #[test]
    fn the_four_entries_fit_the_budget_of_2500_characters() {
        for cloud in [false, true] {
            let total: usize = TOOLS
                .iter()
                .filter(|t| t.name.starts_with("slate_"))
                .filter_map(|t| entry_in(t.listed, cloud))
                .map(|e| serde_json::to_string(&serde_json::from_str::<Value>(e).unwrap()).unwrap().chars().count())
                .sum();
            assert!(total < 2500, "the slate tools list {total} characters with the cloud {}", if cloud { "on" } else { "off" });
        }
    }

    #[test]
    fn an_answer_keeps_the_hosts_order_less_its_frame() {
        let answer: Answered = serde_json::from_str(r#"{"id":4,"ok":true,"version":3,"text":"slate v3","zeta":1.0,"alpha":[]}"#).unwrap();
        assert_eq!(answer.text().as_deref(), Some("slate v3"));
        assert_eq!(serde_json::to_string(&Out(answer)).unwrap(), r#"{"version":3,"text":"slate v3","zeta":1.0,"alpha":[]}"#);
    }
}
