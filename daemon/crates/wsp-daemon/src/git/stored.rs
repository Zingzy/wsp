// SPDX-License-Identifier: AGPL-3.0-only
//! A stopped workspace's branch, read off its copy's git directory by this daemon's own reads: HEAD, the refs,
//! packed-refs, the branch's lines of config and the commit objects, loose or packed. No program runs, so nothing an
//! agent wrote into that directory (a hook, an fsmonitor, a filter, an include, an ssh command) runs as the root this
//! daemon is, and nothing of the worktree or the index is read, so the edits never committed stay unread. Every
//! file is opened one component at a time with no link followed, so a link or a gitfile cannot point the read at
//! another folder, and every size read is capped, since the bytes are an agent's to write.

use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::OwnedFd;
use std::os::unix::fs::FileExt;
use std::path::Path;

use flate2::read::ZlibDecoder;
use nix::errno::Errno;
use nix::fcntl::{open, openat, OFlag};
use nix::sys::stat::Mode;
use wsp_frames::{DaemonErrorCode, GitBranch, GitStatusReply};

use crate::paths::OpError;

/// HEAD, a loose ref, packed-refs, config and shallow: text files a repository keeps well under this.
const TEXT_MAX: u64 = 64 << 20;
/// One object whole, and the deltas held to build it.
const OBJECT_MAX: usize = 64 << 20;
/// git writes no chain deeper than 4095.
const DEPTH_MAX: usize = 4096;
/// Commits one count may walk before it gives up rather than hold the daemon.
const COMMITS_MAX: usize = 1_000_000;
/// How many commits past the last one reachable from one side alone the walk goes, against clock skew: git's own.
const SLOP: usize = 5;
/// How deep one ref may point at another.
const SYMREF_MAX: usize = 5;
/// Packs held open at once, two descriptors each: git repacks on its own past 50.
const PACKS_MAX: usize = 128;

/// The branch of the checkout copied at `copy`, mounted inside at `root`. The entries are empty and said unread,
/// so an empty list is never taken for a clean tree.
pub(crate) fn status(copy: &Path, root: &str) -> Result<GitStatusReply, OpError> {
    let dir = GitDir::open(copy)?;
    let branch = Repo::new(&dir).and_then(|mut repo| repo.branch()).map_err(|why| unread(root, &why))?;
    Ok(GitStatusReply { branch, entries: Vec::new(), root: root.to_owned(), edits_unread: true })
}

fn unread(root: &str, why: &str) -> OpError {
    OpError::plain(format!("the branch of {root} could not be read while it is stopped: {why}"))
}

fn not_a_repo() -> OpError {
    OpError::coded(DaemonErrorCode::NotAGitRepo, "not inside a git repository")
}

/// The copy's `.git`, a real folder or nothing: a gitfile or a link there names another folder.
struct GitDir {
    fd: OwnedFd,
}

impl GitDir {
    fn open(copy: &Path) -> Result<GitDir, OpError> {
        let top = open(copy, OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC, Mode::empty())
            .map_err(|e| OpError::plain(format!("{}: {e}", copy.display())))?;
        match openat(&top, ".git", dir_flags(), Mode::empty()) {
            Ok(fd) => Ok(GitDir { fd }),
            Err(Errno::ENOENT | Errno::ENOTDIR | Errno::ELOOP) => Err(not_a_repo()),
            Err(e) => Err(OpError::plain(format!("{}: {e}", copy.display()))),
        }
    }

    /// The folder holding `rel` and its last name, each folder on the way opened with no link followed. None where
    /// a folder on the way is not there.
    fn parent_of<'a>(&self, rel: &'a str) -> Result<Option<(OwnedFd, &'a str)>, String> {
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.iter().any(|part| part.is_empty() || *part == "." || *part == "..") {
            return Err(format!("{rel} is not a name inside a git directory"));
        }
        let (leaf, folders) = parts.split_last().ok_or_else(|| "an empty name".to_owned())?;
        let mut at = self.fd.try_clone().map_err(|e| e.to_string())?;
        for folder in folders {
            at = match openat(&at, *folder, dir_flags(), Mode::empty()) {
                Ok(next) => next,
                Err(Errno::ENOENT | Errno::ENOTDIR) => return Ok(None),
                Err(Errno::ELOOP) => return Err(format!("a link stands at {rel}")),
                Err(e) => return Err(format!("{rel}: {e}")),
            };
        }
        Ok(Some((at, leaf)))
    }

    /// A regular file, or None where nothing or a folder stands there. Opened without blocking, so a fifo an agent
    /// left in place of a ref cannot hold the read.
    fn file(&self, rel: &str) -> Result<Option<File>, String> {
        let Some((parent, leaf)) = self.parent_of(rel)? else { return Ok(None) };
        let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
        let file = match openat(&parent, leaf, flags, Mode::empty()) {
            Ok(fd) => File::from(fd),
            Err(Errno::ENOENT) => return Ok(None),
            Err(Errno::ELOOP) => return Err(format!("a link stands at {rel}")),
            Err(e) => return Err(format!("{rel}: {e}")),
        };
        let kind = file.metadata().map_err(|e| format!("{rel}: {e}"))?.file_type();
        if kind.is_dir() {
            return Ok(None);
        }
        if !kind.is_file() {
            return Err(format!("{rel} is not a file"));
        }
        Ok(Some(file))
    }

    fn text(&self, rel: &str) -> Result<Option<String>, String> {
        let Some(file) = self.file(rel)? else { return Ok(None) };
        let mut bytes = Vec::new();
        file.take(TEXT_MAX + 1).read_to_end(&mut bytes).map_err(|e| format!("{rel}: {e}"))?;
        if bytes.len() as u64 > TEXT_MAX {
            return Err(format!("{rel} is too large"));
        }
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// The names in a folder, or none where it is not there.
    fn names(&self, rel: &str) -> Result<Vec<String>, String> {
        let Some((parent, leaf)) = self.parent_of(rel)? else { return Ok(Vec::new()) };
        let fd = match openat(&parent, leaf, dir_flags(), Mode::empty()) {
            Ok(fd) => fd,
            Err(Errno::ENOENT | Errno::ENOTDIR) => return Ok(Vec::new()),
            Err(Errno::ELOOP) => return Err(format!("a link stands at {rel}")),
            Err(e) => return Err(format!("{rel}: {e}")),
        };
        let mut listed = nix::dir::Dir::from_fd(fd).map_err(|e| format!("{rel}: {e}"))?;
        let mut names = Vec::new();
        for entry in listed.iter() {
            let entry = entry.map_err(|e| format!("{rel}: {e}"))?;
            if names.len() > 4 * PACKS_MAX {
                return Err(format!("{rel} holds too many files"));
            }
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        Ok(names)
    }
}

fn dir_flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}

type Oid = Vec<u8>;

fn hex(oid: &[u8]) -> String {
    oid.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_oid(text: &str, len: usize) -> Option<Oid> {
    let text = text.trim();
    if text.len() != len * 2 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..len).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()).collect()
}

/// A ref name this reader will open as a path: under refs/, no component a path walk reads as anything but itself,
/// and none of the characters git refuses in a ref.
fn plain_ref(name: &str) -> bool {
    name.starts_with("refs/")
        && !name.contains("..")
        && !name.contains("@{")
        && !name.bytes().any(|b| b < 0x20 || b == 0x7f || b" ~^:?*[\\".contains(&b))
        && name.split('/').all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

/// One config line git would read out of the repository's own file, includes left unread: an include names a file
/// anywhere on the computer.
struct Line {
    section: String,
    sub: Option<String>,
    key: String,
    value: String,
}

fn parse_config(text: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    let (mut section, mut sub) = (String::new(), None);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' | '\r' | '\n' => {}
            '#' | ';' => skip_line(&mut chars),
            '[' => {
                let (mut name, mut quoted, mut in_quote) = (String::new(), None::<String>, false);
                while let Some(c) = chars.next() {
                    if in_quote {
                        match c {
                            '"' => in_quote = false,
                            '\\' => quoted.get_or_insert_default().extend(chars.next()),
                            '\n' => break,
                            c => quoted.get_or_insert_default().push(c),
                        }
                        continue;
                    }
                    match c {
                        ']' | '\n' => break,
                        '"' => {
                            in_quote = true;
                            quoted.get_or_insert_default();
                        }
                        c if c.is_whitespace() => {}
                        c => name.push(c),
                    }
                }
                (section, sub) = match (quoted, name.split_once('.')) {
                    (Some(q), _) => (name.to_ascii_lowercase(), Some(q)),
                    (None, Some((s, rest))) => (s.to_ascii_lowercase(), Some(rest.to_ascii_lowercase())),
                    (None, None) => (name.to_ascii_lowercase(), None),
                };
            }
            c => {
                let mut key = String::from(c);
                while let Some(&next) = chars.peek() {
                    if next.is_ascii_alphanumeric() || next == '-' {
                        key.push(next);
                        chars.next();
                    } else {
                        break;
                    }
                }
                while matches!(chars.peek(), Some(' ' | '\t')) {
                    chars.next();
                }
                let value = if chars.peek() == Some(&'=') {
                    chars.next();
                    read_value(&mut chars)
                } else {
                    skip_line(&mut chars);
                    "true".to_owned()
                };
                lines.push(Line { section: section.clone(), sub: sub.clone(), key: key.to_ascii_lowercase(), value });
            }
        }
    }
    lines
}

fn skip_line(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    for c in chars.by_ref() {
        if c == '\n' {
            break;
        }
    }
}

/// A value to its line's end: quotes kept out, the escapes git reads read, a comment outside quotes dropped, a
/// backslash before the line end carrying it on, and the space around it trimmed.
fn read_value(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let (mut value, mut quoted, mut kept) = (String::new(), false, 0);
    while let Some(c) = chars.next() {
        match c {
            '\n' => break,
            '"' => {
                quoted = !quoted;
                kept = value.len();
            }
            '\\' => {
                match chars.next() {
                    Some('\n') => {}
                    Some('n') => value.push('\n'),
                    Some('t') => value.push('\t'),
                    Some('b') => {
                        value.pop();
                    }
                    Some(other) => value.push(other),
                    None => {}
                }
                kept = value.len();
            }
            '#' | ';' if !quoted => {
                skip_line(chars);
                break;
            }
            c => {
                if !c.is_whitespace() || quoted {
                    value.push(c);
                    kept = value.len();
                } else if !value.is_empty() {
                    value.push(c);
                }
            }
        }
    }
    value.truncate(kept);
    value.trim_start().to_owned()
}

struct Config(Vec<Line>);

impl Config {
    fn all(&self, section: &str, sub: Option<&str>, key: &str) -> Vec<&str> {
        self.0.iter().filter(|l| l.section == section && l.sub.as_deref() == sub && l.key == key).map(|l| l.value.as_str()).collect()
    }
    fn last(&self, section: &str, sub: Option<&str>, key: &str) -> Option<&str> {
        self.all(section, sub, key).pop()
    }
}

/// Where a remote's fetch refspecs file the branch it merges: the first spec that takes it, a glob or a name.
fn tracking_of(specs: &[&str], merge: &str) -> Option<String> {
    for spec in specs {
        let spec = spec.trim_start_matches('+');
        if spec.starts_with('^') {
            continue;
        }
        let Some((src, dst)) = spec.split_once(':') else { continue };
        match (src.split_once('*'), dst.split_once('*')) {
            (Some((pre, post)), Some((dpre, dpost))) => {
                if let Some(middle) = merge.strip_prefix(pre).and_then(|rest| rest.strip_suffix(post)) {
                    return Some(format!("{dpre}{middle}{dpost}"));
                }
            }
            (None, None) if src == merge => return Some(dst.to_owned()),
            _ => {}
        }
    }
    None
}

fn short(name: &str) -> &str {
    name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/remotes/")).unwrap_or(name)
}

struct Repo<'a> {
    dir: &'a GitDir,
    len: usize,
    config: Config,
    packed: Option<HashMap<String, Option<Oid>>>,
    packs: Option<Vec<Pack>>,
    shallow: HashSet<Oid>,
    commits: HashMap<Oid, (i64, Vec<Oid>)>,
}

impl<'a> Repo<'a> {
    fn new(dir: &'a GitDir) -> Result<Repo<'a>, String> {
        let config = Config(parse_config(&dir.text("config")?.unwrap_or_default()));
        let len = match config.last("extensions", None, "objectformat").map(str::to_ascii_lowercase).as_deref() {
            None | Some("sha1") => 20,
            Some("sha256") => 32,
            Some(other) => return Err(format!("object format {other} is not one this reads")),
        };
        let shallow = dir.text("shallow")?.unwrap_or_default().lines().filter_map(|line| parse_oid(line, len)).collect();
        Ok(Repo { dir, len, config, packed: None, packs: None, shallow, commits: HashMap::new() })
    }

    fn branch(&mut self) -> Result<GitBranch, String> {
        let head = self.dir.text("HEAD")?.ok_or_else(|| "HEAD is missing".to_owned())?;
        let head = head.trim();
        let (name, oid) = match head.strip_prefix("ref: ") {
            Some(target) => {
                let target = target.trim();
                if !plain_ref(target) {
                    return Err("HEAD names no ref".to_owned());
                }
                (Some(target.to_owned()), self.resolve(target)?)
            }
            None => (None, Some(parse_oid(head, self.len).ok_or_else(|| "HEAD names no commit".to_owned())?)),
        };
        let mut branch = GitBranch {
            oid: oid.as_deref().map_or_else(|| "(initial)".to_owned(), hex),
            head: name.as_deref().map_or_else(|| "(detached)".to_owned(), |n| short(n).to_owned()),
            upstream: None,
            ahead: 0,
            behind: 0,
        };
        let Some(oid) = oid else { return Ok(branch) };
        let upstream = match name.as_deref().and_then(|n| n.strip_prefix("refs/heads/")) {
            Some(local) => self.upstream_of(local)?,
            None => None,
        };
        let base = match &upstream {
            Some((display, tip)) => {
                branch.upstream = Some(display.clone());
                Some(tip.clone())
            }
            None => self.default_tip()?,
        };
        if let Some(base) = base {
            (branch.ahead, branch.behind) = self.ahead_behind(&oid, &base)?;
        }
        Ok(branch)
    }

    /// The branch's upstream as git names it and the commit its tracking ref holds, where it has one that is here.
    fn upstream_of(&mut self, local: &str) -> Result<Option<(String, Oid)>, String> {
        let remote = self.config.last("branch", Some(local), "remote").map(str::to_owned);
        let merge = self.config.last("branch", Some(local), "merge").map(str::to_owned);
        let (Some(remote), Some(merge)) = (remote, merge) else { return Ok(None) };
        let tracking = if remote == "." { Some(merge) } else { tracking_of(&self.config.all("remote", Some(&remote), "fetch"), &merge) };
        let Some(tracking) = tracking.filter(|t| plain_ref(t)) else { return Ok(None) };
        Ok(self.resolve(&tracking)?.map(|tip| (short(&tracking).to_owned(), tip)))
    }

    /// What a branch with no upstream is counted against: origin's HEAD, or a local main or master.
    fn default_tip(&mut self) -> Result<Option<Oid>, String> {
        for name in ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"] {
            if let Some(tip) = self.resolve(name)? {
                return Ok(Some(tip));
            }
        }
        Ok(None)
    }

    fn resolve(&mut self, name: &str) -> Result<Option<Oid>, String> {
        let mut name = name.to_owned();
        for _ in 0..SYMREF_MAX {
            if !plain_ref(&name) {
                return Err(format!("{name} is not a ref"));
            }
            let Some(text) = self.dir.text(&name)? else {
                return match self.packed()?.get(&name) {
                    Some(Some(oid)) => Ok(Some(oid.clone())),
                    Some(None) => Err(format!("{name} holds no commit")),
                    None => Ok(None),
                };
            };
            let text = text.trim();
            match text.strip_prefix("ref: ") {
                Some(target) => name = target.trim().to_owned(),
                None => return parse_oid(text, self.len).map(Some).ok_or_else(|| format!("{name} holds no commit")),
            }
        }
        Err(format!("{name} points too deep"))
    }

    /// packed-refs by name. A line that names a ref and no commit is kept as such, so that ref reads as damaged
    /// rather than as a branch with no commits yet, which would say it holds nothing origin lacks.
    fn packed(&mut self) -> Result<&HashMap<String, Option<Oid>>, String> {
        if self.packed.is_none() {
            let text = self.dir.text("packed-refs")?.unwrap_or_default();
            let refs = text
                .lines()
                .filter(|line| !line.trim().is_empty() && !line.starts_with('#') && !line.starts_with('^'))
                .map(|line| match line.split_once(' ') {
                    Some((oid, name)) => (name.trim().to_owned(), parse_oid(oid, self.len)),
                    None => (line.trim().to_owned(), None),
                })
                .collect();
            self.packed = Some(refs);
        }
        Ok(self.packed.get_or_insert_with(HashMap::new))
    }

    /// Commits reachable from the head and not the base, and from the base and not the head, as
    /// `rev-list --left-right --count base...head` counts them: newest first by committer date, stopping once
    /// every commit left to read is reachable from both.
    fn ahead_behind(&mut self, head: &Oid, base: &Oid) -> Result<(u64, u64), String> {
        const AHEAD: u8 = 1;
        const BEHIND: u8 = 2;
        const BOTH: u8 = AHEAD | BEHIND;
        let head = self.peel(head)?;
        let base = self.peel(base)?;
        if head == base {
            return Ok((0, 0));
        }
        let mut flags: HashMap<Oid, u8> = HashMap::new();
        let mut spread: HashMap<Oid, u8> = HashMap::new();
        let mut queue: BinaryHeap<(i64, Oid, u8)> = BinaryHeap::new();
        let mut single = 0usize;
        for (oid, flag) in [(head, AHEAD), (base, BEHIND)] {
            let (time, _) = self.commit(&oid)?;
            flags.insert(oid.clone(), flag);
            queue.push((time, oid, flag));
            single += 1;
        }
        let mut slop = SLOP;
        while let Some((_, oid, pushed)) = queue.pop() {
            if pushed != BOTH {
                single -= 1;
            }
            let flag = flags[&oid];
            if spread.get(&oid) == Some(&flag) {
                continue;
            }
            spread.insert(oid.clone(), flag);
            if spread.len() > COMMITS_MAX {
                return Err("the history is too long to count".to_owned());
            }
            let (_, parents) = self.commit(&oid)?;
            for parent in parents {
                let held = flags.entry(parent.clone()).or_default();
                if *held | flag != *held {
                    *held |= flag;
                    let now = *held;
                    let (time, _) = self.commit(&parent)?;
                    if now != BOTH {
                        single += 1;
                    }
                    queue.push((time, parent, now));
                }
            }
            if single == 0 {
                if slop == 0 {
                    break;
                }
                slop -= 1;
            } else {
                slop = SLOP;
            }
        }
        let count = |want: u8| flags.values().filter(|f| **f == want).count() as u64;
        Ok((count(AHEAD), count(BEHIND)))
    }

    /// An annotated tag followed to the commit it names.
    fn peel(&mut self, oid: &Oid) -> Result<Oid, String> {
        let mut oid = oid.clone();
        for _ in 0..SYMREF_MAX {
            let (kind, body) = self.object(&oid)?;
            match kind {
                Kind::Commit => return Ok(oid),
                Kind::Tag => {
                    let text = String::from_utf8_lossy(&body);
                    let named = text.lines().find_map(|l| l.strip_prefix("object ")).and_then(|o| parse_oid(o, self.len));
                    oid = named.ok_or_else(|| "a tag names no object".to_owned())?;
                }
                Kind::Other => return Err("a ref names no commit".to_owned()),
            }
        }
        Err("a tag points too deep".to_owned())
    }

    /// A commit's committer time and parents; a commit the shallow file names has none here.
    fn commit(&mut self, oid: &Oid) -> Result<(i64, Vec<Oid>), String> {
        if let Some(read) = self.commits.get(oid) {
            return Ok(read.clone());
        }
        let (kind, body) = self.object(oid)?;
        if kind != Kind::Commit {
            return Err(format!("{} is not a commit", hex(oid)));
        }
        let text = String::from_utf8_lossy(&body);
        let (mut time, mut parents) = (0, Vec::new());
        for line in text.lines() {
            if line.is_empty() {
                break;
            }
            if let Some(parent) = line.strip_prefix("parent ") {
                parents.push(parse_oid(parent, self.len).ok_or_else(|| format!("{} names a bad parent", hex(oid)))?);
            } else if let Some(who) = line.strip_prefix("committer ") {
                time = who.rsplit(' ').nth(1).and_then(|t| t.parse().ok()).unwrap_or(0);
            }
        }
        if self.shallow.contains(oid) {
            parents.clear();
        }
        self.commits.insert(oid.clone(), (time, parents.clone()));
        Ok((time, parents))
    }

    fn object(&mut self, oid: &Oid) -> Result<(Kind, Vec<u8>), String> {
        match self.locate(oid)? {
            Located::Loose(file) => loose(file).ok_or_else(|| format!("object {} is damaged", hex(oid))),
            Located::Packed(pack, at) => self.unpack(pack, at).map_err(|why| format!("object {}: {why}", hex(oid))),
        }
    }

    fn locate(&mut self, oid: &Oid) -> Result<Located, String> {
        let name = hex(oid);
        if let Some(file) = self.dir.file(&format!("objects/{}/{}", &name[..2], &name[2..]))? {
            return Ok(Located::Loose(file));
        }
        if self.packs.is_none() {
            self.packs = Some(self.open_packs()?);
        }
        let found =
            self.packs.as_ref().into_iter().flatten().enumerate().find_map(|(i, pack)| pack.offset_of(oid, self.len).map(|at| (i, at)));
        found.map(|(i, at)| Located::Packed(i, at)).ok_or_else(|| format!("object {name} is missing"))
    }

    fn open_packs(&self) -> Result<Vec<Pack>, String> {
        let mut packs = Vec::new();
        for name in self.dir.names("objects/pack")? {
            let Some(stem) = name.strip_suffix(".idx") else { continue };
            let (Some(idx), Some(pack)) =
                (self.dir.file(&format!("objects/pack/{name}"))?, self.dir.file(&format!("objects/pack/{stem}.pack"))?)
            else {
                continue;
            };
            if packs.len() == PACKS_MAX {
                return Err("too many packs to read".to_owned());
            }
            packs.push(Pack::new(idx, pack, self.len).ok_or_else(|| format!("{name} is damaged"))?);
        }
        Ok(packs)
    }

    /// One packed object: its deltas gathered back to a whole base, then laid over it newest last. A base named by
    /// its id is followed in the same loop, never by a call of its own, so a chain that names itself ends at the
    /// depth cap rather than on the stack.
    fn unpack(&mut self, mut pack: usize, mut at: u64) -> Result<(Kind, Vec<u8>), String> {
        let (mut deltas, mut held): (Vec<Vec<u8>>, usize) = (Vec::new(), 0);
        let (kind, mut body) = loop {
            if deltas.len() > DEPTH_MAX {
                return Err("a delta chain is too deep".to_owned());
            }
            let packs = self.packs.as_ref().ok_or("no packs")?;
            let entry = packs[pack].entry(at, self.len).ok_or("a damaged entry")?;
            let data = packs[pack].inflate(entry.data, entry.size).ok_or("a damaged entry")?;
            let named = match entry.base {
                Base::Whole(kind) => break (kind, data),
                Base::Offset(base) => {
                    at = base;
                    None
                }
                Base::Named(base) => Some(base),
            };
            held += data.len();
            if held > OBJECT_MAX {
                return Err("deltas too large".to_owned());
            }
            deltas.push(data);
            if let Some(base) = named {
                match self.locate(&base)? {
                    Located::Loose(file) => break loose(file).ok_or("a damaged base")?,
                    Located::Packed(next, offset) => (pack, at) = (next, offset),
                }
            }
        };
        for delta in deltas.iter().rev() {
            body = apply_delta(&body, delta).ok_or("a damaged delta")?;
        }
        Ok((kind, body))
    }
}

enum Located {
    Loose(File),
    Packed(usize, u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Commit,
    Tag,
    Other,
}

fn kind_named(name: &[u8]) -> Kind {
    match name {
        b"commit" => Kind::Commit,
        b"tag" => Kind::Tag,
        _ => Kind::Other,
    }
}

/// A loose object: zlib over "<type> <size>\0<body>".
fn loose(file: File) -> Option<(Kind, Vec<u8>)> {
    let mut out = Vec::new();
    ZlibDecoder::new(file).take(OBJECT_MAX as u64 + 64).read_to_end(&mut out).ok()?;
    let nul = out.iter().position(|b| *b == 0)?;
    let (kind, size) = std::str::from_utf8(&out[..nul]).ok()?.split_once(' ')?;
    let (kind, size): (Kind, usize) = (kind_named(kind.as_bytes()), size.parse().ok()?);
    let body = out.split_off(nul + 1);
    (body.len() == size && size <= OBJECT_MAX).then_some((kind, body))
}

enum Base {
    Whole(Kind),
    Offset(u64),
    Named(Oid),
}

struct Entry {
    size: usize,
    data: u64,
    base: Base,
}

/// One pack and its version 2 index, read in place rather than loaded: an index is the agent's to make as large
/// as it likes.
struct Pack {
    idx: File,
    pack: File,
    count: u64,
    fanout: Vec<u32>,
}

impl Pack {
    fn new(idx: File, pack: File, len: usize) -> Option<Pack> {
        let mut head = vec![0u8; 8 + 256 * 4];
        idx.read_exact_at(&mut head, 0).ok()?;
        if head[..8] != [0xff, b't', b'O', b'c', 0, 0, 0, 2] {
            return None;
        }
        let fanout: Vec<u32> = head[8..].chunks(4).map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]])).collect();
        if fanout.windows(2).any(|w| w[0] > w[1]) {
            return None;
        }
        let count = u64::from(fanout[255]);
        let size = idx.metadata().ok()?.len();
        (size >= 8 + 1024 + count * (len as u64 + 8)).then_some(Pack { idx, pack, count, fanout })
    }

    fn offset_of(&self, oid: &[u8], len: usize) -> Option<u64> {
        let first = usize::from(*oid.first()?);
        let (mut lo, mut hi) = (if first == 0 { 0 } else { u64::from(self.fanout[first - 1]) }, u64::from(self.fanout[first]));
        let names = 8 + 1024;
        let mut name = vec![0u8; len];
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            self.idx.read_exact_at(&mut name, names + mid * len as u64).ok()?;
            match name.as_slice().cmp(oid) {
                std::cmp::Ordering::Equal => return self.offset_at(mid, len),
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
            }
        }
        None
    }

    fn offset_at(&self, i: u64, len: usize) -> Option<u64> {
        let offsets = 8 + 1024 + self.count * (len as u64 + 4);
        let mut word = [0u8; 4];
        self.idx.read_exact_at(&mut word, offsets + i * 4).ok()?;
        let small = u32::from_be_bytes(word);
        if small & 0x8000_0000 == 0 {
            return Some(u64::from(small));
        }
        let mut large = [0u8; 8];
        self.idx.read_exact_at(&mut large, offsets + self.count * 4 + u64::from(small & 0x7fff_ffff) * 8).ok()?;
        Some(u64::from_be_bytes(large))
    }

    fn entry(&self, at: u64, len: usize) -> Option<Entry> {
        let mut head = vec![0u8; 16 + len];
        let got = self.pack.read_at(&mut head, at).ok()?;
        head.truncate(got);
        let mut bytes = head.iter().copied();
        let mut c = bytes.next()?;
        let kind = (c >> 4) & 7;
        let mut size = u64::from(c & 15);
        let mut shift = 4;
        while c & 0x80 != 0 {
            c = bytes.next()?;
            size |= u64::from(c & 0x7f).checked_shl(shift)?;
            shift += 7;
            if shift > 63 {
                return None;
            }
        }
        let size = usize::try_from(size).ok().filter(|s| *s <= OBJECT_MAX)?;
        let mut used = head.len() - bytes.len();
        let base = match kind {
            1 => Base::Whole(Kind::Commit),
            2 | 3 => Base::Whole(Kind::Other),
            4 => Base::Whole(Kind::Tag),
            6 => {
                let mut c = bytes.next()?;
                let mut back = u64::from(c & 0x7f);
                while c & 0x80 != 0 {
                    c = bytes.next()?;
                    back = back.checked_add(1)?.checked_shl(7)? | u64::from(c & 0x7f);
                }
                used = head.len() - bytes.len();
                Base::Offset(at.checked_sub(back).filter(|_| back > 0)?)
            }
            7 => {
                let named: Vec<u8> = bytes.by_ref().take(len).collect();
                if named.len() != len {
                    return None;
                }
                used = head.len() - bytes.len();
                Base::Named(named)
            }
            _ => return None,
        };
        Some(Entry { size, data: at + used as u64, base })
    }

    fn inflate(&self, at: u64, size: usize) -> Option<Vec<u8>> {
        let mut out = Vec::with_capacity(size.min(1 << 20));
        ZlibDecoder::new(Reading { file: &self.pack, at }).take(size as u64 + 1).read_to_end(&mut out).ok()?;
        (out.len() == size).then_some(out)
    }
}

/// A pack read from an offset on, for the inflater.
struct Reading<'f> {
    file: &'f File,
    at: u64,
}

impl Read for Reading<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.file.read_at(buf, self.at)?;
        self.at += n as u64;
        Ok(n)
    }
}

fn varint(bytes: &[u8], at: &mut usize) -> Option<usize> {
    let (mut value, mut shift) = (0usize, 0u32);
    loop {
        let c = *bytes.get(*at)?;
        *at += 1;
        value |= usize::from(c & 0x7f).checked_shl(shift)?;
        if c & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift > 56 {
            return None;
        }
    }
}

/// git's delta: the base's size, the result's, then copies out of the base and bytes of its own.
fn apply_delta(base: &[u8], delta: &[u8]) -> Option<Vec<u8>> {
    let mut i = 0;
    if varint(delta, &mut i)? != base.len() {
        return None;
    }
    let size = varint(delta, &mut i)?;
    if size > OBJECT_MAX {
        return None;
    }
    let mut out = Vec::with_capacity(size);
    while i < delta.len() {
        let op = delta[i];
        i += 1;
        if op & 0x80 != 0 {
            let (mut from, mut len) = (0usize, 0usize);
            for bit in 0..4 {
                if op & (1 << bit) != 0 {
                    from |= usize::from(*delta.get(i)?) << (8 * bit);
                    i += 1;
                }
            }
            for bit in 0..3 {
                if op & (0x10 << bit) != 0 {
                    len |= usize::from(*delta.get(i)?) << (8 * bit);
                    i += 1;
                }
            }
            if len == 0 {
                len = 0x10000;
            }
            out.extend_from_slice(base.get(from..from.checked_add(len)?)?);
        } else if op != 0 {
            out.extend_from_slice(delta.get(i..i + usize::from(op))?);
            i += usize::from(op);
        } else {
            return None;
        }
        if out.len() > size {
            return None;
        }
    }
    (out.len() == size).then_some(out)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::Command;

    use super::*;
    use crate::git::parse_porcelain_v2;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "-c",
                "init.defaultBranch=main",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("LC_ALL", "C")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn commit(cwd: &Path, file: &str, text: &str) {
        std::fs::write(cwd.join(file), text).unwrap();
        git(cwd, &["add", file]);
        git(cwd, &["commit", "-q", "-m", text]);
    }

    /// An origin with three commits, a clone of it on a branch that tracks origin/main, two commits of the clone's
    /// own and one more on origin fetched: ahead two, behind one.
    fn tracking_clone() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let origin = dir.path().join("origin");
        std::fs::create_dir(&origin).unwrap();
        git(&origin, &["init", "-q"]);
        for n in 0..3 {
            commit(&origin, "a.txt", &format!("origin {n}\n{}", "shared line\n".repeat(200)));
        }
        let copy = dir.path().join("copy");
        git(dir.path(), &["clone", "-q", &origin.to_string_lossy(), "copy"]);
        git(&copy, &["checkout", "-q", "-b", "fix/cart", "--track", "origin/main"]);
        commit(&copy, "b.txt", "mine 1\n");
        commit(&copy, "b.txt", "mine 2\n");
        commit(&origin, "a.txt", "origin 3\n");
        git(&copy, &["fetch", "-q"]);
        (dir, copy)
    }

    /// What git itself reads for the branch, for the cases that hold this reader to it.
    fn by_git(copy: &Path) -> GitBranch {
        parse_porcelain_v2(&git(copy, &["status", "--porcelain=v2", "--branch", "-z"])).0
    }

    #[test]
    fn a_tracking_branch_reads_as_git_reads_it_loose_packed_and_deltified() {
        let (_dir, copy) = tracking_clone();
        let want = by_git(&copy);
        assert_eq!((want.head.as_str(), want.upstream.as_deref(), want.ahead, want.behind), ("fix/cart", Some("origin/main"), 2, 1));
        let loose = status(&copy, "/root/app").unwrap();
        assert_eq!(loose.branch, want);
        assert_eq!((loose.root.as_str(), loose.entries.len(), loose.edits_unread), ("/root/app", 0, true));
        // Every object in one pack, deltas chained as deep as git will make them, and every ref in packed-refs.
        git(&copy, &["repack", "-q", "-a", "-d", "-f", "--depth=50", "--window=250"]);
        git(&copy, &["pack-refs", "--all", "--prune"]);
        git(&copy, &["prune-packed"]);
        assert!(!copy.join(".git/refs/heads/fix/cart").exists());
        assert_eq!(status(&copy, "/root/app").unwrap().branch, want);
        // And with every delta naming its base by id rather than by where it sits in the pack.
        git(&copy, &["-c", "repack.useDeltaBaseOffset=false", "repack", "-q", "-a", "-d", "-f", "--depth=50", "--window=250"]);
        assert_eq!(status(&copy, "/root/app").unwrap().branch, want);
    }

    #[test]
    fn a_branch_with_no_upstream_counts_against_origins_default_branch() {
        let (_dir, copy) = tracking_clone();
        git(&copy, &["branch", "-q", "--unset-upstream"]);
        let read = status(&copy, "/root/app").unwrap().branch;
        assert_eq!((read.upstream, read.ahead, read.behind), (None, 2, 1));
        // A detached head reads as git reads it, and counts the same way.
        git(&copy, &["checkout", "-q", "--detach", "HEAD~1"]);
        let detached = status(&copy, "/root/app").unwrap().branch;
        assert_eq!((detached.head.as_str(), detached.oid, detached.ahead, detached.behind), ("(detached)", by_git(&copy).oid, 1, 1));
    }

    #[test]
    fn a_repo_with_no_commits_and_a_shallow_clone_read_as_git_reads_them() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        assert_eq!(status(dir.path(), "/root/app").unwrap().branch, by_git(dir.path()));
        let (_origin, copy) = tracking_clone();
        let shallow = dir.path().join("shallow");
        git(dir.path(), &["clone", "-q", "--depth=1", &format!("file://{}", copy.display()), "shallow"]);
        commit(&shallow, "c.txt", "on top\n");
        assert_eq!(status(&shallow, "/root/app").unwrap().branch, by_git(&shallow));
    }

    #[test]
    fn a_link_a_gitfile_or_a_fifo_in_the_git_directory_is_refused_and_nothing_hangs() {
        let (dir, copy) = tracking_clone();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::rename(copy.join(".git"), &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, copy.join(".git")).unwrap();
        assert_eq!(status(&copy, "/root/app").unwrap_err().code, Some(DaemonErrorCode::NotAGitRepo));
        std::fs::remove_file(copy.join(".git")).unwrap();
        std::fs::write(copy.join(".git"), format!("gitdir: {}\n", elsewhere.display())).unwrap();
        assert_eq!(status(&copy, "/root/app").unwrap_err().code, Some(DaemonErrorCode::NotAGitRepo));
        std::fs::remove_file(copy.join(".git")).unwrap();
        std::fs::rename(&elsewhere, copy.join(".git")).unwrap();
        assert!(status(&copy, "/root/app").is_ok());

        let branch_ref = copy.join(".git/refs/heads/fix/cart");
        let secret = dir.path().join("secret");
        std::fs::copy(&branch_ref, &secret).unwrap();
        std::fs::remove_file(&branch_ref).unwrap();
        std::os::unix::fs::symlink(&secret, &branch_ref).unwrap();
        let err = status(&copy, "/root/app").unwrap_err();
        assert!(err.message.contains("a link stands at refs/heads/fix/cart"), "{}", err.message);
        std::fs::remove_file(&branch_ref).unwrap();

        // A packed ref that names no commit is damaged, never a branch with nothing on it.
        std::fs::write(copy.join(".git/packed-refs"), "# pack-refs with: peeled\nnot-an-oid refs/heads/fix/cart\n").unwrap();
        assert!(status(&copy, "/root/app").unwrap_err().message.contains("refs/heads/fix/cart holds no commit"));

        std::fs::write(copy.join(".git/HEAD"), "ref: refs/heads/../../../etc/passwd\n").unwrap();
        assert!(status(&copy, "/root/app").unwrap_err().message.contains("HEAD names no ref"));
        std::fs::remove_file(copy.join(".git/HEAD")).unwrap();
        let made = Command::new("mkfifo").arg(copy.join(".git/HEAD")).status().unwrap();
        assert!(made.success());
        assert!(status(&copy, "/root/app").unwrap_err().message.contains("HEAD is not a file"));
    }

    /// Everything a checkout's config and folder can name that runs a program, each writing a mark of its own: an
    /// fsmonitor, a hooks folder and the hooks in .git/hooks, a filter's clean, smudge and process, a textconv, an
    /// ssh command, a credential helper, a gpg program, a pager, an editor, an alias over status, and an include and
    /// an includeIf naming a file that sets an fsmonitor of its own. The worktree is dirty, so a status that read it
    /// would hand the change to the filter.
    #[test]
    fn a_hostile_config_runs_nothing_and_the_branch_still_reads() {
        let (dir, copy) = tracking_clone();
        let want = by_git(&copy);
        let marks = dir.path().join("marks");
        std::fs::create_dir(&marks).unwrap();
        let script = |name: &str| -> String {
            let at = dir.path().join(format!("run-{name}"));
            std::fs::write(&at, format!("#!/bin/sh\ntouch '{}/{name}'\nexit 1\n", marks.display())).unwrap();
            std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            at.to_string_lossy().into_owned()
        };
        let hooks = dir.path().join("hooks");
        std::fs::create_dir(&hooks).unwrap();
        for hook in ["pre-commit", "post-checkout", "post-index-change", "reference-transaction", "fsmonitor-watchman", "pre-push"] {
            let body = format!("#!/bin/sh\ntouch '{}/hook-{hook}'\n", marks.display());
            for folder in [hooks.clone(), copy.join(".git/hooks")] {
                std::fs::write(folder.join(hook), &body).unwrap();
                std::fs::set_permissions(folder.join(hook), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            }
        }
        let included = dir.path().join("included");
        std::fs::write(&included, format!("[core]\n\tfsmonitor = {}\n", script("include"))).unwrap();
        let hostile = format!(
            "[core]\n\tfsmonitor = {fsmonitor}\n\thooksPath = {hooks}\n\tsshCommand = {ssh}\n\tpager = {pager}\n\teditor = {editor}\n\
             [filter \"evil\"]\n\tclean = {clean}\n\tsmudge = {smudge}\n\tprocess = {process}\n\trequired = true\n\
             [diff \"evil\"]\n\ttextconv = {textconv}\n\
             [credential]\n\thelper = !{credential}\n\
             [gpg]\n\tprogram = {gpg}\n\
             [alias]\n\tstatus = !{alias}\n\
             [include]\n\tpath = {included}\n\
             [includeIf \"gitdir:/\"]\n\tpath = {included}\n",
            fsmonitor = script("fsmonitor"),
            hooks = hooks.display(),
            ssh = script("ssh"),
            pager = script("pager"),
            editor = script("editor"),
            clean = script("clean"),
            smudge = script("smudge"),
            process = script("process"),
            textconv = script("textconv"),
            credential = script("credential"),
            gpg = script("gpg"),
            alias = script("alias"),
            included = included.display(),
        );
        let config = copy.join(".git/config");
        std::fs::write(&config, format!("{}{hostile}", std::fs::read_to_string(&config).unwrap())).unwrap();
        std::fs::write(copy.join(".gitattributes"), "* filter=evil diff=evil\n").unwrap();
        std::fs::write(copy.join("a.txt"), "an edit never committed\n").unwrap();
        std::fs::write(copy.join("untracked.txt"), "new\n").unwrap();

        let read = status(&copy, "/root/app").unwrap();
        assert_eq!(read.branch, want);
        assert!(read.entries.is_empty() && read.edits_unread);
        let ran: Vec<String> = std::fs::read_dir(&marks).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(ran.is_empty(), "the read ran {ran:?}");
    }

    /// One repo read by both roads, the running one through git and the stopped one off the files, answers one
    /// branch: tracking, with no upstream, with an upstream whose tracking ref is gone, detached, and with no commits.
    #[tokio::test]
    async fn a_running_copy_and_a_stopped_one_answer_the_same_branch() {
        let both = async |copy: &Path| {
            let running = crate::git::git_status(&crate::git::here::Here::new(), copy).await.unwrap().branch;
            assert_eq!(running, status(copy, "/root/app").unwrap().branch);
            running
        };
        let (dir, copy) = tracking_clone();
        assert_eq!(both(&copy).await.upstream.as_deref(), Some("origin/main"));
        git(&copy, &["branch", "-q", "--unset-upstream"]);
        let unset = both(&copy).await;
        assert_eq!((unset.upstream, unset.ahead, unset.behind), (None, 2, 1));
        git(&copy, &["branch", "-q", "--set-upstream-to=origin/main"]);
        git(&copy, &["update-ref", "-d", "refs/remotes/origin/main"]);
        git(&copy, &["remote", "set-head", "origin", "-d"]);
        let gone = both(&copy).await;
        assert_eq!((gone.upstream, gone.ahead, gone.behind), (None, 2, 0));
        git(&copy, &["checkout", "-q", "--detach", "HEAD~1"]);
        assert_eq!(both(&copy).await.head, "(detached)");
        let empty = dir.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        git(&empty, &["init", "-q"]);
        assert_eq!(both(&empty).await.oid, "(initial)");
    }

    /// A pack whose one object is a delta over itself: the chain is followed in a loop and ends at the depth cap,
    /// never on the stack of a daemon that aborts on overflow.
    #[test]
    fn a_delta_that_names_itself_as_its_base_ends_at_the_depth_cap() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        let oid = vec![0x42u8; 20];
        let mut delta = Vec::new();
        flate2::write::ZlibEncoder::new(&mut delta, flate2::Compression::default()).write_all(&[0, 0]).unwrap();
        let mut pack = b"PACK\0\0\0\x02\0\0\0\x01".to_vec();
        pack.push(0x72);
        pack.extend_from_slice(&oid);
        pack.extend_from_slice(&delta);
        let mut idx = vec![0xff, b't', b'O', b'c', 0, 0, 0, 2];
        for byte in 0..=255u8 {
            idx.extend_from_slice(&u32::from(byte >= 0x42).to_be_bytes());
        }
        idx.extend_from_slice(&oid);
        idx.extend_from_slice(&[0; 4]);
        idx.extend_from_slice(&12u32.to_be_bytes());
        let packs = dir.path().join(".git/objects/pack");
        std::fs::write(packs.join("pack-self.pack"), pack).unwrap();
        std::fs::write(packs.join("pack-self.idx"), idx).unwrap();
        let git_dir = GitDir::open(dir.path()).unwrap();
        let err = Repo::new(&git_dir).unwrap().object(&oid).unwrap_err();
        assert!(err.contains("a delta chain is too deep"), "{err}");
    }

    #[test]
    fn config_reads_sections_subsections_quotes_comments_and_continued_lines() {
        let text = "# top\n[branch \"fix/Cart\"]\n\tremote = origin ; a comment\n\tmerge = \"refs/heads/ma\\\nin\"\n\
                    [Remote \"origin\"]\n\tFetch = +refs/heads/*:refs/remotes/origin/*\n[core.Sub]\n\tbare\n";
        let config = Config(parse_config(text));
        assert_eq!(config.last("branch", Some("fix/Cart"), "remote"), Some("origin"));
        assert_eq!(config.last("branch", Some("fix/Cart"), "merge"), Some("refs/heads/main"));
        assert_eq!(config.last("branch", Some("fix/cart"), "merge"), None);
        assert_eq!(config.all("remote", Some("origin"), "fetch"), vec!["+refs/heads/*:refs/remotes/origin/*"]);
        assert_eq!(config.last("core", Some("sub"), "bare"), Some("true"));
        assert_eq!(tracking_of(&["+refs/heads/*:refs/remotes/origin/*"], "refs/heads/main").as_deref(), Some("refs/remotes/origin/main"));
        assert_eq!(tracking_of(&["refs/heads/main:refs/remotes/o/m"], "refs/heads/main").as_deref(), Some("refs/remotes/o/m"));
        assert_eq!(tracking_of(&["^refs/heads/main", "refs/heads/dev:refs/x"], "refs/heads/main"), None);
    }

    #[test]
    fn a_ref_name_that_would_walk_out_of_the_git_directory_is_no_ref() {
        assert!(plain_ref("refs/heads/fix/cart"));
        for bad in ["refs/heads/../../x", "refs/heads/.hidden", "refs//x", "HEAD", "/etc/passwd", "refs/heads/a.lock", "refs/heads/a b"] {
            assert!(!plain_ref(bad), "{bad}");
        }
    }

    #[test]
    fn a_delta_copies_and_inserts_and_a_damaged_one_is_refused() {
        let base = b"hello world";
        let delta = [11, 9, 0x91, 0, 5, 4, b' ', b'y', b'o', b'u'];
        assert_eq!(apply_delta(base, &delta).as_deref(), Some(&b"hello you"[..]));
        assert_eq!(apply_delta(base, &[10, 9]), None);
        assert_eq!(apply_delta(base, &[11, 5, 0x91, 8, 5]), None);
        assert_eq!(apply_delta(base, &[11, 1, 0]), None);
    }
}
