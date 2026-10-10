// SPDX-License-Identifier: AGPL-3.0-only
//! What the thread and turn tools name before they act: a thread by its id or a prefix of it, off the session index
//! folded into threads as packages/protocol/src/index.ts `foldThreads` folds it; a workspace by its name or id, as
//! the host resolves it; and the wake every tool that needs the machine goes through, as
//! packages/host/src/verbs.ts `awake` wakes it. Only the fields these tools read are folded.

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{Map, Value};

use super::said::{quoted_inside, turns};
use super::target::refusal_line;
use crate::client::Client;
use crate::failure::Failure;
use crate::record::fill;

/// One thread as the sidebar folds it, as far as these tools read one: `id` is the fold key, `thread_id` the
/// runtime's, `session_id` the latest turn's row, which a stop interrupts.
#[derive(Debug, Clone)]
pub struct Thread {
    pub id: String,
    pub thread_id: Option<String>,
    pub workspace_id: String,
    pub harness: String,
    pub status: String,
    pub session_id: String,
    pub ran: bool,
    /// The folder its latest turn ran in, absent where none recorded one.
    pub cwd: Option<String>,
}

impl Thread {
    /// The runtime's thread id, the one its events carry; a row from before threads is its own.
    pub fn runtime_id(&self) -> &str {
        self.thread_id.as_deref().unwrap_or(&self.id)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRow {
    #[serde(default)]
    id: String,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    harness: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    claude_session_id: Option<String>,
    #[serde(default)]
    refusal: Option<Value>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct Sessions {
    sessions: Vec<SessionRow>,
}

fn fold(rows: Vec<SessionRow>) -> Vec<Thread> {
    let mut threads: Vec<(String, Vec<SessionRow>)> = Vec::new();
    for row in rows {
        let key = row.thread_id.clone().unwrap_or_else(|| row.id.clone());
        match threads.iter_mut().find(|(k, _)| *k == key) {
            Some((_, turns)) => turns.push(row),
            None => threads.push((key, vec![row])),
        }
    }
    threads
        .into_iter()
        .map(|(id, turns)| {
            let ran = turns.iter().any(|t| t.status == "running" || (t.claude_session_id.is_some() && t.refusal.is_none()));
            let first = &turns[0];
            let latest = &turns[turns.len() - 1];
            Thread {
                thread_id: first.thread_id.clone(),
                workspace_id: first.workspace_id.clone(),
                harness: first.harness.clone(),
                status: latest.status.clone(),
                session_id: latest.id.clone(),
                cwd: latest.cwd.clone(),
                ran,
                id,
            }
        })
        .collect()
}

/// Every thread, or the threads of one workspace.
pub async fn threads(client: &Client, workspace_id: Option<&str>) -> Result<Vec<Thread>, Failure> {
    let params = workspace_id.map(|id| params([("workspaceId", Value::from(id))])).unwrap_or_default();
    Ok(fold(client.request::<Sessions>("sessions.list", params).await?.sessions))
}

fn pick(all: &[Thread], named: &str) -> Result<Thread, Failure> {
    if let Some(exact) = all.iter().find(|t| t.id == named) {
        return Ok(exact.clone());
    }
    let prefixed: Vec<&Thread> = all.iter().filter(|t| t.id.starts_with(named)).collect();
    match prefixed.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(Failure::of_kind(fill(&turns().no_thread, &[("ref", named)]), "not-found")),
        several => Err(Failure::new(fill(&turns().several_threads, &[("count", &several.len().to_string()), ("ref", named)]))),
    }
}

/// A thread by id, or by a prefix of it that names exactly one.
pub async fn thread_of(client: &Client, named: &str) -> Result<Thread, Failure> {
    pick(&threads(client, None).await?, named)
}

/// Several threads by the same rule, off one listing, in the order named.
pub async fn threads_of(client: &Client, named: &[String]) -> Result<Vec<Thread>, Failure> {
    let all = threads(client, None).await?;
    named.iter().map(|n| pick(&all, n)).collect()
}

/// A thread a tool names and the record of the folder it works in, as packages/host/src/verbs/turns-help.ts
/// `threadAt` reads them: the thread by its id or a prefix naming one, then its record through the host, which
/// refuses one the caller may not drive. A word that names no thread is read once more, so a project's name, or with
/// a cloud a machine's, is refused saying the line takes a thread, in the same words as the command line.
pub async fn thread_at<W: DeserializeOwned>(client: &Client, named: &str, at: &Aim<'_>) -> Result<(Thread, W), Failure> {
    let thread = match thread_of(client, named).await {
        Ok(thread) => thread,
        Err(missing) => {
            if missing.kind.as_deref() == Some("not-found") {
                refuse_not_a_thread(client, named, at).await?;
            }
            return Err(missing);
        }
    };
    #[derive(Deserialize)]
    struct Got {
        #[serde(default)]
        workspace: Value,
    }
    let got: Got = client
        .request(
            "workspaces.get",
            params([("workspaceId", Value::from(thread.workspace_id.as_str())), ("threadId", Value::from(thread.runtime_id()))]),
        )
        .await?;
    let read = workspace_out(&got.workspace).and_then(|_| serde_json::from_value(got.workspace).ok());
    Ok((thread, read.ok_or_else(|| other_version("workspaces.get"))?))
}

/// What a tool's thread is refused in the words of: the line's name, whether the line takes a computer too, and
/// whether a cloud is on, where a machine's name is the word a person may still type.
pub struct Aim<'a> {
    pub line: &'a str,
    pub or_computer: bool,
    pub cloud: bool,
}

/// Refuses a word that names a project, or with a cloud a machine, in the words of a line that takes a thread;
/// nothing for any other word, so the tool's own refusal stands.
async fn refuse_not_a_thread(client: &Client, named: &str, at: &Aim<'_>) -> Result<(), Failure> {
    let words = super::workspace::words();
    let said = |project: &str, on: &str| {
        let template = if at.or_computer { on } else { project };
        Failure::usage(refusal_line(&fill(template, &[("word", named), ("line", at.line)]), &words.name_a_thread_fix))
    };
    if super::turn::projects_here(client).await.unwrap_or_default().iter().any(|p| p.id == named || p.name == named) {
        return Err(said(&words.not_a_thread_project, &words.not_a_thread_project_or_on));
    }
    if !at.cloud {
        return Ok(());
    }
    #[derive(Deserialize)]
    struct Listed {
        workspaces: Vec<Listing>,
    }
    #[derive(Deserialize)]
    struct Listing {
        id: String,
        name: String,
        #[serde(default)]
        kind: Option<super::workspace::Kind>,
    }
    let listed = client.request::<Listed>("workspaces.list", Map::new()).await.map(|l| l.workspaces).unwrap_or_default();
    if listed.iter().any(|w| !w.kind.is_some_and(super::workspace::Kind::in_folder) && (w.id == named || w.name == named)) {
        return Err(said(&words.not_a_thread_machine, &words.not_a_thread_machine_or_on));
    }
    Ok(())
}

/// The other threads in a thread's folder, by id, which a commit, a discard or an update acted for too.
pub async fn sharing_with(client: &Client, thread: &Thread, workspace_id: &str) -> Result<Vec<String>, Failure> {
    let mine = thread.runtime_id();
    Ok(threads(client, Some(workspace_id))
        .await?
        .into_iter()
        .filter(|t| t.workspace_id == workspace_id && t.runtime_id() != mine)
        .map(|t| t.runtime_id().to_owned())
        .collect())
}

/// A thread as an answer line opens with it.
pub fn thread_label(thread: &Thread) -> String {
    fill(&super::workspace::words().thread_label, &[("thread", &thread_word(thread.runtime_id()))])
}

/// The first characters of a thread's id a person reads, as packages/protocol's `threadWord` cuts them.
pub fn thread_word(id: &str) -> String {
    id.chars().take(8).collect()
}

/// An answer line with the threads that share the folder under it.
pub fn with_shared(line: String, shared: &[String]) -> String {
    let words = super::workspace::words();
    let short: Vec<String> = shared.iter().map(|id| thread_word(id)).collect();
    match short.as_slice() {
        [] => line,
        [one] => format!("{line}\n{}", fill(&words.shared_one, &[("thread", one)])),
        [rest @ .., last] => format!("{line}\n{}", fill(&words.shared_many, &[("list", &rest.join(&words.shared_join)), ("last", last)])),
    }
}

/// A child thread named to merge into its lead's folder: one in that same folder has nothing apart to merge.
pub async fn child_of<W: DeserializeOwned>(
    client: &Client,
    lead: &Thread,
    lead_workspace: &str,
    named: &str,
    at: &Aim<'_>,
) -> Result<(Thread, W, String), Failure> {
    let (kid, raw): (Thread, Value) = thread_at(client, named, at).await?;
    let kid_workspace = raw.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
    if kid_workspace == lead_workspace {
        let said = fill(
            &super::workspace::words().child_beside_lead,
            &[("child", &thread_word(kid.runtime_id())), ("lead", &thread_word(lead.runtime_id()))],
        );
        return Err(Failure::usage(said));
    }
    let read = serde_json::from_value(raw).map_err(|_| other_version("workspaces.get"))?;
    Ok((kid, read, kid_workspace))
}

/// A workspace as far as these tools read one.
#[derive(Debug, Clone, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub phase: String,
    #[serde(default)]
    pub gone: Option<String>,
}

const PHASES: [&str; 5] = ["running", "pausing", "napping", "waking", "gone"];

/// The fields `WorkspaceOut` requires, each of its type: a reply short of them is a host of another version.
fn workspace_out(value: &Value) -> Option<Workspace> {
    let strings = |v: &Value, keys: &[&str]| keys.iter().all(|k| v.get(*k).is_some_and(Value::is_string));
    let optional = |k: &str| value.get(k).is_none_or(Value::is_string);
    let phase = value.get("phase").and_then(Value::as_str).is_some_and(|p| PHASES.contains(&p));
    let project = value.get("project").is_some_and(|p| strings(p, &["id", "name", "path", "computer"]));
    (strings(value, &["id", "name", "machineId", "golden", "createdAt"]) && phase && project && optional("gone") && optional("home"))
        .then(|| serde_json::from_value(value.clone()).ok())
        .flatten()
}

/// A workspace as a person names it, by id or by the name exactly one carries; the host reads the name.
pub async fn workspace_of(client: &Client, named: &str) -> Result<Workspace, Failure> {
    resolved(client, params([("ref", Value::from(named))])).await
}

async fn resolved(client: &Client, asked: Map<String, Value>) -> Result<Workspace, Failure> {
    #[derive(Deserialize)]
    struct Resolved {
        #[serde(default)]
        workspace: Value,
    }
    let resolved: Resolved = client.request("workspaces.resolve", asked).await?;
    workspace_out(&resolved.workspace).ok_or_else(|| other_version("workspaces.resolve"))
}

/// The folder a thread works in, as its latest turn ran there; none where that was a worktree since gone, whose next
/// turn runs in the folder its record answers now.
pub fn thread_cwd(thread: &Thread, record: &Value) -> Option<String> {
    let cwd = thread.cwd.as_deref()?;
    let gone = record.pointer("/worktree/gone").and_then(Value::as_bool) == Some(true);
    let moved = gone
        && record
            .pointer("/worktree/path")
            .and_then(Value::as_str)
            .is_some_and(|p| cwd == p || cwd.starts_with(&format!("{}/", p.trim_end_matches('/'))));
    (!moved).then(|| cwd.to_owned())
}

pub fn other_version(op: &str) -> Failure {
    Failure::new(fill(&turns().other_version, &[("op", op)]))
}

/// A reply whose outcome is one of the protocol's own, read as `T`: any other shape is a host of another version,
/// which the TypeScript parse of the same reply refuses.
pub fn with_outcome<T: DeserializeOwned>(op: &str, reply: Value, outcomes: &[&str]) -> Result<T, Failure> {
    let known = reply.get("outcome").and_then(Value::as_str).is_some_and(|o| outcomes.contains(&o));
    if !known {
        return Err(other_version(op));
    }
    serde_json::from_value(reply).map_err(|_| other_version(op))
}

/// The state a phase reads as, the only part of the fold a wake is decided on.
fn state(phase: &str) -> &str {
    match phase {
        "napping" => "paused",
        other => other,
    }
}

pub struct Woken {
    pub workspace: Workspace,
    /// Whether this call took the machine off its nap, which is what makes a launch that died owe it one back.
    pub woke: bool,
}

/// The machine awake before a tool asks it anything: a gone one is refused in the words of the tool's action.
pub async fn awake(client: &Client, workspace: &Workspace, action: &str) -> Result<Woken, Failure> {
    let before = state(&workspace.phase);
    if before == "gone" {
        let said = match workspace.gone.as_deref() {
            None | Some("") => fill(&turns().gone, &[("name", &workspace.name), ("action", action)]),
            Some(words) => fill(&turns().gone_with, &[("name", &workspace.name), ("action", action), ("words", words)]),
        };
        return Err(Failure::new(said));
    }
    #[derive(Deserialize)]
    struct Waking {
        workspace: Workspace,
    }
    let woken: Waking = client.request("workspaces.wake", params([("workspaceId", Value::from(workspace.id.as_str()))])).await?;
    let woke = matches!(before, "paused" | "pausing") && state(&woken.workspace.phase) == "running";
    Ok(Woken { workspace: woken.workspace, woke })
}

/// The workspace's transcript as the host holds it, each event as it came.
pub async fn history(client: &Client, workspace_id: &str) -> Result<Vec<Value>, Failure> {
    #[derive(Deserialize)]
    struct Events {
        events: Vec<Value>,
    }
    Ok(client.request::<Events>("sessions.history", params([("workspaceId", Value::from(workspace_id))])).await?.events)
}

/// A folder on the machine a thread starts or a command runs in, refused unless absolute: whoever reads it works in
/// a folder this caller cannot see.
pub fn absolute_folder(cwd: Option<&str>) -> Result<Option<&str>, Failure> {
    match cwd {
        Some(path) if !path.starts_with('/') => Err(Failure::usage(fill(&turns().cwd_not_absolute, &[("path", &quoted_inside(path))]))),
        other => Ok(other),
    }
}

pub fn params<const N: usize>(fields: [(&str, Value); N]) -> Map<String, Value> {
    fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, thread: Option<&str>, status: &str) -> SessionRow {
        SessionRow {
            id: id.into(),
            thread_id: thread.map(Into::into),
            workspace_id: "w".into(),
            harness: "claude".into(),
            status: status.into(),
            claude_session_id: None,
            refusal: None,
            cwd: None,
        }
    }

    #[test]
    fn a_thread_works_in_its_own_folder_unless_that_was_a_worktree_since_gone() {
        let mut thread = fold(vec![row("s1", Some("t1"), "completed")]).remove(0);
        thread.cwd = Some("/root/proj/sub".into());
        assert_eq!(thread_cwd(&thread, &serde_json::json!({ "id": "w" })).as_deref(), Some("/root/proj/sub"));
        let gone = serde_json::json!({ "id": "w", "worktree": { "path": "/root/proj", "gone": true } });
        assert_eq!(thread_cwd(&thread, &gone), None);
        thread.cwd = None;
        assert_eq!(thread_cwd(&thread, &serde_json::json!({ "id": "w" })), None);
    }

    #[test]
    fn folds_turns_into_threads_in_first_appearance_order() {
        let threads = fold(vec![row("s1", Some("t1"), "completed"), row("s2", None, "failed"), row("s3", Some("t1"), "running")]);
        assert_eq!(threads.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t1", "s2"]);
        assert_eq!((threads[0].session_id.as_str(), threads[0].status.as_str(), threads[0].ran), ("s3", "running", true));
        assert_eq!((threads[1].runtime_id(), threads[1].ran), ("s2", false));
    }

    #[test]
    fn an_outcome_outside_the_enum_is_a_host_of_another_version() {
        let read = |reply: Value| with_outcome::<Value>("sessions.interrupt", reply, &["accepted", "not-running"]);
        assert!(read(serde_json::json!({ "outcome": "accepted" })).is_ok());
        for reply in [serde_json::json!({ "outcome": "stopped" }), serde_json::json!({}), serde_json::json!({ "outcome": 1 })] {
            assert_eq!(read(reply).unwrap_err(), other_version("sessions.interrupt"));
        }
    }

    #[test]
    fn picks_by_id_then_by_the_one_prefix() {
        let all = fold(vec![row("s1", Some("abc"), "completed"), row("s2", Some("abd"), "completed"), row("s3", Some("ab"), "completed")]);
        assert_eq!(pick(&all, "ab").unwrap().id, "ab");
        assert_eq!(pick(&all, "abc").unwrap().id, "abc");
        let several = pick(&all, "a").unwrap_err();
        assert!(several.message.starts_with("3 threads start with a"), "{}", several.message);
        assert_eq!(pick(&all, "z").unwrap_err().kind.as_deref(), Some("not-found"));
    }
}
