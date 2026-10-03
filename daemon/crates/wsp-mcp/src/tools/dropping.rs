// SPDX-License-Identifier: AGPL-3.0-only
//! The two tools that take a workspace off this computer: forget, for one whose machine is already gone, and delete,
//! which kills the machine first and asks the person through a second call before it does. Named by thread, delete
//! takes a thread on this computer away, with the worktree wsp made for it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::named::thread_of;
use super::workspace::{self, counted, params, thread_count, workspace_of, Kind, Workspace};
use super::{input, Answer, Refused, Tool};
use crate::client::Client;
use crate::failure::Failure;
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
    refuse_folder(&dropped)?;
    let threads = thread_count(&client, &dropped.id).await?;
    let _: Value = client.request("workspaces.forget", params([("workspaceId", Value::from(dropped.id.as_str()))])).await?;
    let words = workspace::words();
    let said = fill(&counted(threads, &words.forgot_one, &words.forgot_many), &[("name", &dropped.name), ("id", &dropped.id)]);
    Ok(Answer::text(said, &ForgetOut { workspace_id: dropped.id, name: dropped.name, threads }))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct DeleteIn {
    #[serde(default)]
    pub thread: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub confirm: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct DeleteOut {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    pub threads: u64,
}

const DELETE_NAME: &str = "delete";

pub const DELETE: Tool =
    Tool { name: DELETE_NAME, listed: include_str!("../../record/tools/delete.json"), call: |host, args| Box::pin(delete(host, args)) };

#[derive(Deserialize)]
struct Place {
    id: String,
    name: String,
    #[serde(default)]
    kind: String,
}

#[derive(Deserialize)]
struct Places {
    places: Vec<Place>,
}

/// The name of the computer somebody joined that a workspace stands on, as `deleting`'s `on` reads it: the recorded
/// word for one whose name the caller could not read, never the machine's id, and nothing for a fork at another
/// provider's account, which is a cloud machine and takes its kind's words.
async fn stands_on(client: &Client, workspace: &Workspace) -> Option<String> {
    let at = workspace.place.as_deref()?;
    let Ok(listed) = client.request::<Places>("places.list", Map::new()).await else {
        return Some(workspace::words().unnamed_computer.clone());
    };
    listed.places.into_iter().find(|p| p.id == at && p.kind != "provider").map(|p| p.name)
}

/// What a delete does to this workspace's machine, in its kind's words: a create that made none, a worktree wsp made,
/// one on a computer somebody joined, by that computer's name, or the kind's own machine.
fn on_delete(workspace: &Workspace, on: Option<&str>) -> (String, String) {
    let words = workspace::words();
    let key = if workspace.machine_id.is_empty() {
        "none"
    } else if workspace.worktree.as_ref().is_some_and(|w| w.removable()) {
        "worktree"
    } else if on.is_some() {
        "place"
    } else {
        workspace.kind.unwrap_or(Kind::Cloud).word()
    };
    let path = workspace.worktree.as_ref().filter(|w| w.removable()).map_or("", |w| w.path.as_str());
    let fills =
        [("machine", workspace.machine_id.as_str()), ("path", path), ("name", workspace.name.as_str()), ("computer", on.unwrap_or(""))];
    let said = &words.on_delete[key];
    (fill(&said.asked, &fills), fill(&said.done, &fills))
}

/// The command line asks a person before a delete; over MCP the second call is that step, so a machine is never
/// killed by one call the caller made on its own.
async fn delete(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let DeleteIn { thread, workspace, confirm } = input(DELETE_NAME, arguments)?;
    let client = host.client().await?;
    let words = workspace::words();
    if let Some(named) = thread {
        return delete_thread(&client, &named, confirm == Some(true)).await;
    }
    let Some(workspace) = workspace else { return Err(Failure::usage(words.delete_names_nothing).into()) };
    let dropped = workspace_of(&client, &workspace).await?;
    refuse_folder(&dropped)?;
    let threads = thread_count(&client, &dropped.id).await?;
    let on = stands_on(&client, &dropped).await;
    let (asked, done) = on_delete(&dropped, on.as_deref());
    let going = DeleteOut {
        thread_id: None,
        workspace_id: dropped.id.clone(),
        worktree: None,
        name: Some(dropped.name.clone()),
        machine_id: Some(dropped.machine_id.clone()),
        threads,
    };
    if confirm != Some(true) {
        let notice = fill(&counted(threads, &words.delete_notice_one, &words.delete_notice_many), &[("asked", &asked)]);
        return Ok(Answer::text_error(fill(&words.delete_kept, &[("name", &dropped.name), ("notice", &notice)]), &going));
    }
    let _: Value = client.request("workspaces.delete", params([("workspaceId", Value::from(dropped.id.as_str()))])).await?;
    let said =
        fill(&counted(threads, &words.deleted_one, &words.deleted_many), &[("name", &dropped.name), ("id", &dropped.id), ("done", &done)]);
    Ok(Answer::text(said, &going))
}

/// A folder of a project on this computer is never named to delete or forget: its threads are what goes.
fn refuse_folder(workspace: &Workspace) -> Result<(), Failure> {
    if workspace.kind == Some(Kind::Local) {
        return Err(Failure::usage(fill(&workspace::words().local_folder, &[("name", &workspace.name)])));
    }
    Ok(())
}

/// A thread on this computer, with the worktree wsp made that it runs in; nothing where the word names no thread, or
/// one on a box, which a workspace delete takes.
async fn delete_thread(client: &Client, named: &str, confirm: bool) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Folder {
        id: String,
        #[serde(default)]
        kind: Option<Kind>,
        #[serde(default)]
        worktree: Option<workspace::Worktree>,
    }
    #[derive(Deserialize)]
    struct Listed {
        workspaces: Vec<Folder>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Deleted {
        workspace_id: String,
        #[serde(default)]
        worktree: Option<String>,
        threads: u64,
    }
    let words = workspace::words();
    let not_here = || Failure::usage(fill(&words.no_thread_here, &[("ref", named)]));
    let Ok(thread) = thread_of(client, named).await else { return Err(not_here().into()) };
    let Listed { workspaces } = client.request("workspaces.list", Map::new()).await?;
    let at = workspaces.into_iter().find(|w| w.id == thread.workspace_id).filter(|w| w.kind == Some(Kind::Local)).ok_or_else(not_here)?;
    let id = thread.runtime_id().to_owned();
    let worktree = at.worktree.filter(|w| w.removable()).map(|w| w.path);
    if !confirm {
        let said = match &worktree {
            Some(path) => fill(&words.thread_kept_worktree, &[("thread", &id), ("path", path)]),
            None => fill(&words.thread_kept_folder, &[("thread", &id)]),
        };
        let going = DeleteOut { thread_id: Some(id), workspace_id: at.id, worktree: None, name: None, machine_id: None, threads: 1 };
        return Ok(Answer::text_error(said, &going));
    }
    let gone: Deleted = client.request("sessions.delete", params([("threadId", Value::from(id.as_str()))])).await?;
    let said = match &gone.worktree {
        Some(path) => {
            fill(&counted(gone.threads, &words.thread_deleted_one, &words.thread_deleted_many), &[("thread", &id), ("path", path)])
        }
        None => fill(&words.thread_deleted, &[("thread", &id)]),
    };
    let out = DeleteOut {
        thread_id: Some(id),
        workspace_id: gone.workspace_id,
        worktree: gone.worktree,
        name: None,
        machine_id: None,
        threads: gone.threads,
    };
    Ok(Answer::text(said, &out))
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
