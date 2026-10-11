// SPDX-License-Identifier: AGPL-3.0-only
//! Claude Code's transcripts read for a person who wants to pick a conversation up: transcripts.list tells each one
//! off the first and the last 64 KB of its file, and transcripts.read walks one file along the branch the CLI resumes.
//!
//! The store sits in a home every workspace on the computer may write into, as root there, while this daemon runs as
//! root: it is read the way usage.logs reads it, the home held by descriptor, every name under it opened one at a time
//! with no link followed (`beneath`), and on Linux as the home's owner.

use std::collections::HashMap;
use std::fs::File;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::fs::{FileExt as _, MetadataExt as _};
use std::path::Path;

use nix::dir::{Dir, Type};
use nix::fcntl::{open, openat, OFlag};
use nix::sys::stat::{fstat, Mode};
use serde_json::Value;
use wsp_frames::{words, DaemonErrorCode, TranscriptMessage, TranscriptRow, TranscriptVoice, TranscriptsListReply, TranscriptsReadReply};

use crate::beneath;
use crate::ops::Road;
use crate::paths::OpError;
use crate::usage_logs::{as_owner, lines};
use crate::Ctx;

/// How much of each end of a transcript the list reads: Claude Code appends its titles and last prompt again near the
/// end of the file so that its own picker finds them in the last 64 KB, and the first prompt sits in the first.
const END_BYTES: u64 = 64 << 10;
/// The most transcripts one list reads, the newest files first.
const LIST_CAP: usize = 1000;
/// The most messages one read hands back, whatever it was asked for.
const LAST_CAP: u32 = 1000;
/// How much of a title or a prompt a row carries, and of a message or a tool call's input a read does.
const LINE_WORDS: usize = 500;
const MESSAGE_WORDS: usize = 8000;
const INPUT_WORDS: usize = 2000;

pub(crate) async fn serve_list(
    road: &Road,
    ctx: &Ctx,
    root: String,
    dirs: Vec<String>,
    cwds: Vec<String>,
) -> Result<TranscriptsListReply, OpError> {
    if !crate::roads::host_road_serves(road, ctx.is_place()) {
        return Err(OpError::coded(DaemonErrorCode::Forbidden, words::NOT_ON_THIS_ROAD));
    }
    let home = crate::place::place_home(ctx.options.home.as_deref());
    tokio::task::spawn_blocking(move || list(&root, &dirs, &cwds, &home)).await.map_err(|e| OpError::plain(e.to_string()))
}

pub(crate) async fn serve_read(
    road: &Road,
    ctx: &Ctx,
    root: String,
    dirs: Vec<String>,
    id: String,
    last: u32,
) -> Result<TranscriptsReadReply, OpError> {
    if !crate::roads::host_road_serves(road, ctx.is_place()) {
        return Err(OpError::coded(DaemonErrorCode::Forbidden, words::NOT_ON_THIS_ROAD));
    }
    let home = crate::place::place_home(ctx.options.home.as_deref());
    tokio::task::spawn_blocking(move || read(&root, &dirs, &id, last, &home)).await.map_err(|e| OpError::plain(e.to_string()))
}

/// The store's folder under the held home, `~/` for a root inside it or a path from `/`, opened as the home's owner, the
/// switch every read under it runs inside. The way to the root follows links, as a macOS temp folder under `/var` and
/// a `~/.claude` kept in a dotfiles repo both need; nothing under the root does.
fn with_store<T>(home: &Path, root: &str, empty: T, work: impl FnOnce(&OwnedFd) -> T) -> T {
    let Ok(held) = open(home, OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC, Mode::empty()) else { return empty };
    let owner = fstat(held.as_fd()).map(|st| (st.st_uid, st.st_gid)).unwrap_or((0, 0));
    // A switch that did not take reads nothing: the read is never made as root over a home somebody else owns.
    let Ok(_switched) = as_owner(owner.0, owner.1) else { return empty };
    let store = match root.strip_prefix("~/").map(|rel| rel.trim_end_matches('/')) {
        Some("") => Some(held),
        Some(rel) => openat(&held, rel, OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC, Mode::empty()).ok(),
        None if root.starts_with('/') => open(root, OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC, Mode::empty()).ok(),
        None => None,
    };
    match store {
        Some(store) => work(&store),
        None => empty,
    }
}

/// One of Claude Code's project folders by its name alone: a name with a slash, `.` or `..` names nothing.
fn project_dir(store: &OwnedFd, name: &str) -> Option<OwnedFd> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return None;
    }
    openat(store, name, beneath::dir_flags(), Mode::empty()).ok()
}

/// A session id as Claude Code names its transcripts: a uuid.
fn session_id(name: &str) -> bool {
    name.len() == 36 && name.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// Each transcript a project folder holds directly, by session id: its subagents' folders and anything else beside them
/// are not conversations of their own.
fn transcripts_in(dir: &OwnedFd) -> Vec<String> {
    let Ok(fd) = dir.try_clone() else { return Vec::new() };
    let Ok(mut listing) = Dir::from_fd(fd) else { return Vec::new() };
    let mut ids = Vec::new();
    for entry in listing.iter().flatten() {
        let Ok(name) = entry.file_name().to_str() else { continue };
        if matches!(entry.file_type(), Some(Type::Directory)) {
            continue;
        }
        if let Some(id) = name.strip_suffix(".jsonl").filter(|id| session_id(id)) {
            ids.push(id.to_owned());
        }
    }
    ids.sort();
    ids
}

/// The file's mtime in ms and its size.
fn stat_of(file: &File) -> Option<(i64, u64)> {
    let meta = file.metadata().ok()?;
    Some((meta.mtime() * 1000 + meta.mtime_nsec() / 1_000_000, meta.len()))
}

/// The newest file under any of the folders for one session id, with its stamp: a session Claude Code copied into a
/// second folder goes on in the copy it last wrote.
fn newest(store: &OwnedFd, dirs: &[String], id: &str) -> Option<(File, i64, u64)> {
    let mut best: Option<(File, i64, u64)> = None;
    for name in dirs {
        let Some(dir) = project_dir(store, name) else { continue };
        let Ok(Some(file)) = beneath::file(&dir, &format!("{id}.jsonl")) else { continue };
        let Some((at, bytes)) = stat_of(&file) else { continue };
        if best.as_ref().is_none_or(|b| at > b.1) {
            best = Some((file, at, bytes));
        }
    }
    best
}

/// `text` cut to `cap` characters on a character boundary, an ellipsis saying it was.
fn cut(text: &str, cap: usize) -> String {
    match text.char_indices().nth(cap) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

fn str_of<'a>(line: &'a Value, key: &str) -> Option<&'a str> {
    line.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// What the person typed on a line, where the line is their message: no tool's result, no line Claude Code wrote for
/// itself (a reminder, a slash command's echo, a compaction's summary), and nothing from a subagent's run.
fn person_text(line: &Value) -> Option<String> {
    if str_of(line, "type") != Some("user") {
        return None;
    }
    if ["isMeta", "isSidechain", "isCompactSummary"].iter().any(|k| line.get(*k).and_then(Value::as_bool) == Some(true)) {
        return None;
    }
    let content = line.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => {
            let texts: Vec<&str> = parts.iter().filter(|p| str_of(p, "type") == Some("text")).filter_map(|p| str_of(p, "text")).collect();
            if texts.is_empty() {
                return None;
            }
            texts.join("\n")
        }
        _ => return None,
    };
    let text = text.trim();
    let mut chars = text.chars();
    // Claude Code's own lines open on a tag: <command-name>, <local-command-stdout>, <system-reminder> and the like.
    if chars.next() == Some('<') && chars.next().is_some_and(|c| c.is_ascii_lowercase()) {
        return None;
    }
    (!text.is_empty()).then(|| text.to_owned())
}

/// Every whole line in `bytes`, parsed; a line cut at either end of the window, or one that does not parse, is
/// skipped.
fn each_line(bytes: &[u8], cut_head: bool, mut each: impl FnMut(&Value)) {
    let mut parts = bytes.split(|b| *b == b'\n');
    if cut_head {
        parts.next();
    }
    for part in parts {
        if part.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(part) {
            each(&value);
        }
    }
}

fn read_window(file: &File, from: u64, len: u64) -> Vec<u8> {
    let mut buf = vec![0u8; len as usize];
    let mut got = 0;
    while got < buf.len() {
        match file.read_at(&mut buf[got..], from + got as u64) {
            Ok(0) | Err(_) => break,
            Ok(n) => got += n,
        }
    }
    buf.truncate(got);
    buf
}

/// What a transcript's ends say about it.
#[derive(Default)]
struct Ends {
    cwd: Option<String>,
    entrypoint: Option<String>,
    branch: Option<String>,
    first_prompt: Option<String>,
    custom_title: Option<String>,
    ai_title: Option<String>,
    last_prompt: Option<String>,
}

impl Ends {
    /// One line: the first cwd, entrypoint and prompt seen stand; the newest branch and names replace older ones.
    fn take(&mut self, line: &Value) {
        if self.cwd.is_none() {
            self.cwd = str_of(line, "cwd").map(str::to_owned);
        }
        if self.entrypoint.is_none() {
            self.entrypoint = str_of(line, "entrypoint").map(str::to_owned);
        }
        if let Some(branch) = str_of(line, "gitBranch") {
            self.branch = Some(branch.to_owned());
        }
        if self.first_prompt.is_none() {
            self.first_prompt = person_text(line);
        }
        match str_of(line, "type") {
            Some("custom-title") => self.custom_title = str_of(line, "customTitle").map(str::to_owned).or(self.custom_title.take()),
            Some("ai-title") => self.ai_title = str_of(line, "aiTitle").map(str::to_owned).or(self.ai_title.take()),
            Some("last-prompt") => self.last_prompt = str_of(line, "lastPrompt").map(str::to_owned).or(self.last_prompt.take()),
            _ => {}
        }
    }

    /// The name Claude Code's own picker shows: the person's, then its own, then the last prompt, then the first.
    fn title(&self) -> Option<String> {
        self.custom_title
            .clone()
            .or_else(|| self.ai_title.clone())
            .or_else(|| self.last_prompt.clone())
            .or_else(|| self.first_prompt.clone())
    }
}

/// A transcript's first and last END_BYTES, read as one window where they meet.
fn ends_of(file: &File, bytes: u64) -> Ends {
    let mut ends = Ends::default();
    let head = read_window(file, 0, bytes.min(END_BYTES));
    each_line(&head, false, |line| ends.take(line));
    if bytes > END_BYTES {
        let from = (bytes - END_BYTES).max(END_BYTES);
        let tail = read_window(file, from, bytes - from);
        // A tail that starts where the head stopped starts on a line the head already cut.
        each_line(&tail, true, |line| ends.take(line));
    }
    ends
}

pub(crate) fn list(root: &str, dirs: &[String], cwds: &[String], home: &Path) -> TranscriptsListReply {
    let rows = with_store(home, root, Vec::new(), |store| {
        let mut found: HashMap<String, (usize, i64, u64)> = HashMap::new();
        for (at, name) in dirs.iter().enumerate() {
            let Some(dir) = project_dir(store, name) else { continue };
            for id in transcripts_in(&dir) {
                let Ok(Some(file)) = beneath::file(&dir, &format!("{id}.jsonl")) else { continue };
                let Some((mtime, bytes)) = stat_of(&file) else { continue };
                if found.get(&id).is_none_or(|held| mtime > held.1) {
                    found.insert(id, (at, mtime, bytes));
                }
            }
        }
        let mut newest: Vec<(String, usize, i64, u64)> = found.into_iter().map(|(id, (dir, at, bytes))| (id, dir, at, bytes)).collect();
        newest.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        newest.truncate(LIST_CAP);
        let mut rows = Vec::new();
        for (id, dir, last_at, bytes) in newest {
            let Some(dir) = project_dir(store, &dirs[dir]) else { continue };
            let Ok(Some(file)) = beneath::file(&dir, &format!("{id}.jsonl")) else { continue };
            let ends = ends_of(&file, bytes);
            let Some(cwd) = ends.cwd.clone().filter(|cwd| cwds.iter().any(|c| c == cwd)) else { continue };
            rows.push(TranscriptRow {
                id,
                cwd,
                branch: ends.branch.clone(),
                entrypoint: ends.entrypoint.clone(),
                title: ends.title().map(|t| cut(t.trim(), LINE_WORDS)),
                first_prompt: ends.first_prompt.as_deref().map(|p| cut(p, LINE_WORDS)),
                last_at,
                bytes,
            });
        }
        rows
    });
    TranscriptsListReply { rows }
}

/// One line of the conversation with a place in its tree.
struct Node {
    parent: Option<String>,
    rows: Vec<(TranscriptMessage, Option<String>)>,
}

/// The rows one line holds: the person's message, or the agent's words and tool calls, each word row with the
/// harness message it is a piece of.
fn rows_of(line: &Value) -> Vec<(TranscriptMessage, Option<String>)> {
    if let Some(text) = person_text(line) {
        return vec![(TranscriptMessage { who: TranscriptVoice::Person, text: cut(&text, MESSAGE_WORDS), tool: None }, None)];
    }
    if str_of(line, "type") != Some("assistant") {
        return Vec::new();
    }
    let Some(message) = line.get("message") else { return Vec::new() };
    let id = str_of(message, "id").map(str::to_owned);
    let Some(Value::Array(parts)) = message.get("content") else { return Vec::new() };
    parts
        .iter()
        .filter_map(|part| match str_of(part, "type") {
            Some("text") => str_of(part, "text")
                .map(|text| (TranscriptMessage { who: TranscriptVoice::Agent, text: cut(text, MESSAGE_WORDS), tool: None }, id.clone())),
            Some("tool_use") => {
                let input = part.get("input").map(Value::to_string).unwrap_or_default();
                Some((
                    TranscriptMessage {
                        who: TranscriptVoice::Tool,
                        text: cut(&input, INPUT_WORDS),
                        tool: str_of(part, "name").map(str::to_owned),
                    },
                    None,
                ))
            }
            _ => None,
        })
        .collect()
}

pub(crate) fn read(root: &str, dirs: &[String], id: &str, last: u32, home: &Path) -> TranscriptsReadReply {
    let nothing = || TranscriptsReadReply { found: false, cwd: None, title: None, messages: Vec::new(), earlier: 0 };
    if !session_id(id) {
        return nothing();
    }
    with_store(home, root, nothing(), |store| {
        let Some((file, _, _)) = newest(store, dirs, id) else { return nothing() };
        let mut ends = Ends::default();
        let mut nodes: HashMap<String, Node> = HashMap::new();
        // The child each line had last, which is the one the CLI wrote after it on the branch it went on along.
        let mut latest_child: HashMap<String, String> = HashMap::new();
        let mut leaf: Option<String> = None;
        let mut newest_line: Option<String> = None;
        let _ = lines(
            file,
            |_| true,
            |text| {
                let Ok(line) = serde_json::from_str::<Value>(text) else { return };
                ends.take(&line);
                if str_of(&line, "type") == Some("last-prompt") {
                    if let Some(at) = str_of(&line, "leafUuid") {
                        leaf = Some(at.to_owned());
                    }
                    return;
                }
                let Some(uuid) = str_of(&line, "uuid") else { return };
                if line.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                    return;
                }
                let parent = str_of(&line, "parentUuid").map(str::to_owned);
                if let Some(parent) = &parent {
                    latest_child.insert(parent.clone(), uuid.to_owned());
                }
                newest_line = Some(uuid.to_owned());
                nodes.insert(uuid.to_owned(), Node { parent, rows: rows_of(&line) });
            },
        );
        // The newest last prompt names where the CLI resumes; a turn cut short after it wrote that line carries on
        // below it along the newest child of each line.
        let mut at = leaf.filter(|l| nodes.contains_key(l)).or(newest_line);
        let mut steps = 0;
        while let Some(child) = at.as_ref().and_then(|a| latest_child.get(a)) {
            if steps > nodes.len() {
                break;
            }
            steps += 1;
            at = Some(child.clone());
        }
        let mut chain: Vec<&Node> = Vec::new();
        let mut steps = 0;
        while let Some(node) = at.as_ref().and_then(|a| nodes.get(a)) {
            if steps > nodes.len() {
                break;
            }
            steps += 1;
            chain.push(node);
            at = node.parent.clone();
        }
        chain.reverse();
        let mut rows: Vec<(TranscriptMessage, Option<String>)> = Vec::new();
        for (row, piece_of) in chain.into_iter().flat_map(|n| n.rows.iter().cloned()) {
            if let Some((held, held_of)) = rows.last_mut() {
                if row.who == TranscriptVoice::Agent && held.who == TranscriptVoice::Agent && piece_of.is_some() && *held_of == piece_of {
                    held.text.push_str(&row.text);
                    continue;
                }
            }
            rows.push((row, piece_of));
        }
        let is_message = |m: &TranscriptMessage| m.who != TranscriptVoice::Tool;
        let total = rows.iter().filter(|(m, _)| is_message(m)).count();
        let keep = (last.min(LAST_CAP) as usize).min(total);
        let earlier = total - keep;
        let mut seen = 0;
        let from = rows
            .iter()
            .position(|(m, _)| {
                if is_message(m) {
                    seen += 1;
                }
                seen > earlier
            })
            .unwrap_or(rows.len());
        TranscriptsReadReply {
            found: true,
            title: ends.title().map(|t| cut(t.trim(), LINE_WORDS)),
            cwd: ends.cwd,
            messages: rows.into_iter().skip(from).map(|(m, _)| m).collect(),
            earlier: earlier as u32,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write as _;

    const ONE: &str = "11111111-2222-4333-8444-555555555555";
    const TWO: &str = "22222222-3333-4444-8555-666666666666";

    fn write(home: &Path, rel: &str, lines: &[Value]) {
        let path = home.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = File::create(path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
    }

    fn user(uuid: &str, parent: Option<&str>, text: &str, entrypoint: &str) -> Value {
        json!({"type": "user", "uuid": uuid, "parentUuid": parent, "isSidechain": false, "cwd": "/work/acme/lab", "entrypoint": entrypoint, "gitBranch": "main", "message": {"role": "user", "content": text}})
    }

    fn said(uuid: &str, parent: &str, id: &str, text: &str) -> Value {
        json!({"type": "assistant", "uuid": uuid, "parentUuid": parent, "isSidechain": false, "cwd": "/work/acme/lab", "message": {"id": id, "role": "assistant", "content": [{"type": "text", "text": text}]}})
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn a_title_is_the_persons_then_claudes_then_the_last_prompt_then_the_first() {
        let home = tempfile::tempdir().unwrap();
        let first = user("u1", None, "first words", "cli");
        write(
            home.path(),
            &format!(".claude/projects/-work-acme-lab/{ONE}.jsonl"),
            &[
                first.clone(),
                json!({"type": "ai-title", "aiTitle": "made by claude"}),
                json!({"type": "last-prompt", "lastPrompt": "the last prompt", "leafUuid": "u1"}),
                json!({"type": "custom-title", "customTitle": "named by the person"}),
            ],
        );
        write(
            home.path(),
            &format!(".claude/projects/-work-acme-lab/{TWO}.jsonl"),
            &[
                first.clone(),
                json!({"type": "ai-title", "aiTitle": "made by claude"}),
                json!({"type": "last-prompt", "lastPrompt": "the last prompt"}),
            ],
        );
        let three = "33333333-3333-4333-8333-333333333333";
        let four = "44444444-4444-4444-8444-444444444444";
        write(
            home.path(),
            &format!(".claude/projects/-work-acme-lab/{three}.jsonl"),
            &[first.clone(), json!({"type": "last-prompt", "lastPrompt": "the last prompt"})],
        );
        write(home.path(), &format!(".claude/projects/-work-acme-lab/{four}.jsonl"), &[first]);
        let reply = list("~/.claude/projects", &names(&["-work-acme-lab"]), &names(&["/work/acme/lab"]), home.path());
        let title = |id: &str| reply.rows.iter().find(|r| r.id == id).and_then(|r| r.title.clone());
        assert_eq!(title(ONE).as_deref(), Some("named by the person"));
        assert_eq!(title(TWO).as_deref(), Some("made by claude"));
        assert_eq!(title(three).as_deref(), Some("the last prompt"));
        assert_eq!(title(four).as_deref(), Some("first words"));
    }

    #[test]
    fn only_a_session_first_recorded_in_a_named_folder_is_listed_with_its_ends() {
        let home = tempfile::tempdir().unwrap();
        let mut elsewhere = user("u1", None, "hi", "cli");
        elsewhere["cwd"] = json!("/work/acme/other");
        write(home.path(), &format!(".claude/projects/-work-acme-lab/{ONE}.jsonl"), &[user("u1", None, "hello there", "cli")]);
        write(home.path(), &format!(".claude/projects/-work-acme-lab/{TWO}.jsonl"), &[elsewhere]);
        write(home.path(), ".claude/projects/-work-acme-lab/not-a-session.jsonl", &[user("u1", None, "hi", "cli")]);
        write(home.path(), &format!(".claude/projects/-work-acme-lab/{ONE}/subagents/agent-a.jsonl"), &[user("u1", None, "hi", "cli")]);
        let reply = list("~/.claude/projects", &names(&["-work-acme-lab", "../etc", "a/b"]), &names(&["/work/acme/lab"]), home.path());
        assert_eq!(reply.rows.len(), 1);
        let row = &reply.rows[0];
        assert_eq!(
            (row.id.as_str(), row.cwd.as_str(), row.branch.as_deref(), row.entrypoint.as_deref(), row.first_prompt.as_deref()),
            (ONE, "/work/acme/lab", Some("main"), Some("cli"), Some("hello there"))
        );
        assert!(row.bytes > 0 && row.last_at > 0);
    }

    #[test]
    fn the_tail_is_read_past_a_head_the_size_of_the_window() {
        let home = tempfile::tempdir().unwrap();
        let pad = "x".repeat(70_000);
        write(
            home.path(),
            &format!("cc/projects/k/{ONE}.jsonl"),
            &[
                user("u1", None, "the first prompt", "cli"),
                json!({"type": "attachment", "uuid": "a1", "parentUuid": "u1", "content": pad}),
                json!({"type": "attachment", "uuid": "a2", "parentUuid": "a1", "content": pad}),
                json!({"type": "custom-title", "customTitle": "found in the tail"}),
            ],
        );
        let reply = list(&format!("{}/cc/projects", home.path().display()), &names(&["k"]), &names(&["/work/acme/lab"]), home.path());
        assert_eq!(reply.rows[0].title.as_deref(), Some("found in the tail"));
        assert_eq!(reply.rows[0].first_prompt.as_deref(), Some("the first prompt"));
    }

    #[test]
    fn a_store_reached_through_a_link_is_read_whether_named_from_the_home_or_from_the_root() {
        let home = tempfile::tempdir().unwrap();
        write(home.path(), &format!("dotfiles/claude/projects/k/{ONE}.jsonl"), &[user("u1", None, "hi", "cli")]);
        std::os::unix::fs::symlink(home.path().join("dotfiles/claude"), home.path().join(".claude")).unwrap();
        for root in ["~/.claude/projects".to_string(), format!("{}/.claude/projects", home.path().display())] {
            let reply = list(&root, &names(&["k"]), &names(&["/work/acme/lab"]), home.path());
            assert_eq!(reply.rows.len(), 1, "{root}");
        }
    }

    #[test]
    fn a_link_in_the_store_names_nothing() {
        let home = tempfile::tempdir().unwrap();
        write(home.path(), &format!("real/{ONE}.jsonl"), &[user("u1", None, "hi", "cli")]);
        std::fs::create_dir_all(home.path().join(".claude/projects")).unwrap();
        std::os::unix::fs::symlink(home.path().join("real"), home.path().join(".claude/projects/k")).unwrap();
        std::fs::create_dir_all(home.path().join(".claude/projects/j")).unwrap();
        std::os::unix::fs::symlink(
            home.path().join(format!("real/{ONE}.jsonl")),
            home.path().join(format!(".claude/projects/j/{ONE}.jsonl")),
        )
        .unwrap();
        assert!(list("~/.claude/projects", &names(&["k", "j"]), &names(&["/work/acme/lab"]), home.path()).rows.is_empty());
        assert!(!read("~/.claude/projects", &names(&["k", "j"]), ONE, 10, home.path()).found);
    }

    #[test]
    fn a_read_keeps_the_newest_messages_and_counts_the_rest_with_tool_calls_as_rows() {
        let home = tempfile::tempdir().unwrap();
        write(
            home.path(),
            &format!(".claude/projects/k/{ONE}.jsonl"),
            &[
                user("u1", None, "one", "cli"),
                said("a1", "u1", "m1", "two"),
                user("u2", Some("a1"), "three", "cli"),
                json!({"type": "assistant", "uuid": "a2", "parentUuid": "u2", "message": {"id": "m2", "content": [{"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]}}),
                json!({"type": "user", "uuid": "r2", "parentUuid": "a2", "message": {"content": [{"type": "tool_result", "content": "a.txt"}]}}),
                said("a3", "r2", "m3", "four "),
                said("a4", "a3", "m3", "and more"),
                json!({"type": "last-prompt", "lastPrompt": "three", "leafUuid": "a4"}),
            ],
        );
        let all = read("~/.claude/projects", &names(&["k"]), ONE, 200, home.path());
        let rows: Vec<(TranscriptVoice, &str, Option<&str>)> =
            all.messages.iter().map(|m| (m.who, m.text.as_str(), m.tool.as_deref())).collect();
        assert_eq!(
            rows,
            vec![
                (TranscriptVoice::Person, "one", None),
                (TranscriptVoice::Agent, "two", None),
                (TranscriptVoice::Person, "three", None),
                (TranscriptVoice::Tool, "{\"command\":\"ls\"}", Some("Bash")),
                (TranscriptVoice::Agent, "four and more", None),
            ]
        );
        assert_eq!((all.found, all.earlier, all.cwd.as_deref()), (true, 0, Some("/work/acme/lab")));
        let two = read("~/.claude/projects", &names(&["k"]), ONE, 2, home.path());
        assert_eq!(two.earlier, 2);
        assert_eq!(
            two.messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            vec!["three", "{\"command\":\"ls\"}", "four and more"]
        );
        assert!(!read("~/.claude/projects", &names(&["k"]), TWO, 2, home.path()).found);
    }

    #[test]
    fn a_read_follows_the_branch_the_newest_last_prompt_names_not_the_newest_line() {
        let home = tempfile::tempdir().unwrap();
        write(
            home.path(),
            &format!(".claude/projects/k/{ONE}.jsonl"),
            &[
                user("u1", None, "one", "cli"),
                said("a1", "u1", "m1", "kept"),
                json!({"type": "last-prompt", "lastPrompt": "one", "leafUuid": "a1"}),
                // A second writer's turn off the same message, its own last prompt never written.
                user("u2", Some("u1"), "two", "sdk-cli"),
                said("a2", "u2", "m2", "dropped"),
            ],
        );
        let read = read("~/.claude/projects", &names(&["k"]), ONE, 200, home.path());
        assert_eq!(read.messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["one", "kept"]);
    }

    #[test]
    fn a_read_carries_on_past_a_last_prompt_written_before_its_reply() {
        let home = tempfile::tempdir().unwrap();
        write(
            home.path(),
            &format!(".claude/projects/k/{ONE}.jsonl"),
            &[
                user("u1", None, "one", "cli"),
                json!({"type": "last-prompt", "lastPrompt": "one", "leafUuid": "u1"}),
                said("a1", "u1", "m1", "the reply"),
            ],
        );
        let read = read("~/.claude/projects", &names(&["k"]), ONE, 200, home.path());
        assert_eq!(read.messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["one", "the reply"]);
    }

    /// A real Claude Code 2.1.296 transcript of two writers on one session: the terminal's turn set ALPHA, a `-p
    /// --resume` beside the open terminal wrote BRAVO, and the terminal went on from ALPHA. Its attachments are cut
    /// down and its folder renamed; every other line is as the CLI wrote it.
    const TWO_WRITERS: &str = include_str!("../tests/fixtures/claude-2.1.296-two-writers.jsonl");
    const TWO_WRITERS_ID: &str = "7414323d-e71b-4957-8b56-eefdf6bfa350";

    #[test]
    fn a_real_two_writer_transcript_lists_under_its_name_and_reads_along_the_branch_the_cli_resumes() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(format!(".claude/projects/-work-acme-lab/{TWO_WRITERS_ID}.jsonl"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, TWO_WRITERS).unwrap();
        let listed = list("~/.claude/projects", &names(&["-work-acme-lab"]), &names(&["/work/acme/lab"]), home.path());
        let row = &listed.rows[0];
        assert_eq!(
            (row.title.as_deref(), row.branch.as_deref(), row.entrypoint.as_deref()),
            (Some("lab codewords"), Some("feat/x"), Some("cli"))
        );
        assert_eq!(row.first_prompt.as_deref(), Some("Remember the codeword ALPHA. Reply with just OK."));
        let read = read("~/.claude/projects", &names(&["-work-acme-lab"]), TWO_WRITERS_ID, 200, home.path());
        let said: Vec<&str> = read.messages.iter().map(|m| m.text.as_str()).collect();
        assert!(said.contains(&"Remember the codeword ALPHA. Reply with just OK."));
        assert!(said.contains(&"What codewords do you remember? List them only."));
        assert!(said.contains(&"ALPHA"));
        assert!(!said.iter().any(|t| t.contains("BRAVO")), "the -p writer's branch is not the one the CLI resumes: {said:?}");
        assert!(read.messages.iter().any(|m| m.who == TranscriptVoice::Tool && m.tool.as_deref() == Some("Bash")));
        assert_eq!((read.cwd.as_deref(), read.title.as_deref()), (Some("/work/acme/lab"), Some("lab codewords")));
    }
}
