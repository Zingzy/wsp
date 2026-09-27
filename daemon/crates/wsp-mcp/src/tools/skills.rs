// SPDX-License-Identifier: AGPL-3.0-only
//! The skill tools: skills.sh searched and read through the host, and a skill added, removed, or turned off and on
//! on one computer or workspace. Each answers a line of its own with the value beside it, as asText does. The host's
//! rows are read into the shapes the TypeScript tool parses them with, so a key no schema holds is dropped there as
//! it is here and the fields go in the schema's order.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::target::{self, agent_name, cell, printable, refused, table, Asked, ProjectIn};
use super::{input, Answer, Refused, Tool};
use crate::host::Host;
use crate::record::{self, fill};

pub const SEARCH: Tool = Tool {
    name: "skills_search",
    listed: include_str!("../../record/tools/skills_search.json"),
    call: |host, args| Box::pin(search(host, args)),
};
pub const SHOW: Tool = Tool {
    name: "skills_show",
    listed: include_str!("../../record/tools/skills_show.json"),
    call: |host, args| Box::pin(show(host, args)),
};
pub const ADD: Tool =
    Tool { name: "skills_add", listed: include_str!("../../record/tools/skills_add.json"), call: |host, args| Box::pin(add(host, args)) };
pub const REMOVE: Tool = Tool {
    name: "skills_remove",
    listed: include_str!("../../record/tools/skills_remove.json"),
    call: |host, args| Box::pin(remove(host, args)),
};
pub const DISABLE: Tool = Tool {
    name: "skills_disable",
    listed: include_str!("../../record/tools/skills_disable.json"),
    call: |host, args| Box::pin(toggle(host, args, "skills_disable", false)),
};
pub const ENABLE: Tool = Tool {
    name: "skills_enable",
    listed: include_str!("../../record/tools/skills_enable.json"),
    call: |host, args| Box::pin(toggle(host, args, "skills_enable", true)),
};

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SearchIn {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SearchOut {
    pub skills: Vec<SkillHit>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SkillHit {
    pub id: String,
    pub source: String,
    pub skill_id: String,
    pub name: String,
    pub installs: u64,
}

async fn search(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let SearchIn { query, limit } = input("skills_search", arguments)?;
    let client = host.client().await?;
    let mut asked = Map::new();
    asked.insert("q".to_owned(), Value::from(query));
    if let Some(limit) = limit {
        asked.insert("limit".to_owned(), Value::from(limit));
    }
    let found: SearchOut = client.request("skills.search", asked).await?;
    let words = record::words();
    let lines = if found.skills.is_empty() {
        vec![words.no_skill_hits]
    } else {
        let rows = found.skills.iter().map(|h| vec![cell(&h.name), h.installs.to_string(), cell(&h.id)]);
        table(&std::iter::once(words.skill_hit_columns).chain(rows).collect::<Vec<_>>())
    };
    Ok(Answer::text(lines.join("\n"), &found))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ShowIn {
    pub skill: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectIn>,
}

/// A skill's SKILL.md: its first bytes and the whole file's size.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Preview {
    pub text: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct Previewed {
    preview: Preview,
}

async fn show(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ShowIn { skill, workspace, on, project } = input("skills_show", arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let usage = target::usage(&words, "skills_show");
    let asked = target::project_asked(&words, project.as_ref(), on.as_deref(), "skills_show")?;
    let Previewed { preview } = if skill.split('/').count() == 3 {
        if workspace.is_some() || on.is_some() || asked.project {
            return Err(refused(&words.skills_sh_placeless, &[("skill", &skill)], &usage).into());
        }
        let mut get = Map::new();
        get.insert("skill".to_owned(), Value::from(skill));
        client.request("skills.get", get).await?
    } else {
        let aimed = target::target(&client, &words, workspace.as_deref(), on.as_deref(), &usage, asked.name.as_deref()).await?;
        let mut read = Map::new();
        read.insert("target".to_owned(), aimed);
        read.insert("name".to_owned(), Value::from(skill));
        project_field(&mut read, &asked);
        client.request("skills.preview", read).await?
    };
    let text = printable(&preview.text);
    let text = if preview.size > words.preview_bytes {
        let kb = preview.size.div_ceil(1024).to_string();
        format!("{text}\n\n{}", fill(&words.preview_cut, &[("kb", &kb)]))
    } else {
        text
    };
    Ok(Answer::text(text, &preview))
}

fn project_field(asked_host: &mut Map<String, Value>, asked: &Asked) {
    if asked.project {
        asked_host.insert("project".to_owned(), Value::Bool(true));
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AddIn {
    pub skill: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectIn>,
}

/// Where a skill landed: its own folder, and each agent's link or copy.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Added {
    pub path: String,
    pub agents: Vec<AgentCopy>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AgentCopy {
    pub agent: String,
    pub path: String,
}

async fn add(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Answered {
        added: Added,
    }
    let AddIn { skill, workspace, on, agent, project } = input("skills_add", arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let asked = target::project_asked(&words, project.as_ref(), on.as_deref(), "skills_add")?;
    let usage = target::usage(&words, "skills_add");
    let aimed = target::target(&client, &words, workspace.as_deref(), on.as_deref(), &usage, asked.name.as_deref()).await?;
    let mut adding = Map::new();
    adding.insert("target".to_owned(), aimed);
    adding.insert("skill".to_owned(), Value::from(skill.as_str()));
    if let Some(agents) = agent.filter(|a| !a.is_empty()) {
        adding.insert("agents".to_owned(), Value::from(agents));
    }
    project_field(&mut adding, &asked);
    let Answered { added } = client.request("skills.add", adding).await?;
    let name = cell(skill.rsplit('/').next().unwrap_or(&skill));
    let path = cell(&added.path);
    let line = if added.agents.is_empty() {
        fill(&words.is_in, &[("name", &name), ("path", &path)])
    } else {
        let copies = added
            .agents
            .iter()
            .map(|a| fill(&words.agent_copy, &[("agent", &agent_name(&words, &a.agent)), ("path", &cell(&a.path))]))
            .collect::<Vec<_>>()
            .join(", ");
        fill(&words.is_in_also, &[("name", &name), ("path", &path), ("copies", &copies)])
    };
    Ok(Answer::text(line, &added))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RemoveIn {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectIn>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RemoveOut {
    pub removed: Vec<String>,
}

async fn remove(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let RemoveIn { name, workspace, on, project } = input("skills_remove", arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let asked = target::project_asked(&words, project.as_ref(), on.as_deref(), "skills_remove")?;
    let usage = target::usage(&words, "skills_remove");
    let aimed = target::target(&client, &words, workspace.as_deref(), on.as_deref(), &usage, asked.name.as_deref()).await?;
    let mut removing = Map::new();
    removing.insert("target".to_owned(), aimed);
    removing.insert("name".to_owned(), Value::from(name.as_str()));
    project_field(&mut removing, &asked);
    let out: RemoveOut = client.request("skills.remove", removing).await?;
    let from = out.removed.iter().map(|p| cell(p)).collect::<Vec<_>>().join(", ");
    Ok(Answer::text(fill(&words.gone_from, &[("name", &cell(&name)), ("from", &from)]), &out))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ToggleIn {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ToggleOut {
    pub paths: Vec<String>,
}

/// A project's skill lives in the repo, so a toggle never names one.
async fn toggle(host: Arc<Host>, arguments: Value, tool: &'static str, turn_on: bool) -> Result<Answer, Refused> {
    let ToggleIn { name, workspace, on } = input(tool, arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let usage = target::usage(&words, tool);
    let aimed = target::target(&client, &words, workspace.as_deref(), on.as_deref(), &usage, None).await?;
    let mut turning = Map::new();
    turning.insert("target".to_owned(), aimed);
    turning.insert("name".to_owned(), Value::from(name.as_str()));
    turning.insert("on".to_owned(), Value::Bool(turn_on));
    let out: ToggleOut = client.request("skills.toggle", turning).await?;
    let line = fill(if turn_on { &words.turned_on } else { &words.turned_off }, &[("name", &name)]);
    Ok(Answer::text(line, &out))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<SearchIn, SearchOut>(SEARCH.listed);
        to_the_record::<ShowIn, Preview>(SHOW.listed);
        to_the_record::<AddIn, Added>(ADD.listed);
        to_the_record::<RemoveIn, RemoveOut>(REMOVE.listed);
        to_the_record::<ToggleIn, ToggleOut>(DISABLE.listed);
        to_the_record::<ToggleIn, ToggleOut>(ENABLE.listed);
    }
}
