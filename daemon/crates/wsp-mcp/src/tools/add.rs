// SPDX-License-Identifier: AGPL-3.0-only
//! `add`: a computer of the person's added over ssh and set up from a saved recipe, or with resume a computer
//! already added set up again. It answers at the first sign-in waiting on the person, at the end, or at its ceiling,
//! reading the computer's row again at each setup frame, and never waits on the person.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Number, Value};
use tokio::time::{sleep_until, Duration, Instant};

use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::{self, fill};

type Arc<T> = std::sync::Arc<T>;

const NAME: &str = "add";

pub const ADD: Tool =
    Tool { name: NAME, listed: include_str!("../../record/tools/add.json"), call: |host, args| Box::pin(call(host, args)) };

/// What the add tool says and reads off the record: its refusal of a word that is no computer, the providers whose
/// names it refuses, and how long one call runs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Words {
    pub refused: String,
    pub providers: Vec<String>,
    pub ceiling_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {
    pub address: String,
    #[serde(default)]
    pub recipe: Option<String>,
    #[serde(default)]
    pub later: Option<bool>,
    #[serde(default)]
    pub resume: Option<bool>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub ssh_port: Option<Number>,
    #[serde(default)]
    pub ssh_key: Option<String>,
    #[serde(default)]
    pub host_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Out {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub computer: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub setup: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub waiting: Box<RawValue>,
}

#[derive(Deserialize)]
struct Placed {
    place: Box<RawValue>,
}

#[derive(Deserialize)]
struct Places {
    places: Vec<Box<RawValue>>,
}

/// What the loop reads off a computer's row: which it is, and how its setup stands.
#[derive(Deserialize)]
struct Row {
    id: String,
    #[serde(default)]
    setup: Option<Setup>,
}

#[derive(Deserialize)]
struct Setup {
    state: String,
    steps: Box<RawValue>,
    waiting: Box<RawValue>,
}

#[derive(Deserialize)]
struct Wait {
    state: String,
}

#[derive(Deserialize)]
struct Pushed {
    #[serde(rename = "type", default)]
    kind: String,
}

/// user@host or an ssh alias: never a path, a repo or a provider's name, which the TypeScript tool reads the same way.
fn is_computer_word(word: &str, providers: &[String]) -> bool {
    !word.contains(['/', ':']) && !word.starts_with(['~', '.']) && !word.ends_with(".git") && !providers.iter().any(|p| p == word)
}

fn empty() -> Box<RawValue> {
    RawValue::from_string("[]".to_owned()).expect("an empty array reads")
}

async fn call(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let In { address, recipe, later, resume, name, ssh_port, ssh_key, host_key } = input(NAME, arguments)?;
    let words = record::words().add;
    let resume = resume == Some(true);
    if !resume && !is_computer_word(&address, &words.providers) {
        return Err(Failure::usage(fill(&words.refused, &[("word", &address)])).into());
    }
    let client = host.client().await?;
    let mut frames = client.frames();
    client.events().await?;
    let mut asked = Map::new();
    let op = if resume {
        asked.insert("ref".to_owned(), Value::from(address));
        "places.setup"
    } else {
        asked.insert("address".to_owned(), Value::from(address));
        for (key, value) in [
            ("name", name.map(Value::from)),
            ("sshPort", ssh_port.map(Value::Number)),
            ("keyPath", ssh_key.map(Value::from)),
            ("hostKey", host_key.map(Value::from)),
        ] {
            if let Some(value) = value {
                asked.insert(key.to_owned(), value);
            }
        }
        "places.add"
    };
    if let Some(recipe) = recipe {
        asked.insert("recipe".to_owned(), Value::from(recipe));
    }
    let Placed { place } = client.request(op, asked).await?;
    let id = serde_json::from_str::<Row>(place.get()).map_err(|e| Failure::new(e.to_string()))?.id;
    let until = Instant::now() + Duration::from_millis(words.ceiling_ms);
    loop {
        let Places { places } = client.request("places.list", Map::new()).await?;
        let now =
            places.into_iter().find(|p| serde_json::from_str::<Row>(p.get()).is_ok_and(|r| r.id == id)).unwrap_or_else(|| place.clone());
        let row: Row = serde_json::from_str(now.get()).map_err(|e| Failure::new(e.to_string()))?;
        let (over, open, setup, waiting) = match row.setup {
            None => (true, false, empty(), empty()),
            Some(Setup { state, steps, waiting }) => {
                let waits: Vec<Wait> = serde_json::from_str(waiting.get()).map_err(|e| Failure::new(e.to_string()))?;
                (state != "running", waits.iter().any(|w| w.state == "waiting"), steps, waiting)
            }
        };
        if over || (later != Some(true) && open) || Instant::now() >= until {
            return Ok(Answer::json(&Out { computer: now, setup, waiting }));
        }
        loop {
            tokio::select! {
                frame = frames.next() => {
                    let Some(text) = frame else { return Err(Failure::new(client.close_words()).into()) };
                    if serde_json::from_str::<Pushed>(&text).is_ok_and(|p| p.kind == "place.setup") {
                        break;
                    }
                }
                () = sleep_until(until) => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::held;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        held::to_the_record::<In, Out>(ADD.listed);
    }

    #[test]
    fn a_computer_is_user_at_host_or_an_alias_and_never_a_path_a_repo_or_a_provider() {
        let providers = record::words().add.providers;
        for word in ["root@203.0.113.7", "spoo", "dev.box", "constructor"] {
            assert!(is_computer_word(word, &providers), "{word}");
        }
        for word in
            ["/Users/dev/app", "~/app", "./app", "owner/repo", "https://github.com/a/b", "git@github.com:a/b", "app.git", "solari", "box"]
        {
            assert!(!is_computer_word(word, &providers), "{word}");
        }
    }
}
