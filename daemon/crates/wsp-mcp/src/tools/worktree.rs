// SPDX-License-Identifier: AGPL-3.0-only
//! The two worktree tools: worktree answers the path of a worktree of a project's repo on a branch, made under wsp's
//! folder where none holds it, and worktree_remove takes away one wsp made. The host does the git work; these name it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::workspace::{self, params};
use super::{input, Answer, Refused, Tool};
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MakeIn {
    pub project: String,
    pub branch: String,
}

/// packages/protocol's WorktreeMade, in its order, since the TypeScript tool parses the host's answer with it.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MakeOut {
    pub path: String,
    pub branch: String,
    pub made: bool,
}

const MAKE_NAME: &str = "worktree";

pub const MAKE: Tool =
    Tool { name: MAKE_NAME, listed: include_str!("../../record/tools/worktree.json"), call: |host, args| Box::pin(make(host, args)) };

async fn make(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let MakeIn { project, branch } = input(MAKE_NAME, arguments)?;
    let client = host.client().await?;
    let made: MakeOut =
        client.request("worktree.make", params([("project", Value::from(project)), ("branch", Value::from(branch))])).await?;
    Ok(Answer::text(made.path.clone(), &made))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RemoveIn {
    pub project: String,
    pub branch: String,
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RemoveOut {
    pub project: String,
    pub branch: String,
    pub removed: bool,
}

const REMOVE_NAME: &str = "worktree_remove";

pub const REMOVE: Tool = Tool {
    name: REMOVE_NAME,
    listed: include_str!("../../record/tools/worktree_remove.json"),
    call: |host, args| Box::pin(remove(host, args)),
};

async fn remove(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let RemoveIn { project, branch, force } = input(REMOVE_NAME, arguments)?;
    let client = host.client().await?;
    let mut asked = params([("project", Value::from(project.as_str())), ("branch", Value::from(branch.as_str()))]);
    if force == Some(true) {
        asked.insert("force".to_owned(), Value::Bool(true));
    }
    let _: Value = client.request("worktree.remove", asked).await?;
    let said = fill(&workspace::words().worktree_removed, &[("branch", &branch)]);
    Ok(Answer::text(said, &RemoveOut { project, branch, removed: true }))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<MakeIn, MakeOut>(MAKE.listed);
        to_the_record::<RemoveIn, RemoveOut>(REMOVE.listed);
    }
}
