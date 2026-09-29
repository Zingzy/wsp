// SPDX-License-Identifier: AGPL-3.0-only
//! The tools that change one workspace's machine or its record and answer with the record after: pause, wake,
//! snapshot, rename, rebuild and the agents switch.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Number, Value};

use super::workspace::{self, agents_asked, agents_line, awake, params, read, rebuilt_line, state_of, workspace_of, Agents, Phase};
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct WorkspaceIn {
    pub workspace: String,
}

/// A workspace as the host sent it, passed through in its own bytes.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct WorkspaceOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub workspace: Box<RawValue>,
}

#[derive(Deserialize)]
struct Reply {
    workspace: Box<RawValue>,
}

/// What a tool reads off the view the host answered with.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Named {
    id: String,
    name: String,
    machine_id: String,
    phase: Phase,
    #[serde(default)]
    agents: Option<Agents>,
}

async fn acted(host: &Host, reference: &str, op: &str) -> Result<Box<RawValue>, Failure> {
    let client = host.client().await?;
    let source = workspace_of(&client, reference).await?;
    let reply: Reply = client.request(op, params([("workspaceId", Value::from(source.id))])).await?;
    Ok(reply.workspace)
}

const PAUSE_NAME: &str = "pause";

pub const PAUSE: Tool =
    Tool { name: PAUSE_NAME, listed: include_str!("../../record/tools/pause.json"), call: |host, args| Box::pin(pause(host, args)) };

async fn pause(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let WorkspaceIn { workspace } = input(PAUSE_NAME, arguments)?;
    Ok(Answer::json(&WorkspaceOut { workspace: acted(&host, &workspace, "workspaces.nap").await? }))
}

const WAKE_NAME: &str = "wake";

pub const WAKE: Tool =
    Tool { name: WAKE_NAME, listed: include_str!("../../record/tools/wake.json"), call: |host, args| Box::pin(wake(host, args)) };

async fn wake(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let WorkspaceIn { workspace } = input(WAKE_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    Ok(Answer::json(&WorkspaceOut { workspace: awake(&client, &source, "wake").await? }))
}

const REBUILD_NAME: &str = "rebuild";

pub const REBUILD: Tool =
    Tool { name: REBUILD_NAME, listed: include_str!("../../record/tools/rebuild.json"), call: |host, args| Box::pin(rebuild(host, args)) };

/// The status is read beside the record, since the record alone carries no reach: a machine that stopped answering
/// is the row's own refusal, not a rebuild.
async fn rebuild(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Reach {
        #[serde(default)]
        state: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        id: String,
        #[serde(default)]
        machine_state: Option<String>,
        #[serde(default)]
        reach: Option<Reach>,
    }
    #[derive(Deserialize)]
    struct Statuses {
        statuses: Vec<Status>,
    }
    let WorkspaceIn { workspace } = input(REBUILD_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    let listed: Statuses = client.request("status.list", serde_json::Map::new()).await?;
    let status = listed.statuses.into_iter().find(|s| s.id == source.id);
    let machine = status.as_ref().and_then(|s| s.machine_state.as_deref());
    let reach = status.as_ref().and_then(|s| s.reach.as_ref()).and_then(|r| r.state.as_deref());
    let state = state_of(source.phase, machine, reach);
    if state != "gone" && reach != Some("zombie") && source.wake_refused.is_none() {
        return Err(Failure::new(workspace::words().rebuild_refused[state].clone()).into());
    }
    let reply: Reply = client.request("workspaces.rebuild", params([("workspaceId", Value::from(source.id))])).await?;
    let now: Named = read(&reply.workspace, "workspaces.rebuild")?;
    Ok(Answer::text(rebuilt_line(&now.name, now.phase, &now.machine_id), &WorkspaceOut { workspace: reply.workspace }))
}

const SNAPSHOT_NAME: &str = "snapshot";

pub const SNAPSHOT: Tool = Tool {
    name: SNAPSHOT_NAME,
    listed: include_str!("../../record/tools/snapshot.json"),
    call: |host, args| Box::pin(snapshot(host, args)),
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SnapshotOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub project_golden: Box<RawValue>,
}

async fn snapshot(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let WorkspaceIn { workspace } = input(SNAPSHOT_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    let taken: SnapshotOut = client.request("workspaces.snapshot", params([("workspaceId", Value::from(source.id))])).await?;
    Ok(Answer::json(&taken))
}

const RENAME_NAME: &str = "rename";

pub const RENAME: Tool =
    Tool { name: RENAME_NAME, listed: include_str!("../../record/tools/rename.json"), call: |host, args| Box::pin(rename(host, args)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RenameIn {
    pub workspace: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RenameOut {
    pub was: String,
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub workspace: Box<RawValue>,
}

async fn rename(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let RenameIn { workspace, name } = input(RENAME_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    let reply: Reply =
        client.request("workspaces.rename", params([("workspaceId", Value::from(source.id)), ("name", Value::from(name))])).await?;
    let now: Named = read(&reply.workspace, "workspaces.rename")?;
    let said = fill(&workspace::words().renamed, &[("was", &source.name), ("name", &now.name), ("id", &now.id)]);
    Ok(Answer::text(said, &RenameOut { was: source.name, workspace: reply.workspace }))
}

const AGENTS_NAME: &str = "workspaces_agents";

pub const AGENTS: Tool = Tool {
    name: AGENTS_NAME,
    listed: include_str!("../../record/tools/workspaces_agents.json"),
    call: |host, args| Box::pin(set_agents(host, args)),
};

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AgentsIn {
    pub workspace: String,
    #[serde(default)]
    pub spawn: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub max_machines: Option<Number>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub max_depth: Option<Number>,
}

async fn set_agents(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let AgentsIn { workspace, spawn, max_machines, max_depth } = input(AGENTS_NAME, arguments)?;
    let asked = agents_asked(spawn.as_deref(), max_machines.as_ref(), max_depth.as_ref())
        .ok_or_else(|| Failure::usage(workspace::words().agents_nothing))?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    let mut frame = params([("workspaceId", Value::from(source.id))]);
    frame.extend(asked);
    let reply: Reply = client.request("workspaces.agents", frame).await?;
    let now: Named = read(&reply.workspace, "workspaces.agents")?;
    let said = fill(&workspace::words().agents_set, &[("name", &now.name), ("agents", &agents_line(now.agents.as_ref()))]);
    Ok(Answer::text(said, &WorkspaceOut { workspace: reply.workspace }))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        for tool in [&PAUSE, &WAKE, &REBUILD] {
            to_the_record::<WorkspaceIn, WorkspaceOut>(tool.listed);
        }
        to_the_record::<WorkspaceIn, SnapshotOut>(SNAPSHOT.listed);
        to_the_record::<RenameIn, RenameOut>(RENAME.listed);
        to_the_record::<AgentsIn, WorkspaceOut>(AGENTS.listed);
    }
}
