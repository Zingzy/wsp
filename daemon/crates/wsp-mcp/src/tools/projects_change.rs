// SPDX-License-Identifier: AGPL-3.0-only
//! The two tools that change which projects this host holds: add records one source on one computer, and remove
//! takes a project's record out with the folder wsp made for it.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::workspace::{self, params, read, shell_quote};
use super::{input, Answer, Refused, Tool};
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AddIn {
    pub source: String,
    #[serde(default)]
    pub on: Option<String>,
    #[serde(default)]
    pub into: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AddOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub project: Box<RawValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// What an added project's line reads off it.
#[derive(Deserialize)]
struct Project {
    id: String,
    name: String,
    computer: String,
    path: String,
    source: Source,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Source {
    Folder { path: String },
    Git { url: String },
    Github { repo: String },
    Gitlab { repo: String },
}

impl Source {
    fn word(&self) -> &str {
        match self {
            Source::Folder { path } => path,
            Source::Git { url } => url,
            Source::Github { repo } | Source::Gitlab { repo } => repo,
        }
    }
}

/// The computer as every row names it: this one in its platform's own word, any other by the name this wsp holds for
/// it, else its id.
fn computer_named(computer: &str, named: &HashMap<String, String>) -> String {
    let words = workspace::words();
    if computer == words.here_place_id {
        return if cfg!(target_os = "macos") { words.this_mac } else { words.this_computer };
    }
    named.get(computer).cloned().unwrap_or_else(|| computer.to_owned())
}

const ADD_NAME: &str = "projects_add";

pub const ADD: Tool =
    Tool { name: ADD_NAME, listed: include_str!("../../record/tools/projects_add.json"), call: |host, args| Box::pin(add(host, args)) };

/// What landed and is not what was asked for rides the answer under the added line: an add that stands with the
/// commits left behind reads as one that stands, and the caller has to be told which.
async fn add(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Place {
        id: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct Places {
        places: Vec<Place>,
    }
    let AddIn { source, on, into, name, base } = input(ADD_NAME, arguments)?;
    let client = host.client().await?;
    let mut asked = params([("source", Value::from(source))]);
    for (key, value) in [("on", on), ("name", name), ("base", base), ("into", into)] {
        if let Some(value) = value {
            asked.insert(key.to_owned(), Value::from(value));
        }
    }
    let added: AddOut = client.request("projects.add", asked).await?;
    let named: HashMap<String, String> = match client.request::<Places>("places.list", Map::new()).await {
        Ok(listed) => listed.places.into_iter().map(|p| (p.id, p.name)).collect(),
        Err(_) => HashMap::new(),
    };
    let project: Project = read(&added.project, "projects.add")?;
    let said = fill(
        &workspace::words().added_project,
        &[
            ("name", &project.name),
            ("id", &project.id),
            ("source", project.source.word()),
            ("computer", &computer_named(&project.computer, &named)),
            ("path", &project.path),
            ("quoted", &shell_quote(&project.name)),
        ],
    );
    let text = match &added.notice {
        Some(notice) => format!("{said}\n{notice}"),
        None => said,
    };
    Ok(Answer::text(text, &added))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RemoveIn {
    pub project: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RemoveOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub project: Box<RawValue>,
    pub said: String,
}

const REMOVE_NAME: &str = "projects_remove";

pub const REMOVE: Tool = Tool {
    name: REMOVE_NAME,
    listed: include_str!("../../record/tools/projects_remove.json"),
    call: |host, args| Box::pin(remove(host, args)),
};

/// The sentence comes off the wire: what a remove took is true differently on each kind of computer, and the
/// runtime's own road for that computer is what says which.
async fn remove(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Resolved {
        project: Box<RawValue>,
    }
    #[derive(Deserialize)]
    struct Id {
        id: String,
    }
    #[derive(Deserialize)]
    struct Removed {
        said: String,
    }
    let RemoveIn { project } = input(REMOVE_NAME, arguments)?;
    let client = host.client().await?;
    let resolved: Resolved = client.request("projects.resolve", params([("ref", Value::from(project))])).await?;
    let Id { id } = read(&resolved.project, "projects.resolve")?;
    let Removed { said } = client.request("projects.remove", params([("projectId", Value::from(id))])).await?;
    Ok(Answer::text(said.clone(), &RemoveOut { project: resolved.project, said }))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<AddIn, AddOut>(ADD.listed);
        to_the_record::<RemoveIn, RemoveOut>(REMOVE.listed);
    }
}
