// SPDX-License-Identifier: AGPL-3.0-only
//! The tree of branches' one tool: a child's branch merged into its lead's copy with a merge commit, the lead woken
//! first where it sleeps.

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use super::workspace::{self, awake, counted_number, params, read, workspace_of};
use super::{input, Answer, Refused, Tool};
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MergeInIn {
    pub lead: String,
    pub child: String,
}

/// packages/protocol's MergeInResult, in its order.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MergeInOut {
    lead: String,
    child: String,
    branch: String,
    merged: bool,
    #[cfg_attr(test, schemars(with = "i64"))]
    commits: Number,
    conflicts: Vec<String>,
}

const MERGE_IN_NAME: &str = "merge_in";

pub const MERGE_IN: Tool = Tool {
    name: MERGE_IN_NAME,
    listed: include_str!("../../record/tools/merge_in.json"),
    call: |host, args| Box::pin(merge_in(host, args)),
};

/// The one line a merge reads as: the files it stopped on, the commits it brought, or that there was nothing to take.
fn merge_in_line(done: &MergeInOut) -> String {
    let words = workspace::words();
    if !done.merged {
        return fill(&words.merge_conflicts, &[("lead", &done.lead), ("branch", &done.branch), ("paths", &done.conflicts.join(", "))]);
    }
    if done.commits.as_f64() == Some(0.0) {
        return fill(&words.nothing_to_merge, &[("lead", &done.lead), ("child", &done.child)]);
    }
    let merged = counted_number(&done.commits, &words.merged_in_one, &words.merged_in_many);
    fill(&merged, &[("lead", &done.lead), ("branch", &done.branch), ("child", &done.child)])
}

async fn merge_in(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Woken {
        id: String,
    }
    let MergeInIn { lead, child } = input(MERGE_IN_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &lead).await?;
    let woken: Woken = read(&awake(&client, &source, "merge in").await?, "workspaces.wake")?;
    let done: MergeInOut =
        client.request("workspaces.mergeIn", params([("workspaceId", Value::from(woken.id)), ("child", Value::from(child))])).await?;
    Ok(Answer::text(merge_in_line(&done), &done))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<MergeInIn, MergeInOut>(MERGE_IN.listed);
    }
}
