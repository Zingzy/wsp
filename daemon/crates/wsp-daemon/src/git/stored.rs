// SPDX-License-Identifier: AGPL-3.0-only
//! A stopped workspace's branch, read off its copy's git directory by this daemon's own reads: HEAD, the refs,
//! packed-refs, the branch's lines of config and the commit objects, loose or packed. No program runs, so nothing an
//! agent wrote into that directory (a hook, an fsmonitor, a filter, an include, an ssh command) runs as the root this
//! daemon is, and nothing of the worktree or the index is read, so the edits never committed stay unread. Every
//! file is opened one component at a time with no link followed, so a link or a gitfile cannot point the read at
//! another folder, and every size read is capped, since the bytes are an agent's to write. A leave's count of what no
//! remote has follows a link only where it stays inside the checkout, and fails on one that leads out.

use std::collections::{BinaryHeap, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::time::{Duration, Instant};

use flate2::read::ZlibDecoder;
use nix::errno::Errno;
use nix::fcntl::{open, openat, OFlag};
use nix::sys::stat::Mode;
use wsp_frames::{GitBranch, GitStatusReply};

use crate::beneath::{self, dir_flags};
use crate::git::{not_a_repo, DEFAULT_BRANCHES};
use crate::paths::OpError;

/// HEAD and a loose ref: one line each.
const REF_MAX: u64 = 16 << 10;
/// config, kept whole while it is read: git's own run to a few KiB, and every query keeps only the lines it asked for.
const CONFIG_MAX: u64 = 1 << 20;
/// packed-refs and shallow, scanned in place: a repository with a hundred thousand tags keeps packed-refs under this.
const LIST_MAX: u64 = 16 << 20;
/// One object whole, and the deltas held to build it: only commits and tags are read, and git's run to a few KiB.
const OBJECT_MAX: usize = 1 << 20;
/// git writes no chain deeper than 4095.
const DEPTH_MAX: usize = 4096;
/// What one count may inflate, walk and take before its counts read as unknown: it runs on one of the daemon's few
/// blocking threads, and a history an agent wrote may be built to be slow.
const INFLATE_BUDGET: usize = 256 << 20;
const COMMITS_MAX: usize = 200_000;
const WALK_BUDGET: Duration = Duration::from_secs(2);
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
    let mut repo = Repo::new(&dir).map_err(|why| unread(root, &why))?;
    let branch = repo.branch().map_err(|why| unread(root, &why))?;
    let stashes = stashes_of(&dir).map_err(|why| unread(root, &why))?;
    Ok(GitStatusReply { branch, entries: Vec::new(), root: root.to_owned(), edits_unread: true, counts_unknown: repo.over_budget, stashes })
}

/// What a stopped checkout holds that no remote does, off its git directory alone: the commits at every branch's tip,
/// at HEAD and at each linked worktree's HEAD that no remote-tracking branch and no seeded ref reaches, and its stashes.
/// None where the checkout holds no git directory. Its uncommitted files are never read: that takes running git over
/// what an agent wrote, as root.
pub(crate) fn unsaved(checkout: &Path) -> Result<Option<Unsaved>, String> {
    let dir = match GitDir::open_following(checkout) {
        Ok(dir) => dir,
        Err(_) if std::fs::symlink_metadata(checkout.join(".git")).is_err() => return Ok(None),
        Err(_) => return Err(format!("{}: its git folder could not be opened", checkout.display())),
    };
    let mut repo = Repo::new(&dir)?;
    let commits = match repo.unpushed() {
        Ok(n) => Some(n),
        Err(_) if repo.over_budget => None,
        Err(why) => return Err(why),
    };
    let stashes = stashes_of(&dir)?.unwrap_or(0);
    Ok(Some(Unsaved { commits, stashes }))
}

/// What `unsaved` read: the commits no remote has, None past the walk's budget, and the stashes.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Unsaved {
    pub(crate) commits: Option<u64>,
    pub(crate) stashes: u64,
}

/// How many refs one prefix's loose folders are read for, and how deep, before the read gives up: git's own run far
/// under both, and the folders are an agent's to fill.
const LOOSE_REFS_MAX: usize = 100_000;
const REF_DEPTH_MAX: usize = 32;

/// How many stashes the stash ref's log holds, one line each; a stash ref with no log is one.
fn stashes_of(dir: &GitDir) -> Result<Option<u64>, String> {
    let logged = dir.text("logs/refs/stash", LIST_MAX)?.map_or(0, |log| log.lines().filter(|line| !line.trim().is_empty()).count() as u64);
    let held = if logged == 0 && dir.text("refs/stash", REF_MAX)?.is_some() { 1 } else { logged };
    Ok((held > 0).then_some(held))
}

fn unread(root: &str, why: &str) -> OpError {
    OpError::plain(format!("the branch of {root} could not be read while it is stopped: {why}"))
}

/// The copy's `.git`, a real folder or nothing: a gitfile or a link there names another folder. Every name under it is
/// opened one component at a time with no link followed, except in a leave's unsaved read, which holds the checkout's
/// own folder too and follows a link inside the checkout as git would, and refuses one that leads out of it, since a
/// link there that read as nothing would hide commits a leave then takes.
struct GitDir {
    fd: OwnedFd,
    within: Option<OwnedFd>,
}

impl GitDir {
    fn open(copy: &Path) -> Result<GitDir, OpError> {
        let top = open(copy, OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC, Mode::empty())
            .map_err(|e| OpError::plain(format!("{}: {e}", copy.display())))?;
        match openat(&top, ".git", dir_flags(), Mode::empty()) {
            Ok(fd) => Ok(GitDir { fd, within: None }),
            Err(Errno::ENOENT | Errno::ENOTDIR | Errno::ELOOP) => Err(not_a_repo()),
            Err(e) => Err(OpError::plain(format!("{}: {e}", copy.display()))),
        }
    }

    /// The same `.git`, read with the links inside the checkout followed.
    fn open_following(copy: &Path) -> Result<GitDir, OpError> {
        let mut dir = GitDir::open(copy)?;
        let top = open(copy, OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC, Mode::empty())
            .map_err(|e| OpError::plain(format!("{}: {e}", copy.display())))?;
        dir.within = Some(top);
        Ok(dir)
    }

    /// `rel` under `.git` opened with `flags`, or None where nothing stands there or a name on the way is no folder.
    fn open_at(&self, rel: &OsStr, flags: OFlag) -> Result<Option<OwnedFd>, String> {
        let shown = rel.to_string_lossy();
        if let Some(top) = &self.within {
            return open_within(top, rel, flags);
        }
        let rel = rel.to_str().ok_or_else(|| format!("{shown} is not a name this reads"))?;
        let Some((parent, leaf)) = self.parent_of(rel)? else { return Ok(None) };
        match openat(&parent, leaf, flags | OFlag::O_NOFOLLOW, Mode::empty()) {
            Ok(fd) => Ok(Some(fd)),
            Err(Errno::ENOENT) => Ok(None),
            Err(Errno::ENOTDIR) if flags.contains(OFlag::O_DIRECTORY) => Ok(None),
            Err(Errno::ELOOP) => Err(format!("a link stands at {rel}")),
            Err(e) => Err(format!("{rel}: {e}")),
        }
    }

    /// The folder holding `rel` and its last name, as the one walk under a held folder reads it.
    fn parent_of<'a>(&self, rel: &'a str) -> Result<Option<(OwnedFd, &'a str)>, String> {
        beneath::parent_of(&self.fd, rel)
    }

    /// A regular file, or None where nothing or a folder stands there.
    fn file(&self, rel: impl AsRef<OsStr>) -> Result<Option<File>, String> {
        let rel = rel.as_ref();
        if self.within.is_none() {
            return beneath::file(&self.fd, rel.to_str().ok_or_else(|| format!("{} is not a name this reads", rel.to_string_lossy()))?);
        }
        let flags = OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
        let Some(fd) = self.open_at(rel, flags)? else { return Ok(None) };
        let file = File::from(fd);
        let kind = file.metadata().map_err(|e| format!("{}: {e}", rel.to_string_lossy()))?.file_type();
        if kind.is_dir() {
            return Ok(None);
        }
        if !kind.is_file() {
            return Err(format!("{} is not a file", rel.to_string_lossy()));
        }
        Ok(Some(file))
    }

    fn text(&self, rel: impl AsRef<OsStr>, max: u64) -> Result<Option<String>, String> {
        let rel = rel.as_ref();
        let Some(file) = self.file(rel)? else { return Ok(None) };
        let mut bytes = Vec::new();
        file.take(max + 1).read_to_end(&mut bytes).map_err(|e| format!("{}: {e}", rel.to_string_lossy()))?;
        if bytes.len() as u64 > max {
            return Err(format!("{} is too large", rel.to_string_lossy()));
        }
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// Every name in a folder, byte for byte, and whether it is a folder itself, or None where it is no folder or not
    /// there.
    fn entries(&self, rel: &OsStr) -> Result<Option<Vec<(OsString, bool)>>, String> {
        let Some(fd) = self.open_at(rel, dir_flags())? else { return Ok(None) };
        let shown = rel.to_string_lossy();
        let mut listed = nix::dir::Dir::from_fd(fd).map_err(|e| format!("{shown}: {e}"))?;
        let mut names = Vec::new();
        for entry in listed.iter() {
            let entry = entry.map_err(|e| format!("{shown}: {e}"))?;
            let name = OsStr::from_bytes(entry.file_name().to_bytes()).to_owned();
            if name == "." || name == ".." {
                continue;
            }
            let folder = match entry.file_type() {
                Some(nix::dir::Type::Directory) => true,
                Some(nix::dir::Type::Symlink) if self.within.is_some() => self.entries(&joined_name(rel, &name))?.is_some(),
                Some(_) => false,
                None => self.entries(&joined_name(rel, &name))?.is_some(),
            };
            names.push((name, folder));
        }
        names.sort();
        Ok(Some(names))
    }

    /// The loose refs under a prefix, by their full names byte for byte: the folders walked one at a time.
    fn loose_refs(&self, prefix: &OsStr, depth: usize, out: &mut Vec<OsString>) -> Result<(), String> {
        if depth > REF_DEPTH_MAX {
            return Err(format!("{} is nested too deep to read", prefix.to_string_lossy()));
        }
        for (name, folder) in self.entries(prefix)?.unwrap_or_default() {
            let full = joined_name(prefix, &name);
            if folder {
                self.loose_refs(&full, depth + 1, out)?;
            } else if plain_ref_bytes(full.as_bytes()) {
                if out.len() == LOOSE_REFS_MAX {
                    return Err(format!("{} holds too many refs to read", prefix.to_string_lossy()));
                }
                out.push(full);
            }
        }
        Ok(())
    }

    /// The names in a folder ending in `suffix`, or none where it is not there.
    fn names(&self, rel: &str, suffix: &str) -> Result<Vec<String>, String> {
        let Some(fd) = self.open_at(OsStr::new(rel), dir_flags())? else { return Ok(Vec::new()) };
        let mut listed = nix::dir::Dir::from_fd(fd).map_err(|e| format!("{rel}: {e}"))?;
        let mut names = Vec::new();
        for entry in listed.iter() {
            let entry = entry.map_err(|e| format!("{rel}: {e}"))?;
            let name = entry.file_name().to_string_lossy();
            if !name.ends_with(suffix) {
                continue;
            }
            if names.len() == PACKS_MAX {
                return Err(format!("{rel} holds too many packs to read"));
            }
            names.push(name.into_owned());
        }
        names.sort();
        Ok(names)
    }
}

fn joined_name(prefix: &OsStr, name: &OsStr) -> OsString {
    let mut full = prefix.to_owned();
    full.push("/");
    full.push(name);
    full
}

/// `.git/<rel>` under the checkout's own folder, following a link only where it stays inside that folder and on its
/// mount, as openat2 resolves beneath a folder; a link that leads out of it is refused, never read as nothing.
#[cfg(target_os = "linux")]
fn open_within(top: &OwnedFd, rel: &OsStr, flags: OFlag) -> Result<Option<OwnedFd>, String> {
    use nix::fcntl::{openat2, OpenHow, ResolveFlag};
    let shown = rel.to_string_lossy();
    let path = joined_name(OsStr::new(".git"), rel);
    let how = OpenHow::new()
        .flags(flags.difference(OFlag::O_NOFOLLOW))
        .resolve(ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_MAGICLINKS | ResolveFlag::RESOLVE_NO_XDEV);
    match openat2(top, path.as_os_str(), how) {
        Ok(fd) => Ok(Some(fd)),
        Err(Errno::ENOENT | Errno::ENOTDIR) => Ok(None),
        Err(Errno::EXDEV | Errno::ELOOP) => Err(format!("a link at {shown} leads out of the checkout")),
        Err(e) => Err(format!("{shown}: {e}")),
    }
}

#[cfg(not(target_os = "linux"))]
fn open_within(_top: &OwnedFd, rel: &OsStr, _flags: OFlag) -> Result<Option<OwnedFd>, String> {
    Err(format!("{}: only Linux reads a checkout beneath its own folder", rel.to_string_lossy()))
}

type Oid = Vec<u8>;

fn hex(oid: &[u8]) -> String {
    oid.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_oid(text: &str, len: usize) -> Option<Oid> {
    let id = super::GitOid::parse(text).filter(|id| id.as_str().len() == len * 2)?;
    let text = id.as_str();
    (0..len).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()).collect()
}

/// A ref name this reader will open as a path: under refs/, no component a path walk reads as anything but itself,
/// and none of the characters git refuses in a ref.
fn plain_ref(name: &str) -> bool {
    plain_ref_bytes(name.as_bytes())
}

/// The same rule over a name's bytes, which git takes in any encoding.
fn plain_ref_bytes(name: &[u8]) -> bool {
    let has = |needle: &[u8]| name.windows(needle.len()).any(|w| w == needle);
    name.starts_with(b"refs/")
        && !has(b"..")
        && !has(b"@{")
        && !name.iter().any(|b| *b < 0x20 || *b == 0x7f || b" ~^:?*[\\".contains(b))
        && name.split(|b| *b == b'/').all(|part| !part.is_empty() && !part.starts_with(b".") && !part.ends_with(b".lock"))
}

/// The values of the lines `keep` takes, the last `CONFIG_KEPT` of them, as git reads the repository's own file with
/// includes left unread, since an include names a file anywhere on the computer. Every other line's value is read
/// and dropped at once, so what a config holds costs its own bytes and no more.
fn parse_config(text: &str, keep: impl Fn(&str, Option<&str>, &str) -> bool) -> Vec<String> {
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
                let key = key.to_ascii_lowercase();
                if keep(&section, sub.as_deref(), &key) {
                    if lines.len() == CONFIG_KEPT {
                        lines.remove(0);
                    }
                    lines.push(value);
                }
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

const CONFIG_KEPT: usize = 64;

/// The repository's config as text, read for one key at a time.
struct Config(String);

impl Config {
    fn all(&self, section: &str, sub: Option<&str>, key: &str) -> Vec<String> {
        parse_config(&self.0, |s, b, k| s == section && b == sub && k == key)
    }
    fn last(&self, section: &str, sub: Option<&str>, key: &str) -> Option<String> {
        self.all(section, sub, key).pop()
    }
}

/// Where a remote's fetch refspecs file the branch it merges: the first spec that takes it, a glob or a name.
fn tracking_of(specs: &[String], merge: &str) -> Option<String> {
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
    packed: Option<String>,
    packs: Option<Vec<Pack>>,
    shallow: HashSet<Oid>,
    commits: HashMap<Oid, (i64, Vec<Oid>)>,
    inflated: usize,
    budget: usize,
    deadline: Instant,
    /// The walk passed its budget, so the counts are unknown rather than counted.
    over_budget: bool,
}

impl<'a> Repo<'a> {
    fn new(dir: &'a GitDir) -> Result<Repo<'a>, String> {
        let deadline = Instant::now() + WALK_BUDGET;
        let config = Config(dir.text("config", CONFIG_MAX)?.unwrap_or_default());
        let len = match config.last("extensions", None, "objectformat").map(|f| f.to_ascii_lowercase()).as_deref() {
            None | Some("sha1") => 20,
            Some("sha256") => 32,
            Some(other) => return Err(format!("object format {other} is not one this reads")),
        };
        if let Some(store) = config.last("extensions", None, "refstorage").filter(|s| !s.eq_ignore_ascii_case("files")) {
            return Err(format!("refs kept as {store} are not ones this reads"));
        }
        let shallow = dir.text("shallow", LIST_MAX)?.unwrap_or_default().lines().filter_map(|line| parse_oid(line, len)).collect();
        Ok(Repo {
            dir,
            len,
            config,
            packed: None,
            packs: None,
            shallow,
            commits: HashMap::new(),
            inflated: 0,
            budget: INFLATE_BUDGET,
            deadline,
            over_budget: false,
        })
    }

    fn branch(&mut self) -> Result<GitBranch, String> {
        let head = self.dir.text("HEAD", REF_MAX)?.ok_or_else(|| "HEAD is missing".to_owned())?;
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
            match self.ahead_behind(&oid, &base) {
                Ok(counts) => (branch.ahead, branch.behind) = counts,
                Err(_) if self.over_budget => {}
                Err(why) => return Err(why),
            }
        }
        Ok(branch)
    }

    /// The commits reachable from a branch, HEAD or a linked worktree's HEAD that no remote-tracking branch and no
    /// seeded ref reaches, as `rev-list --count --branches <heads> --not --remotes --glob=<seeded>` counts them. A tag
    /// is not counted: a clone fetches the remote's tags with no mark saying the remote holds them.
    fn unpushed(&mut self) -> Result<u64, String> {
        let mut heads = self.tips("refs/heads")?;
        let mut bases = self.tips("refs/remotes")?;
        bases.extend(self.tips(wsp_frames::numbers::SEEDED_REFS)?);
        if let Some(oid) = self.head_of(OsStr::new("HEAD"))? {
            heads.push(oid);
        }
        for (name, folder) in self.dir.entries(OsStr::new("worktrees"))?.unwrap_or_default() {
            if folder {
                let mut head = joined_name(OsStr::new("worktrees"), &name);
                head.push("/HEAD");
                if let Some(oid) = self.head_of(&head)? {
                    heads.push(oid);
                }
            }
        }
        if heads.is_empty() {
            return Ok(0);
        }
        Ok(self.apart(&heads, &bases)?.0)
    }

    /// The commit a HEAD file names, through the ref it points at; None for a branch with no commit yet. A loose ref
    /// whose name is not UTF-8 is read the same way, by its bytes.
    fn head_of(&mut self, rel: &OsStr) -> Result<Option<Oid>, String> {
        let shown = rel.to_string_lossy();
        let Some(text) = self.dir.text(rel, REF_MAX)? else { return Ok(None) };
        let text = text.trim();
        match text.strip_prefix("ref: ") {
            Some(target) if plain_ref(target.trim()) => self.resolve(target.trim()),
            Some(_) => Err(format!("{shown} names no ref")),
            None => parse_oid(text, self.len).map(Some).ok_or_else(|| format!("{shown} names no commit")),
        }
    }

    /// The commit at every ref under a prefix, loose or packed, a loose one standing over a packed one of its name.
    fn tips(&mut self, prefix: &str) -> Result<Vec<Oid>, String> {
        let mut loose = Vec::new();
        self.dir.loose_refs(OsStr::new(prefix), 0, &mut loose)?;
        if self.packed.is_none() {
            self.packed = Some(self.dir.text("packed-refs", LIST_MAX)?.unwrap_or_default());
        }
        let within = format!("{prefix}/");
        let mut packed = Vec::new();
        for line in self.packed.as_deref().unwrap_or_default().lines().filter(|line| !line.starts_with('#') && !line.starts_with('^')) {
            if let Some((_, named)) = line.split_once(' ') {
                let named = named.trim();
                if named.starts_with(&within) && plain_ref(named) && !loose.iter().any(|n| n.as_bytes() == named.as_bytes()) {
                    packed.push(named.to_owned());
                }
            }
        }
        let mut tips = Vec::new();
        for name in loose {
            let oid = match name.to_str() {
                Some(name) => self.resolve(name)?,
                None => self.head_of(&name)?,
            };
            tips.extend(oid);
        }
        for name in packed {
            tips.extend(self.resolve(&name)?);
        }
        Ok(tips)
    }

    /// The branch's upstream as git names it and the commit its tracking ref holds, where it has one that is here.
    fn upstream_of(&mut self, local: &str) -> Result<Option<(String, Oid)>, String> {
        let remote = self.config.last("branch", Some(local), "remote");
        let merge = self.config.last("branch", Some(local), "merge");
        let (Some(remote), Some(merge)) = (remote, merge) else { return Ok(None) };
        let tracking = if remote == "." { Some(merge) } else { tracking_of(&self.config.all("remote", Some(&remote), "fetch"), &merge) };
        let Some(tracking) = tracking.filter(|t| plain_ref(t)) else { return Ok(None) };
        Ok(self.resolve(&tracking)?.map(|tip| (short(&tracking).to_owned(), tip)))
    }

    /// What a branch with no upstream is counted against: origin's HEAD, or a local main or master.
    fn default_tip(&mut self) -> Result<Option<Oid>, String> {
        for name in DEFAULT_BRANCHES {
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
            let Some(text) = self.dir.text(&name, REF_MAX)? else { return self.packed_ref(&name) };
            let text = text.trim();
            match text.strip_prefix("ref: ") {
                Some(target) => name = target.trim().to_owned(),
                None => return parse_oid(text, self.len).map(Some).ok_or_else(|| format!("{name} holds no commit")),
            }
        }
        Err(format!("{name} points too deep"))
    }

    /// A ref in packed-refs, scanned in place for its one line: the file is read once and nothing is built of it. A
    /// line that names the ref and no commit reads as damaged, never as a branch with no commits yet, which would say
    /// it holds nothing origin lacks.
    fn packed_ref(&mut self, name: &str) -> Result<Option<Oid>, String> {
        if self.packed.is_none() {
            self.packed = Some(self.dir.text("packed-refs", LIST_MAX)?.unwrap_or_default());
        }
        let text = self.packed.as_deref().unwrap_or_default();
        for line in text.lines().filter(|line| !line.starts_with('#') && !line.starts_with('^')) {
            let (oid, named) = line.split_once(' ').unwrap_or(("", line));
            if named.trim() == name {
                return parse_oid(oid, self.len).map(Some).ok_or_else(|| format!("{name} holds no commit"));
            }
        }
        Ok(None)
    }

    /// Commits reachable from the head and not the base, and from the base and not the head, as
    /// `rev-list --left-right --count base...head` counts them.
    fn ahead_behind(&mut self, head: &Oid, base: &Oid) -> Result<(u64, u64), String> {
        self.apart(std::slice::from_ref(head), std::slice::from_ref(base))
    }

    /// Commits reachable from some head and no base, and from some base and no head: newest first by committer date,
    /// stopping once every commit left to read is reachable from both sides.
    fn apart(&mut self, heads: &[Oid], bases: &[Oid]) -> Result<(u64, u64), String> {
        const AHEAD: u8 = 1;
        const BEHIND: u8 = 2;
        const BOTH: u8 = AHEAD | BEHIND;
        let mut flags: HashMap<Oid, u8> = HashMap::new();
        for (side, flag) in [(heads, AHEAD), (bases, BEHIND)] {
            for oid in side {
                let oid = self.peel(oid)?;
                *flags.entry(oid).or_default() |= flag;
            }
        }
        if flags.values().all(|flag| *flag == BOTH) {
            return Ok((0, 0));
        }
        let mut spread: HashMap<Oid, u8> = HashMap::new();
        let mut queue: BinaryHeap<(i64, Oid, u8)> = BinaryHeap::new();
        let mut single = 0usize;
        for (oid, flag) in flags.clone() {
            let (time, _) = self.commit(&oid)?;
            if flag != BOTH {
                single += 1;
            }
            queue.push((time, oid, flag));
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
            if spread.len() > COMMITS_MAX || Instant::now() > self.deadline {
                self.over_budget = true;
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
        if self.inflated > self.budget || Instant::now() > self.deadline {
            self.over_budget = true;
            return Err("the history is too long to count".to_owned());
        }
        match self.locate(oid)? {
            Located::Loose(file) => {
                let read = loose(file).ok_or_else(|| format!("object {} is damaged or past {OBJECT_MAX} bytes", hex(oid)))?;
                self.inflated += read.1.len();
                Ok(read)
            }
            Located::Packed(pack, at) => self.unpack(pack, at).map_err(|why| format!("object {}: {why}", hex(oid))),
        }
    }

    fn locate(&mut self, oid: &Oid) -> Result<Located, String> {
        let name = hex(oid);
        if let Some(file) = self.dir.file(format!("objects/{}/{}", &name[..2], &name[2..]))? {
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
        for name in self.dir.names("objects/pack", ".idx")? {
            let Some(stem) = name.strip_suffix(".idx") else { continue };
            let (Some(idx), Some(pack)) =
                (self.dir.file(format!("objects/pack/{name}"))?, self.dir.file(format!("objects/pack/{stem}.pack"))?)
            else {
                continue;
            };
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
            let entry = packs[pack].entry(at, self.len).ok_or_else(|| format!("a damaged entry or one past {OBJECT_MAX} bytes"))?;
            let data = packs[pack].inflate(entry.data, entry.size).ok_or("a damaged entry")?;
            self.inflated += data.len();
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
                    Located::Loose(file) => {
                        let read = loose(file).ok_or("a damaged base")?;
                        self.inflated += read.1.len();
                        break read;
                    }
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
#[path = "../../tests/stored_git/mod.rs"]
mod tests;
