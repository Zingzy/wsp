// SPDX-License-Identifier: AGPL-3.0-only
//! What each agent's own store on this computer counted, for usage.logs: tokens by session, model, folder and half
//! hour, a cost where the store keeps one, and the newest plan reading a store kept. Counts, a model and a folder
//! leave here, never a line of a transcript. What each file came to is kept for the life of this daemon under its
//! size and mtime, so every read after the first opens only the files that changed.
//!
//! The stores sit in a home every workspace on a computer somebody owns may write into, as root there, while this
//! daemon runs as root: the home is held by descriptor, every folder and file under it is opened one name at a time
//! with no link followed (`beneath`), and on Linux the read runs with the thread's file access set to the home's
//! owner. sqlite3 parses a copy of a database, never the agent's file, and never as root.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::fs::MetadataExt as _;
use std::os::unix::process::CommandExt as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use nix::dir::{Dir, Type};
use nix::fcntl::{open, openat, OFlag};
use nix::sys::stat::{fstat, Mode};
use serde_json::{Map, Value};
use wsp_frames::{
    words, DaemonErrorCode, UsageLimitReading, UsageLimitWindow, UsageLogFormat, UsageLogRow, UsageLogsReply, UsageStore, UsageTokens,
};

use crate::beneath;
use crate::ops::Road;
use crate::paths::OpError;
use crate::Ctx;

const HALF_HOUR: i64 = 1_800_000;
/// The longest line read whole: a longer one carries a tool's output rather than a count, and is skipped.
const LINE_CAP: usize = 16 << 20;
/// How deep a store's folders are walked: Claude Code's subagents sit three below its projects folder and Codex's
/// rollouts three below its sessions folder, so a deeper tree is nothing an agent wrote there for itself.
const DEPTH_CAP: usize = 6;
/// The folder Claude Code moves a cleared session's transcript into, one level under its project's.
const CLEARED: &str = "_cleared_sessions";
const OPENCODE_QUERY: &str =
    "select id, directory, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated from session";
/// Where sqlite3 is looked for, by full path: on a computer somebody owns this daemon runs as root.
const SQLITE3: [&str; 3] = ["/usr/bin/sqlite3", "/usr/local/bin/sqlite3", "/opt/homebrew/bin/sqlite3"];
const SQLITE_DEADLINE: Duration = Duration::from_secs(20);
const SQLITE_POLL: Duration = Duration::from_millis(20);
/// The most of an OpenCode database copied out for sqlite3 to read, its write-ahead log included.
const DATABASE_CAP: u64 = 1 << 30;
/// The ids a database copied out of a home root owns is parsed as, the first no passwd or group entry names, so no
/// agent's file is parsed as root and no other process on the computer can read the copy while sqlite3 runs.
const UNNAMED_IDS: std::ops::RangeInclusive<u32> = 2_147_483_000..=2_147_483_646;

#[derive(Debug, Clone, PartialEq)]
struct Piece {
    session: String,
    at: i64,
    model: String,
    folder: Option<String>,
    tokens: UsageTokens,
    cost: Option<f64>,
}

/// What one file came to: its pieces folded by half hour, and the newest plan reading it carried.
#[derive(Debug, Clone, Default)]
struct FileRead {
    pieces: Vec<Piece>,
    limit: Option<UsageLimitReading>,
}

/// What each file came to, under its store and its name there, with the stamp it had when it was read.
#[derive(Default)]
pub(crate) struct UsageCache {
    files: Mutex<HashMap<String, (String, FileRead)>>,
}

/// usage.logs as the daemon answers it, read off the blocking pool. The home's agent stores are the person's: the host
/// asks for them, on the inbound socket of a daemon that is no place and on the link of one that is, and a socket
/// inside a workspace or a person holding a joined computer's token does not.
pub(crate) async fn serve(road: &Road, ctx: &Ctx, stores: Vec<UsageStore>) -> Result<UsageLogsReply, OpError> {
    if !crate::roads::host_road_serves(road, ctx.is_place()) {
        return Err(OpError::coded(DaemonErrorCode::Forbidden, words::NOT_ON_THIS_ROAD));
    }
    let home = crate::place::place_home(ctx.options.home.as_deref());
    let cache = std::sync::Arc::clone(&ctx.usage_logs);
    tokio::task::spawn_blocking(move || read(&stores, &home, &cache)).await.map_err(|e| OpError::plain(e.to_string()))
}

/// Every store named under `home`, read as the home's owner. A store that is not there counts nothing, and a file
/// that does not read, a link, a fifo or anything but a plain file, is skipped. A session whose files sit under two
/// holders (two of Claude Code's project folders) is counted from the holder whose newest message is latest, the
/// first found on a tie: a copy stops where it was taken while the original goes on.
pub(crate) fn read(stores: &[UsageStore], home: &Path, cache: &UsageCache) -> UsageLogsReply {
    let mut rows = Vec::new();
    let mut limits = Vec::new();
    let mut seen = HashSet::new();
    let Ok(held) = open(home, OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC, Mode::empty()) else {
        return UsageLogsReply { rows, limits };
    };
    let owner = fstat(held.as_fd()).map(|st| (st.st_uid, st.st_gid)).unwrap_or((0, 0));
    // A switch that did not take reads nothing: the read is never made as root over a home somebody else owns.
    let Ok(switched) = as_owner(owner.0, owner.1) else { return UsageLogsReply { rows, limits } };
    let daemon_root = nix::unistd::geteuid().is_root();
    for store in stores {
        let Some(root) = store.root.strip_prefix("~/") else { continue };
        let mut holders: HashMap<String, Vec<(String, i64, Vec<Piece>)>> = HashMap::new();
        let mut newest: Option<UsageLimitReading> = None;
        let mut take = |rel: &str, read: FileRead| {
            let holder = match store.format {
                UsageLogFormat::ClaudeJsonl => rel.split('/').next().unwrap_or_default().to_owned(),
                _ => rel.to_owned(),
            };
            for piece in read.pieces {
                let held = holders.entry(piece.session.clone()).or_default();
                let at = piece.at;
                match held.iter_mut().find(|(h, _, _)| *h == holder) {
                    Some((_, newest_at, pieces)) => {
                        *newest_at = (*newest_at).max(at);
                        pieces.push(piece);
                    }
                    None => held.push((holder.clone(), at, vec![piece])),
                }
            }
            if let Some(limit) = read.limit {
                if newest.as_ref().is_none_or(|n| limit.at > n.at) {
                    newest = Some(limit);
                }
            }
        };
        match store.format {
            UsageLogFormat::ClaudeJsonl | UsageLogFormat::CodexRollout => {
                let Some(dir) = folder(&held, root) else { continue };
                walk(dir, "", 0, &mut |rel, file| {
                    let claude = store.format == UsageLogFormat::ClaudeJsonl;
                    if claude && claude_session(rel).is_none() {
                        return;
                    }
                    let key = format!("{}/{rel}", store.root);
                    seen.insert(key.clone());
                    let Some(stamp) = stamp(&file) else { return };
                    let read = cached_read(cache, &key, &stamp, || if claude { claude_pieces(rel, file) } else { codex_pieces(rel, file) });
                    if let Some(read) = read {
                        take(rel, read);
                    }
                });
            }
            UsageLogFormat::OpencodeSqlite => {
                let Ok(Some(db)) = beneath::file(&held, root) else { continue };
                let wal = beneath::file(&held, &format!("{root}-wal")).ok().flatten();
                let key = store.root.clone();
                seen.insert(key.clone());
                let Some(stamp) = stamp(&db).map(|s| format!("{s}+{}", wal.as_ref().and_then(stamp).unwrap_or_default())) else { continue };
                let Some(parser) = parser_for(daemon_root, owner, switched.is_some()) else { continue };
                let Some(bin) = SQLITE3.iter().find(|p| Path::new(p).is_file()) else { continue };
                if let Some(read) =
                    cached_read(cache, &key, &stamp, || opencode_pieces(db, wal, parser, Path::new(bin), &std::env::temp_dir()))
                {
                    take(root, read);
                }
            }
        }
        for held in holders.into_values() {
            let mut kept: Option<(String, i64, Vec<Piece>)> = None;
            for h in held {
                if kept.as_ref().is_none_or(|k| h.1 > k.1) {
                    kept = Some(h);
                }
            }
            for p in folded(kept.map(|k| k.2).unwrap_or_default()) {
                rows.push(UsageLogRow {
                    agent: store.agent.clone(),
                    session: p.session,
                    at: p.at,
                    model: p.model,
                    folder: p.folder,
                    tokens: p.tokens,
                    cost: p.cost,
                });
            }
        }
        if let Some(limit) = newest {
            limits.push(UsageLimitReading { agent: store.agent.clone(), ..limit });
        }
    }
    cache.files.lock().unwrap_or_else(|e| e.into_inner()).retain(|key, _| seen.contains(key));
    rows.sort_by(|a, b| (&a.agent, &a.session, a.at, &a.model, &a.folder).cmp(&(&b.agent, &b.session, b.at, &b.model, &b.folder)));
    UsageLogsReply { rows, limits }
}

/// The file's read off the cache where its stamp has not moved, else read now and kept; a file that does not read
/// is not kept, so the next read tries it again.
fn cached_read(cache: &UsageCache, key: &str, stamp: &str, read: impl FnOnce() -> Option<FileRead>) -> Option<FileRead> {
    if let Some((held, read)) = cache.files.lock().unwrap_or_else(|e| e.into_inner()).get(key) {
        if held == stamp {
            return Some(read.clone());
        }
    }
    let fresh = read()?;
    cache.files.lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_owned(), (stamp.to_owned(), fresh.clone()));
    Some(fresh)
}

/// The thread's file access as the home's owner, put back when this goes. Linux keeps file credentials per thread and
/// these are the raw calls, since glibc's own setgroups changes every thread of the process. Nothing to drop where
/// this daemon is not root, which is every Mac: there it runs as the person, in their own session.
#[cfg(target_os = "linux")]
struct AsOwner {
    uid: nix::unistd::Uid,
    gid: nix::unistd::Gid,
    groups: Vec<nix::unistd::Gid>,
}

/// Ok(None) where there is nothing to switch, and an error where a switch was due and did not take, which the read
/// answers with nothing. setfsuid and setfsgid report no failure, so each is read back by setting it again.
#[cfg(target_os = "linux")]
fn as_owner(uid: u32, gid: u32) -> Result<Option<AsOwner>, ()> {
    use nix::unistd::{geteuid, getgroups, setfsgid, setfsuid, Gid, Uid};
    if !geteuid().is_root() || uid == 0 {
        return Ok(None);
    }
    let groups = getgroups().map_err(|_| ())?;
    // SAFETY: setgroups with no list touches no memory, and the raw call changes the calling thread alone.
    if unsafe { nix::libc::syscall(nix::libc::SYS_setgroups, 0usize, std::ptr::null::<nix::libc::gid_t>()) } != 0 {
        return Err(());
    }
    let mut held = AsOwner { uid: Uid::from_raw(0), gid: Gid::from_raw(0), groups };
    held.gid = setfsgid(Gid::from_raw(gid));
    held.uid = setfsuid(Uid::from_raw(uid));
    // From here a refusal drops `held`, which puts back what was in force.
    if setfsgid(Gid::from_raw(gid)) != Gid::from_raw(gid) || setfsuid(Uid::from_raw(uid)) != Uid::from_raw(uid) {
        return Err(());
    }
    Ok(Some(held))
}

#[cfg(target_os = "linux")]
impl Drop for AsOwner {
    fn drop(&mut self) {
        nix::unistd::setfsuid(self.uid);
        nix::unistd::setfsgid(self.gid);
        let groups: Vec<nix::libc::gid_t> = self.groups.iter().map(|g| g.as_raw()).collect();
        // SAFETY: the list lives for the call, and the raw call changes the calling thread alone.
        unsafe { nix::libc::syscall(nix::libc::SYS_setgroups, groups.len(), groups.as_ptr()) };
    }
}

#[cfg(not(target_os = "linux"))]
fn as_owner(_uid: u32, _gid: u32) -> Result<Option<()>, ()> {
    Ok(None)
}

/// The first id of UNNAMED_IDS that neither a passwd nor a group entry names, read at each use.
fn unnamed_id() -> Option<u32> {
    use nix::unistd::{Gid, Group, Uid, User};
    UNNAMED_IDS
        .rev()
        .find(|id| matches!(User::from_uid(Uid::from_raw(*id)), Ok(None)) && matches!(Group::from_gid(Gid::from_raw(*id)), Ok(None)))
}

/// The parser for a home with this owner: as is where the daemon is not root; as the owner where it is, and the copy
/// already theirs where this thread runs as them; as an id nobody is named for where the home is root's. Nothing where
/// no such id is free.
fn parser_for(root: bool, owner: (u32, u32), switched: bool) -> Option<Parser> {
    let run_as = match (root, owner.0) {
        (false, _) => None,
        (true, 0) => unnamed_id().map(|id| (id, id)),
        (true, _) => Some(owner),
    };
    if root && run_as.is_none() {
        return None;
    }
    Some(Parser { run_as, hand_over: root && !switched })
}

/// Who sqlite3 reads a copied database as: the uid and gid it drops to before it runs, where the daemon is root, and
/// whether the daemon hands the copy to them, which it need not where this thread already writes it as them.
#[derive(Debug, Clone, Copy)]
struct Parser {
    run_as: Option<(u32, u32)>,
    hand_over: bool,
}

/// A folder under the held home, every folder on the way opened with no link followed; nothing where one is not
/// there, is not a folder, or is a link.
fn folder(held: &OwnedFd, rel: &str) -> Option<OwnedFd> {
    let (parent, leaf) = beneath::parent_of(held, rel).ok()??;
    openat(&parent, leaf, beneath::dir_flags(), Mode::empty()).ok()
}

/// Each `.jsonl` file under a held folder, in name order, handed open with its name under the folder: a folder is
/// opened with no link followed and a file through `beneath::file()`, so a link, a fifo or a socket names nothing.
fn walk(dir: OwnedFd, rel: &str, depth: usize, each: &mut dyn FnMut(&str, File)) {
    let Ok(listing) = dir.try_clone().map_err(|_| ()).and_then(|fd| Dir::from_fd(fd).map_err(|_| ())) else { return };
    let mut names: Vec<(String, Option<Type>)> = Vec::new();
    let mut listing = listing;
    for entry in listing.iter().flatten() {
        let Ok(name) = entry.file_name().to_str() else { continue };
        if name != "." && name != ".." {
            names.push((name.to_owned(), entry.file_type()));
        }
    }
    drop(listing);
    names.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, kind) in names {
        let below = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let is_dir = match kind {
            Some(Type::Directory) => true,
            Some(Type::File) => false,
            None => openat(&dir, name.as_str(), beneath::dir_flags(), Mode::empty()).is_ok(),
            _ => continue,
        };
        if is_dir {
            if depth < DEPTH_CAP {
                if let Ok(next) = openat(&dir, name.as_str(), beneath::dir_flags(), Mode::empty()) {
                    walk(next, &below, depth + 1, each);
                }
            }
        } else if name.ends_with(".jsonl") {
            if let Ok(Some(file)) = beneath::file(&dir, &name) {
                each(&below, file);
            }
        }
    }
}

/// What says an open file has not changed since it was last read.
fn stamp(file: &File) -> Option<String> {
    let meta = file.metadata().ok()?;
    Some(format!("{}.{}:{}", meta.mtime(), meta.mtime_nsec(), meta.len()))
}

/// A file's name without its last extension.
fn stem(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(dot) if dot > 0 => &base[..dot],
        _ => base,
    }
}

/// The session a transcript under Claude Code's projects folder belongs to, off its path under that folder: the file
/// itself in a project's folder, the folder it sits under (a session's subagents), or a cleared session's file.
fn claude_session(rel: &str) -> Option<String> {
    let mut parts = rel.split('/');
    parts.next()?;
    let second = parts.next()?;
    if second == CLEARED {
        return parts.next().map(|third| stem(third).to_owned());
    }
    Some(if second.ends_with(".jsonl") { stem(second).to_owned() } else { second.to_owned() })
}

/// Each line of an open file that `wanted` keeps, a line past the cap skipped whole.
fn lines(file: File, wanted: impl Fn(&str) -> bool, mut each: impl FnMut(&str)) -> Option<()> {
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let mut over = false;
        loop {
            let buf = match reader.fill_buf() {
                Ok(buf) => buf,
                Err(_) => return Some(()),
            };
            if buf.is_empty() {
                break;
            }
            let (take, done) = match buf.iter().position(|b| *b == b'\n') {
                Some(at) => (at + 1, true),
                None => (buf.len(), false),
            };
            if !over && line.len() + take <= LINE_CAP {
                line.extend_from_slice(&buf[..take]);
            } else {
                over = true;
                line.clear();
            }
            reader.consume(take);
            if done {
                break;
            }
        }
        if line.is_empty() && !over {
            return Some(());
        }
        if over {
            continue;
        }
        if let Ok(text) = std::str::from_utf8(&line) {
            let text = text.trim_end();
            if wanted(text) {
                each(text);
            }
        }
    }
}

fn count(value: Option<&Value>) -> u64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => n as u64,
        _ => 0,
    }
}

fn add_to(into: &mut UsageTokens, t: &UsageTokens) {
    into.input += t.input;
    into.output += t.output;
    into.cached += t.cached;
    into.cache_write += t.cache_write;
    into.reasoning += t.reasoning;
}

/// Pieces summed by session, model, folder and half hour, the newest moment of each kept, in the order first seen.
fn folded(pieces: Vec<Piece>) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::new();
    let mut at: HashMap<(String, String, Option<String>, i64), usize> = HashMap::new();
    for p in pieces {
        let key = (p.session.clone(), p.model.clone(), p.folder.clone(), p.at.div_euclid(HALF_HOUR));
        match at.get(&key) {
            Some(&i) => {
                let held = &mut out[i];
                add_to(&mut held.tokens, &p.tokens);
                held.at = held.at.max(p.at);
                if let Some(cost) = p.cost {
                    held.cost = Some(held.cost.unwrap_or(0.0) + cost);
                }
            }
            None => {
                at.insert(key, out.len());
                out.push(p);
            }
        }
    }
    out
}

/// Claude Code writes one line per block of a message and every one repeats the message's usage, so a message is
/// counted once, by its id. input is everything the model read, the cached and the written part included.
fn claude_pieces(rel: &str, file: File) -> Option<FileRead> {
    let session = claude_session(rel)?;
    let mut seen = HashSet::new();
    let mut pieces = Vec::new();
    lines(
        file,
        |line| line.contains("\"usage\"") && line.contains("\"assistant\""),
        |line| {
            let Ok(Value::Object(row)) = serde_json::from_str::<Value>(line) else { return };
            if row.get("type").and_then(Value::as_str) != Some("assistant") {
                return;
            }
            let Some(message) = row.get("message").and_then(Value::as_object) else { return };
            let Some(usage) = message.get("usage").and_then(Value::as_object) else { return };
            let Some(id) = message.get("id").and_then(Value::as_str) else { return };
            let Some(at) = row.get("timestamp").and_then(Value::as_str).and_then(epoch_ms) else { return };
            let model = message.get("model").and_then(Value::as_str).unwrap_or_default();
            // Claude Code files its own error lines as messages of a model it calls <synthetic>, which no model wrote.
            if model == "<synthetic>" || !seen.insert(id.to_owned()) {
                return;
            }
            let cached = count(usage.get("cache_read_input_tokens"));
            let cache_write = count(usage.get("cache_creation_input_tokens"));
            pieces.push(Piece {
                session: session.clone(),
                at,
                model: model.to_owned(),
                folder: row.get("cwd").and_then(Value::as_str).map(str::to_owned),
                tokens: UsageTokens {
                    input: count(usage.get("input_tokens")) + cached + cache_write,
                    output: count(usage.get("output_tokens")),
                    cached,
                    cache_write,
                    reasoning: 0,
                },
                cost: None,
            });
        },
    )?;
    Some(FileRead { pieces: folded(pieces), limit: None })
}

/// A Codex rollout's token_count lines carry the thread's running total, so each one's use is what the total gained
/// since the one before, under the model the last turn_context named. The thread is the id session_meta names,
/// which is what wsp's own row keeps for a Codex thread. The same lines carry the plan's windows as they stood.
fn codex_pieces(rel: &str, file: File) -> Option<FileRead> {
    let mut session = stem(rel).to_owned();
    let mut folder: Option<String> = None;
    let mut model = String::new();
    let mut before = UsageTokens::default();
    let mut pieces: Vec<(i64, String, UsageTokens)> = Vec::new();
    let mut limit: Option<UsageLimitReading> = None;
    lines(
        file,
        |line| line.contains("\"session_meta\"") || line.contains("\"turn_context\"") || line.contains("\"token_count\""),
        |line| {
            let Ok(Value::Object(row)) = serde_json::from_str::<Value>(line) else { return };
            let Some(payload) = row.get("payload").and_then(Value::as_object) else { return };
            match row.get("type").and_then(Value::as_str) {
                Some("session_meta") => {
                    if let Some(id) = payload.get("id").and_then(Value::as_str) {
                        session = id.to_owned();
                    }
                    if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                        folder = Some(cwd.to_owned());
                    }
                }
                Some("turn_context") => {
                    if let Some(m) = payload.get("model").and_then(Value::as_str) {
                        model = m.to_owned();
                    }
                }
                _ if payload.get("type").and_then(Value::as_str) == Some("token_count") => {
                    let Some(at) = row.get("timestamp").and_then(Value::as_str).and_then(epoch_ms) else { return };
                    if let Some(reading) = payload.get("rate_limits").and_then(Value::as_object).and_then(|r| codex_limit(r, at)) {
                        limit = Some(reading);
                    }
                    let Some(t) = payload.get("info").and_then(|i| i.get("total_token_usage")).and_then(Value::as_object) else { return };
                    let total = UsageTokens {
                        input: count(t.get("input_tokens")),
                        output: count(t.get("output_tokens")),
                        cached: count(t.get("cached_input_tokens")),
                        cache_write: count(t.get("cache_write_input_tokens")),
                        reasoning: count(t.get("reasoning_output_tokens")),
                    };
                    // A total under the last one started again from nothing, so all of it is new.
                    let restarted = total.input < before.input || total.output < before.output;
                    let gained = if restarted {
                        total
                    } else {
                        UsageTokens {
                            input: total.input.saturating_sub(before.input),
                            output: total.output.saturating_sub(before.output),
                            cached: total.cached.saturating_sub(before.cached),
                            cache_write: total.cache_write.saturating_sub(before.cache_write),
                            reasoning: total.reasoning.saturating_sub(before.reasoning),
                        }
                    };
                    before = total;
                    if gained.input + gained.output > 0 {
                        pieces.push((at, model.clone(), gained));
                    }
                }
                _ => {}
            }
        },
    )?;
    let pieces = pieces
        .into_iter()
        .map(|(at, model, tokens)| Piece { session: session.clone(), at, model, folder: folder.clone(), tokens, cost: None })
        .collect();
    Some(FileRead { pieces: folded(pieces), limit })
}

/// The windows a rollout's rate_limits held at a line's moment, in the shape Codex's server answers a rate-limits read
/// with: a window's length and its reset, epoch seconds, where the line named them. A snapshot of a meter other than
/// codex's own, or one with no window in it, is no reading.
fn codex_limit(limits: &Map<String, Value>, at: i64) -> Option<UsageLimitReading> {
    if let Some(id) = limits.get("limit_id").and_then(Value::as_str) {
        if id != "codex" {
            return None;
        }
    }
    let window = |slot: &str| -> Option<UsageLimitWindow> {
        let w = limits.get(slot)?.as_object()?;
        let used_percent = w.get("used_percent")?.as_f64().filter(|n| n.is_finite())?;
        let resets_at = w
            .get("resets_at")
            .and_then(Value::as_i64)
            .or_else(|| w.get("resets_in_seconds").and_then(Value::as_i64).map(|s| at.div_euclid(1000) + s));
        Some(UsageLimitWindow { used_percent, window_duration_mins: w.get("window_minutes").and_then(Value::as_u64), resets_at })
    };
    let (primary, secondary) = (window("primary"), window("secondary"));
    if primary.is_none() && secondary.is_none() {
        return None;
    }
    let word = |key: &str| limits.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(UsageLimitReading {
        agent: String::new(),
        at,
        primary,
        secondary,
        plan_type: word("plan_type"),
        rate_limit_reached_type: word("rate_limit_reached_type"),
    })
}

/// A model as OpenCode's session row names it: a JSON pair of provider and model, else the text as it is.
fn opencode_model(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else { return String::new() };
    if let Ok(Value::Object(pair)) = serde_json::from_str::<Value>(text) {
        if let Some(model) = pair.get("modelID").and_then(Value::as_str) {
            return match pair.get("providerID").and_then(Value::as_str) {
                Some(provider) => format!("{provider}/{model}"),
                None => model.to_owned(),
            };
        }
    }
    text.to_owned()
}

/// OpenCode 1.x keeps each session's own totals and cost on its row. Its input leaves the cache out, so the cached and
/// written parts are added in, as every other agent's input counts them.
fn opencode_pieces(db: File, wal: Option<File>, parser: Parser, bin: &Path, scratch: &Path) -> Option<FileRead> {
    let out = sqlite_json(db, wal, parser, bin, scratch)?;
    let rows: Value = if out.trim().is_empty() { Value::Array(Vec::new()) } else { serde_json::from_str(&out).ok()? };
    let pieces = rows
        .as_array()?
        .iter()
        .filter_map(|raw| {
            let raw = raw.as_object()?;
            let id = raw.get("id")?.as_str()?;
            let cached = count(raw.get("tokens_cache_read"));
            let cache_write = count(raw.get("tokens_cache_write"));
            let tokens = UsageTokens {
                input: count(raw.get("tokens_input")) + cached + cache_write,
                output: count(raw.get("tokens_output")),
                cached,
                cache_write,
                reasoning: count(raw.get("tokens_reasoning")),
            };
            if tokens.input + tokens.output == 0 {
                return None;
            }
            Some(Piece {
                session: id.to_owned(),
                at: count(raw.get("time_updated")) as i64,
                model: opencode_model(raw.get("model")),
                folder: raw.get("directory").and_then(Value::as_str).map(str::to_owned),
                tokens,
                cost: raw.get("cost").and_then(Value::as_f64).filter(|c| c.is_finite() && *c > 0.0),
            })
        })
        .collect();
    Some(FileRead { pieces, limit: None })
}

/// A private folder the daemon made under the system's temp folder, held by descriptor and taken away with all it
/// holds when this goes.
struct Scratch {
    path: std::path::PathBuf,
    fd: OwnedFd,
    names: Vec<&'static str>,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        for name in ["db-shm", "db-journal"].iter().chain(self.names.iter()) {
            let _ = nix::unistd::unlinkat(&self.fd, *name, nix::unistd::UnlinkatFlags::NoRemoveDir);
        }
        let _ = nix::unistd::unlinkat(nix::fcntl::AT_FDCWD, &self.path, nix::unistd::UnlinkatFlags::RemoveDir);
    }
}

/// The session rows of an OpenCode database as sqlite3 prints them in JSON. The database and its write-ahead log are
/// copied out of the open files into a private folder made under `scratch`, and sqlite3 reads the copy on no
/// environment of this daemon's, as the parser's ids, which it drops to before it runs. Nothing where the two files
/// pass the cap, checked before a byte is copied and again as they grow, or sqlite3 fails or overruns its deadline.
fn sqlite_json(db: File, wal: Option<File>, parser: Parser, bin: &Path, scratch: &Path) -> Option<String> {
    let size = db.metadata().ok()?.len() + wal.as_ref().map_or(Some(0), |w| w.metadata().ok().map(|m| m.len()))?;
    if size > DATABASE_CAP {
        return None;
    }
    let path = nix::unistd::mkdtemp(&scratch.join("wsp-usage-XXXXXX")).ok()?;
    let fd = open(&path, beneath::dir_flags(), Mode::empty()).ok()?;
    let mut scratch = Scratch { path, fd, names: Vec::new() };
    let mut room = DATABASE_CAP;
    for (name, from) in [("db", Some(db)), ("db-wal", wal)] {
        let Some(mut from) = from else { continue };
        let made = OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut to = File::from(openat(&scratch.fd, name, made, Mode::from_bits_truncate(0o600)).ok()?);
        scratch.names.push(name);
        let copied = std::io::copy(&mut (&mut from).take(room + 1), &mut to).ok()?;
        if copied > room {
            return None;
        }
        room -= copied;
        to.flush().ok()?;
        if let (true, Some((uid, gid))) = (parser.hand_over, parser.run_as) {
            std::os::unix::fs::fchown(&to, Some(uid), Some(gid)).ok()?;
        }
    }
    if let (true, Some((uid, gid))) = (parser.hand_over, parser.run_as) {
        std::os::unix::fs::fchown(scratch.fd.as_fd(), Some(uid), Some(gid)).ok()?;
    }
    let mut command = Command::new(bin);
    command
        .arg("-json")
        .arg(scratch.path.join("db"))
        .arg(OPENCODE_QUERY)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some((uid, gid)) = parser.run_as {
        command.uid(uid).gid(gid);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // Read while it runs, so a database with many sessions never fills the pipe and stalls sqlite3 to its deadline.
    let reading = std::thread::spawn(move || {
        let mut out = String::new();
        stdout.read_to_string(&mut out).map(|_| out)
    });
    let until = Instant::now() + SQLITE_DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < until => std::thread::sleep(SQLITE_POLL),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let out = reading.join().ok()?.ok()?;
    status.success().then_some(out)
}

/// An RFC 3339 instant, as the stores write it, in ms epoch: a date, a time with or without its fraction, and Z or
/// an offset.
fn epoch_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = text.get(from..from + len)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut at = 19;
    let mut ms = 0i64;
    if b.get(at) == Some(&b'.') {
        let digits = text[at + 1..].bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let frac = &text[at + 1..at + 1 + digits.min(3)];
        ms = frac.parse::<i64>().ok()? * 10i64.pow(3 - frac.len() as u32);
        at += 1 + digits;
    }
    let offset_min = match b.get(at) {
        Some(b'Z' | b'z') if at + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if at + 6 == b.len() && b[at + 3] == b':' => {
            let minutes = num(at + 1, 2)? * 60 + num(at + 4, 2)?;
            if *sign == b'+' {
                minutes
            } else {
                -minutes
            }
        }
        _ => return None,
    };
    // Days from the civil date, Howard Hinnant's algorithm.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second - offset_min * 60) * 1_000) + ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::sys::stat::Mode;
    use serde_json::json;

    const NOBODY: u32 = 65_534;

    fn store(agent: &str, format: UsageLogFormat, root: &str) -> UsageStore {
        UsageStore { agent: agent.to_owned(), format, root: root.to_owned() }
    }

    fn write(home: &Path, rel: &str, lines: &[Value]) {
        let path = home.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    }

    fn claude_line(id: &str, session: &str, at: &str, model: &str, cwd: Option<&str>, usage: Value) -> Value {
        let mut row = json!({ "type": "assistant", "sessionId": session, "timestamp": at, "requestId": format!("req_{id}"), "message": { "id": id, "model": model, "role": "assistant", "content": [{ "type": "text", "text": "x" }], "usage": usage } });
        if let Some(cwd) = cwd {
            row["cwd"] = json!(cwd);
        }
        row
    }

    fn ms(at: &str) -> i64 {
        epoch_ms(at).unwrap()
    }

    const CLAUDE: &str = "~/.claude/projects";
    const CODEX: &str = "~/.codex/sessions";

    #[test]
    fn an_instant_reads_as_javascript_reads_it() {
        assert_eq!(epoch_ms("2026-09-29T10:00:00.000Z"), Some(1_790_676_000_000));
        assert_eq!(epoch_ms("2026-09-29T10:00:00Z"), Some(1_790_676_000_000));
        assert_eq!(epoch_ms("2026-09-29T10:00:00.5Z"), Some(1_790_676_000_500));
        assert_eq!(epoch_ms("2026-09-29T12:00:00.123456+02:00"), Some(1_790_676_000_123));
        assert_eq!(epoch_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(epoch_ms("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        for bad in ["", "yesterday", "2026-09-29", "2026-13-01T00:00:00Z", "2026-09-29T10:00:00", "2026-09-29T10:00:00.Z"] {
            assert_eq!(epoch_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn claude_counts_a_message_once_though_every_block_repeats_its_usage() {
        let home = tempfile::tempdir().unwrap();
        let usage = json!({ "input_tokens": 2, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1_000, "output_tokens": 50 });
        write(
            home.path(),
            ".claude/projects/-Users-dev-proj/s1.jsonl",
            &[
                claude_line("msg_1", "s1", "2026-09-29T10:00:00.000Z", "claude-opus-5", Some("/Users/dev/proj"), usage.clone()),
                claude_line("msg_1", "s1", "2026-09-29T10:00:01.000Z", "claude-opus-5", Some("/Users/dev/proj"), usage),
                claude_line(
                    "msg_2",
                    "s1",
                    "2026-09-29T10:05:00.000Z",
                    "claude-opus-5",
                    Some("/Users/dev/proj"),
                    json!({ "input_tokens": 10, "output_tokens": 5 }),
                ),
                json!({ "type": "user", "message": { "role": "user", "content": "a tool's result is not usage" } }),
            ],
        );
        let read = super::read(&[store("claude", UsageLogFormat::ClaudeJsonl, CLAUDE)], home.path(), &UsageCache::default());
        assert_eq!(
            read.rows,
            vec![UsageLogRow {
                agent: "claude".into(),
                session: "s1".into(),
                at: ms("2026-09-29T10:05:00.000Z"),
                model: "claude-opus-5".into(),
                folder: Some("/Users/dev/proj".into()),
                tokens: UsageTokens { input: 1_112, output: 55, cached: 1_000, cache_write: 100, reasoning: 0 },
                cost: None,
            }]
        );
        assert!(read.limits.is_empty());
    }

    #[test]
    fn a_session_under_two_project_folders_counts_once_by_the_folder_whose_newest_message_is_latest() {
        let home = tempfile::tempdir().unwrap();
        let at = |m: u32| format!("2026-09-06T10:{m:02}:00.000Z");
        let msg = |id: &str, m: u32, cwd: &str, input: u64| {
            claude_line(id, "s1", &at(m), "claude-opus-5", Some(cwd), json!({ "input_tokens": input, "output_tokens": 1 }))
        };
        let (own, copy) = ("/Users/dev/wsp", "/private/tmp/wsp-test/export-dev/wsp");
        let copied = |cwd: &str| (1..=30).map(|i| msg(&format!("msg_{i}"), i, cwd, 100)).collect::<Vec<_>>();
        let mut original = copied(own);
        original.push(msg("msg_grown", 50, own, 1_000));
        write(home.path(), ".claude/projects/-Users-dev-wsp/s1.jsonl", &original);
        write(home.path(), ".claude/projects/-Users-dev-wsp/s1/subagents/agent-a.jsonl", &[msg("msg_sub", 31, own, 5)]);
        write(home.path(), ".claude/projects/-private-tmp-wsp-test-export-dev-wsp/s1.jsonl", &copied(copy));
        write(
            home.path(),
            ".claude/projects/-private-tmp-wsp-test-export-dev-wsp/s1/subagents/agent-a.jsonl",
            &[msg("msg_sub", 31, copy, 5)],
        );
        write(
            home.path(),
            ".claude/projects/-private-tmp-wsp-test-export-dev-wsp/s2.jsonl",
            &[claude_line("msg_9", "s2", &at(5), "claude-opus-5", Some(copy), json!({ "input_tokens": 7, "output_tokens": 1 }))],
        );
        let read = super::read(&[store("claude", UsageLogFormat::ClaudeJsonl, CLAUDE)], home.path(), &UsageCache::default());
        let mut summed: Vec<(String, Option<String>, u64, u64)> = Vec::new();
        for r in read.rows {
            match summed.iter_mut().find(|s| s.0 == r.session && s.1 == r.folder) {
                Some(s) => {
                    s.2 += r.tokens.input;
                    s.3 += r.tokens.output;
                }
                None => summed.push((r.session, r.folder, r.tokens.input, r.tokens.output)),
            }
        }
        assert_eq!(summed, vec![("s1".into(), Some(own.into()), 4_005, 32), ("s2".into(), Some(copy.into()), 7, 1)]);
    }

    fn token_count(at: &str, total: Value, rate_limits: Value) -> Value {
        json!({ "timestamp": at, "type": "event_msg", "payload": { "type": "token_count", "info": { "total_token_usage": total }, "rate_limits": rate_limits } })
    }

    #[test]
    fn codex_files_what_each_total_gained_under_the_thread_its_session_meta_names_and_the_model_then_running() {
        let home = tempfile::tempdir().unwrap();
        let total = |input: u64, cached: u64, output: u64| json!({ "input_tokens": input, "cached_input_tokens": cached, "output_tokens": output, "reasoning_output_tokens": 0 });
        write(
            home.path(),
            ".codex/sessions/2026/09/29/rollout-2026-09-29T09-00-00-01a0e365.jsonl",
            &[
                json!({ "timestamp": "2026-09-29T09:00:00.000Z", "type": "session_meta", "payload": { "id": "01a0e365-72f3-77e3-ba3a-3d18e12e9b95", "cwd": "/Users/dev/proj" } }),
                json!({ "timestamp": "2026-09-29T09:00:01.000Z", "type": "turn_context", "payload": { "model": "gpt-5.5" } }),
                token_count("2026-09-29T09:01:00.000Z", total(1_000, 400, 20), json!({})),
                token_count("2026-09-29T14:02:00.000Z", total(3_000, 2_000, 90), json!({})),
                json!({ "timestamp": "2026-09-30T00:59:00.000Z", "type": "turn_context", "payload": { "model": "gpt-5.5-mini" } }),
                token_count("2026-09-30T01:00:00.000Z", total(3_500, 2_100, 100), json!({})),
                token_count(
                    "2026-09-30T01:10:00.000Z",
                    json!({ "input_tokens": 50, "cached_input_tokens": 0, "cache_write_input_tokens": 30, "output_tokens": 1 }),
                    json!({}),
                ),
            ],
        );
        let read = super::read(&[store("codex", UsageLogFormat::CodexRollout, CODEX)], home.path(), &UsageCache::default());
        let got: Vec<_> = read
            .rows
            .iter()
            .map(|r| {
                (
                    r.session.as_str(),
                    r.at,
                    r.model.as_str(),
                    r.folder.as_deref(),
                    r.tokens.input,
                    r.tokens.cached,
                    r.tokens.cache_write,
                    r.tokens.output,
                )
            })
            .collect();
        let thread = "01a0e365-72f3-77e3-ba3a-3d18e12e9b95";
        assert_eq!(
            got,
            vec![
                (thread, ms("2026-09-29T09:01:00.000Z"), "gpt-5.5", Some("/Users/dev/proj"), 1_000, 400, 0, 20),
                (thread, ms("2026-09-29T14:02:00.000Z"), "gpt-5.5", Some("/Users/dev/proj"), 2_000, 1_600, 0, 70),
                // A total under the last one started again from nothing, and its cache writes are kept.
                (thread, ms("2026-09-30T01:10:00.000Z"), "gpt-5.5-mini", Some("/Users/dev/proj"), 550, 100, 30, 11),
            ]
        );
    }

    #[test]
    fn codex_keeps_the_newest_plan_reading_any_rollout_carried_at_its_line_s_moment() {
        let home = tempfile::tempdir().unwrap();
        let total = json!({ "input_tokens": 10, "output_tokens": 1 });
        let limits = |used: f64| json!({ "primary": { "used_percent": used, "window_minutes": 300, "resets_at": 1_790_690_000 }, "secondary": { "used_percent": 12.0, "window_minutes": 10_080, "resets_in_seconds": 3_600 }, "plan_type": "pro" });
        write(
            home.path(),
            ".codex/sessions/2026/09/29/rollout-a.jsonl",
            &[
                token_count("2026-09-29T09:00:00.000Z", total.clone(), limits(40.0)),
                token_count("2026-09-29T11:00:00.000Z", total.clone(), limits(55.5)),
            ],
        );
        write(
            home.path(),
            ".codex/sessions/2026/09/29/rollout-b.jsonl",
            &[
                token_count("2026-09-29T10:00:00.000Z", total.clone(), limits(50.0)),
                // Another meter's bucket, and a line whose limits name no window, read as no reading.
                token_count("2026-09-29T12:00:00.000Z", total.clone(), json!({ "limit_id": "other", "primary": { "used_percent": 99.0 } })),
                token_count("2026-09-29T12:30:00.000Z", total, json!({ "primary": null })),
            ],
        );
        let read = super::read(&[store("codex", UsageLogFormat::CodexRollout, CODEX)], home.path(), &UsageCache::default());
        let at = ms("2026-09-29T11:00:00.000Z");
        assert_eq!(
            read.limits,
            vec![UsageLimitReading {
                agent: "codex".into(),
                at,
                primary: Some(UsageLimitWindow { used_percent: 55.5, window_duration_mins: Some(300), resets_at: Some(1_790_690_000) }),
                secondary: Some(UsageLimitWindow {
                    used_percent: 12.0,
                    window_duration_mins: Some(10_080),
                    resets_at: Some(at / 1000 + 3_600)
                }),
                plan_type: Some("pro".into()),
                rate_limit_reached_type: None,
            }]
        );
    }

    #[test]
    fn claude_leaves_out_the_lines_it_writes_under_no_model_and_a_line_past_the_cap() {
        let home = tempfile::tempdir().unwrap();
        let big = claude_line(
            "msg_big",
            "s1",
            "2026-09-29T10:02:00.000Z",
            "claude-opus-5",
            Some(&"x".repeat(LINE_CAP)),
            json!({ "input_tokens": 1_000_000, "output_tokens": 1 }),
        );
        write(
            home.path(),
            ".claude/projects/-Users-dev-proj/s1.jsonl",
            &[
                claude_line(
                    "msg_1",
                    "s1",
                    "2026-09-29T10:00:00.000Z",
                    "<synthetic>",
                    None,
                    json!({ "input_tokens": 5, "output_tokens": 1 }),
                ),
                big,
                claude_line(
                    "msg_2",
                    "s1",
                    "2026-09-29T10:01:00.000Z",
                    "claude-opus-5",
                    None,
                    json!({ "input_tokens": 7, "output_tokens": 1 }),
                ),
            ],
        );
        let read = super::read(&[store("claude", UsageLogFormat::ClaudeJsonl, CLAUDE)], home.path(), &UsageCache::default());
        assert_eq!(read.rows.iter().map(|r| (r.model.as_str(), r.tokens.input)).collect::<Vec<_>>(), vec![("claude-opus-5", 7)]);
    }

    #[test]
    fn a_file_whose_stamp_has_not_moved_is_answered_off_the_cache_and_a_gone_one_leaves_it() {
        let home = tempfile::tempdir().unwrap();
        let rel = ".claude/projects/-Users-dev-proj/s1.jsonl";
        let line = |input: u64| {
            claude_line(
                "msg_1",
                "s1",
                "2026-09-29T10:00:00.000Z",
                "claude-opus-5",
                None,
                json!({ "input_tokens": input, "output_tokens": 1 }),
            )
        };
        write(home.path(), rel, &[line(1)]);
        let stores = [store("claude", UsageLogFormat::ClaudeJsonl, CLAUDE)];
        let cache = UsageCache::default();
        assert_eq!(super::read(&stores, home.path(), &cache).rows[0].tokens.input, 1);
        // What the cache holds for the file is what a read with an unmoved stamp answers: the file is not opened.
        let path = home.path().join(rel);
        cache.files.lock().unwrap().get_mut(&format!("~/{rel}")).unwrap().1.pieces[0].tokens.input = 999;
        assert_eq!(super::read(&stores, home.path(), &cache).rows[0].tokens.input, 999);
        // A write that moves the stamp is read again.
        write(home.path(), rel, &[line(2), line(2)]);
        assert_eq!(super::read(&stores, home.path(), &cache).rows[0].tokens.input, 2);
        std::fs::remove_file(&path).unwrap();
        assert!(super::read(&stores, home.path(), &cache).rows.is_empty());
        assert!(cache.files.lock().unwrap().is_empty());
    }

    #[test]
    fn a_store_that_is_not_there_counts_nothing_and_a_root_outside_the_home_is_not_read() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        write(
            other.path(),
            "proj/s1.jsonl",
            &[claude_line(
                "msg_1",
                "s1",
                "2026-09-29T10:00:00.000Z",
                "claude-opus-5",
                None,
                json!({ "input_tokens": 3, "output_tokens": 1 }),
            )],
        );
        let stores = [
            store("claude", UsageLogFormat::ClaudeJsonl, CLAUDE),
            store("codex", UsageLogFormat::CodexRollout, CODEX),
            store("opencode", UsageLogFormat::OpencodeSqlite, "~/.local/share/opencode/opencode.db"),
            store("claude", UsageLogFormat::ClaudeJsonl, &other.path().to_string_lossy()),
        ];
        let read = super::read(&stores, home.path(), &UsageCache::default());
        assert!(read.rows.is_empty(), "{:?}", read.rows);
    }

    #[test]
    fn a_link_in_a_store_is_not_followed() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(
            outside.path(),
            "s9.jsonl",
            &[claude_line(
                "msg_1",
                "s9",
                "2026-09-29T10:00:00.000Z",
                "claude-opus-5",
                None,
                json!({ "input_tokens": 3, "output_tokens": 1 }),
            )],
        );
        std::fs::create_dir_all(home.path().join(".claude/projects")).unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join(".claude/projects/-linked")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("s9.jsonl"), home.path().join(".claude/projects/-linked-file.jsonl")).unwrap();
        let read = super::read(&[store("claude", UsageLogFormat::ClaudeJsonl, CLAUDE)], home.path(), &UsageCache::default());
        assert!(read.rows.is_empty());
    }

    /// A file only root may read, outside every home, as an agent on a box could point at.
    fn root_only(dir: &Path) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let file = dir.join("s9.jsonl");
        std::fs::write(
            &file,
            format!(
                "{}\n",
                claude_line(
                    "msg_1",
                    "s9",
                    "2026-09-29T10:00:00.000Z",
                    "claude-opus-5",
                    None,
                    json!({ "input_tokens": 3, "output_tokens": 1 })
                )
            ),
        )
        .unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        file
    }

    #[test]
    fn a_link_at_the_store_root_or_on_the_way_to_it_reads_nothing() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("-proj")).unwrap();
        std::fs::rename(root_only(outside.path()), outside.path().join("-proj/s9.jsonl")).unwrap();
        let stores = [store("claude", UsageLogFormat::ClaudeJsonl, CLAUDE)];
        // The store's own folder a link out of the home.
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join(".claude/projects")).unwrap();
        assert!(super::read(&stores, home.path(), &UsageCache::default()).rows.is_empty());
        // A folder above it a link.
        let home = tempfile::tempdir().unwrap();
        let claude = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), claude.path().join("projects")).unwrap();
        std::os::unix::fs::symlink(claude.path(), home.path().join(".claude")).unwrap();
        assert!(super::read(&stores, home.path(), &UsageCache::default()).rows.is_empty());
    }

    #[test]
    fn a_fifo_in_place_of_a_transcript_is_passed_over_without_waiting_on_it() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".claude/projects/-proj");
        std::fs::create_dir_all(&dir).unwrap();
        nix::unistd::mkfifo(&dir.join("s1.jsonl"), Mode::from_bits_truncate(0o644)).unwrap();
        write(
            home.path(),
            ".claude/projects/-proj/s2.jsonl",
            &[claude_line(
                "msg_2",
                "s2",
                "2026-09-29T10:00:00.000Z",
                "claude-opus-5",
                None,
                json!({ "input_tokens": 4, "output_tokens": 1 }),
            )],
        );
        let read = super::read(&[store("claude", UsageLogFormat::ClaudeJsonl, CLAUDE)], home.path(), &UsageCache::default());
        assert_eq!(read.rows.iter().map(|r| r.session.as_str()).collect::<Vec<_>>(), vec!["s2"]);
    }

    #[test]
    fn as_root_the_stores_are_read_as_the_homes_owner_so_a_root_only_file_reads_nothing() {
        if !nix::unistd::geteuid().is_root() {
            eprintln!("not root; a read as the home's owner is the read this daemon already makes");
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = root_only(outside.path());
        write(
            home.path(),
            ".claude/projects/-proj/s1.jsonl",
            &[claude_line(
                "msg_1",
                "s1",
                "2026-09-29T10:00:00.000Z",
                "claude-opus-5",
                None,
                json!({ "input_tokens": 7, "output_tokens": 1 }),
            )],
        );
        // A hard link names the root-only file inside the store, so only the owner's own access keeps it unread.
        std::fs::hard_link(&secret, home.path().join(".claude/projects/-proj/s9.jsonl")).unwrap();
        for path in [
            home.path().to_path_buf(),
            home.path().join(".claude"),
            home.path().join(".claude/projects"),
            home.path().join(".claude/projects/-proj"),
            home.path().join(".claude/projects/-proj/s1.jsonl"),
        ] {
            std::os::unix::fs::chown(&path, Some(NOBODY), Some(NOBODY)).unwrap();
        }
        let read = super::read(&[store("claude", UsageLogFormat::ClaudeJsonl, CLAUDE)], home.path(), &UsageCache::default());
        assert_eq!(read.rows.iter().map(|r| r.session.as_str()).collect::<Vec<_>>(), vec!["s1"]);
        // And the thread is root again once the read is over.
        assert!(std::fs::read(&secret).is_ok());
        assert_eq!(nix::unistd::setfsuid(nix::unistd::Uid::from_raw(0)), nix::unistd::Uid::from_raw(0));
    }

    /// An OpenCode database with one session, made by the real sqlite3 at `db`.
    fn opencode_db(db: &Path) {
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let made = Command::new(SQLITE3.iter().find(|p| Path::new(p).is_file()).unwrap())
            .arg(db)
            .arg(
                "create table session (id text, directory text, model text, cost real, tokens_input int, tokens_output int, tokens_reasoning int, tokens_cache_read int, tokens_cache_write int, time_updated int);\
                 insert into session values ('ses_1', '/home/dev/proj', 'gpt-5.5', 0, 900, 40, 0, 0, 0, 1790679600000);",
            )
            .status()
            .unwrap();
        assert!(made.success());
    }

    #[test]
    fn as_root_a_home_whose_group_is_not_its_owners_uid_still_reads_its_opencode_rows() {
        if !nix::unistd::geteuid().is_root() || !SQLITE3.iter().any(|p| Path::new(p).is_file()) {
            eprintln!("not root, or no sqlite3 here; the read as a home's owner is not exercised");
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let db = home.path().join(".local/share/opencode/opencode.db");
        opencode_db(&db);
        for path in [
            home.path().to_path_buf(),
            home.path().join(".local"),
            home.path().join(".local/share"),
            home.path().join(".local/share/opencode"),
            db.clone(),
        ] {
            std::os::unix::fs::chown(&path, Some(NOBODY), Some(100)).unwrap();
        }
        let read = super::read(
            &[store("opencode", UsageLogFormat::OpencodeSqlite, "~/.local/share/opencode/opencode.db")],
            home.path(),
            &UsageCache::default(),
        );
        assert_eq!(read.rows.iter().map(|r| r.session.as_str()).collect::<Vec<_>>(), vec!["ses_1"]);
    }

    /// A stand-in sqlite3 that exits 9 if handed `agent_file` itself, and otherwise answers one session named for the
    /// ids it ran as, its model the owner and mode of the folder the copy sits in.
    fn stub_sqlite3(agent_file: &Path) -> (tempfile::TempDir, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let bin = dir.path().join("sqlite3");
        let agent = agent_file.to_string_lossy();
        std::fs::write(&bin, format!("#!/bin/sh\n[ \"$2\" = '{agent}' ] && exit 9\nhead -c 20 \"$2\" > /dev/null || exit 8\nprintf '[{{\"id\":\"%s\",\"model\":\"%s\",\"tokens_input\":1,\"tokens_output\":1,\"time_updated\":1}}]' \"$(id -u):$(id -g)\" \"$(stat -c '%u:%a' \"$(dirname \"$2\")\")\"\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, bin)
    }

    #[test]
    fn sqlite3_reads_a_copy_in_a_folder_only_its_ids_enter_and_never_as_root() {
        let home = tempfile::tempdir().unwrap();
        let db = home.path().join("opencode.db");
        std::fs::write(&db, "not read by the stub").unwrap();
        let (_keep, bin) = stub_sqlite3(&db);
        let me = nix::unistd::geteuid().as_raw();
        let root = me == 0;
        let parser = parser_for(root, (0, 0), false).expect("an id is free");
        // Laid out as the system's temp folder is, which anybody may enter.
        let scratch = tempfile::tempdir().unwrap();
        std::fs::set_permissions(scratch.path(), std::os::unix::fs::PermissionsExt::from_mode(0o1777)).unwrap();
        let read = opencode_pieces(File::open(&db).unwrap(), None, parser, &bin, scratch.path()).expect("the stub answered");
        let (session, model) = (read.pieces[0].session.clone(), read.pieces[0].model.clone());
        if root {
            // A home that is root's is parsed as an id no passwd or group entry names, in a folder only that id enters.
            let (id, _) = parser.run_as.unwrap();
            assert!(UNNAMED_IDS.contains(&id));
            assert!(matches!(nix::unistd::User::from_uid(nix::unistd::Uid::from_raw(id)), Ok(None)));
            assert_eq!((session, model), (format!("{id}:{id}"), format!("{id}:700")));
        } else {
            assert_eq!((session, model), (format!("{me}:{}", nix::unistd::getegid().as_raw()), format!("{me}:700")));
        }
        // The folder goes once sqlite3 is done.
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
    }

    #[test]
    fn the_parser_runs_as_the_home_owners_own_ids_and_takes_the_copy_as_is_where_this_thread_writes_as_them() {
        let owner = (NOBODY, 100);
        let switched = parser_for(true, owner, true).unwrap();
        assert_eq!((switched.run_as, switched.hand_over), (Some(owner), false));
        let unswitched = parser_for(true, owner, false).unwrap();
        assert_eq!((unswitched.run_as, unswitched.hand_over), (Some(owner), true));
        let mine = parser_for(false, owner, false).unwrap();
        assert_eq!((mine.run_as, mine.hand_over), (None, false));
        let rooted = parser_for(true, (0, 0), false).unwrap();
        assert!(rooted.run_as.is_some_and(|(uid, gid)| uid == gid && UNNAMED_IDS.contains(&uid)) && rooted.hand_over);
    }

    #[test]
    fn a_database_past_the_cap_is_refused_before_a_byte_of_it_is_copied() {
        let home = tempfile::tempdir().unwrap();
        let db = home.path().join("opencode.db");
        File::create(&db).unwrap().set_len(DATABASE_CAP + (1 << 20)).unwrap();
        let (_keep, bin) = stub_sqlite3(&db);
        let scratch = tempfile::tempdir().unwrap();
        let watching = scratch.path().to_path_buf();
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop = std::sync::Arc::clone(&done);
        // The largest file seen under the scratch folder while the read runs.
        let watcher = std::thread::spawn(move || {
            let mut largest = 0u64;
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                for folder in std::fs::read_dir(&watching).into_iter().flatten().flatten() {
                    for file in std::fs::read_dir(folder.path()).into_iter().flatten().flatten() {
                        largest = largest.max(file.metadata().map(|m| m.len()).unwrap_or(0));
                    }
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            largest
        });
        let parser = parser_for(nix::unistd::geteuid().is_root(), (0, 0), false).unwrap();
        let read = opencode_pieces(File::open(&db).unwrap(), None, parser, &bin, scratch.path());
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(read.is_none());
        assert_eq!(watcher.join().unwrap(), 0, "a byte of a database past the cap was copied");
    }

    #[test]
    fn opencode_reads_each_session_s_own_totals_and_cost_out_of_its_database_read_only() {
        if !SQLITE3.iter().any(|p| Path::new(p).is_file()) {
            eprintln!("no sqlite3 here; the OpenCode read is not exercised");
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let db = home.path().join(".local/share/opencode/opencode.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let made = Command::new(SQLITE3.iter().find(|p| Path::new(p).is_file()).unwrap())
            .arg(&db)
            .arg(
                "create table session (id text, directory text, model text, cost real, tokens_input int, tokens_output int, tokens_reasoning int, tokens_cache_read int, tokens_cache_write int, time_updated int);\
                 insert into session values ('ses_1', '/Users/dev/proj', '{\"providerID\":\"anthropic\",\"modelID\":\"claude-sonnet-4-5\"}', 0.12, 900, 40, 0, 300, 10, 1790679600000);\
                 insert into session values ('ses_2', '/Users/dev/other', 'gpt-5.5', 0, 0, 0, 0, 0, 0, 1790679600000);",
            )
            .status()
            .unwrap();
        assert!(made.success());
        let read = super::read(
            &[store("opencode", UsageLogFormat::OpencodeSqlite, "~/.local/share/opencode/opencode.db")],
            home.path(),
            &UsageCache::default(),
        );
        assert_eq!(
            read.rows,
            vec![UsageLogRow {
                agent: "opencode".into(),
                session: "ses_1".into(),
                at: 1_790_679_600_000,
                model: "anthropic/claude-sonnet-4-5".into(),
                folder: Some("/Users/dev/proj".into()),
                tokens: UsageTokens { input: 1_210, output: 40, cached: 300, cache_write: 10, reasoning: 0 },
                cost: Some(0.12),
            }]
        );
    }
}
