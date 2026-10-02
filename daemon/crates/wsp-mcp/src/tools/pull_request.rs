// SPDX-License-Identifier: AGPL-3.0-only
//! The three tools that act on a workspace's pull request: fix asks the workspace's agent to fix a failed check or
//! the conflicts an update from the base met, merge merges it as the person, and update merges the base's latest
//! commits into the copy's branch. Who may ask for each is the host's to say off the token.

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use super::named::other_version;
use super::said::turns;
use super::workspace::{self, awake, counted_number, params, read, workspace_of};
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct FixIn {
    pub workspace: String,
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
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MergeIn {
    pub workspace: String,
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
    pub workspace: String,
}

/// packages/protocol's GitUpdateReply, in its order.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct UpdateOut {
    base: String,
    merged: bool,
    #[cfg_attr(test, schemars(with = "i64"))]
    commits: Number,
    conflicts: Vec<String>,
}

#[derive(Deserialize)]
struct Woken {
    id: String,
    name: String,
}

const FIX_NAME: &str = "fix";
const MERGE_NAME: &str = "merge";
const UPDATE_NAME: &str = "update";

pub const FIX: Tool =
    Tool { name: FIX_NAME, listed: include_str!("../../record/tools/fix.json"), call: |host, args| Box::pin(fix(host, args)) };
pub const MERGE: Tool =
    Tool { name: MERGE_NAME, listed: include_str!("../../record/tools/merge.json"), call: |host, args| Box::pin(merge(host, args)) };
pub const UPDATE: Tool =
    Tool { name: UPDATE_NAME, listed: include_str!("../../record/tools/update.json"), call: |host, args| Box::pin(update(host, args)) };

/// A named check is read off the pull request as it stands, so the copy is not woken for it; without one the host
/// updates the copy from its base first, which needs its machine.
async fn fix(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let FixIn { workspace, check, child } = input(FIX_NAME, arguments)?;
    if check.is_some() && child.is_some() {
        return Err(Failure::new(workspace::words().fix_check_or_child.clone()).into());
    }
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    let (id, name) = if check.is_none() {
        let woken: Woken = read(&awake(&client, &source, "fix").await?, "workspaces.wake")?;
        (woken.id, woken.name)
    } else {
        (source.id.clone(), source.name.clone())
    };
    let mut asked = params([("workspaceId", Value::from(id))]);
    if let Some(check) = check {
        asked.insert("check".to_owned(), Value::from(check));
    }
    if let Some(child) = child {
        asked.insert("child".to_owned(), Value::from(child));
    }
    let done: FixOut = client.request("workspaces.fix", asked).await?;
    let words = workspace::words();
    if done.outcome == "updated" {
        return Ok(Answer::text(fill(&words.fix_nothing, &[("name", &name), ("base", &done.base)]), &done));
    }
    let Some(id) = &done.agent else { return Err(other_version("workspaces.fix").into()) };
    let agent = turns().agents.get(id).cloned().unwrap_or_else(|| id.clone());
    let said = if let Some(child) = &done.child {
        fill(&words.fix_merge_child, &[("name", &name), ("agent", &agent), ("child", child)])
    } else if let Some(check) = &done.check {
        fill(&words.fix_asked, &[("name", &name), ("agent", &agent), ("check", check)])
    } else {
        fill(&words.fix_conflicts, &[("name", &name), ("agent", &agent), ("base", &done.base)])
    };
    Ok(Answer::text(said, &done))
}

/// The host merges on the head it last read, so a push since then fails in the git host's own words.
async fn merge(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let MergeIn { workspace, method, when_checks_pass } = input(MERGE_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    let mut asked = params([("workspaceId", Value::from(source.id.as_str()))]);
    if let Some(method) = method {
        asked.insert("method".to_owned(), Value::from(method));
    }
    if when_checks_pass == Some(true) {
        asked.insert("whenChecksPass".to_owned(), Value::Bool(true));
    }
    let done: MergeOut = client.request("workspaces.merge", asked).await?;
    let words = workspace::words();
    let number = done.number.to_string();
    let said = if done.merged {
        fill(&words.merged, &[("name", &source.name), ("number", &number), ("method", &done.method)])
    } else {
        fill(&words.merge_armed, &[("name", &source.name), ("number", &number)])
    };
    Ok(Answer::text(said, &done))
}

async fn update(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let UpdateIn { workspace } = input(UPDATE_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    let woken: Woken = read(&awake(&client, &source, "update").await?, "workspaces.wake")?;
    let done: UpdateOut = client.request("workspaces.update", params([("workspaceId", Value::from(woken.id))])).await?;
    let words = workspace::words();
    let said = if done.merged {
        let line = if done.commits.as_f64() == Some(0.0) {
            words.updated_none.clone()
        } else {
            counted_number(&done.commits, &words.updated_one, &words.updated_many)
        };
        fill(&line, &[("name", &woken.name), ("base", &done.base)])
    } else {
        let files = done.conflicts.join(&words.update_conflicts_join);
        fill(&words.update_conflicts, &[("name", &woken.name), ("base", &done.base), ("files", &files)])
    };
    Ok(Answer::text(said, &done))
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
