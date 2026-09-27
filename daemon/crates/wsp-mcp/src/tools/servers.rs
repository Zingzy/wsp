// SPDX-License-Identifier: AGPL-3.0-only
//! The MCP server tools: one server started once for its tools, and a server written into, taken out of, or turned
//! off and on in one agent's own config on one computer or workspace; and the wsp server itself written into an
//! agent's config on the computer the host runs on. Each answers a line of its own with the value beside it, as
//! asText does.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::target::{self, agent_name, js_space, refused, table, Asked, ProjectIn};
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::{self, fill, Words};

pub const TOOLS: Tool = Tool {
    name: "servers_tools",
    listed: include_str!("../../record/tools/servers_tools.json"),
    call: |host, args| Box::pin(tools(host, args)),
};
pub const ADD: Tool =
    Tool { name: "servers_add", listed: include_str!("../../record/tools/servers_add.json"), call: |host, args| Box::pin(add(host, args)) };
pub const REMOVE: Tool = Tool {
    name: "servers_remove",
    listed: include_str!("../../record/tools/servers_remove.json"),
    call: |host, args| Box::pin(changed(host, args, "servers_remove", None)),
};
pub const DISABLE: Tool = Tool {
    name: "servers_disable",
    listed: include_str!("../../record/tools/servers_disable.json"),
    call: |host, args| Box::pin(changed(host, args, "servers_disable", Some(false))),
};
pub const ENABLE: Tool = Tool {
    name: "servers_enable",
    listed: include_str!("../../record/tools/servers_enable.json"),
    call: |host, args| Box::pin(changed(host, args, "servers_enable", Some(true))),
};
pub const ADD_TOOLS: Tool = Tool {
    name: "agents_addtools",
    listed: include_str!("../../record/tools/agents_addtools.json"),
    call: |host, args| Box::pin(add_tools(host, args)),
};

/// The file a change wrote.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Written {
    pub file: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ToolsIn {
    pub name: String,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh: Option<bool>,
}

/// What one connect to the server found: its sign-in, its tools, the agent holding its sign-in, or why nothing came.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ToolsAnswer {
    pub auth: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<McpTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
    pub read_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct McpTool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<McpToolParam>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct McpToolParam {
    pub name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

async fn tools(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Answered {
        answer: ToolsAnswer,
    }
    let ToolsIn { name, agent, workspace, on, project, refresh } = input("servers_tools", arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let usage = target::usage(&words, "servers_tools");
    let project = match project.as_deref() {
        None => None,
        Some("") => return Err(refused(&words.tools_project_bare, &[], &usage).into()),
        Some(named) => target::project_asked(&words, Some(&ProjectIn::Named(named.to_owned())), on.as_deref(), &usage)?.name,
    };
    let aimed = target::target(&client, &words, workspace.as_deref(), on.as_deref(), &usage, project.as_deref()).await?;
    let mut asking = Map::new();
    asking.insert("target".to_owned(), aimed);
    asking.insert("agent".to_owned(), Value::from(agent));
    asking.insert("name".to_owned(), Value::from(name.as_str()));
    if refresh == Some(true) {
        asking.insert("refresh".to_owned(), Value::Bool(true));
    }
    let Answered { answer } = client.request("servers.tools", asking).await?;
    Ok(Answer::text(tool_lines(&words, &name, &answer).join("\n"), &answer))
}

/// One server's tools as lines: its sign-in as the connect found it, then each tool, or why none came back.
fn tool_lines(words: &Words, name: &str, answer: &ToolsAnswer) -> Vec<String> {
    let head = match &answer.holder {
        Some(holder) => fill(&words.server_tools_held, &[("name", name), ("auth", &answer.auth), ("holder", &agent_name(words, holder))]),
        None => fill(&words.server_tools_head, &[("name", name), ("auth", &answer.auth)]),
    };
    if let Some(why) = &answer.refused {
        return vec![head, fill(&words.server_tools_refused, &[("refused", why)])];
    }
    match &answer.tools {
        None => vec![head],
        Some(tools) if tools.is_empty() => vec![head, words.server_tools_none.clone()],
        Some(tools) => {
            let rows = tools.iter().map(|t| {
                let described = t.description.as_deref().unwrap_or("-");
                vec![t.name.clone(), described.split('\n').next().unwrap_or_default().to_owned()]
            });
            std::iter::once(head)
                .chain(table(&std::iter::once(words.server_tool_columns.clone()).chain(rows).collect::<Vec<_>>()))
                .collect()
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AddIn {
    pub name: String,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectIn>,
}

/// Every value an add names is read off the environment the server runs in and goes to the host alone.
async fn add(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let AddIn { name, agent, workspace, on, command, env, url, header, project } = input("servers_add", arguments)?;
    let words = record::words();
    let usage = target::usage(&words, "servers_add");
    let mut adding = values(&words, host.env(), &env.unwrap_or_default(), &header.unwrap_or_default(), &usage)?;
    let asked = target::project_asked(&words, project.as_ref(), on.as_deref(), &usage)?;
    adding.insert("agent".to_owned(), Value::from(agent));
    adding.insert("name".to_owned(), Value::from(name.as_str()));
    if let Some(line) = command {
        let Some(split) = command_words(&line) else {
            return Err(refused(&words.unclosed_quote, &[], &usage).into());
        };
        let mut split = split.into_iter();
        adding.insert("command".to_owned(), Value::from(split.next().unwrap_or_default()));
        adding.insert("args".to_owned(), Value::from(split.collect::<Vec<_>>()));
    }
    if let Some(url) = url {
        adding.insert("url".to_owned(), Value::from(url));
    }
    if asked.project {
        adding.insert("project".to_owned(), Value::Bool(true));
    }
    let client = host.client().await?;
    let aimed = target::target(&client, &words, workspace.as_deref(), on.as_deref(), &usage, asked.name.as_deref()).await?;
    adding.insert("target".to_owned(), aimed);
    let out: Written = client.request("servers.add", adding).await?;
    Ok(Answer::text(fill(&words.is_in, &[("name", &name), ("path", &out.file)]), &out))
}

/// The values an add names: `NAME` reads $NAME for a variable, and `Name=VAR` reads $VAR as that header's value. A
/// variable the environment does not hold is refused rather than sent empty.
fn values(words: &Words, env: &crate::Env, names: &[String], headers: &[String], usage: &str) -> Result<Map<String, Value>, Failure> {
    let read = |variable: &str| env.get(variable).cloned().ok_or_else(|| refused(&words.unset_variable, &[("variable", variable)], usage));
    let mut vars = Map::new();
    for name in names {
        vars.insert(name.clone(), Value::from(read(name)?));
    }
    let mut heads = Map::new();
    for pair in headers {
        match pair.find('=') {
            Some(at) if at > 0 && at < pair.len() - 1 => {
                heads.insert(pair[..at].to_owned(), Value::from(read(&pair[at + 1..])?));
            }
            _ => return Err(refused(&words.not_header, &[("pair", pair)], usage)),
        }
    }
    let mut body = Map::new();
    if !names.is_empty() {
        body.insert("env".to_owned(), Value::Object(vars));
    }
    if !headers.is_empty() {
        body.insert("headers".to_owned(), Value::Object(heads));
    }
    Ok(body)
}

/// `commandWords`: a line split at spaces, a word in single quotes as written, one in double quotes with its
/// backslash escapes, and a backslash outside quotes taking the next character as it is; nothing expanded, and a
/// quote never closed gives no words.
fn command_words(line: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = line.chars().collect();
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            let end = chars[i + 1..].iter().position(|&q| q == '\'')? + i + 1;
            word.get_or_insert_with(String::new).extend(&chars[i + 1..end]);
            i = end;
        } else if c == '"' {
            let w = word.get_or_insert_with(String::new);
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                }
                w.push(chars[i]);
                i += 1;
            }
            if i >= chars.len() {
                return None;
            }
        } else if c == '\\' && i + 1 < chars.len() {
            i += 1;
            word.get_or_insert_with(String::new).push(chars[i]);
        } else if js_space(c) {
            words.extend(word.take());
        } else {
            word.get_or_insert_with(String::new).push(c);
        }
        i += 1;
    }
    words.extend(word);
    Some(words)
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ChangeIn {
    pub name: String,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectIn>,
}

/// A server taken out, or turned off or on where `turn` says which, in the scope it is listed under.
async fn changed(host: Arc<Host>, arguments: Value, tool: &'static str, turn: Option<bool>) -> Result<Answer, Refused> {
    let ChangeIn { name, agent, workspace, on, scope, project } = input(tool, arguments)?;
    let words = record::words();
    let usage = target::usage(&words, tool);
    let asked = target::project_asked(&words, project.as_ref(), on.as_deref(), &usage)?;
    let client = host.client().await?;
    let mut changing = Map::new();
    changing.insert("agent".to_owned(), Value::from(agent));
    changing.insert("name".to_owned(), Value::from(name.as_str()));
    if let Some(scope) = server_scope(&words, scope, &asked, &usage)? {
        changing.insert("scope".to_owned(), Value::from(scope));
    }
    if let Some(turn) = turn {
        changing.insert("on".to_owned(), Value::Bool(turn));
    }
    let aimed = target::target(&client, &words, workspace.as_deref(), on.as_deref(), &usage, asked.name.as_deref()).await?;
    changing.insert("target".to_owned(), aimed);
    let op = if turn.is_some() { "servers.toggle" } else { "servers.remove" };
    let out: Written = client.request(op, changing).await?;
    let line = match turn {
        None => fill(&words.gone_from, &[("name", &name), ("from", &out.file)]),
        Some(true) => fill(&words.turned_on_in, &[("name", &name), ("file", &out.file)]),
        Some(false) => fill(&words.turned_off_in, &[("name", &name), ("file", &out.file)]),
    };
    Ok(Answer::text(line, &out))
}

/// The scope a call names, which its schema has already held to the three, and a project, which is the project scope.
fn server_scope(words: &Words, scope: Option<String>, asked: &Asked, usage: &str) -> Result<Option<String>, Failure> {
    match scope {
        None => Ok(asked.project.then(|| "project".to_owned())),
        Some(scope) if asked.project && scope != "project" => Err(refused(&words.project_scope, &[("scope", &scope)], usage)),
        Some(scope) => Ok(Some(scope)),
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AddToolsIn {
    pub agent: String,
}

async fn add_tools(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let AddToolsIn { agent } = input("agents_addtools", arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let mut here = Map::new();
    here.insert("placeId".to_owned(), Value::from(words.here_place_id.as_str()));
    let mut adding = Map::new();
    adding.insert("target".to_owned(), Value::Object(here));
    adding.insert("agent".to_owned(), Value::from(agent.as_str()));
    let out: Written = client.request("agents.addTools", adding).await?;
    Ok(Answer::text(fill(&words.tools_added, &[("agent", &agent_name(&words, &agent)), ("file", &out.file)]), &out))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<ToolsIn, ToolsAnswer>(TOOLS.listed);
        to_the_record::<AddIn, Written>(ADD.listed);
        to_the_record::<ChangeIn, Written>(REMOVE.listed);
        to_the_record::<ChangeIn, Written>(DISABLE.listed);
        to_the_record::<ChangeIn, Written>(ENABLE.listed);
        to_the_record::<AddToolsIn, Written>(ADD_TOOLS.listed);
    }

    #[test]
    fn a_command_splits_as_the_typescript_split_does() {
        let recorded = record::words().command_words;
        assert!(!recorded.is_empty());
        for (line, split) in recorded {
            assert_eq!(command_words(&line), split, "{line:?}");
        }
    }
}
