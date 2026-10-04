// SPDX-License-Identifier: AGPL-3.0-only
//! `run`, which opens a thread in a project's folder or a workspace, and `send`, which continues one: each checks what it asks for against
//! the agent's own lists before a machine is woken, starts the turn, and follows it to its reply through the frames
//! the host pushes, dialling the host again when it stops under the turn. packages/host/src/verbs.ts `follow`,
//! `checkedStart`, `openingOf` and `napAfterDeadLaunch` are the rules.

use std::collections::HashMap;
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
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub message: String,
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
pub(super) struct Picks {
    pub(super) model: Option<String>,
    pub(super) effort: Option<String>,
    pub(super) access: Option<String>,
    pub(super) fast: Option<bool>,
}

impl Picks {
    /// The access in wsp's own word, refused where it is none of the four: `accessWordOf`.
    pub(super) fn access_word(&self) -> Result<Option<&str>, Failure> {
        let picks = &turns().picks;
        match self.access.as_deref() {
            Some(given) if !picks.access_choices.iter().any(|word| word == given) => {
                Err(Failure::usage(fill(&picks.access_words, &[("given", given)])))
            }
            word => Ok(word),
        }
    }

    /// As sessions.start carries them: the access as wsp's word, which the agent's row maps.
    pub(super) fn wire(&self, into: &mut Map<String, Value>) -> Result<(), Failure> {
        let access = self.access_word()?;
        for (key, value) in [("model", self.model.as_deref()), ("effort", self.effort.as_deref()), ("access", access)] {
            if let Some(value) = value {
                into.insert(key.to_owned(), Value::from(value));
            }
        }
        if self.fast == Some(true) {
            into.insert("fast".to_owned(), Value::from(true));
        }
        Ok(())
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
    label: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    is_default: Option<bool>,
    #[serde(default)]
    models: Vec<Choice>,
    #[serde(default)]
    legacy_models: Option<Vec<Choice>>,
    #[serde(default)]
    hidden_models: Option<Vec<Choice>>,
    #[serde(default)]
    efforts: Vec<Choice>,
    #[serde(default)]
    permission_modes: Vec<Choice>,
    #[serde(default)]
    access: Option<HashMap<String, String>>,
}

impl Catalog {
    /// The agent's own mode for one of wsp's words, where its row maps the word to a mode it lists: `accessMode`.
    fn access_mode(&self, word: &str) -> Option<&str> {
        let mode = self.access.as_ref()?.get(word)?;
        self.permission_modes.iter().any(|m| &m.value == mode).then_some(mode.as_str())
    }

    /// Why a word was refused: the agent maps it to none of its modes, naming the ones it takes: `accessRefusal`.
    fn access_refusal(&self, word: &str) -> Option<String> {
        if self.access_mode(word).is_some() {
            return None;
        }
        let picks = &turns().picks;
        let takes: Vec<&str> = picks.access_choices.iter().map(String::as_str).filter(|w| self.access_mode(w).is_some()).collect();
        Some(if takes.is_empty() {
            fill(&picks.no_access_words, &[("label", &self.label)])
        } else {
            fill(&picks.access_not_taken, &[("label", &self.label), ("word", word), ("takes", &takes.join(", "))])
        })
    }
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

fn listed(
    subject: &str,
    word: &str,
    choices: &[Choice],
    value: Option<&str>,
    legacy: &[Choice],
    hidden: &[Choice],
) -> Result<(), Unlisted> {
    let Some(value) = value else { return Ok(()) };
    if choices.iter().chain(legacy).chain(hidden).any(|c| c.value == value) {
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
    let hidden = catalog.hidden_models.as_deref().unwrap_or_default();
    if !catalog.models.is_empty() {
        listed(&catalog.harness, "model", &catalog.models, picks.model.as_deref(), legacy, hidden)?;
    }
    let every = || catalog.models.iter().chain(legacy).chain(hidden);
    let model = picks.model.clone().or_else(|| every().find(|m| m.is_default == Some(true)).map(|m| m.value.clone()));
    let chosen = model.map(|value| {
        every().find(|m| m.value == value).cloned().unwrap_or(Choice {
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
        listed(subject, "effort", &efforts, picks.effort.as_deref(), &[], &[])?;
    }
    if let Some(chosen) = chosen.filter(|c| picks.fast == Some(true) && c.fast != Some(true)) {
        return Err(Unlisted { said: fill(&turns().picks.no_fast, &[("model", &chosen.label)]), offered: None });
    }
    Ok(())
}

/// Refuses, before a machine is woken for it, what the runtime would refuse once it was there: an empty task, an
/// agent the host has no adapter for, a pick the agent's catalog does not list.
pub(super) async fn checked_start(
    client: &Client,
    task: &str,
    harness: Option<&str>,
    picks: &Picks,
    workspace_id: Option<&str>,
) -> Result<(), Failure> {
    let words = turns();
    if js_trim(task).is_empty() {
        return Err(Failure::usage(words.empty_task.clone()));
    }
    #[derive(Deserialize)]
    struct Listed {
        harnesses: Vec<Catalog>,
    }
    let asked = workspace_id.map_or_else(Map::new, |id| params([("workspaceId", Value::from(id))]));
    let Listed { harnesses } = client.request("harnesses.list", asked).await?;
    let table = harnesses.iter().find(|c| harness.map_or(c.is_default == Some(true), |h| c.harness == h));
    if let (None, Some(harness)) = (table, harness) {
        // An agent the host runs that is off on this workspace's computer is the start's to refuse, naming it.
        let all = match workspace_id {
            None => &harnesses,
            Some(_) => &client.request::<Listed>("harnesses.list", Map::new()).await?.harnesses,
        };
        if all.iter().any(|c| c.harness == harness) {
            return Ok(());
        }
        let agents: Vec<&str> = all.iter().map(|c| c.harness.as_str()).collect();
        let said = if agents.join(", ").is_empty() {
            fill(&words.no_adapter_none, &[("agent", harness)])
        } else {
            fill(&words.no_adapter, &[("agent", harness), ("agents", &agents.join(", "))])
        };
        return Err(Failure::usage(said));
    }
    let access = picks.access_word()?;
    let Some(table) = table else { return Ok(()) };
    checked_against(table, picks).map_err(|Unlisted { said, offered }| {
        let clause = if offered == Some(0) { &words.picks.built_in_table } else { &words.picks.built_in_list };
        let said = if table.source == "table" { format!("{said}{clause}") } else { said };
        Failure::usage(fill(&words.picks.refused, &[("said", &said)]))
    })?;
    match access.and_then(|word| table.access_refusal(word)) {
        Some(said) => Err(Failure::usage(fill(&words.picks.access_refused, &[("said", &said)]))),
        None => Ok(()),
    }
}

/// The repo a folder on this computer is in: the nearest folder up the tree holding a .git entry.
fn git_root_of(folder: &Path) -> Option<PathBuf> {
    folder.ancestors().find(|at| at.join(".git").exists()).map(Path::to_path_buf)
}

/// The main folder of the repo a folder is in: the root itself, or for a linked worktree the folder holding the git
/// directory its .git file points into (`<main>/.git/worktrees/<name>`).
fn main_worktree_of(folder: &Path) -> Option<PathBuf> {
    let root = git_root_of(folder)?;
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(root);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let pointed = text.lines().find_map(|l| l.strip_prefix("gitdir:")).map(str::trim)?;
    let git_dir = root.join(pointed);
    let worktrees = git_dir.parent()?;
    worktrees.ends_with(".git/worktrees").then(|| worktrees.parent()?.parent().map(Path::to_path_buf)).flatten()
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

/// The start that opens a thread in a workspace. The token of the turn this server runs inside rides it, which is what
/// the host reads a notify of me against; there is none when the server is not inside a turn.
pub(super) fn opening(
    host: &Host,
    workspace_id: &str,
    prompt: &str,
    harness: Option<String>,
    cwd: Option<&str>,
    notify: Option<Vec<String>>,
) -> Map<String, Value> {
    opening_at(host, params([("workspaceId", Value::from(workspace_id))]), prompt, harness, cwd, notify)
}

/// The same start where the host picks the folder: the project and branch named, or beside the thread asking.
fn opening_at(
    host: &Host,
    mut start: Map<String, Value>,
    prompt: &str,
    harness: Option<String>,
    cwd: Option<&str>,
    notify: Option<Vec<String>>,
) -> Map<String, Value> {
    start.insert("prompt".to_owned(), Value::from(prompt));
    if let Some(cwd) = cwd {
        start.insert("cwd".to_owned(), Value::from(cwd));
    }
    if let Some(harness) = harness {
        start.insert("harness".to_owned(), Value::from(harness));
    }
    if let Some(notify) = notify {
        start.insert("notify".to_owned(), Value::from(notify));
    }
    if let Some(token) = host.env().get(&turns().turn_token_env).filter(|t| !t.is_empty()) {
        start.insert("turnToken".to_owned(), Value::from(token.as_str()));
    }
    start
}

/// A project as a run reads the list: what names it, the computer it is on, its folder and its repo's top.
#[derive(Deserialize, Clone)]
struct ProjectRow {
    id: String,
    name: String,
    computer: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    git: Option<GitTop>,
}

#[derive(Deserialize, Clone)]
struct GitTop {
    top: String,
}

/// Where a run goes: a folder the host picks on this computer, or a workspace on a box.
enum Target {
    /// The project's folder, a worktree for the branch, or with no project the folder of the thread asking.
    Here {
        project: Option<ProjectRow>,
        branch: Option<String>,
        cwd: Option<String>,
    },
    Box(Workspace),
}

/// The projects a caller may name: the host's own list, and for a caller the host answers as a thread, which reads
/// its own tree rather than the person's records, the projects its workspaces hold.
async fn projects_here(client: &Client) -> Result<Vec<ProjectRow>, Failure> {
    #[derive(Deserialize)]
    struct Projects {
        projects: Vec<ProjectRow>,
    }
    #[derive(Deserialize)]
    struct Held {
        project: ProjectRow,
    }
    #[derive(Deserialize)]
    struct Listed {
        workspaces: Vec<Held>,
    }
    if let Ok(Projects { projects }) = client.request("projects.list", Map::new()).await {
        return Ok(projects);
    }
    let Listed { workspaces } = client.request("workspaces.list", Map::new()).await?;
    let mut held: Vec<ProjectRow> = Vec::new();
    for Held { project } in workspaces {
        match held.iter_mut().find(|p| p.id == project.id) {
            Some(seen) => *seen = project,
            None => held.push(project),
        }
    }
    Ok(held)
}

/// The project on this computer a folder is in: the one whose folder holds it, the deepest where two do, else the one
/// whose repo the folder is a worktree of.
fn project_of_folder(projects: Vec<ProjectRow>, folder: &Path, here: &str) -> Option<ProjectRow> {
    let folder_text = folder.to_string_lossy();
    let mine: Vec<ProjectRow> = projects.into_iter().filter(|p| p.computer == here).collect();
    if let Some(holding) = mine.iter().filter(|p| under(&folder_text, &p.path)).max_by_key(|p| p.path.len()) {
        return Some(holding.clone());
    }
    let main = main_worktree_of(folder)?;
    let main = main.to_string_lossy();
    mine.into_iter().find(|p| p.git.as_ref().is_some_and(|g| g.top == main))
}

/// Where a run goes, as packages/host/src/verbs.ts `runTarget` decides: the project named when it is on this
/// computer, else the box workspace the word names; with no word, beside the thread asking, or the project whose
/// folder, or a worktree of whose repo, the server's own folder is in. A guest's folder is on its machine, so a guest
/// names what it means.
async fn run_target(
    host: &Host,
    client: &Client,
    named: Option<&str>,
    branch: Option<String>,
    cwd: Option<String>,
) -> Result<Target, Failure> {
    let words = turns();
    let here = super::workspace::words().here_place_id;
    if let Some(named) = named {
        let listed = projects_here(client).await.unwrap_or_default();
        if let Some(project) = listed.into_iter().find(|p| p.id == named || p.name == named).filter(|p| p.computer == here) {
            #[derive(Deserialize)]
            struct Resolved {
                #[allow(dead_code)]
                project: Value,
            }
            let _ = client.request::<Resolved>("projects.resolve", params([("ref", Value::from(project.id.as_str()))])).await;
            return Ok(Target::Here { project: Some(project), branch, cwd });
        }
        if branch.is_some() {
            return Err(Failure::usage(words.branch_here_only.clone()));
        }
        return Ok(Target::Box(workspace_of(client, named).await?));
    }
    let env = host.env();
    let set = |name: &str| env.get(name).is_some_and(|v| !v.is_empty());
    let guest = host.args().guest;
    if (set(&words.turn_token_env) || set(&record::host().env.token)) && !guest {
        return Ok(Target::Here { project: None, branch, cwd });
    }
    if guest {
        return Err(Failure::usage(words.guest_names_workspace.clone()));
    }
    let project = match host.cwd() {
        None => None,
        Some(folder) => {
            #[derive(Deserialize)]
            struct Projects {
                projects: Vec<ProjectRow>,
            }
            let listed = client.request::<Projects>("projects.list", Map::new()).await.map(|p| p.projects).unwrap_or_default();
            project_of_folder(listed, folder, &here)
        }
    };
    let Some(project) = project else { return Err(Failure::usage(words.no_thread_target.clone())) };
    let caller = host.cwd().map(|f| f.to_string_lossy().into_owned());
    let in_worktree = caller.as_deref().is_some_and(|c| !under(c, &project.path));
    let cwd = match (cwd, &branch) {
        (None, None) if in_worktree => caller,
        (cwd, _) => cwd,
    };
    Ok(Target::Here { project: Some(project), branch, cwd })
}

/// The files a call names, read off this computer and carried as bytes, so nothing on the machine reaches back for the
/// person's files: an image told by its own first bytes and carried as one, any other file under its own name, and
/// the caps checked against what the files weigh before any of them is read whole.
fn files_from(paths: &[String], guest: bool) -> Result<Vec<Value>, Failure> {
    let words = &turns().files;
    // Before a path is resolved: a guest would otherwise learn from the refusals which paths exist on the person's
    // disk, and a file that does exist would be read and sent.
    if guest && !paths.is_empty() {
        return Err(Failure::usage(words.guest.clone()));
    }
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
pub(super) struct Turn {
    thread_id: String,
    workspace_id: String,
    harness: String,
    outcome: String,
    turn_id: String,
    /// The folder the host started the thread in.
    cwd: Option<String>,
    result: Option<TurnResult>,
    reason: Option<String>,
    after_cut: bool,
}

const SESSION_STATUSES: [&str; 4] = ["running", "completed", "interrupted", "failed"];
const START_OUTCOMES: [&str; 3] = ["started", "steered", "queued"];

/// Starts the turn as the agent's under `request_id`, which every send of this start carries, and answers with it the
/// moment the runtime names it.
async fn begin(client: &Client, start: &Map<String, Value>, request_id: &str) -> Result<Turn, Failure> {
    client.events().await?;
    let mut asked = start.clone();
    asked.insert("startedBy".to_owned(), Value::from("agent"));
    asked.insert("requestId".to_owned(), Value::from(request_id));
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
        cwd: str_at(session, "cwd"),
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

/// The socket to send a start again on, after `failure` ended the try before the host answered it: a host that stopped
/// under it is dialled again, and the host that comes back knows the start by its request id and answers with the turn
/// it already opened where it took the message, so whether a message landed is the host's to say. Any other failure is
/// the start's own, and a host that did not come back in time is a message nobody took: the failure says so rather
/// than that a turn goes on.
async fn redial_unanswered(host: &Host, socket: &Client, failure: Failure) -> Result<Arc<Client>, Failure> {
    if !socket.stopped_under() {
        return Err(failure);
    }
    host.back_within(start_wait()).await.map_err(|_| Failure::new(record::words().not_delivered))
}

/// A start whose caller does not stay for the reply, sent again to the host that comes back when one stops before it
/// answers.
async fn begin_through(host: &Host, client: Arc<Client>, start: &Map<String, Value>) -> Result<Turn, Failure> {
    let id = request_id();
    let mut socket = client;
    loop {
        match begin(&socket, start, &id).await {
            Ok(turn) => return Ok(turn),
            Err(failure) => socket = redial_unanswered(host, &socket, failure).await?,
        }
    }
}

/// A send's reads before its start, which send nothing: a host that stops under them took no message, so the failure
/// says it was not delivered rather than that a turn goes on.
pub(super) fn before_sending<T>(client: &Client, read: Result<T, Failure>) -> Result<T, Failure> {
    read.map_err(|failure| if client.stopped_under() { Failure::new(record::words().not_delivered) } else { failure })
}

/// Starts the turn and follows it to its end, which is the turn's done, or its end where the runtime ended it. A host
/// that stops under the follow once the turn is named is dialled again, and the follow goes on from the host that
/// comes back: an end its transcript already holds is read off it, the rest arrive as they come. `started` holds the
/// turn from the moment it is named, for a caller whose launch died after it. A host that stops before it answers the
/// start is dialled again the same way and sent the same start, which it answers with the turn it opened where it
/// took it; none back in time is a message not delivered.
pub(super) async fn follow(
    host: &Host,
    client: Arc<Client>,
    start: &Map<String, Value>,
    started: &mut Option<Turn>,
) -> Result<Turn, Failure> {
    let id = request_id();
    let mut socket = client.clone();
    loop {
        let mut frames = socket.frames();
        let attempt: Result<Turn, Failure> = async {
            let mut turn = match started.clone() {
                None => {
                    let turn = begin(&socket, start, &id).await?;
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
            Err(failure) if started.is_none() => socket = redial_unanswered(host, &socket, failure).await?,
            Err(failure) if !socket.stopped_under() => return Err(failure),
            Err(_) => socket = host.back_within(start_wait()).await?,
        }
    }
}

/// Why the turn did not complete, classed by the cause the agent named: a refusal for want of a sign-in is auth.
pub(super) fn turn_refusal(turn: &Turn) -> Option<Failure> {
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

pub(super) fn turn_out(turn: &Turn) -> TurnOut {
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
        Some(line) => Failure { message: format!("{}\n{line}", failure.message), ..failure },
        None => failure,
    }
}

/// What the notify list names for the runtime: `me` as given, and every other thread by its full id.
pub(super) async fn notify_of(client: &Client, named: &[String]) -> Result<Option<Vec<String>>, Failure> {
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

/// Where a thread the host picked the folder for went: the project named, where the caller named one, and the
/// folder the host started it in.
struct Opened {
    project: Option<String>,
}

impl Opened {
    fn line(&self, thread_id: &str, folder: Option<&str>) -> String {
        let words = turns();
        let Some(folder) = folder else { return fill(&words.opened_thread, &[("thread", thread_id)]) };
        let home = std::env::var("HOME").ok();
        let folder = home_shortened(folder, home.as_deref());
        match &self.project {
            Some(project) => fill(&words.thread_opened, &[("thread", thread_id), ("project", project), ("folder", &folder)]),
            None => fill(&words.thread_opened_in, &[("thread", thread_id), ("folder", &folder)]),
        }
    }
}

/// The first line of a thread: where it went when the host picked it, else its id.
fn opened_thread(thread_id: &str, opened: Option<&Opened>, folder: Option<&str>) -> String {
    opened.map_or_else(|| fill(&turns().opened_thread, &[("thread", thread_id)]), |o| o.line(thread_id, folder))
}

async fn run(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let RunIn { project, branch, cwd, message, agent, model, effort, access, fast, notify, title, files, detach } =
        input("run", arguments)?;
    let client = host.client().await?;
    let picks = Picks { model, effort, access, fast };
    let read = async {
        let target = run_target(&host, &client, project.as_deref(), branch, cwd.clone()).await?;
        let on = match &target {
            Target::Box(found) => Some(found.id.as_str()),
            Target::Here { .. } => None,
        };
        checked_start(&client, &message, agent.as_deref(), &picks, on).await?;
        let woken = match &target {
            Target::Box(found) => Some(awake(&client, found, "send").await?),
            Target::Here { .. } => None,
        };
        let notify = notify_of(&client, notify.as_deref().unwrap_or_default()).await?;
        Ok((target, woken, notify))
    }
    .await;
    let (target, woken, notify) = before_sending(&client, read)?;
    let attachments_of = || files_from(files.as_deref().unwrap_or_default(), host.args().guest);
    let (mut start, opened, attachments) = match target {
        Target::Box(_) => {
            let folder = absolute_folder(cwd.as_deref())?;
            let attachments = attachments_of()?;
            let woken = woken.as_ref().map_or("", |w| w.workspace.id.as_str());
            (opening(&host, woken, &message, agent, folder, notify), None, attachments)
        }
        Target::Here { project, branch, cwd } => {
            let folder = absolute_folder(cwd.as_deref())?;
            let attachments = attachments_of()?;
            let mut at = Map::new();
            if let Some(project) = &project {
                at.insert("project".to_owned(), Value::from(project.id.as_str()));
            }
            if let Some(branch) = branch {
                at.insert("branch".to_owned(), Value::from(branch));
            }
            (opening_at(&host, at, &message, agent, folder, notify), Some(Opened { project: project.map(|p| p.name) }), attachments)
        }
    };
    if let Some(title) = title {
        start.insert("title".to_owned(), Value::from(title));
    }
    if !attachments.is_empty() {
        start.insert("attachments".to_owned(), Value::from(attachments));
    }
    picks.wire(&mut start)?;
    let mut started = None;
    let answered = if detach == Some(true) {
        begin_through(&host, client.clone(), &start)
            .await
            .map(|turn| Answer::text(opened_thread(&turn.thread_id, opened.as_ref(), turn.cwd.as_deref()), &turn_out(&turn)))
    } else {
        match follow(&host, client.clone(), &start, &mut started).await {
            Ok(turn) => match turn_refusal(&turn) {
                Some(refused) => Err(refused),
                None => {
                    let out = turn_out(&turn);
                    let text = match &opened {
                        Some(opened) => format!("{}\n{}", opened.line(&out.thread_id, turn.cwd.as_deref()), turn_text(&out)),
                        None => turn_text(&out),
                    };
                    Ok(Answer::text(text, &out))
                }
            },
            Err(failure) => Err(failure),
        }
    };
    match (answered, woken) {
        (Ok(answer), _) => Ok(answer),
        (Err(failure), Some(woken)) => Err(with_line(failure, nap_after_dead_launch(&client, &woken, started.as_ref()).await).into()),
        (Err(failure), None) => Err(failure.into()),
    }
}

async fn send(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let SendIn { thread, message, model, effort, fast, files, detach } = input("send", arguments)?;
    let client = host.client().await?;
    let picks = Picks { model, effort, access: None, fast };
    let read = async {
        let thread: Thread = thread_of(&client, &thread).await?;
        checked_start(&client, &message, Some(&thread.harness), &picks, Some(&thread.workspace_id)).await?;
        awake(&client, &workspace_of(&client, &thread.workspace_id).await?, "send").await?;
        Ok(thread)
    }
    .await;
    let thread = before_sending(&client, read)?;
    let attachments = files_from(files.as_deref().unwrap_or_default(), host.args().guest)?;
    let mut start = params([
        ("workspaceId", Value::from(thread.workspace_id.as_str())),
        ("prompt", Value::from(message.as_str())),
        ("harness", Value::from(thread.harness.as_str())),
        ("thread", Value::from(thread.runtime_id())),
    ]);
    if !attachments.is_empty() {
        start.insert("attachments".to_owned(), Value::from(attachments));
    }
    picks.wire(&mut start)?;
    if detach == Some(true) {
        let turn = begin_through(&host, client, &start).await?;
        return Ok(Answer::text(opened_thread(&turn.thread_id, None, None), &turn_out(&turn)));
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
        let carried = files_from(&[shot.to_string_lossy().into_owned()], false).unwrap();
        assert_eq!(carried, [serde_json::json!({ "mediaType": "image/png", "name": "shot.txt", "bytes": "iVBORw0KGgoBAg==" })]);
        let words = &turns().files;
        let many: Vec<String> = (0..=words.max).map(|_| shot.to_string_lossy().into_owned()).collect();
        let refused = files_from(&many, false).unwrap_err();
        assert_eq!(refused.kind.as_deref(), Some("usage"));
        assert!(refused.message.contains(&format!("carries {}", words.max + 1)), "{}", refused.message);
        let text = dir.path().join("notes.png");
        std::fs::write(&text, "ab").unwrap();
        let carried = files_from(&[text.to_string_lossy().into_owned()], false).unwrap();
        assert_eq!(carried, [serde_json::json!({ "mediaType": words.untyped, "name": "notes.png", "bytes": "YWI=" })]);
        let empty = dir.path().join("empty.md");
        std::fs::write(&empty, "").unwrap();
        assert!(files_from(&[empty.to_string_lossy().into_owned()], false).unwrap_err().message.contains("empty.md is empty"));
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"abc"), "YWJj");
        assert_eq!(request_id().len(), 36);
    }

    #[test]
    fn fast_rides_the_start_and_is_refused_on_a_model_with_none() {
        let mut start = Map::new();
        Picks { fast: Some(true), ..Picks::default() }.wire(&mut start).unwrap();
        Picks { fast: Some(false), ..Picks::default() }.wire(&mut Map::new()).unwrap();
        assert_eq!(Value::from(start), serde_json::json!({ "fast": true }));
        let model =
            |fast: Option<bool>| Choice { value: "m".to_owned(), label: "M one".to_owned(), efforts: None, fast, is_default: Some(true) };
        let catalog = |fast| Catalog {
            harness: "claude".to_owned(),
            label: "Claude Code".to_owned(),
            source: String::new(),
            is_default: Some(true),
            models: vec![model(fast)],
            legacy_models: None,
            hidden_models: None,
            efforts: vec![],
            permission_modes: vec![],
            access: None,
        };
        let fast = Picks { fast: Some(true), ..Picks::default() };
        assert!(checked_against(&catalog(Some(true)), &fast).is_ok());
        let refused = checked_against(&catalog(None), &fast).err().unwrap();
        assert!(refused.said.starts_with("M one has no fast mode"), "{}", refused.said);
        assert_eq!(refused.offered, None);
        assert!(checked_against(&catalog(None), &Picks::default()).is_ok());
    }

    #[test]
    fn a_folder_is_shortened_under_the_home_and_its_repo_found() {
        assert_eq!(home_shortened("/root/wsp", Some("/root")), "~/wsp");
        assert_eq!(home_shortened("/root", Some("/root")), "~");
        assert_eq!(home_shortened("/rootless", Some("/root")), "/rootless");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        assert_eq!(git_root_of(&dir.path().join("a/b")), Some(dir.path().to_path_buf()));
    }
}
