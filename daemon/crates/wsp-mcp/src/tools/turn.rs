// SPDX-License-Identifier: AGPL-3.0-only
//! `run`, which opens a thread in a workspace, and `send`, which continues one: each checks what it asks for against
//! the agent's own lists before a machine is woken, starts the turn, and follows it to its reply through the frames
//! the host pushes, dialling the host again when it stops under the turn. packages/host/src/verbs.ts `follow`,
//! `checkedStart`, `openingOf` and `napAfterDeadLaunch` are the rules.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::named::{absolute_folder, awake, history, params, thread_of, threads, workspace_of, Thread, Woken, Workspace};
use super::said::{fmt_bytes, fmt_uptime, js_trim, turns};
use super::wait::TurnResult;
use super::{input, Answer, Refused, Tool};
use crate::client::Client;
use crate::failure::Failure;
use crate::host::Host;
use crate::record::{self, fill};

pub const RUN: Tool =
    Tool { name: "run", listed: include_str!("../../record/tools/run.json"), call: |host, args| Box::pin(run(host, args)) };
pub const SEND: Tool =
    Tool { name: "send", listed: include_str!("../../record/tools/send.json"), call: |host, args| Box::pin(send(host, args)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RunIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detach: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SendIn {
    pub thread: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detach: Option<bool>,
}

/// How the message landed and, once the turn ended, its reply; `afterCut` where the thread's previous turn ended
/// without a result.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TurnOut {
    pub thread_id: String,
    pub workspace_id: String,
    pub harness: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_cut: Option<bool>,
}

/// The model, effort and access mode a start names, as the composer's pickers name them, and whether it runs fast.
#[derive(Default)]
struct Picks {
    model: Option<String>,
    effort: Option<String>,
    access: Option<String>,
    fast: Option<bool>,
}

impl Picks {
    /// As sessions.start carries them: access is the wire's permissionMode.
    fn wire(&self, into: &mut Map<String, Value>) {
        for (key, value) in [("model", &self.model), ("effort", &self.effort), ("permissionMode", &self.access)] {
            if let Some(value) = value {
                into.insert(key.to_owned(), Value::from(value.as_str()));
            }
        }
        if self.fast == Some(true) {
            into.insert("fast".to_owned(), Value::from(true));
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct Choice {
    value: String,
    label: String,
    #[serde(default)]
    efforts: Option<Vec<String>>,
    #[serde(default)]
    fast: Option<bool>,
    #[serde(default, rename = "isDefault")]
    is_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    harness: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    is_default: Option<bool>,
    #[serde(default)]
    models: Vec<Choice>,
    #[serde(default)]
    legacy_models: Option<Vec<Choice>>,
    #[serde(default)]
    efforts: Vec<Choice>,
    #[serde(default)]
    permission_modes: Vec<Choice>,
}

/// A value the list does not carry, in the composer's words, and how many the list offered; none for a refusal that
/// quotes no list.
struct Unlisted {
    said: String,
    offered: Option<usize>,
}

fn choice_words(choices: &[Choice]) -> String {
    choices.iter().map(|c| format!("{} ({})", c.label, c.value)).collect::<Vec<_>>().join(", ")
}

fn listed(subject: &str, word: &str, choices: &[Choice], value: Option<&str>, legacy: &[Choice]) -> Result<(), Unlisted> {
    let Some(value) = value else { return Ok(()) };
    if choices.iter().chain(legacy).any(|c| c.value == value) {
        return Ok(());
    }
    let picks = &turns().picks;
    let said = if choices.is_empty() {
        fill(&picks.takes_no_effort, &[("subject", subject)])
    } else {
        let key = if word == "access mode" { "access" } else { word };
        let mut said = fill(
            picks.not_one.get(key).map_or("", String::as_str),
            &[("value", value), ("subject", subject), ("options", &choice_words(choices))],
        );
        if !legacy.is_empty() {
            said.push_str(&fill(&picks.legacy, &[("legacy", &choice_words(legacy))]));
        }
        said
    };
    Err(Unlisted { said, offered: Some(choices.len()) })
}

/// The picks against the agent's catalog, as packages/protocol/src/index.ts `startPicks` checks a start that opens a
/// thread: a model the start names none of runs the one the catalog marks, and the efforts are that model's own.
fn checked_against(catalog: &Catalog, picks: &Picks) -> Result<(), Unlisted> {
    let legacy = catalog.legacy_models.as_deref().unwrap_or_default();
    if !catalog.models.is_empty() {
        listed(&catalog.harness, "model", &catalog.models, picks.model.as_deref(), legacy)?;
    }
    let model = picks.model.clone().or_else(|| catalog.models.iter().find(|m| m.is_default == Some(true)).map(|m| m.value.clone()));
    let chosen = model.map(|value| {
        catalog.models.iter().chain(legacy).find(|m| m.value == value).cloned().unwrap_or(Choice {
            label: value.clone(),
            value,
            efforts: None,
            fast: None,
            is_default: None,
        })
    });
    if !catalog.efforts.is_empty() {
        let own = chosen.as_ref().and_then(|c| c.efforts.as_ref());
        let subject = match (&chosen, own) {
            (Some(chosen), Some(_)) => chosen.label.as_str(),
            _ => catalog.harness.as_str(),
        };
        let efforts: Vec<Choice> = catalog.efforts.iter().filter(|e| own.is_none_or(|own| own.contains(&e.value))).cloned().collect();
        listed(subject, "effort", &efforts, picks.effort.as_deref(), &[])?;
    }
    if !catalog.permission_modes.is_empty() {
        listed(&catalog.harness, "access mode", &catalog.permission_modes, picks.access.as_deref(), &[])?;
    }
    if let Some(chosen) = chosen.filter(|c| picks.fast == Some(true) && c.fast != Some(true)) {
        return Err(Unlisted { said: fill(&turns().picks.no_fast, &[("model", &chosen.label)]), offered: None });
    }
    Ok(())
}

/// Refuses, before a machine is woken for it, what the runtime would refuse once it was there: an empty task, an
/// agent the host has no adapter for, a pick the agent's catalog does not list.
async fn checked_start(client: &Client, task: &str, harness: Option<&str>, picks: &Picks, workspace_id: &str) -> Result<(), Failure> {
    let words = turns();
    if js_trim(task).is_empty() {
        return Err(Failure::usage(words.empty_task.clone()));
    }
    #[derive(Deserialize)]
    struct Listed {
        harnesses: Vec<Catalog>,
    }
    let Listed { harnesses } = client.request("harnesses.list", params([("workspaceId", Value::from(workspace_id))])).await?;
    let table = harnesses.iter().find(|c| harness.map_or(c.is_default == Some(true), |h| c.harness == h));
    let Some(table) = table else {
        let Some(harness) = harness else { return Ok(()) };
        let agents: Vec<&str> = harnesses.iter().map(|c| c.harness.as_str()).collect();
        let said = if agents.join(", ").is_empty() {
            fill(&words.no_adapter_none, &[("agent", harness)])
        } else {
            fill(&words.no_adapter, &[("agent", harness), ("agents", &agents.join(", "))])
        };
        return Err(Failure::usage(said));
    };
    checked_against(table, picks).map_err(|Unlisted { said, offered }| {
        let clause = if offered == Some(0) { &words.picks.built_in_table } else { &words.picks.built_in_list };
        let said = if table.source == "table" { format!("{said}{clause}") } else { said };
        Failure::usage(fill(&words.picks.refused, &[("said", &said)]))
    })
}

/// The folder a thread starts in when the call names no workspace: the repo the server's own folder is in.
fn git_root_of(folder: &Path) -> Option<PathBuf> {
    folder.ancestors().find(|at| at.join(".git").exists()).map(Path::to_path_buf)
}

fn under(path: &str, root: &str) -> bool {
    path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

fn home_shortened(path: &str, home: Option<&str>) -> String {
    match home {
        Some(home) if under(path, home) => {
            if path == home {
                "~".to_owned()
            } else {
                format!("~{}", &path[home.len()..])
            }
        }
        _ => path.to_owned(),
    }
}

/// Where a thread goes: the workspace named, else the one standing on the project the server's folder is a repo of,
/// and then the first line says where it went.
async fn thread_target(client: &Client, named: Option<&str>, cwd: Option<&Path>) -> Result<(Workspace, bool), Failure> {
    let words = turns();
    if let Some(named) = named {
        return Ok((workspace_of(client, named).await?, false));
    }
    let Some(root) = cwd.and_then(git_root_of) else { return Err(Failure::usage(words.no_thread_target.clone())) };
    let root = root.to_string_lossy().into_owned();
    #[derive(Deserialize)]
    struct Listed {
        workspaces: Vec<Value>,
    }
    #[derive(Deserialize)]
    struct Projects {
        projects: Vec<Value>,
    }
    let Listed { workspaces } = client.request("workspaces.list", Map::new()).await?;
    let Projects { projects } = client.request("projects.list", Map::new()).await?;
    let str_of = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let mut found: Option<(String, String)> = None;
    for project in &projects {
        let folder = project.get("source").and_then(|s| s.get("kind")).and_then(Value::as_str) == Some("folder");
        let (Some(id), Some(path)) = (str_of(project, "id"), str_of(project, "path")) else { continue };
        if folder && under(&root, &path) && found.as_ref().is_none_or(|(_, held)| path.len() > held.len()) {
            found = Some((id, path));
        }
    }
    let workspace = found.and_then(|(id, _)| {
        workspaces.into_iter().find(|w| w.get("project").and_then(|p| p.get("id")).and_then(Value::as_str) == Some(id.as_str()))
    });
    // The recorded sentence quotes the folder where it is a word for a shell; that one is filled shell-quoted.
    let template = words.no_workspace_for_folder.replace("'{folder}'", "{quoted}");
    let refused = || Failure::new(fill(&template, &[("quoted", &shell_quote(&root)), ("folder", &root)]));
    let workspace = workspace.ok_or_else(refused)?;
    let workspace: Workspace = serde_json::from_value(workspace).map_err(|_| refused())?;
    Ok((workspace, true))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The files a call names, read off this computer and carried as bytes, so nothing on the machine reaches back for the
/// person's files: an image told by its own first bytes and carried as one, any other file under its own name, and
/// the caps checked against what the files weigh before any of them is read whole.
fn files_from(paths: &[String]) -> Result<Vec<Value>, Failure> {
    let words = &turns().files;
    let mut files = Vec::new();
    for given in paths {
        let path = std::path::absolute(given).unwrap_or_else(|_| PathBuf::from(given));
        let meta = std::fs::metadata(&path).ok().filter(std::fs::Metadata::is_file);
        let Some(meta) = meta else { return Err(Failure::usage(fill(&words.not_a_file, &[("path", given)]))) };
        let mut head = [0u8; 12];
        let read = std::fs::File::open(&path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
        let media = image_type_of(&head[..read]);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        files.push((path, media, name, meta.len()));
    }
    let refusal = if files.len() > words.max {
        Some(fill(&words.too_many, &[("count", &files.len().to_string())]))
    } else {
        files.iter().find_map(|(_, media, name, bytes)| {
            let (cap, over) =
                if media.is_some() { (words.image_max_bytes, &words.image_too_big) } else { (words.file_max_bytes, &words.file_too_big) };
            if *bytes == 0 {
                Some(fill(&words.empty, &[("name", name)]))
            } else {
                (*bytes > cap).then(|| fill(over, &[("name", name), ("size", &fmt_bytes(*bytes as f64))]))
            }
        })
    };
    if let Some(refusal) = refusal {
        return Err(Failure::usage(fill(&words.refused, &[("refusal", &refusal)])));
    }
    files
        .into_iter()
        .map(|(path, media, name, _)| {
            let bytes = std::fs::read(&path).map_err(|e| Failure::new(e.to_string()))?;
            Ok(serde_json::json!({ "mediaType": media.unwrap_or(&words.untyped), "name": name, "bytes": base64(&bytes) }))
        })
        .collect()
}

/// Which of the four image types these first bytes are, as packages/protocol/src/attachments.ts `imageTypeOf` reads.
fn image_type_of(head: &[u8]) -> Option<&'static str> {
    let starts = |at: usize, want: &[u8]| head.get(at..at + want.len()) == Some(want);
    if starts(0, &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if starts(0, &[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if starts(0, &[0x47, 0x49, 0x46, 0x38]) {
        Some("image/gif")
    } else if starts(0, &[0x52, 0x49, 0x46, 0x46]) && starts(8, &[0x57, 0x45, 0x42, 0x50]) {
        Some("image/webp")
    } else {
        None
    }
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            out.push(if i <= chunk.len() { ABC[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// A fresh v4 UUID, the id a start is known by in the frames it pushes.
fn request_id() -> String {
    let mut b = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        b = (nanos ^ u128::from(std::process::id()) << 64).to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

/// A turn as a caller sees it: the thread it opened or resumed, how the start went, and once it ended the result
/// and the runtime's reason.
#[derive(Debug, Clone)]
struct Turn {
    thread_id: String,
    workspace_id: String,
    harness: String,
    outcome: String,
    turn_id: String,
    result: Option<TurnResult>,
    reason: Option<String>,
    after_cut: bool,
}

const SESSION_STATUSES: [&str; 4] = ["running", "completed", "interrupted", "failed"];
const START_OUTCOMES: [&str; 3] = ["started", "steered", "queued"];

/// Starts the turn as the agent's and answers with it the moment the runtime names it.
async fn begin(client: &Client, start: &Map<String, Value>) -> Result<Turn, Failure> {
    client.events().await?;
    let mut asked = start.clone();
    asked.insert("startedBy".to_owned(), Value::from("agent"));
    asked.insert("requestId".to_owned(), Value::from(request_id()));
    let answer: Value = client.request("sessions.start", asked).await?;
    let str_at = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let session =
        answer.get("session").filter(|s| ["id", "workspaceId", "harness"].iter().all(|k| s.get(*k).is_some_and(Value::is_string)));
    let status = session.and_then(|s| str_at(s, "status")).filter(|s| SESSION_STATUSES.contains(&s.as_str()));
    let outcome = str_at(&answer, "outcome").filter(|o| START_OUTCOMES.contains(&o.as_str()));
    let (Some(session), Some(_), Some(outcome), Some(turn_id)) = (session, status, outcome, str_at(&answer, "turnId")) else {
        return Err(super::named::other_version("sessions.start"));
    };
    let Some(thread_id) = str_at(session, "threadId") else { return Err(Failure::new(turns().no_thread_stamped.clone())) };
    Ok(Turn {
        thread_id,
        workspace_id: str_at(session, "workspaceId").unwrap_or_default(),
        harness: str_at(session, "harness").unwrap_or_default(),
        outcome,
        turn_id,
        result: None,
        reason: None,
        after_cut: false,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    after_cut: Option<bool>,
    #[serde(default)]
    result: Option<TurnResult>,
    #[serde(default)]
    reason: Option<String>,
}

/// One event of the turn taken in; true once it is the turn's done or end.
fn take(turn: &mut Turn, event: Event) -> bool {
    match event.kind.as_str() {
        "session.start" if event.after_cut == Some(true) => turn.after_cut = true,
        "session.done" => turn.result = event.result,
        "session.end" if event.reason.is_some() => turn.reason = event.reason,
        _ => {}
    }
    event.kind == "session.done" || event.kind == "session.end"
}

fn start_wait() -> Duration {
    Duration::from_millis(record::host().start_wait_ms)
}

/// Starts the turn and follows it to its end, which is the turn's done, or its end where the runtime ended it. A host
/// that stops under the follow once the turn is named is dialled again, and the follow goes on from the host that
/// comes back: an end its transcript already holds is read off it, the rest arrive as they come. `started` holds the
/// turn from the moment it is named, for a caller whose launch died after it.
async fn follow(host: &Host, client: Arc<Client>, start: &Map<String, Value>, started: &mut Option<Turn>) -> Result<Turn, Failure> {
    let mut socket = client.clone();
    loop {
        let mut frames = socket.frames();
        let attempt: Result<Turn, Failure> = async {
            let mut turn = match started.clone() {
                None => {
                    let turn = begin(&socket, start).await?;
                    *started = Some(turn.clone());
                    turn
                }
                Some(turn) => {
                    socket.events().await?;
                    turn
                }
            };
            if !Arc::ptr_eq(&socket, &client) {
                let mut over = false;
                for event in history(&socket, &turn.workspace_id).await? {
                    let Ok(event) = serde_json::from_value::<Event>(event) else { continue };
                    if !over
                        && event.turn_id.as_deref() == Some(turn.turn_id.as_str())
                        && matches!(event.kind.as_str(), "session.done" | "session.end")
                    {
                        over = take(&mut turn, event);
                    }
                }
                if over {
                    return Ok(turn);
                }
            }
            loop {
                let Some(text) = frames.next().await else { return Err(Failure::new(socket.close_words())) };
                let Ok(event) = serde_json::from_str::<Event>(&text) else { continue };
                if event.kind.starts_with("session.") && event.turn_id.as_deref() == Some(turn.turn_id.as_str()) && take(&mut turn, event) {
                    return Ok(turn);
                }
            }
        }
        .await;
        match attempt {
            Ok(turn) => return Ok(turn),
            Err(failure) if started.is_none() || !socket.stopped_under() => return Err(failure),
            Err(_) => socket = host.back_within(start_wait()).await?,
        }
    }
}

/// Why the turn did not complete, classed by the cause the agent named: a refusal for want of a sign-in is auth.
fn turn_refusal(turn: &Turn) -> Option<Failure> {
    let result = turn.result.as_ref();
    if result.is_some_and(|r| r.status == "completed") {
        return None;
    }
    let words = turns();
    let said = result
        .and_then(|r| r.error.clone())
        .or_else(|| turn.reason.clone())
        .unwrap_or_else(|| result.map_or_else(|| words.turn_no_result.clone(), |r| fill(&words.turn_failed, &[("status", &r.status)])));
    Some(match result.and_then(|r| r.refusal.as_deref()) {
        Some("sign-in") => Failure::auth(said),
        _ => Failure::new(said),
    })
}

fn turn_out(turn: &Turn) -> TurnOut {
    TurnOut {
        thread_id: turn.thread_id.clone(),
        workspace_id: turn.workspace_id.clone(),
        harness: turn.harness.clone(),
        text: turn.result.as_ref().map(|r| r.text.clone().unwrap_or_default()),
        outcome: turn.outcome.clone(),
        after_cut: turn.after_cut.then_some(true),
    }
}

/// The reply as the tool's text, the cut line first where the thread's previous turn did not finish.
fn turn_text(out: &TurnOut) -> String {
    let text = out.text.clone().unwrap_or_default();
    if out.after_cut == Some(true) {
        format!("{}\n{text}", turns().after_cut)
    } else {
        text
    }
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1_000.0
}

/// What a launch owes the machine it woke when its thread never got going: the nap back, unless another thread is
/// working there, in which case the line says when the idle window takes it. Nothing where this launch woke nothing
/// or its turn reached the agent.
async fn nap_after_dead_launch(client: &Client, woken: &Woken, turn: Option<&Turn>) -> Option<String> {
    if !woken.woke || turn.and_then(|t| t.result.as_ref()).is_some_and(|r| r.refusal.is_some()) {
        return None;
    }
    let words = turns();
    let name = woken.workspace.name.as_str();
    let tried: Result<Option<String>, Failure> = async {
        let rows = threads(client, Some(&woken.workspace.id)).await?;
        let mine = turn.and_then(|t| rows.iter().position(|r| r.runtime_id() == t.thread_id));
        if mine.is_some_and(|i| rows[i].ran) {
            return Ok(None);
        }
        if rows.iter().enumerate().any(|(i, t)| Some(i) != mine && t.status == "running") {
            #[derive(Deserialize)]
            struct Statuses {
                statuses: Vec<Value>,
            }
            let Statuses { statuses } = client.request("status.list", Map::new()).await?;
            let idle = statuses
                .iter()
                .find(|s| s.get("id").and_then(Value::as_str) == Some(woken.workspace.id.as_str()))
                .and_then(|s| s.get("idleAt")?.as_f64());
            return Ok(Some(match idle {
                Some(at) => fill(&words.stays_awake_naps, &[("name", name), ("naps", &fmt_uptime((at - now_ms()).max(0.0)))]),
                None => fill(&words.stays_awake, &[("name", name)]),
            }));
        }
        client.request::<Value>("workspaces.nap", params([("workspaceId", Value::from(woken.workspace.id.as_str()))])).await?;
        Ok(Some(fill(&words.asleep_again, &[("name", name)])))
    }
    .await;
    tried.unwrap_or_else(|_| Some(fill(&words.stays_awake, &[("name", name)])))
}

/// The same failure with one more line under it, its kind kept.
fn with_line(failure: Failure, line: Option<String>) -> Failure {
    match line {
        Some(line) => Failure { message: format!("{}\n{line}", failure.message), kind: failure.kind },
        None => failure,
    }
}

/// What the notify list names for the runtime: `me` as given, and every other thread by its full id.
async fn notify_of(client: &Client, named: &[String]) -> Result<Option<Vec<String>>, Failure> {
    if named.is_empty() {
        return Ok(None);
    }
    let me = &turns().notify_me;
    let mut out = Vec::new();
    for n in named {
        if n == me {
            out.push(me.clone());
        } else {
            out.push(thread_of(client, n).await?.runtime_id().to_owned());
        }
    }
    Ok(Some(out))
}

/// Where a thread whose workspace was inferred went: the workspace's name and the folder it starts in.
struct Opened {
    workspace: String,
    folder: String,
}

impl Opened {
    fn line(&self, thread_id: &str) -> String {
        fill(&turns().thread_opened, &[("thread", thread_id), ("workspace", &self.workspace), ("folder", &self.folder)])
    }
}

/// The first line of a thread: where it went when that was inferred, else its id.
fn opened_thread(thread_id: &str, opened: Option<&Opened>) -> String {
    opened.map_or_else(|| fill(&turns().opened_thread, &[("thread", thread_id)]), |o| o.line(thread_id))
}

async fn run(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let RunIn { workspace, task, agent, model, effort, access, fast, cwd, notify, title, files, detach } = input("run", arguments)?;
    let words = turns();
    let client = host.client().await?;
    let (found, inferred) = thread_target(&client, workspace.as_deref(), host.cwd()).await?;
    let picks = Picks { model, effort, access, fast };
    checked_start(&client, &task, agent.as_deref(), &picks, &found.id).await?;
    let opened = inferred.then(|| Opened {
        workspace: found.name.clone(),
        folder: home_shortened(cwd.as_deref().unwrap_or(&found.project.path), found.home.as_deref()),
    });
    let woken = awake(&client, &found, "send").await?;
    let notify = notify_of(&client, notify.as_deref().unwrap_or_default()).await?;
    let mut start = params([("workspaceId", Value::from(woken.workspace.id.as_str())), ("prompt", Value::from(task.as_str()))]);
    if let Some(cwd) = absolute_folder(cwd.as_deref())? {
        start.insert("cwd".to_owned(), Value::from(cwd));
    }
    let attachments = files_from(files.as_deref().unwrap_or_default())?;
    if let Some(agent) = agent {
        start.insert("harness".to_owned(), Value::from(agent));
    }
    if let Some(notify) = notify {
        start.insert("notify".to_owned(), Value::from(notify));
    }
    if let Some(token) = host.env().get(&words.turn_token_env).filter(|t| !t.is_empty()) {
        start.insert("turnToken".to_owned(), Value::from(token.as_str()));
    }
    if let Some(title) = title {
        start.insert("title".to_owned(), Value::from(title));
    }
    if !attachments.is_empty() {
        start.insert("attachments".to_owned(), Value::from(attachments));
    }
    picks.wire(&mut start);
    let mut started = None;
    let answered = if detach == Some(true) {
        begin(&client, &start).await.map(|turn| Answer::text(opened_thread(&turn.thread_id, opened.as_ref()), &turn_out(&turn)))
    } else {
        match follow(&host, client.clone(), &start, &mut started).await {
            Ok(turn) => match turn_refusal(&turn) {
                Some(refused) => Err(refused),
                None => {
                    let out = turn_out(&turn);
                    let text = match &opened {
                        Some(opened) => format!("{}\n{}", opened.line(&out.thread_id), turn_text(&out)),
                        None => turn_text(&out),
                    };
                    Ok(Answer::text(text, &out))
                }
            },
            Err(failure) => Err(failure),
        }
    };
    match answered {
        Ok(answer) => Ok(answer),
        Err(failure) => Err(with_line(failure, nap_after_dead_launch(&client, &woken, started.as_ref()).await).into()),
    }
}

async fn send(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let SendIn { thread, message, model, effort, fast, files, detach } = input("send", arguments)?;
    let client = host.client().await?;
    let thread: Thread = thread_of(&client, &thread).await?;
    let picks = Picks { model, effort, access: None, fast };
    checked_start(&client, &message, Some(&thread.harness), &picks, &thread.workspace_id).await?;
    awake(&client, &workspace_of(&client, &thread.workspace_id).await?, "send").await?;
    let attachments = files_from(files.as_deref().unwrap_or_default())?;
    let mut start = params([
        ("workspaceId", Value::from(thread.workspace_id.as_str())),
        ("prompt", Value::from(message.as_str())),
        ("harness", Value::from(thread.harness.as_str())),
        ("thread", Value::from(thread.runtime_id())),
    ]);
    if !attachments.is_empty() {
        start.insert("attachments".to_owned(), Value::from(attachments));
    }
    picks.wire(&mut start);
    if detach == Some(true) {
        let turn = begin(&client, &start).await?;
        return Ok(Answer::text(opened_thread(&turn.thread_id, None), &turn_out(&turn)));
    }
    let turn = follow(&host, client, &start, &mut None).await?;
    if let Some(refused) = turn_refusal(&turn) {
        return Err(refused.into());
    }
    let out = turn_out(&turn);
    Ok(Answer::text(turn_text(&out), &out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::held::to_the_record;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<RunIn, TurnOut>(RUN.listed);
        to_the_record::<SendIn, TurnOut>(SEND.listed);
    }

    #[test]
    fn an_image_is_read_off_its_bytes_and_any_other_file_travels_under_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let shot = dir.path().join("shot.txt");
        std::fs::write(&shot, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).unwrap();
        let carried = files_from(&[shot.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(carried, [serde_json::json!({ "mediaType": "image/png", "name": "shot.txt", "bytes": "iVBORw0KGgoBAg==" })]);
        let words = &turns().files;
        let many: Vec<String> = (0..=words.max).map(|_| shot.to_string_lossy().into_owned()).collect();
        let refused = files_from(&many).unwrap_err();
        assert_eq!(refused.kind.as_deref(), Some("usage"));
        assert!(refused.message.contains(&format!("carries {}", words.max + 1)), "{}", refused.message);
        let text = dir.path().join("notes.png");
        std::fs::write(&text, "ab").unwrap();
        let carried = files_from(&[text.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(carried, [serde_json::json!({ "mediaType": words.untyped, "name": "notes.png", "bytes": "YWI=" })]);
        let empty = dir.path().join("empty.md");
        std::fs::write(&empty, "").unwrap();
        assert!(files_from(&[empty.to_string_lossy().into_owned()]).unwrap_err().message.contains("empty.md is empty"));
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"abc"), "YWJj");
        assert_eq!(request_id().len(), 36);
    }

    #[test]
    fn fast_rides_the_start_and_is_refused_on_a_model_with_none() {
        let mut start = Map::new();
        Picks { fast: Some(true), ..Picks::default() }.wire(&mut start);
        Picks { fast: Some(false), ..Picks::default() }.wire(&mut Map::new());
        assert_eq!(Value::from(start), serde_json::json!({ "fast": true }));
        let model =
            |fast: Option<bool>| Choice { value: "m".to_owned(), label: "M one".to_owned(), efforts: None, fast, is_default: Some(true) };
        let catalog = |fast| Catalog {
            harness: "claude".to_owned(),
            source: String::new(),
            is_default: Some(true),
            models: vec![model(fast)],
            legacy_models: None,
            efforts: vec![],
            permission_modes: vec![],
        };
        let fast = Picks { fast: Some(true), ..Picks::default() };
        assert!(checked_against(&catalog(Some(true)), &fast).is_ok());
        let refused = checked_against(&catalog(None), &fast).err().unwrap();
        assert!(refused.said.starts_with("M one has no fast mode"), "{}", refused.said);
        assert_eq!(refused.offered, None);
        assert!(checked_against(&catalog(None), &Picks::default()).is_ok());
    }

    #[test]
    fn a_folder_is_shortened_under_the_home_and_quoted_for_a_shell() {
        assert_eq!(home_shortened("/root/wsp", Some("/root")), "~/wsp");
        assert_eq!(home_shortened("/root", Some("/root")), "~");
        assert_eq!(home_shortened("/rootless", Some("/root")), "/rootless");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        assert_eq!(git_root_of(&dir.path().join("a/b")), Some(dir.path().to_path_buf()));
    }
}
