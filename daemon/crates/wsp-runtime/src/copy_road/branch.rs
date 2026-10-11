// SPDX-License-Identifier: AGPL-3.0-only
//! A thread on another branch than the project folder's works in a git worktree the host keeps under its own
//! folder: one per branch, the folder's config files and the dependency directories of each ecosystem whose
//! lockfile a folder of the branch holds carried in by one directory clone each (a reflink copy on a Linux disk that
//! shares blocks, an overlay of a frozen copy of the folder's own on one that does not), and taken away only with
//! nothing in it uncommitted. A branch some worktree already holds is answered with that worktree, since git checks a
//! branch out in one place; nothing here resets a branch the person has, so an existing branch is checked out as it
//! stands and only a new one starts at the folder's HEAD, or forked from a checkpoint at the commit it was taken on
//! with the checkpoint's files laid in uncommitted.

use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::Instant;

use wsp_frames::{checkpoint_id_ok, words, CarryModule, FoundModule, GitWorktree, WorktreeRemoval, WorktreeReport, CHECKPOINT_REFS};

use super::aside::{remove_later, sweep, ASIDE_PREFIX};
use super::rules::{config_files_in, git, has_branch, ignored, is_repo_top, sha_of, READ_MS, WRITE_MS};
use crate::git_line::{GitLine, Oid};

/// One worktree as the verb is asked for it.
pub struct Ask<'a> {
    /// The top of the project's repository.
    pub from: &'a Path,
    /// The host's own folder, whose `worktrees` folder holds the worktrees of projects on its volume.
    pub home: &'a Path,
    /// The project's id, which names the folder its worktrees sit in.
    pub project: &'a str,
    pub branch: &'a str,
    /// The ecosystems a new worktree is read for: each folder holding one's lockfile carries its directories in.
    pub modules: &'a [CarryModule],
    /// A checkpoint ref the new branch is forked from: the branch starts at the commit the checkpoint was taken on
    /// and the checkpoint's files are laid in uncommitted.
    pub checkpoint: Option<&'a str>,
}

/// How one carried directory came to be in the worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Took {
    Clone,
    Overlay,
}

/// Where one carried directory goes: `at` inside `worktree`; for an overlay, `dir` a folder of its own for its
/// upper and work directories and `frozen` the key of the frozen copy of the folder's directory, made where it is
/// not, both named under `beside`, the folder of the project's worktrees.
pub struct Layer {
    pub worktree: PathBuf,
    pub at: String,
    pub beside: PathBuf,
    pub dir: String,
    pub frozen: String,
}

/// How one directory is cloned from the folder's `source` into its layer's place: handed in so a test can count the
/// calls or fail them.
pub type CloneDir = fn(&Path, &Layer) -> io::Result<Took>;

/// The worktree for the branch: the one already holding it, else one made under the worktree root.
pub fn make(ask: &Ask) -> Result<WorktreeReport, String> {
    make_with(ask, clone_dir)
}

pub fn make_with(ask: &Ask, clone: CloneDir) -> Result<WorktreeReport, String> {
    let started = Instant::now();
    let from = ask.from;
    if !is_repo_top(from) {
        return Err(not_a_repo_top(from));
    }
    one_part("project id", ask.project)?;
    for module in ask.modules {
        for name in &module.lockfiles {
            one_part("lockfile name", name)?;
        }
        let paths = module.carry.iter().map(|n| ("carried directory", n));
        for (what, name) in
            paths.chain(module.never.iter().map(|n| ("directory", n))).chain(module.installed.iter().map(|n| ("install record", n)))
        {
            if !downward(name) {
                return Err(format!("{name:?} is not a {what} name: a path down from a folder, one folder name to a part"));
            }
        }
    }
    branch_name(from, ask.branch)?;
    let fork = ask.checkpoint.map(|checkpoint| fork_point(from, ask.branch, checkpoint)).transpose()?;
    let home = fs::canonicalize(ask.home).map_err(|e| format!("{}: {e}", ask.home.display()))?;
    let held = listed(from)?.into_iter().find(|w| w.branch.as_deref() == Some(ask.branch));
    if let Some(held) = held {
        if !held.prunable {
            let made = made_here(Path::new(&held.path), &home);
            // A restart of the computer took its mounts; they come back before a thread runs there again.
            if made {
                mount_layers(Path::new(&held.path));
            }
            return Ok(WorktreeReport {
                made,
                path: held.path,
                branch: ask.branch.to_owned(),
                carried: Vec::new(),
                plain: Vec::new(),
                overlaid: Vec::new(),
                fresh: false,
                modules: Vec::new(),
                ms: started.elapsed().as_millis() as u64,
            });
        }
        // A worktree of ours whose folder was removed by hand still holds the branch in git's eyes; its record is
        // dropped so the branch can be checked out again. One somebody else made is git's to refuse.
        if made_here(Path::new(&held.path), &home) {
            let _ = git(from, &GitLine::new(&["worktree", "remove"]).operands(&[&held.path]), WRITE_MS);
        }
    }
    let dir = root_for(from, &home)?.join(ask.project);
    fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    sweep_aside(&dir);
    let path = claim(&dir, &safe(ask.branch))?;
    // Layers a worktree once at this path left, removed by hand since, are nobody's now.
    drop_layers(&path);
    let to = path.to_string_lossy();
    let existing = has_branch(from, ask.branch);
    let added = if existing {
        git(from, &GitLine::new(&["worktree", "add", "--quiet"]).operands(&[&to, ask.branch]), WRITE_MS)
    } else {
        let start = fork.as_ref().map_or("HEAD", |fork| fork.start.as_str());
        git(from, &GitLine::new(&["worktree", "add", "--quiet"]).value("-b", ask.branch).operands(&[&to, start]), WRITE_MS)
    }
    .map_err(|e| format!("git worktree add: {e}"))?;
    if !added.ok() {
        let _ = fs::remove_dir_all(&path);
        return Err(added.why());
    }
    let found = found_in(&path, from, ask.modules);
    // Two makes of this project at once would each read the other's frozen copies as nobody's.
    let frozen = hold_frozen(&dir);
    let carried = carry(from, &path, &found, clone).and_then(|carried| match &fork {
        Some(fork) => lay(&path, fork).map(|()| carried),
        None => Ok(carried),
    });
    match carried {
        Ok(Carry { carried, plain, overlaid, governed, frozen: keys }) => {
            if frozen.is_ok() {
                keep_newest(&dir, &keys);
                drop_unused_frozen(&dir, &keys, false);
            }
            Ok(WorktreeReport {
                modules: found
                    .iter()
                    .enumerate()
                    .map(|(i, f)| FoundModule {
                        id: f.module.id.clone(),
                        folder: if f.folder.is_empty() { ".".to_owned() } else { f.folder.clone() },
                        rebuild: !(governed.contains(&i) && built(f, &path)),
                    })
                    .collect(),
                path: path.display().to_string(),
                branch: ask.branch.to_owned(),
                made: true,
                carried,
                plain,
                overlaid,
                fresh: true,
                ms: started.elapsed().as_millis() as u64,
            })
        }
        Err(why) => {
            drop_layers(&path);
            let tip = sha_of(&path, "HEAD");
            let _ = git(from, &GitLine::new(&["worktree", "remove", "--force"]).operands(&[&to]), WRITE_MS);
            let _ = fs::remove_dir_all(&path);
            // A branch this call made points at the folder's HEAD and holds nothing of its own, so it goes too.
            if let (false, Some(tip)) = (existing, tip) {
                let _ = git(from, &GitLine::new(&["update-ref", "-d"]).revs(&[&format!("refs/heads/{}", ask.branch), &tip]), WRITE_MS);
            }
            Err(why)
        }
    }
}

/// Where a fork from a checkpoint starts and what it lays on top.
struct Fork {
    /// The checkpoint's commit, whose tree is the fork's files.
    checkpoint: Oid,
    /// The commit the new branch starts at: the HEAD the checkpoint was taken on, else the folder's HEAD.
    start: Oid,
}

/// The checkpoint a new branch forks from, read before anything is written: a ref under the checkpoint refs naming a
/// commit, and a branch that is not there yet, since a fork never moves a branch the person has.
fn fork_point(from: &Path, branch: &str, checkpoint: &str) -> Result<Fork, String> {
    let named = checkpoint
        .strip_prefix(CHECKPOINT_REFS)
        .and_then(|rest| rest.strip_prefix('/'))
        .is_some_and(|rest| rest.split('/').all(checkpoint_id_ok));
    if !named {
        return Err(format!(
            "{checkpoint} is not a checkpoint, so no worktree was made; a fork starts from a ref under {CHECKPOINT_REFS}/"
        ));
    }
    if has_branch(from, branch) || listed(from)?.iter().any(|w| w.branch.as_deref() == Some(branch)) {
        return Err(format!(
            "the branch {branch} already exists, so no worktree was made; a fork makes a new branch, so name one that is not there yet"
        ));
    }
    let commit = |rev: &str| sha_of(from, rev).and_then(|sha| Oid::parse(&sha));
    let checkpoint_commit =
        commit(checkpoint).ok_or_else(|| format!("{checkpoint} names no commit in this folder, so no worktree was made"))?;
    let start = commit(&format!("{}^", checkpoint_commit.as_str()))
        .or_else(|| commit("HEAD"))
        .ok_or_else(|| format!("{} has no commit yet, so a fork has nowhere to start", from.display()))?;
    Ok(Fork { checkpoint: checkpoint_commit, start })
}

/// The checkpoint's tree laid over a worktree standing at the fork's start, as a restore lays one: every file the
/// start holds that the checkpoint lacks removed, then every file of the checkpoint written from an index of its own,
/// so the worktree's index stays at the start and what was uncommitted then is uncommitted again.
fn lay(at: &Path, fork: &Fork) -> Result<(), String> {
    let gone = GitLine::new(&["diff", "--name-only", "--no-renames", "--diff-filter=D", "-z"]).oid(&fork.start).oid(&fork.checkpoint);
    let gone = git(at, &gone, READ_MS).map_err(|e| format!("git diff: {e}"))?;
    if !gone.ok() {
        return Err(gone.why());
    }
    for name in gone.stdout.split('\0').filter(|name| !name.is_empty()) {
        if !downward(name) {
            return Err(format!("{name:?} is not a path inside the worktree, so the checkpoint was not laid"));
        }
        match fs::remove_file(at.join(name)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(format!("{}: {e}", at.join(name).display())),
            _ => {}
        }
    }
    let named = format!("wsp-fork-{}-{}.index", std::process::id(), now_nanos());
    let path = git(at, &GitLine::new(&["rev-parse"]).value("--git-path", &named), READ_MS).map_err(|e| format!("git rev-parse: {e}"))?;
    if !path.ok() {
        return Err(path.why());
    }
    let index = at.join(path.out());
    let index_word = index.to_string_lossy();
    let read = GitLine::new(&["read-tree"]).oid(&fork.checkpoint).env("GIT_INDEX_FILE", &index_word);
    let laid = git(at, &read, WRITE_MS).and_then(|read| {
        if !read.ok() {
            return Ok(read);
        }
        let out = GitLine::new(&["-c", "core.fsmonitor=false", "checkout-index", "-a", "-f"]).env("GIT_INDEX_FILE", &index_word);
        git(at, &out, WRITE_MS)
    });
    let _ = fs::remove_file(&index);
    let laid = laid.map_err(|e| format!("git checkout-index: {e}"))?;
    if !laid.ok() {
        return Err(laid.why());
    }
    Ok(())
}

/// The overlays of a worktree wsp made of this folder mounted again where a restart took them, before a turn or a
/// command runs there; refused for any other path.
pub fn mount(from: &Path, home: &Path, path: &Path) -> Result<(), String> {
    if !is_repo_top(from) {
        return Err(not_a_repo_top(from));
    }
    let home = fs::canonicalize(home).map_err(|e| format!("{}: {e}", home.display()))?;
    let at = resolved(path);
    if !made_here(&at, &home) || !listed(from)?.iter().skip(1).any(|w| Path::new(&w.path) == at) {
        return Err(not_ours_to_mount(path, &home));
    }
    mount_layers(&at);
    Ok(())
}

/// The worktree taken away: refused for anything but a worktree of this folder that wsp made, and for one holding
/// uncommitted files unless `force`. A detached one's commit is saved to a ref first, since no branch holds it.
pub fn remove(from: &Path, home: &Path, path: &Path, force: bool) -> Result<WorktreeRemoval, String> {
    remove_with(from, home, path, force, &|_| {})
}

/// The removal with `meanwhile` run on the worktree's folder between the set-aside and git's answer, where a test
/// puts what another verb could do in that window.
pub fn remove_with(from: &Path, home: &Path, path: &Path, force: bool, meanwhile: &dyn Fn(&Path)) -> Result<WorktreeRemoval, String> {
    if !is_repo_top(from) {
        return Err(not_a_repo_top(from));
    }
    let home = fs::canonicalize(home).map_err(|e| format!("{}: {e}", home.display()))?;
    let at = resolved(path);
    let listed = listed(from)?;
    let ours = made_here(&at, &home) && listed.iter().skip(1).any(|w| Path::new(&w.path) == at);
    if !ours {
        return Err(not_made_here(path, &home));
    }
    let beside = at.parent().unwrap_or(&at).to_path_buf();
    recover_held(&beside);
    let said = at.to_string_lossy().into_owned();
    // One mount or removal of this worktree at a time: a remount meanwhile would stack where git is about to walk.
    let _held = hold_layers(&at);
    if !at.exists() {
        let gone = git(from, &GitLine::new(&["worktree", "remove"]).operands(&[&said]), WRITE_MS)
            .map_err(|e| format!("git worktree remove: {e}"))?;
        if gone.ok() {
            drop_layers(&at);
            drop_frozen_after(&beside);
        }
        return if gone.ok() { Ok(WorktreeRemoval { path: said, rescued: None }) } else { Err(gone.why()) };
    }
    if !force {
        let status = git(&at, &GitLine::new(&["status", "--porcelain", "--untracked-files=all"]), READ_MS)
            .map_err(|e| format!("git status: {e}"))?;
        if !status.ok() {
            return Err(status.why());
        }
        let n = status.stdout.lines().filter(|l| !l.is_empty()).count();
        if n > 0 {
            return Err(uncommitted(path, n));
        }
    }
    let detached = git(&at, &GitLine::new(&["symbolic-ref", "--quiet", "HEAD"]), READ_MS).is_ok_and(|r| r.code == Some(1));
    let rescued = match (detached, sha_of(&at, "HEAD")) {
        (true, Some(sha)) => {
            let leaf = at.strip_prefix(at.parent().and_then(Path::parent).unwrap_or(&at)).unwrap_or(&at).to_string_lossy().into_owned();
            let name = format!("refs/rescue/{leaf}/{}", &sha[..12.min(sha.len())]);
            let saved =
                git(from, &GitLine::new(&["update-ref"]).revs(&[&name, &sha]), WRITE_MS).map_err(|e| format!("git update-ref: {e}"))?;
            if !saved.ok() {
                return Err(saved.why());
            }
            Some(name)
        }
        _ => None,
    };
    // An overlay's mount point cannot be renamed, and git's removal would walk into it and then forget a worktree
    // that still stands: every mount comes down first, or git is not asked.
    unmount_layers(&at);
    let left = mounts_beneath(&at);
    if !left.is_empty() {
        mount_records(&at);
        return Err(mounted_inside(path, left.len()));
    }
    let aside = set_aside_ignored(&at);
    if let Some(beside) = at.parent() {
        meanwhile(beside);
    }
    let removing = GitLine::new(&["worktree", "remove"]).words(if force { &["--force"] } else { &[] });
    let removed = git(from, &removing.operands(&[&said]), WRITE_MS);
    if !removed.as_ref().is_ok_and(|r| r.ok()) {
        for (dir, held) in &aside {
            let _ = fs::rename(held, dir);
            let _ = fs::remove_file(sidecar(held));
        }
        mount_records(&at);
        return Err(match removed {
            Ok(r) => r.why(),
            Err(e) => format!("git worktree remove: {e}"),
        });
    }
    for (_, held) in &aside {
        // Only now named for the sweep: until git agreed, a sweep must not take what may yet go back.
        let gone = held.with_file_name(held.file_name().unwrap_or_default().to_string_lossy().replacen(HOLDING_PREFIX, ASIDE_PREFIX, 1));
        let set = if fs::rename(held, &gone).is_ok() { gone } else { held.clone() };
        if remove_later(&set).is_err() {
            let _ = fs::remove_dir_all(&set);
        }
        let _ = fs::remove_file(sidecar(held));
    }
    drop_layers(&at);
    drop_frozen_after(&beside);
    Ok(WorktreeRemoval { path: said, rescued })
}

/// After a removal, under the lock, the frozen copies no worktree sits on any longer, the newest set kept as the
/// next worktree's cache.
fn drop_frozen_after(beside: &Path) {
    if let Ok(_frozen) = hold_frozen(beside) {
        drop_unused_frozen(beside, &[], false);
    }
}

/// Why a folder that is not the top of a repository has no worktrees here.
pub fn not_a_repo_top(from: &Path) -> String {
    format!("{} is not the top of a git repository; a worktree is made from the repository's top", from.display())
}

/// Why a path's overlays are not mounted again.
pub fn not_ours_to_mount(path: &Path, home: &Path) -> String {
    format!(
        "{} is not a worktree wsp made for this project, so nothing was mounted; wsp mounts only its own, under {}",
        path.display(),
        home.join("worktrees").display()
    )
}

/// Why a path is not taken away.
pub fn not_made_here(path: &Path, home: &Path) -> String {
    format!(
        "{} is not a worktree wsp made for this project, so nothing was removed; wsp removes only its own, under {}",
        path.display(),
        home.join("worktrees").display()
    )
}

/// Why a worktree with work in it stays.
pub fn uncommitted(path: &Path, n: usize) -> String {
    let files = if n == 1 { "1 file".to_owned() } else { format!("{n} files") };
    format!("{} has {files} not committed, so it was not removed; commit them, or remove it with --force", path.display())
}

/// Why a worktree with something mounted inside it that wsp did not mount stays: git's removal would walk into it.
pub fn mounted_inside(path: &Path, n: usize) -> String {
    let mounts = if n == 1 { "1 mount".to_owned() } else { format!("{n} mounts") };
    format!("{} has {mounts} inside it that wsp did not make, so it was not removed; unmount them, then remove it again", path.display())
}

/// Every worktree of the folder, the folder itself first, read from git each time and never kept.
fn listed(from: &Path) -> Result<Vec<GitWorktree>, String> {
    let read =
        git(from, &GitLine::new(&["worktree", "list", "--porcelain", "-z"]), READ_MS).map_err(|e| format!("git worktree list: {e}"))?;
    if !read.ok() {
        return Err(read.why());
    }
    Ok(worktrees_of(&read.stdout))
}

/// `git worktree list --porcelain -z` read into its worktrees, the repository's own first.
pub fn worktrees_of(out: &str) -> Vec<GitWorktree> {
    let mut all: Vec<GitWorktree> = Vec::new();
    for line in out.split('\0') {
        if let Some(path) = line.strip_prefix("worktree ") {
            all.push(GitWorktree { path: path.to_owned(), branch: None, head: None, prunable: false });
        } else if let Some(last) = all.last_mut() {
            if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                last.branch = Some(branch.to_owned());
            } else if let Some(head) = line.strip_prefix("HEAD ") {
                last.head = Some(head.to_owned());
            } else if line.starts_with("prunable") {
                last.prunable = true;
            }
        }
    }
    all
}

/// A name that is one part of a path: no separator, nothing that climbs.
fn one_part(what: &str, name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(format!("{name:?} is not a {what}: it is one folder name"));
    }
    Ok(())
}

/// A branch name git takes, and never one that reads as a flag on git's own line.
fn branch_name(from: &Path, branch: &str) -> Result<(), String> {
    let checked = git(from, &GitLine::new(&["check-ref-format"]).glued("refs/heads/", branch), READ_MS)
        .map_err(|e| format!("git check-ref-format: {e}"))?;
    if branch.starts_with('-') || !checked.ok() {
        return Err(words::not_a_branch_name(branch));
    }
    Ok(())
}

/// The branch as a folder name: every character but letters, digits, `.`, `_` and `-` read as `-`.
pub fn safe(branch: &str) -> String {
    branch.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' }).collect()
}

/// A folder of its own under `dir`, made 0700 so the name is claimed before git writes into it; a name already
/// there gets `-2`, then `-3`.
fn claim(dir: &Path, name: &str) -> Result<PathBuf, String> {
    for n in 1..1000 {
        let at = dir.join(if n == 1 { name.to_owned() } else { format!("{name}-{n}") });
        match fs::DirBuilder::new().mode(0o700).create(&at) {
            Ok(()) => return Ok(at),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", at.display())),
        }
    }
    Err(format!("{} holds a thousand worktrees named {name}", dir.display()))
}

/// Where this folder's worktrees go: under the host's folder when both are on one volume, else under the folder
/// volume's own `.wsp`, so a directory clone never has to cross volumes.
fn root_for(from: &Path, home: &Path) -> Result<PathBuf, String> {
    let device = |at: &Path| fs::metadata(at).map(|m| m.dev()).map_err(|e| format!("{}: {e}", at.display()));
    let from = fs::canonicalize(from).map_err(|e| format!("{}: {e}", from.display()))?;
    Ok(root_of(home, device(home)?, &mount_of(&from), device(&from)?))
}

/// The worktree root read off the two devices and the folder's mount, kept pure so the other-volume root has a
/// test without a second volume mounted.
fn root_of(home: &Path, home_device: u64, mount: &Path, from_device: u64) -> PathBuf {
    if home_device == from_device {
        home.join("worktrees")
    } else {
        mount.join(".wsp").join("worktrees")
    }
}

/// The highest folder above `at` on its own device, which is where that volume is mounted.
fn mount_of(at: &Path) -> PathBuf {
    let device = |p: &Path| fs::metadata(p).map(|m| m.dev()).ok();
    let mine = device(at);
    at.ancestors().take_while(|p| device(p) == mine).last().unwrap_or(at).to_path_buf()
}

/// Whether a worktree path sits where wsp makes them: `<root>/<project id>/<branch>` under either root.
fn made_here(path: &Path, home: &Path) -> bool {
    let Some(project_dir) = path.parent() else { return false };
    let Some(root) = project_dir.parent() else { return false };
    if root == home.join("worktrees") {
        return true;
    }
    let Some(mount) = root.parent().and_then(Path::parent) else { return false };
    root == mount.join(".wsp").join("worktrees") && mount_of(mount) == mount
}

/// The path with every folder above it resolved, the last part kept as typed so a worktree removed by hand is
/// still named as git lists it.
fn resolved(path: &Path) -> PathBuf {
    if let Ok(at) = fs::canonicalize(path) {
        return at;
    }
    match (path.parent().and_then(|p| fs::canonicalize(p).ok()), path.file_name()) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

/// One module whose lockfile a folder of the worktree tracks: the folder relative to the worktree, empty for its
/// top, and the lockfile's own path.
struct Found<'a> {
    module: &'a CarryModule,
    folder: String,
    lockfile: String,
}

/// Every folder of the worktree whose tracked files hold a lockfile of a module where the project folder holds one
/// of that module's directories in that folder, one row per module and folder, the top first and each folder's
/// modules in the order they were asked. A lockfile a test fixture tracks has no installed folder beside it and
/// costs no install. A module that carries nothing counts at the top whatever the folder holds, since what it builds
/// may sit outside the project (Poetry's own venv folder, `UV_PROJECT_ENVIRONMENT`, `CARGO_TARGET_DIR`).
fn found_in<'a>(at: &Path, from: &Path, modules: &'a [CarryModule]) -> Vec<Found<'a>> {
    let installed = |module: &CarryModule, folder: &str| {
        let is_dir = |name: &String| fs::symlink_metadata(from.join(folder).join(name)).is_ok_and(|m| m.is_dir());
        (folder.is_empty() && module.carry.is_empty()) || module.carry.iter().chain(&module.never).any(is_dir)
    };
    let Ok(listed) = git(at, &GitLine::new(&["ls-files", "-z"]), READ_MS) else { return Vec::new() };
    if !listed.ok() {
        return Vec::new();
    }
    let mut found: Vec<Found> = Vec::new();
    for file in listed.stdout.split('\0').filter(|f| !f.is_empty()) {
        let (folder, name) = file.rsplit_once('/').unwrap_or(("", file));
        for module in modules.iter().filter(|m| m.lockfiles.iter().any(|l| l == name)) {
            if found.iter().any(|f| f.module.id == module.id && f.folder == folder)
                || !is_file(&at.join(file))
                || !installed(module, folder)
            {
                continue;
            }
            found.push(Found { module, folder: folder.to_owned(), lockfile: file.to_owned() });
        }
    }
    found.sort_by_key(|f| (f.folder.clone(), modules.iter().position(|m| m.id == f.module.id)));
    found
}

/// Whether a folder of the worktree holds a path in it, the top holding every one.
fn holds(folder: &str, path: &str) -> bool {
    folder.is_empty() || path.strip_prefix(folder).is_some_and(|rest| rest.starts_with('/'))
}

/// Whether a directory is the one a carried name names: the name itself, or the name under any folder.
fn named(dir: &str, name: &str) -> bool {
    dir == name || dir.strip_suffix(name).is_some_and(|rest| rest.ends_with('/'))
}

/// The row that carries a directory: of the folders holding it, the nearest whose module carries its name, unless
/// a module found in any of them never carries it.
fn governing(found: &[Found], dir: &str) -> Option<usize> {
    let over: Vec<(usize, &Found)> = found.iter().enumerate().filter(|(_, f)| holds(&f.folder, dir)).collect();
    if over.iter().any(|(_, f)| f.module.never.iter().any(|n| named(dir, n))) {
        return None;
    }
    over.into_iter().filter(|(_, f)| f.module.carry.iter().any(|n| named(dir, n))).max_by_key(|(_, f)| f.folder.len()).map(|(i, _)| i)
}

/// What one carry put in the worktree, relative to it: every file and directory, the directories a clone could not
/// take and the ones mounted as an overlay, the rows that carried a directory, and the frozen copies the overlays sit on.
struct Carry {
    carried: Vec<String>,
    plain: Vec<String>,
    overlaid: Vec<String>,
    governed: Vec<usize>,
    frozen: Vec<String>,
}

/// The config files and the ignored directories each found module carries, from the folder into the worktree.
fn carry(from: &Path, to: &Path, found: &[Found], clone: CloneDir) -> Result<Carry, String> {
    let listing = ignored(from);
    let mut done = Carry { carried: Vec::new(), plain: Vec::new(), overlaid: Vec::new(), governed: Vec::new(), frozen: Vec::new() };
    for file in config_files_in(from, &listing) {
        let target = to.join(&file);
        // The branch may track a file the folder ignores; the branch's own copy stands.
        if fs::symlink_metadata(&target).is_ok() || !inside(to, &target) {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::copy(from.join(&file), &target).map_err(|e| format!("{}: {e}", target.display()))?;
        done.carried.push(file);
    }
    let beside = to.parent().unwrap_or(to);
    for (n, dir) in listing.iter().filter_map(|p| p.strip_suffix('/')).enumerate() {
        let Some(by) = governing(found, dir) else { continue };
        let (source, target) = (from.join(dir), to.join(dir));
        if !fs::symlink_metadata(&source).is_ok_and(|m| m.is_dir()) || fs::symlink_metadata(&target).is_ok() || !inside(to, &target) {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let key = frozen_key(from, dir, &found[by]);
        let layer = Layer {
            worktree: to.to_path_buf(),
            at: dir.to_owned(),
            beside: beside.to_path_buf(),
            dir: format!("{}/{n}", layers_name(to)),
            frozen: key.clone(),
        };
        match clone(&source, &layer) {
            Ok(Took::Clone) => {}
            Ok(Took::Overlay) => {
                if let Err(e) = write_records(&layer) {
                    unmount_at(to, dir);
                    return Err(format!("{}: {e}", beside.join(&layer.dir).display()));
                }
                done.overlaid.push(dir.to_owned());
                done.frozen.push(key);
            }
            Err(_) => {
                let _ = fs::remove_dir_all(beside.join(&layer.dir));
                let _ = fs::remove_dir_all(&target);
                copy_plain(&source, &target).map_err(|e| format!("{}: {e}", target.display()))?;
                done.plain.push(dir.to_owned());
            }
        }
        done.carried.push(dir.to_owned());
        done.governed.push(by);
    }
    Ok(done)
}

/// Whether a path under the worktree stays in it: the branch can track a link where the folder has a directory,
/// and nothing is carried through one to wherever it points.
fn inside(to: &Path, target: &Path) -> bool {
    let Ok(root) = fs::canonicalize(to) else { return false };
    target.ancestors().skip(1).find_map(|p| fs::canonicalize(p).ok()).is_some_and(|p| p.starts_with(root))
}

/// Whether a module's directories came in already installed for the branch: the record its install leaves of the
/// lockfile it installed from is, byte for byte, the lockfile the branch holds in that folder. A module whose
/// install leaves no such record is never taken as installed.
fn built(found: &Found, to: &Path) -> bool {
    let Some(record) = &found.module.installed else { return false };
    matches!((capped(&to.join(&found.folder).join(record)), capped(&to.join(&found.lockfile))), (Some(x), Some(y)) if x == y)
}

/// A regular file's bytes, read with no link followed at its name, never waiting on a FIFO and never past a
/// lockfile's size; anything but a regular file is never read.
fn capped(at: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    const LOCKFILE_MAX: u64 = 64 << 20;
    let file = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(at).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > LOCKFILE_MAX {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(LOCKFILE_MAX + 1).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// A path a record beside a worktree wrote that only goes down into it: relative, every part a name.
fn downward(rel: &str) -> bool {
    !rel.is_empty() && !rel.starts_with('/') && !rel.split('/').any(|part| part == ".." || part == "." || part.is_empty())
}

/// A regular file at that path, no link followed.
fn is_file(at: &Path) -> bool {
    fs::symlink_metadata(at).is_ok_and(|m| m.is_file())
}

/// One `clonefile(2)` of a whole directory: the files share their blocks with the folder's until either side
/// writes, and the call costs one directory rather than one call per file.
#[cfg(target_os = "macos")]
fn clone_dir(from: &Path, layer: &Layer) -> io::Result<Took> {
    use std::os::unix::ffi::OsStrExt;
    let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e));
    let (source, target) = (c(from)?, c(&layer.worktree.join(&layer.at))?);
    // SAFETY: both paths are nul-terminated; the call writes nothing this process owns.
    if unsafe { libc::clonefile(source.as_ptr(), target.as_ptr(), 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Took::Clone)
}

/// Linux has no directory clone: a disk that shares blocks takes a reflink copy of every file, and any other disk an
/// overlay whose lower layer is a frozen copy of the folder's directory, made once per lockfile and never written
/// again, so a reinstall in the folder reaches no worktree. A plain copy of 863 MB of node_modules took 47 s on
/// ext4; every worktree after the first of a lockfile costs one mount.
#[cfg(target_os = "linux")]
fn clone_dir(from: &Path, layer: &Layer) -> io::Result<Took> {
    clone_linux(from, layer, may_mount)
}

/// The Linux road with whether this login may mount handed in. One the kernel lets mount nothing takes the plain
/// copy at once, so a refused mount never costs a frozen copy on top of it.
#[cfg(target_os = "linux")]
fn clone_linux(from: &Path, layer: &Layer, may: fn(&Path) -> bool) -> io::Result<Took> {
    if crate::copy_reflink::clones_into(from, &layer.beside) {
        crate::copy::copy_tree(from, &layer.worktree.join(&layer.at), crate::copy_reflink::clone_file)?;
        return Ok(Took::Clone);
    }
    if !may(&layer.beside) {
        return Err(io::Error::from_raw_os_error(libc::EPERM));
    }
    freeze(from, &layer.beside, &layer.frozen)?;
    overlay(&layer.beside, &frozen_name(&layer.frozen), &layer.worktree, &layer.at, &layer.dir)?;
    Ok(Took::Overlay)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn clone_dir(_from: &Path, _layer: &Layer) -> io::Result<Took> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// Whether this process may mount an overlay on the disk of `beside`, asked once of the kernel with one overlay of
/// empty folders and kept for the process: a verb's process makes one worktree, and the answer moves with the login
/// the daemon runs as, which a cached file would not see.
#[cfg(target_os = "linux")]
fn may_mount(beside: &Path) -> bool {
    static MAY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *MAY.get_or_init(|| {
        use std::os::fd::AsFd;
        let probe = beside.join(format!("{ASIDE_PREFIX}probe-{}-{}", std::process::id(), now_nanos()));
        let mounted = (|| -> io::Result<()> {
            let mut open = Vec::new();
            for name in ["lower", "upper", "work", "point"] {
                fs::DirBuilder::new().recursive(true).mode(0o700).create(probe.join(name))?;
                open.push(fs::File::open(probe.join(name))?);
            }
            let fd = |n: usize| crate::bundle::by_fd(open[n].as_fd()).display().to_string();
            let options = format!("lowerdir={},upperdir={},workdir={}", fd(0), fd(1), fd(2));
            nix::mount::mount(
                Some("overlay"),
                &crate::bundle::by_fd(open[3].as_fd()),
                Some("overlay"),
                nix::mount::MsFlags::empty(),
                Some(options.as_str()),
            )?;
            nix::mount::umount2(&probe.join("point"), nix::mount::MntFlags::MNT_DETACH)?;
            Ok(())
        })();
        let _ = fs::remove_dir_all(&probe);
        mounted.is_ok()
    })
}

/// The folder beside a project's worktrees that holds the frozen copies their overlays sit on, one per carried
/// directory and lockfile, named by `frozen_key`; a copy being made is named with `MAKING_PREFIX` until it is whole.
/// `NEWEST` in it names the copies the newest make sat on, kept as the cache the next worktree reuses.
const FROZEN: &str = ".wsp-frozen";
const MAKING_PREFIX: &str = ".making-";
const NEWEST: &str = ".newest";

/// A frozen copy's path under the folder of a project's worktrees.
fn frozen_name(key: &str) -> String {
    format!("{FROZEN}/{key}")
}

/// The name of the frozen copy of one directory of the folder: its path and what says which install it holds. That
/// is the record the folder's install left where the module names one, so a pull that brings a lockfile nobody
/// installed makes no second copy of the same bytes, and the folder's lockfile otherwise.
fn frozen_key(from: &Path, dir: &str, by: &Found) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(dir.as_bytes());
    hash.update([0]);
    match by.module.installed.as_ref().and_then(|record| capped(&from.join(&by.folder).join(record))) {
        Some(record) => {
            hash.update(b"installed\0");
            hash.update(record);
        }
        None => hash.update(capped(&from.join(&by.lockfile)).unwrap_or_default()),
    }
    hash.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// The frozen copies of this project's worktrees held for one make or removal: an exclusive lock on their folder,
/// opened with no link followed, let go when the file is dropped.
fn hold_frozen(beside: &Path) -> io::Result<fs::File> {
    lock(&dir_beneath(beside, FROZEN, true)?)
}

/// An exclusive lock on an open folder, on a descriptor of its own that `flock` takes.
#[cfg(target_os = "linux")]
fn lock(dir: &std::os::fd::OwnedFd) -> io::Result<fs::File> {
    use std::os::fd::{AsFd, AsRawFd};
    let held = fs::File::open(crate::bundle::by_fd(dir.as_fd()))?;
    // SAFETY: the descriptor is the open folder's own, alive for the call.
    if unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(held)
}

#[cfg(not(target_os = "linux"))]
fn lock(_dir: &std::os::fd::OwnedFd) -> io::Result<fs::File> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// The folder at `rel` under `beside`, opened with no link followed anywhere on its way and, with `make`, each part
/// made 0700 where it is missing.
#[cfg(target_os = "linux")]
fn dir_beneath(beside: &Path, rel: &str, make: bool) -> io::Result<std::os::fd::OwnedFd> {
    let mut at = String::new();
    for part in rel.split('/') {
        if make {
            let above = crate::engine::open_beneath(beside, if at.is_empty() { "." } else { &at })?;
            match nix::sys::stat::mkdirat(&above, part, nix::sys::stat::Mode::from_bits_truncate(0o700)) {
                Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                Err(e) => return Err(e.into()),
            }
        }
        if !at.is_empty() {
            at.push('/');
        }
        at.push_str(part);
    }
    let dir = crate::engine::open_beneath(beside, &at)?;
    is_dir(&dir)?;
    Ok(dir)
}

#[cfg(not(target_os = "linux"))]
fn dir_beneath(_beside: &Path, _rel: &str, _make: bool) -> io::Result<std::os::fd::OwnedFd> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// An open folder as a path the kernel resolves to it.
#[cfg(target_os = "linux")]
fn fd_path(fd: &std::os::fd::OwnedFd) -> PathBuf {
    use std::os::fd::AsFd;
    crate::bundle::by_fd(fd.as_fd())
}

#[cfg(not(target_os = "linux"))]
fn fd_path(_fd: &std::os::fd::OwnedFd) -> PathBuf {
    PathBuf::new()
}

#[cfg(target_os = "linux")]
fn is_dir(fd: &std::os::fd::OwnedFd) -> io::Result<()> {
    if nix::sys::stat::fstat(fd)?.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a directory"));
    }
    Ok(())
}

/// One record file of an open layer folder, read only where it is a regular file.
#[cfg(target_os = "linux")]
fn record(layer: &std::os::fd::OwnedFd, name: &str) -> Option<String> {
    use std::os::fd::AsFd;
    capped(&crate::bundle::by_fd(layer.as_fd()).join(name)).and_then(|bytes| String::from_utf8(bytes).ok())
}

/// A frozen copy of the folder's directory named `key` in the frozen folder beside the worktrees, made whole under
/// another name and renamed in, unless one is there.
#[cfg(target_os = "linux")]
fn freeze(source: &Path, beside: &Path, key: &str) -> io::Result<()> {
    use crate::copy::Copier;
    use std::os::fd::AsFd;
    let root = dir_beneath(beside, FROZEN, true)?;
    let at = crate::bundle::by_fd(root.as_fd());
    if fs::symlink_metadata(at.join(key)).is_ok_and(|m| m.is_dir()) {
        return Ok(());
    }
    let making = at.join(format!("{MAKING_PREFIX}{}-{}", std::process::id(), now_nanos()));
    crate::copy_plain::Plain.copy(source, &making)?;
    fs::rename(&making, at.join(key)).inspect_err(|_| {
        let _ = crate::copy::remove_tree(&making);
    })
}

/// Under the lock, every frozen copy no worktree's overlay sits on sent on its way out, but those in `keep` and the
/// set the newest make sat on; and every copy a killed make left half made. With the project `going` the newest set
/// goes too, removed here and now, since no turn waits on it and its folder goes after it.
#[cfg(target_os = "linux")]
fn drop_unused_frozen(beside: &Path, keep: &[String], going: bool) {
    let Ok(root) = dir_beneath(beside, FROZEN, false) else { return };
    let at = fd_path(&root);
    let newest: Vec<String> = if going {
        Vec::new()
    } else {
        capped(&at.join(NEWEST)).and_then(|b| String::from_utf8(b).ok()).map(|s| s.lines().map(str::to_owned).collect()).unwrap_or_default()
    };
    let used: Vec<String> = fs::read_dir(beside)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix(LAYERS_PREFIX).map(|leaf| beside.join(leaf)))
        .flat_map(|worktree| layer_records(&worktree))
        .map(|r| r.lower)
        .collect();
    let Ok(entries) = fs::read_dir(&at) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == NEWEST || !name.starts_with(MAKING_PREFIX) && (keep.contains(&name) || used.contains(&name) || newest.contains(&name)) {
            continue;
        }
        if going {
            let _ = crate::copy::remove_tree(&at.join(&name));
            continue;
        }
        let gone = beside.join(format!("{ASIDE_PREFIX}frozen-{name}-{}", now_nanos()));
        let set = if fs::rename(at.join(&name), &gone).is_ok() { gone } else { at.join(&name) };
        if remove_later(&set).is_err() {
            let _ = fs::remove_dir_all(&set);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn drop_unused_frozen(_beside: &Path, _keep: &[String], _going: bool) {}

/// The copies this make's overlays sat on written down as the newest set, which stays as the next worktree's cache
/// once no worktree sits on it; a make that overlaid nothing leaves the set before it standing.
fn keep_newest(beside: &Path, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let Ok(root) = dir_beneath(beside, FROZEN, false) else { return };
    let at = fd_path(&root);
    let making = at.join(format!("{MAKING_PREFIX}newest-{}", std::process::id()));
    if fs::write(&making, keys.join("\n")).and_then(|()| fs::rename(&making, at.join(NEWEST))).is_err() {
        let _ = fs::remove_file(&making);
    }
}

/// Every frozen copy of a project's worktrees taken away, the project going: what a worktree still sits on stays,
/// and the folders go once nothing is left in them. A folder already gone has no volume to read, so its worktrees
/// are looked for under the host's folder.
pub fn forget(from: &Path, home: &Path, project: &str) -> Result<(), String> {
    let gone = fs::symlink_metadata(from).is_err_and(|e| e.kind() == io::ErrorKind::NotFound);
    if !gone && !is_repo_top(from) {
        return Err(not_a_repo_top(from));
    }
    one_part("project id", project)?;
    let home = fs::canonicalize(home).map_err(|e| format!("{}: {e}", home.display()))?;
    let root = if gone { home.join("worktrees") } else { root_for(from, &home)? };
    let beside = root.join(project);
    if fs::symlink_metadata(&beside).is_err() {
        return Ok(());
    }
    if fs::symlink_metadata(beside.join(FROZEN)).is_ok() {
        let held = hold_frozen(&beside).map_err(|e| format!("{}: {e}", beside.join(FROZEN).display()))?;
        drop_unused_frozen(&beside, &[], true);
        let _ = fs::remove_file(beside.join(FROZEN).join(NEWEST));
        drop(held);
        let _ = fs::remove_dir(beside.join(FROZEN));
    }
    let _ = fs::remove_dir(&beside);
    Ok(())
}

/// The folder beside a worktree that holds the upper and work directories of its overlays, one numbered folder per
/// mount with the mount's path inside the worktree and the name of the frozen copy under it written in it.
const LAYERS_PREFIX: &str = ".wsp-layers-";
#[cfg(target_os = "linux")]
const LAYER_AT: &str = "at";
#[cfg(target_os = "linux")]
const LAYER_LOWER: &str = "lower";

fn layers_name(worktree: &Path) -> String {
    format!("{LAYERS_PREFIX}{}", worktree.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

fn layers_of(worktree: &Path) -> PathBuf {
    worktree.with_file_name(layers_name(worktree))
}

/// One overlay a worktree's layers record: its mount point inside the worktree, which only goes down into it, its
/// layer folder under the folder of the project's worktrees, and the name of the frozen copy it sits on.
struct Record {
    at: String,
    layer: String,
    lower: String,
}

/// Every overlay the worktree's layers record, each layer folder opened with no link followed and each record read
/// only where it is a regular file.
#[cfg(target_os = "linux")]
fn layer_records(worktree: &Path) -> Vec<Record> {
    use std::os::fd::AsFd;
    let (Some(beside), name) = (worktree.parent(), layers_name(worktree)) else { return Vec::new() };
    let Ok(dir) = dir_beneath(beside, &name, false) else { return Vec::new() };
    let Ok(entries) = fs::read_dir(crate::bundle::by_fd(dir.as_fd())) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let layer = format!("{name}/{}", e.file_name().to_str()?);
            let open = dir_beneath(beside, &layer, false).ok()?;
            let at = record(&open, LAYER_AT).filter(|rel| downward(rel))?;
            let lower = record(&open, LAYER_LOWER).filter(|key| one_part("frozen copy", key).is_ok())?;
            Some(Record { at, layer, lower })
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn layer_records(_worktree: &Path) -> Vec<Record> {
    Vec::new()
}

/// The two records of a layer written into its new folder, opened with no link followed, neither written over.
#[cfg(target_os = "linux")]
fn write_records(layer: &Layer) -> io::Result<()> {
    use std::io::Write;
    use std::os::fd::AsFd;
    let dir = dir_beneath(&layer.beside, &layer.dir, false)?;
    for (name, text) in [(LAYER_AT, layer.at.as_str()), (LAYER_LOWER, layer.frozen.as_str())] {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(crate::bundle::by_fd(dir.as_fd()).join(name))?
            .write_all(text.as_bytes())?;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn write_records(_layer: &Layer) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// The worktree's layers held for one mount or removal at a time, so two remounts never stack a second overlay on
/// one upper; nothing to hold where the worktree has no layers.
fn hold_layers(worktree: &Path) -> Option<fs::File> {
    lock(&dir_beneath(worktree.parent()?, &layers_name(worktree), false).ok()?).ok()
}

/// The worktree's overlays mounted again where a restart took them, one remount at a time.
fn mount_layers(worktree: &Path) {
    let Some(_held) = hold_layers(worktree) else { return };
    mount_records(worktree);
}

/// Under the hold, each overlay mounted again over its own frozen copy with the upper layer that holds what was
/// written through it. One already mounted is left as it is, one whose frozen copy is gone stays down, and one whose
/// directory holds anything now, written there while it was down, is left as it stands rather than hidden.
fn mount_records(worktree: &Path) {
    let Some(beside) = worktree.parent() else { return };
    for r in layer_records(worktree) {
        match overlay(beside, &frozen_name(&r.lower), worktree, &r.at, &r.layer) {
            Ok(()) => {}
            Err(e) if matches!(e.kind(), io::ErrorKind::AlreadyExists | io::ErrorKind::NotFound) => {}
            Err(e) => eprintln!("{}: {e}", worktree.join(&r.at).display()),
        }
    }
}

/// Every overlay of the worktree taken down, detached so a process still reading one does not hold the removal.
fn unmount_layers(worktree: &Path) {
    for r in layer_records(worktree) {
        unmount_at(worktree, &r.at);
    }
}

/// The worktree's overlays taken down and their layers sent on their way out.
fn drop_layers(worktree: &Path) {
    let layers = layers_of(worktree);
    if fs::symlink_metadata(&layers).is_err() {
        return;
    }
    unmount_layers(worktree);
    let leaf = layers.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let gone = layers.with_file_name(format!("{ASIDE_PREFIX}{leaf}-{}", now_nanos()));
    let set = if fs::rename(&layers, &gone).is_ok() { gone } else { layers };
    if remove_later(&set).is_err() {
        let _ = fs::remove_dir_all(&set);
    }
}

/// Every mount the kernel lists at the worktree or under it, as `/proc/self/mountinfo` names them.
#[cfg(target_os = "linux")]
fn mounts_beneath(worktree: &Path) -> Vec<String> {
    let root = worktree.display().to_string();
    let listed = fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
    listed
        .lines()
        .filter_map(|l| l.split(' ').nth(4))
        .map(unescaped)
        .filter(|p| *p == root || p.strip_prefix(&root).is_some_and(|rest| rest.starts_with('/')))
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn mounts_beneath(_worktree: &Path) -> Vec<String> {
    Vec::new()
}

/// A mount point as mountinfo writes it, its space, tab, newline and backslash written as three octal digits.
#[cfg(target_os = "linux")]
fn unescaped(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let octal = bytes.get(i + 1..i + 4).and_then(|d| std::str::from_utf8(d).ok()).and_then(|d| u8::from_str_radix(d, 8).ok());
        match (bytes[i], octal) {
            (b'\\', Some(byte)) => {
                out.push(byte);
                i += 4;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// An overlay at `rel` inside the worktree whose lower layer is `lower` and whose upper and work directories sit in
/// `layer`, both named under `beside`, the folder of the project's worktrees; the top of it reads with the mode and
/// owner of the lower's top, which is the folder's directory's. Every folder the kernel is handed is opened with no
/// link followed anywhere on its way and named to it by its descriptor, never by a path read again; the mount point
/// is made where it is missing. Refused with `AlreadyExists` where something is mounted there or it holds anything,
/// with `NotFound` where the frozen copy is gone, and wherever the kernel refuses the mount, a login that is not
/// root included; the carry then copies every byte.
#[cfg(target_os = "linux")]
fn overlay(beside: &Path, lower: &str, worktree: &Path, rel: &str, layer: &str) -> io::Result<()> {
    use std::os::fd::AsFd;
    let below = dir_beneath(beside, lower, false)?;
    dir_beneath(beside, layer, true)?;
    let upper = match dir_beneath(beside, &format!("{layer}/upper"), false) {
        Ok(fd) => fd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let fd = dir_beneath(beside, &format!("{layer}/upper"), true)?;
            let like = nix::sys::stat::fstat(&below)?;
            let top = crate::bundle::by_fd(fd.as_fd());
            fs::set_permissions(&top, std::os::unix::fs::PermissionsExt::from_mode(like.st_mode & 0o7777))?;
            std::os::unix::fs::chown(&top, Some(like.st_uid), Some(like.st_gid))?;
            fd
        }
        Err(e) => return Err(e),
    };
    let work = dir_beneath(beside, &format!("{layer}/work"), true)?;
    let point = mount_point(worktree, rel)?;
    let named = |fd: &std::os::fd::OwnedFd| crate::bundle::by_fd(fd.as_fd()).display().to_string();
    let options = format!("lowerdir={},upperdir={},workdir={}", named(&below), named(&upper), named(&work));
    let onto = crate::bundle::by_fd(point.as_fd());
    nix::mount::mount(Some("overlay"), &onto, Some("overlay"), nix::mount::MsFlags::empty(), Some(options.as_str()))
        .map_err(io::Error::from)
}

#[cfg(not(target_os = "linux"))]
fn overlay(_beside: &Path, _lower: &str, _worktree: &Path, _rel: &str, _layer: &str) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// The empty directory at `rel` inside the worktree, made where it is missing, opened beneath the worktree with no
/// link followed on the way or at its name: a link anywhere there is an agent's, and the daemon is root.
#[cfg(target_os = "linux")]
fn mount_point(worktree: &Path, rel: &str) -> io::Result<std::os::fd::OwnedFd> {
    use std::os::fd::AsFd;
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let above = crate::engine::open_beneath(worktree, parent)?;
    match nix::sys::stat::mkdirat(&above, name, nix::sys::stat::Mode::from_bits_truncate(0o700)) {
        Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
        Err(e) => return Err(e.into()),
    }
    let point = crate::engine::open_beneath(worktree, rel)?;
    let (top, here) = (fs::metadata(worktree)?, nix::sys::stat::fstat(&point)?);
    if here.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a directory"));
    }
    if here.st_dev != top.dev() || fs::read_dir(crate::bundle::by_fd(point.as_fd()))?.next().is_some() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "mounted already or not empty"));
    }
    Ok(point)
}

/// Every mount at `rel` inside the worktree detached, a stack of them included, its folder opened beneath the
/// worktree with no link followed and the name itself never followed: a link put where a mount point was takes
/// nothing down where it leads. Nothing mounted there is what was asked for.
#[cfg(target_os = "linux")]
fn unmount_at(worktree: &Path, rel: &str) {
    use std::os::fd::AsFd;
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    let Ok(above) = crate::engine::open_beneath(worktree, parent) else { return };
    let at = crate::bundle::by_fd(above.as_fd()).join(name);
    for _ in 0..16 {
        match nix::mount::umount2(&at, nix::mount::MntFlags::MNT_DETACH | nix::mount::MntFlags::UMOUNT_NOFOLLOW) {
            Ok(()) => continue,
            Err(nix::errno::Errno::EINVAL) | Err(nix::errno::Errno::ENOENT) => {}
            Err(e) => eprintln!("{}: {e}", worktree.join(rel).display()),
        }
        return;
    }
}

#[cfg(not(target_os = "linux"))]
fn unmount_at(_worktree: &Path, _rel: &str) {}

/// Every byte of a directory written again, links kept as links; nothing of `to` is left where it fails.
fn copy_plain(from: &Path, to: &Path) -> io::Result<()> {
    let made = copy_into(from, to);
    if made.is_err() {
        let _ = fs::remove_dir_all(to);
    }
    made
}

fn copy_into(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let (source, target) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(&source)?, &target)?;
        } else if kind.is_dir() {
            copy_into(&source, &target)?;
        } else if kind.is_file() {
            fs::copy(&source, &target)?;
        }
    }
    fs::set_permissions(to, fs::metadata(from)?.permissions())
}

/// What a removal's ignored directories are held under beside the worktree until git answers: a name the sweep
/// does not take, so a make running meanwhile cannot delete what a refusal puts back.
const HOLDING_PREFIX: &str = ".wsp-holding-";

/// Beside each held directory, a file of this name's suffix holding the path inside the worktree it came from, so a
/// hold whose removal was killed can be put back.
const FROM_SUFFIX: &str = ".from";

/// The worktree's ignored directories renamed out beside it, each with where it came from, so git's removal walks
/// the tracked files alone and answers in the time those take; they go back if git refuses.
fn set_aside_ignored(at: &Path) -> Vec<(PathBuf, PathBuf)> {
    hold_as(at, std::process::id(), now_nanos())
}

/// The hold, named for the process and the moment it was taken: `<prefix><leaf>-<pid>-<nanos>-<n>`.
fn hold_as(at: &Path, pid: u32, nanos: u128) -> Vec<(PathBuf, PathBuf)> {
    let Some(beside) = at.parent() else { return Vec::new() };
    let leaf = at.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut set = Vec::new();
    for (i, dir) in ignored(at).iter().filter_map(|p| p.strip_suffix('/')).enumerate() {
        let held = beside.join(format!("{HOLDING_PREFIX}{leaf}-{pid}-{nanos}-{i}"));
        if fs::write(sidecar(&held), dir).is_err() {
            continue;
        }
        if fs::rename(at.join(dir), &held).is_ok() {
            set.push((at.join(dir), held));
        } else {
            let _ = fs::remove_file(sidecar(&held));
        }
    }
    set
}

fn sidecar(held: &Path) -> PathBuf {
    held.with_file_name(format!("{}{FROM_SUFFIX}", held.file_name().unwrap_or_default().to_string_lossy()))
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default()
}

/// The holds a removal killed before git answered left in this folder: put back into their worktree where it still
/// stands and nothing has taken the path, else sent on their way out. A hold whose process lives, or younger than a
/// git write may take, may still be in flight and stays.
fn recover_held(beside: &Path) {
    let Ok(entries) = fs::read_dir(beside) else { return };
    let now = now_nanos();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(HOLDING_PREFIX) else { continue };
        let (rest, sidecar_only) = match rest.strip_suffix(FROM_SUFFIX) {
            Some(base) => (base, true),
            None => (rest, false),
        };
        let Some((leaf, pid, nanos)) = held_parts(rest) else { continue };
        if alive(pid) || now.saturating_sub(nanos) < u128::from(WRITE_MS) * 1_000_000 {
            continue;
        }
        let held = beside.join(format!("{HOLDING_PREFIX}{rest}"));
        if sidecar_only {
            if fs::symlink_metadata(&held).is_err() {
                let _ = fs::remove_file(entry.path());
            }
            continue;
        }
        if !fs::symlink_metadata(&held).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let worktree = beside.join(leaf);
        let back = fs::read_to_string(sidecar(&held)).ok().filter(|rel| downward(rel)).map(|rel| worktree.join(rel)).filter(|to| {
            worktree.is_dir() && fs::symlink_metadata(to).is_err() && to.parent().is_some_and(Path::is_dir) && inside(&worktree, to)
        });
        let restored = back.is_some_and(|to| fs::rename(&held, to).is_ok());
        if !restored {
            let gone = beside.join(format!("{ASIDE_PREFIX}{rest}"));
            let set = if fs::rename(&held, &gone).is_ok() { gone } else { held.clone() };
            if remove_later(&set).is_err() {
                let _ = fs::remove_dir_all(&set);
            }
        }
        let _ = fs::remove_file(sidecar(&held));
    }
}

/// `<leaf>-<pid>-<nanos>-<n>` read back into its leaf, pid and moment.
fn held_parts(rest: &str) -> Option<(&str, u32, u128)> {
    let mut parts = rest.rsplitn(4, '-');
    parts.next()?.parse::<u32>().ok()?;
    let nanos = parts.next()?.parse().ok()?;
    let pid = parts.next()?.parse().ok()?;
    Some((parts.next().filter(|leaf| !leaf.is_empty())?, pid, nanos))
}

/// Whether a process of this id is running, a process this login may not signal counted as running.
fn alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return false };
    // SAFETY: signal 0 delivers nothing; it asks only whether the process is there.
    pid > 0 && (unsafe { libc::kill(pid, 0) } == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

/// The holds a killed removal left and the removals a stop cut short in this project's worktree folder.
fn sweep_aside(dir: &Path) {
    recover_held(dir);
    for failed in sweep([dir], remove_later) {
        eprintln!("{failed}");
    }
}

#[cfg(test)]
#[path = "../../tests/copy_branch/mod.rs"]
mod tests;
