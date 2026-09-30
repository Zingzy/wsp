// SPDX-License-Identifier: AGPL-3.0-only
//! The two tools that take a workspace off this computer: forget, for one whose machine is already gone, and delete,
//! which kills the machine first and asks the person through a second call before it does.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::workspace::{self, counted, params, thread_count, workspace_of, Kind, Workspace};
use super::{input, Answer, Refused, Tool};
use crate::client::Client;
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ForgetIn {
    pub workspace: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ForgetOut {
    pub workspace_id: String,
    pub name: String,
    pub threads: u64,
}

const FORGET_NAME: &str = "forget";

pub const FORGET: Tool =
    Tool { name: FORGET_NAME, listed: include_str!("../../record/tools/forget.json"), call: |host, args| Box::pin(forget(host, args)) };

async fn forget(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ForgetIn { workspace } = input(FORGET_NAME, arguments)?;
    let client = host.client().await?;
    let dropped = workspace_of(&client, &workspace).await?;
    let threads = thread_count(&client, &dropped.id).await?;
    let _: Value = client.request("workspaces.forget", params([("workspaceId", Value::from(dropped.id.as_str()))])).await?;
    let words = workspace::words();
    let said = fill(&counted(threads, &words.forgot_one, &words.forgot_many), &[("name", &dropped.name), ("id", &dropped.id)]);
    Ok(Answer::text(said, &ForgetOut { workspace_id: dropped.id, name: dropped.name, threads }))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct DeleteIn {
    pub workspace: String,
    #[serde(default)]
    pub confirm: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct DeleteOut {
    pub workspace_id: String,
    pub name: String,
    pub machine_id: String,
    pub threads: u64,
}

const DELETE_NAME: &str = "delete";

pub const DELETE: Tool =
    Tool { name: DELETE_NAME, listed: include_str!("../../record/tools/delete.json"), call: |host, args| Box::pin(delete(host, args)) };

#[derive(Deserialize)]
struct Place {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct Places {
    places: Vec<Place>,
}

/// The name of the computer somebody joined that a workspace stands on; nothing everywhere else, and where the caller
/// may not read the computers' names: `dropping`'s `on`.
async fn stands_on(client: &Client, workspace: &Workspace) -> Option<String> {
    let at = workspace.place.as_deref()?;
    let listed = client.request::<Places>("places.list", Map::new()).await.ok()?;
    listed.places.into_iter().find(|p| p.id == at).map(|p| p.name)
}

/// What a delete does to this workspace's machine, in its kind's words: a create that made none, a copy of a folder,
/// one on a computer somebody joined, by that computer's name, or the kind's own machine.
fn on_delete(workspace: &Workspace, on: Option<&str>) -> (String, String) {
    let words = workspace::words();
    let key = if workspace.machine_id.is_empty() {
        "none"
    } else if workspace.copy.is_some() {
        "copy"
    } else if on.is_some() {
        "place"
    } else {
        workspace.kind.unwrap_or(Kind::Cloud).word()
    };
    let path = workspace.copy.as_ref().map_or("", |c| c.path.as_str());
    let fills =
        [("machine", workspace.machine_id.as_str()), ("path", path), ("name", workspace.name.as_str()), ("computer", on.unwrap_or(""))];
    let said = &words.on_delete[key];
    (fill(&said.asked, &fills), fill(&said.done, &fills))
}

/// The command line asks a person before a delete; over MCP the second call is that step, so a machine is never
/// killed by one call the caller made on its own.
async fn delete(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let DeleteIn { workspace, confirm } = input(DELETE_NAME, arguments)?;
    let client = host.client().await?;
    let dropped = workspace_of(&client, &workspace).await?;
    let threads = thread_count(&client, &dropped.id).await?;
    let words = workspace::words();
    let on = stands_on(&client, &dropped).await;
    let (asked, done) = on_delete(&dropped, on.as_deref());
    let going = DeleteOut { workspace_id: dropped.id.clone(), name: dropped.name.clone(), machine_id: dropped.machine_id.clone(), threads };
    if confirm != Some(true) {
        let notice = fill(&counted(threads, &words.delete_notice_one, &words.delete_notice_many), &[("asked", &asked)]);
        return Ok(Answer::text_error(fill(&words.delete_kept, &[("name", &dropped.name), ("notice", &notice)]), &going));
    }
    let _: Value = client.request("workspaces.delete", params([("workspaceId", Value::from(dropped.id.as_str()))])).await?;
    let said =
        fill(&counted(threads, &words.deleted_one, &words.deleted_many), &[("name", &dropped.name), ("id", &dropped.id), ("done", &done)]);
    Ok(Answer::text(said, &going))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<ForgetIn, ForgetOut>(FORGET.listed);
        to_the_record::<DeleteIn, DeleteOut>(DELETE.listed);
    }

    #[test]
    fn a_copy_on_a_joined_computer_is_deleted_from_it_by_its_name_and_the_computers() {
        let workspace: Workspace = serde_json::from_value(serde_json::json!({
            "id": "ws_fix", "name": "fix-login", "machineId": "wsp-workspace-ws_fix", "phase": "running", "kind": "cloud",
            "place": "p_spoo", "project": { "id": "pr_1" }
        }))
        .unwrap();
        // A box is no cloud, and the machine's own id is wsp's, as the command line's delete says it.
        assert_eq!(
            on_delete(&workspace, Some("spoo")),
            ("copy on spoo is deleted".to_owned(), "fix-login is deleted from spoo".to_owned())
        );
    }
}
