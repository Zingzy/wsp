// SPDX-License-Identifier: AGPL-3.0-only
//! `threads` and `thread read`: the session index folded into threads as packages/protocol's `foldThreads` folds it,
//! the sidebar's rows with the names of their project, workspace and computer beside them, and one thread's messages
//! off the transcript the host holds.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::agents::workspace_id;
use super::{input, Answer, Refused, Tool};
use crate::client::Client;
use crate::failure::Failure;
use crate::host::Host;
use crate::js;
use crate::record::{self, fill};
use crate::transcript::{self, Message};
use crate::words::{opening_title, title_line};

pub const THREADS: Tool =
    Tool { name: "threads", listed: include_str!("../../record/tools/threads.json"), call: |host, args| Box::pin(threads(host, args)) };
pub const THREAD_READ: Tool = Tool {
    name: "thread_read",
    listed: include_str!("../../record/tools/thread_read.json"),
    call: |host, args| Box::pin(thread_read(host, args)),
};

/// One turn's row of the session index, as much of it as a thread is folded from.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    workspace_id: String,
    harness: String,
    status: String,
    #[serde(default)]
    started_by: Option<String>,
    #[serde(default)]
    claude_session_id: Option<String>,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    parent_thread_id: Option<String>,
    #[serde(default)]
    root_thread_id: Option<String>,
    #[serde(default)]
    attempt: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    harness_title: Option<String>,
    #[serde(default)]
    started_at: Option<Box<RawValue>>,
    #[serde(default)]
    ended_at: Option<Box<RawValue>>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    refusal: Option<Box<RawValue>>,
    #[serde(default)]
    cost_usd: Option<f64>,
    #[serde(default)]
    asking: Option<String>,
    #[serde(default)]
    waiting_on: Option<Box<RawValue>>,
    #[serde(default)]
    setup_refusal: Option<String>,
    #[serde(default)]
    pid: Option<Box<RawValue>>,
    #[serde(default)]
    read_at: Option<Box<RawValue>>,
    #[serde(default)]
    settled_at: Option<Box<RawValue>>,
    #[serde(default)]
    pinned_at: Option<Box<RawValue>>,
    #[serde(default)]
    snoozed_until: Option<Box<RawValue>>,
    #[serde(default)]
    woke_at: Option<Box<RawValue>>,
    #[serde(default)]
    section: Option<Box<RawValue>>,
    #[serde(default)]
    rewound_at: Option<Box<RawValue>>,
    #[serde(default)]
    permission_mode: Option<String>,
    #[serde(default)]
    fast: Option<bool>,
    #[serde(default)]
    subagents: Option<Box<RawValue>>,
}

/// A thread as `foldThreads` builds it, its fields in that object's order.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub workspace_id: String,
    pub harness: String,
    pub started_by: String,
    pub status: String,
    pub title: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub started_at: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub ended_at: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<serde_json::Map<String, serde_json::Value>>"))]
    pub waiting_on: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_refusal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<i64>"))]
    pub pid: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub read_at: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub settled_at: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub pinned_at: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub snoozed_until: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub woke_at: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<serde_json::Map<String, serde_json::Value>>"))]
    pub section: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub rewound_at: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<Vec<serde_json::Map<String, serde_json::Value>>>"))]
    pub subagents: Option<Box<RawValue>>,
    pub turns: u64,
    pub ran: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub cost_usd: Option<Box<RawValue>>,
}

/// A thread with the names a table reads beside it: `ThreadRow` in packages/host/src/verbs.ts.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Row {
    #[serde(flatten)]
    pub thread: Thread,
    pub project_name: String,
    pub workspace_name: String,
    pub computer_name: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ThreadsIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ThreadsOut {
    pub threads: Vec<Row>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ReadIn {
    pub thread: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ReadOut {
    pub thread_id: String,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub messages: Vec<Message>,
}

/// `foldThreads`: the index grouped by thread, in the order each thread's first turn appears.
fn fold(sessions: Vec<Session>) -> Vec<Thread> {
    let mut order: Vec<String> = Vec::new();
    let mut by_thread: HashMap<String, Vec<Session>> = HashMap::new();
    for session in sessions {
        let key = session.thread_id.clone().unwrap_or_else(|| session.id.clone());
        if !by_thread.contains_key(&key) {
            order.push(key.clone());
        }
        by_thread.entry(key).or_default().push(session);
    }
    order
        .into_iter()
        .filter_map(|id| {
            let turns = by_thread.remove(&id)?;
            let ran = turns.iter().any(|t| t.status == "running" || (t.claude_session_id.is_some() && t.refusal.is_none()));
            let spent: Vec<f64> = turns.iter().filter_map(|t| t.cost_usd).collect();
            let cost_usd = (!spent.is_empty())
                .then(|| spent.iter().fold(0.0, |sum, c| sum + c))
                .and_then(|sum| RawValue::from_string(js::number(sum)).ok());
            let count = turns.len() as u64;
            let mut turns = turns.into_iter();
            let first = turns.next()?;
            let latest = turns.last();
            let title = {
                let latest = latest.as_ref().unwrap_or(&first);
                match (&latest.harness_title, &first.prompt) {
                    (Some(named), _) => title_line(named),
                    (None, Some(prompt)) => opening_title(prompt),
                    (None, None) => first.claude_session_id.clone().unwrap_or_else(|| first.id.clone()),
                }
            };
            let (parent_thread_id, root_thread_id, attempt) =
                (first.parent_thread_id.clone(), first.root_thread_id.clone(), first.attempt.clone());
            let (thread_id, workspace_id, harness, started_by) =
                (first.thread_id.clone(), first.workspace_id.clone(), first.harness.clone(), first.started_by.clone());
            let latest = latest.unwrap_or(first);
            Some(Thread {
                id,
                thread_id,
                workspace_id,
                harness,
                started_by: started_by.unwrap_or_else(|| "person".to_owned()),
                status: latest.status,
                title,
                session_id: latest.id,
                claude_session_id: latest.claude_session_id,
                started_at: latest.started_at,
                ended_at: latest.ended_at,
                cwd: latest.cwd,
                asking: latest.asking,
                waiting_on: latest.waiting_on,
                setup_refusal: latest.setup_refusal,
                pid: latest.pid,
                read_at: latest.read_at,
                settled_at: latest.settled_at,
                pinned_at: latest.pinned_at,
                snoozed_until: latest.snoozed_until,
                woke_at: latest.woke_at,
                section: latest.section,
                rewound_at: latest.rewound_at,
                permission_mode: latest.permission_mode,
                fast: latest.fast.filter(|fast| *fast),
                subagents: latest.subagents,
                turns: count,
                ran,
                parent_thread_id,
                root_thread_id,
                attempt,
                cost_usd,
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct Sessions {
    sessions: Vec<Session>,
}

async fn threads_of(client: &Client, workspace: Option<String>) -> Result<Vec<Thread>, Failure> {
    let mut params = Map::new();
    if let Some(id) = workspace {
        params.insert("workspaceId".to_owned(), Value::from(id));
    }
    Ok(fold(client.request::<Sessions>("sessions.list", params).await?.sessions))
}

#[derive(Deserialize)]
struct Project {
    name: String,
    computer: String,
}

#[derive(Deserialize)]
struct Workspace {
    id: String,
    name: String,
    project: Project,
}

#[derive(Deserialize)]
struct Workspaces {
    workspaces: Vec<Workspace>,
}

#[derive(Deserialize)]
struct Place {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct Places {
    places: Vec<Place>,
}

/// `threadRows`: the rows within one workspace when one is named, each with the names of what it stands on. A caller
/// the host refuses the list of computers reads each computer by its id.
async fn rows(client: &Client, within: Option<&str>) -> Result<Vec<Row>, Failure> {
    let all = client.request::<Workspaces>("workspaces.list", Map::new()).await?.workspaces;
    let scope = match within {
        Some(within) => Some(workspace_id(client, within).await?),
        None => None,
    };
    let threads = threads_of(client, scope).await?;
    let named: HashMap<String, String> = if threads.is_empty() {
        HashMap::new()
    } else {
        client
            .request::<Places>("places.list", Map::new())
            .await
            .map(|p| p.places.into_iter().map(|p| (p.id, p.name)).collect())
            .unwrap_or_default()
    };
    Ok(threads
        .into_iter()
        .map(|thread| {
            let workspace = all.iter().find(|w| w.id == thread.workspace_id);
            Row {
                project_name: workspace.map_or_else(String::new, |w| w.project.name.clone()),
                workspace_name: workspace.map_or_else(|| thread.workspace_id.clone(), |w| w.name.clone()),
                computer_name: workspace
                    .map_or_else(String::new, |w| named.get(&w.project.computer).cloned().unwrap_or_else(|| w.project.computer.clone())),
                thread,
            }
        })
        .collect())
}

async fn threads(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let asked: ThreadsIn = input("threads", arguments)?;
    let client = host.client().await?;
    Ok(Answer::json(&ThreadsOut { threads: rows(&client, asked.workspace.as_deref()).await? }))
}

/// `pickThread`: by id, or by a prefix of it that names exactly one.
fn pick(all: Vec<Thread>, reference: &str) -> Result<Thread, Failure> {
    let words = record::words();
    let mut prefixed = Vec::new();
    for thread in all {
        if thread.id == reference {
            return Ok(thread);
        }
        if thread.id.starts_with(reference) {
            prefixed.push(thread);
        }
    }
    match prefixed.len() {
        1 => Ok(prefixed.remove(0)),
        0 => Err(Failure::of_kind(fill(&words.no_thread, &[("ref", reference)]), "not-found")),
        n => Err(Failure::new(fill(&words.threads_start_with, &[("count", &n.to_string()), ("ref", reference)]))),
    }
}

#[derive(Deserialize)]
struct History {
    events: Vec<Box<RawValue>>,
}

async fn thread_read(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let asked: ReadIn = input("thread_read", arguments)?;
    let last = asked.last == Some(true);
    let client = host.client().await?;
    let thread = pick(threads_of(&client, None).await?, &asked.thread)?;
    let thread_id = thread.thread_id.clone().unwrap_or_else(|| thread.id.clone());
    let mut params = Map::new();
    params.insert("workspaceId".to_owned(), Value::from(thread.workspace_id.as_str()));
    let events = client.request::<History>("sessions.history", params).await?.events;
    let mut params = Map::new();
    params.insert("threadId".to_owned(), Value::from(thread.id.as_str()));
    client.request::<Value>("sessions.read", params).await?;
    let words = record::words();
    let messages =
        if last { transcript::reply_rows(&events, &thread_id, &words.newer_turn) } else { transcript::messages(&events, &thread_id) };
    let text = if messages.is_empty() {
        fill(if last { &words.no_reply } else { &words.no_messages }, &[("thread", js::head(&thread_id, 8))])
    } else {
        transcript::read_text(&messages)
    };
    Ok(Answer::text(text, &ReadOut { thread_id, messages }))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<ThreadsIn, ThreadsOut>(THREADS.listed);
        to_the_record::<ReadIn, ReadOut>(THREAD_READ.listed);
    }
}
