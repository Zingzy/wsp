// SPDX-License-Identifier: AGPL-3.0-only
//! The three tools that act on the pull request of the branch a thread's folder is on: fix asks that thread's agent
//! to fix a failed check or the conflicts an update from the base met, merge merges it as the person, and update
//! merges the base's latest commits into the folder's branch. Who may ask for each is the host's to say off the token.

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use super::changes::shared_of;
use super::named::{child_of, other_version, sharing_with, thread_at, thread_label, with_shared, Aim};
use super::said::turns;
use super::turn::CapWait;
use super::workspace::{self, awake, counted_number, params, read, Workspace};
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct FixIn {
    pub thread: String,
    #[serde(default)]
    pub check: Option<String>,
    #[serde(default)]
    pub child: Option<String>,
}

/// packages/protocol's FixResult, in its order.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct FixOut {
    outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    check: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    child: Option<String>,
    base: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capped: Option<CapWait>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MergeIn {
    pub thread: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub when_checks_pass: Option<bool>,
}

/// packages/protocol's MergeResult, in its order.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct MergeOut {
    #[cfg_attr(test, schemars(with = "i64"))]
    number: Number,
    method: String,
    merged: bool,
    auto_armed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct UpdateIn {
    pub thread: String,
}

/// packages/protocol's GitUpdateReply, in its order, with the threads that share the folder.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct UpdateOut {
    base: String,
    merged: bool,
    #[cfg_attr(test, schemars(with = "i64"))]
    commits: Number,
    conflicts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shared_with: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct Woken {
    id: String,
}

const FIX_NAME: &str = "fix";
const MERGE_NAME: &str = "merge";
const UPDATE_NAME: &str = "update";

pub const FIX: Tool = Tool {
    name: FIX_NAME,
    listed: include_str!(concat!(env!("OUT_DIR"), "/record/tools/fix.json")),
    call: |host, args| Box::pin(fix(host, args)),
};
pub const MERGE: Tool = Tool {
    name: MERGE_NAME,
    listed: include_str!(concat!(env!("OUT_DIR"), "/record/tools/merge.json")),
    call: |host, args| Box::pin(merge(host, args)),
};
pub const UPDATE: Tool = Tool {
    name: UPDATE_NAME,
    listed: include_str!(concat!(env!("OUT_DIR"), "/record/tools/update.json")),
    call: |host, args| Box::pin(update(host, args)),
};

/// A named check is read off the pull request as it stands, so the folder is not woken for it; without one the host
/// updates the folder from its base first, which needs its machine. The message goes to the thread named.
async fn fix(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let FixIn { thread, check, child } = input(FIX_NAME, arguments)?;
    if check.is_some() && child.is_some() {
        return Err(Failure::new(workspace::words().fix_check_or_child.clone()).into());
    }
    let client = host.client().await?;
    let words = workspace::words();
    let aim = Aim { line: "wsp fix", or_computer: false, cloud: host.cloud() };
    let (thread, source): (_, Workspace) = thread_at(&client, &thread, &aim).await?;
    let kid = match &child {
        Some(named) => Some(child_of::<Value>(&client, &thread, &source.id, named, &aim).await?),
        None => None,
    };
    let id = if check.is_none() {
        let woken: Woken = read(&awake(&client, &source, "fix").await?, "workspaces.wake")?;
        woken.id
    } else {
        source.id.clone()
    };
    let mut asked = params([("workspaceId", Value::from(id))]);
    if let Some(check) = check {
        asked.insert("check".to_owned(), Value::from(check));
    }
    if let Some((kid_thread, _, kid_workspace)) = &kid {
        asked.insert("child".to_owned(), Value::from(kid_workspace.as_str()));
        asked.insert("childThreadId".to_owned(), Value::from(kid_thread.runtime_id()));
    }
    asked.insert("threadId".to_owned(), Value::from(thread.runtime_id()));
    let done: FixOut = client.request("workspaces.fix", asked).await?;
    let name = thread_label(&thread);
    if done.outcome == "updated" {
        return Ok(Answer::text(fill(&words.fix_nothing, &[("name", &name), ("base", &done.base)]), &done));
    }
    let Some(id) = &done.agent else { return Err(other_version("workspaces.fix").into()) };
    let agent = turns().agents.get(id).cloned().unwrap_or_else(|| id.clone());
    let said = if let Some(child) = &done.child {
        let child = kid.as_ref().map_or_else(|| child.clone(), |(kid, _, _)| thread_label(kid));
        fill(&words.fix_merge_child, &[("name", &name), ("agent", &agent), ("child", &child)])
    } else if let Some(check) = &done.check {
        fill(&words.fix_asked, &[("name", &name), ("agent", &agent), ("check", check)])
    } else {
        fill(&words.fix_conflicts, &[("name", &name), ("agent", &agent), ("base", &done.base)])
    };
    let said = match &done.capped {
        Some(capped) if done.outcome == "held" => format!("{said}\n{}", capped.line()),
        _ => said,
    };
    Ok(Answer::text(said, &done))
}

/// The host merges on the head it last read, so a push since then fails in the git host's own words.
async fn merge(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let MergeIn { thread, method, when_checks_pass } = input(MERGE_NAME, arguments)?;
    let client = host.client().await?;
    let words = workspace::words();
    let aim = Aim { line: "wsp merge", or_computer: false, cloud: host.cloud() };
    let (thread, source): (_, Workspace) = thread_at(&client, &thread, &aim).await?;
    let mut asked = params([("workspaceId", Value::from(source.id.as_str()))]);
    if let Some(method) = method {
        asked.insert("method".to_owned(), Value::from(method));
    }
    if when_checks_pass == Some(true) {
        asked.insert("whenChecksPass".to_owned(), Value::Bool(true));
    }
    asked.insert("threadId".to_owned(), Value::from(thread.runtime_id()));
    let done: MergeOut = client.request("workspaces.merge", asked).await?;
    let number = done.number.to_string();
    let name = thread_label(&thread);
    let said = if done.merged {
        fill(&words.merged, &[("name", &name), ("number", &number), ("method", &done.method)])
    } else {
        fill(&words.merge_armed, &[("name", &name), ("number", &number)])
    };
    Ok(Answer::text(said, &done))
}

async fn update(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let UpdateIn { thread } = input(UPDATE_NAME, arguments)?;
    let client = host.client().await?;
    let words = workspace::words();
    let aim = Aim { line: "wsp update", or_computer: false, cloud: host.cloud() };
    let (thread, source): (_, Workspace) = thread_at(&client, &thread, &aim).await?;
    let woken: Woken = read(&awake(&client, &source, "update").await?, "workspaces.wake")?;
    let mut done: UpdateOut = client
        .request("workspaces.update", params([("workspaceId", Value::from(woken.id)), ("threadId", Value::from(thread.runtime_id()))]))
        .await?;
    let name = thread_label(&thread);
    let said = if done.merged {
        let line = if done.commits.as_f64() == Some(0.0) {
            words.updated_none.clone()
        } else {
            counted_number(&done.commits, &words.updated_one, &words.updated_many)
        };
        fill(&line, &[("name", &name), ("base", &done.base)])
    } else {
        let files = done.conflicts.join(&words.update_conflicts_join);
        fill(&words.update_conflicts, &[("name", &name), ("base", &done.base), ("files", &files)])
    };
    let shared = sharing_with(&client, &thread, &source.id).await?;
    done.shared_with = shared_of(shared.clone());
    Ok(Answer::text(with_shared(said, &shared), &done))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<FixIn, FixOut>(FIX.listed);
        to_the_record::<MergeIn, MergeOut>(MERGE.listed);
        to_the_record::<UpdateIn, UpdateOut>(UPDATE.listed);
    }
}
