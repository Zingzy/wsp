// SPDX-License-Identifier: AGPL-3.0-only
//! A thread on another branch than the project folder's works in a git worktree the host keeps under its own
//! folder: one per branch, the folder's config files and dependency directories carried in by one directory clone
//! each, and taken away only with nothing in it uncommitted. A branch some worktree already holds is answered with
//! that worktree, since git checks a branch out in one place; nothing here resets a branch the person has, so an
//! existing branch is checked out as it stands and only a new one starts at the folder's HEAD.

use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::Instant;

use wsp_frames::{words, GitWorktree, WorktreeRemoval, WorktreeReport};

use super::aside::{remove_later, sweep, ASIDE_PREFIX};
use super::rules::{config_files_in, git, has_branch, ignored, is_repo_top, sha_of, READ_MS, WRITE_MS};

/// One worktree as the verb is asked for it.
pub struct Ask<'a> {
    /// The top of the project's repository.
    pub from: &'a Path,
    /// The host's own folder, whose `worktrees` folder holds the worktrees of projects on its volume.
    pub home: &'a Path,
    /// The project's id, which names the folder its worktrees sit in.
    pub project: &'a str,
    pub branch: &'a str,
    /// The names of the ignored directories carried in, wherever in the folder they sit.
    pub carry: &'a [String],
}

/// How one directory is cloned: `clonefile(2)` on a Mac, handed in so a test can count the calls or fail them.
pub type CloneDir = fn(&Path, &Path) -> io::Result<()>;

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
    for name in ask.carry {
        one_part("carried directory name", name)?;
    }
    branch_name(from, ask.branch)?;
    let home = fs::canonicalize(ask.home).map_err(|e| format!("{}: {e}", ask.home.display()))?;
    let held = listed(from)?.into_iter().find(|w| w.branch.as_deref() == Some(ask.branch));
    if let Some(held) = held {
        if !held.prunable {
            return Ok(WorktreeReport {
                made: made_here(Path::new(&held.path), &home),
                path: held.path,
                branch: ask.branch.to_owned(),
                carried: Vec::new(),
                plain: Vec::new(),
                ms: started.elapsed().as_millis() as u64,
            });
        }
        // A worktree of ours whose folder was removed by hand still holds the branch in git's eyes; its record is
        // dropped so the branch can be checked out again. One somebody else made is git's to refuse.
        if made_here(Path::new(&held.path), &home) {
            let _ = git(from, &["worktree", "remove", &held.path], WRITE_MS);
        }
    }
    let dir = root_for(from, &home)?.join(ask.project);
    fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    sweep_aside(&dir);
    let path = claim(&dir, &safe(ask.branch))?;
    let to = path.to_string_lossy();
    let existing = has_branch(from, ask.branch);
    let added = if existing {
        git(from, &["worktree", "add", "--quiet", &to, ask.branch], WRITE_MS)
    } else {
        git(from, &["worktree", "add", "--quiet", "-b", ask.branch, &to, "HEAD"], WRITE_MS)
    }
    .map_err(|e| format!("git worktree add: {e}"))?;
    if !added.ok() {
        let _ = fs::remove_dir_all(&path);
        return Err(added.why());
    }
    match carry(from, &path, ask.carry, clone) {
        Ok((carried, plain)) => Ok(WorktreeReport {
            path: path.display().to_string(),
            branch: ask.branch.to_owned(),
            made: true,
            carried,
            plain,
            ms: started.elapsed().as_millis() as u64,
        }),
        Err(why) => {
            let tip = sha_of(&path, "HEAD");
            let _ = git(from, &["worktree", "remove", "--force", &to], WRITE_MS);
            let _ = fs::remove_dir_all(&path);
            // A branch this call made points at the folder's HEAD and holds nothing of its own, so it goes too.
            if let (false, Some(tip)) = (existing, tip) {
                let _ = git(from, &["update-ref", "-d", &format!("refs/heads/{}", ask.branch), &tip], WRITE_MS);
            }
            Err(why)
        }
    }
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
    if let Some(beside) = at.parent() {
        recover_held(beside);
    }
    let said = at.to_string_lossy().into_owned();
    if !at.exists() {
        let gone = git(from, &["worktree", "remove", &said], WRITE_MS).map_err(|e| format!("git worktree remove: {e}"))?;
        return if gone.ok() { Ok(WorktreeRemoval { path: said, rescued: None }) } else { Err(gone.why()) };
    }
    if !force {
        let status = git(&at, &["status", "--porcelain", "--untracked-files=all"], READ_MS).map_err(|e| format!("git status: {e}"))?;
        if !status.ok() {
            return Err(status.why());
        }
        let n = status.stdout.lines().filter(|l| !l.is_empty()).count();
        if n > 0 {
            return Err(uncommitted(path, n));
        }
    }
    let detached = git(&at, &["symbolic-ref", "--quiet", "HEAD"], READ_MS).is_ok_and(|r| r.code == Some(1));
    let rescued = match (detached, sha_of(&at, "HEAD")) {
        (true, Some(sha)) => {
            let leaf = at.strip_prefix(at.parent().and_then(Path::parent).unwrap_or(&at)).unwrap_or(&at).to_string_lossy().into_owned();
            let name = format!("refs/rescue/{leaf}/{}", &sha[..12.min(sha.len())]);
            let saved = git(from, &["update-ref", &name, &sha], WRITE_MS).map_err(|e| format!("git update-ref: {e}"))?;
            if !saved.ok() {
                return Err(saved.why());
            }
            Some(name)
        }
        _ => None,
    };
    let aside = set_aside_ignored(&at);
    if let Some(beside) = at.parent() {
        meanwhile(beside);
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&said);
    let removed = git(from, &args, WRITE_MS);
    if !removed.as_ref().is_ok_and(|r| r.ok()) {
        for (dir, held) in &aside {
            let _ = fs::rename(held, dir);
            let _ = fs::remove_file(sidecar(held));
        }
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
    Ok(WorktreeRemoval { path: said, rescued })
}

/// Why a folder that is not the top of a repository has no worktrees here.
pub fn not_a_repo_top(from: &Path) -> String {
    format!("{} is not the top of a git repository; a worktree is made from the repository's top", from.display())
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

/// Every worktree of the folder, the folder itself first, read from git each time and never kept.
fn listed(from: &Path) -> Result<Vec<GitWorktree>, String> {
    let read = git(from, &["worktree", "list", "--porcelain", "-z"], READ_MS).map_err(|e| format!("git worktree list: {e}"))?;
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
    let checked =
        git(from, &["check-ref-format", &format!("refs/heads/{branch}")], READ_MS).map_err(|e| format!("git check-ref-format: {e}"))?;
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

/// The config files and the named ignored directories carried from the folder into the worktree. Answers what was
/// carried and which directories a clone could not take.
fn carry(from: &Path, to: &Path, names: &[String], clone: CloneDir) -> Result<(Vec<String>, Vec<String>), String> {
    let listing = ignored(from);
    let mut carried = Vec::new();
    let mut plain = Vec::new();
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
        carried.push(file);
    }
    let dirs = listing.iter().filter_map(|p| p.strip_suffix('/')).filter(|p| names.iter().any(|n| p.rsplit('/').next() == Some(n)));
    for dir in dirs {
        let (source, target) = (from.join(dir), to.join(dir));
        if !fs::symlink_metadata(&source).is_ok_and(|m| m.is_dir()) || fs::symlink_metadata(&target).is_ok() || !inside(to, &target) {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        if clone(&source, &target).is_err() {
            let _ = fs::remove_dir_all(&target);
            copy_plain(&source, &target).map_err(|e| format!("{}: {e}", target.display()))?;
            plain.push(dir.to_owned());
        }
        carried.push(dir.to_owned());
    }
    Ok((carried, plain))
}

/// Whether a path under the worktree stays in it: the branch can track a link where the folder has a directory,
/// and nothing is carried through one to wherever it points.
fn inside(to: &Path, target: &Path) -> bool {
    let Ok(root) = fs::canonicalize(to) else { return false };
    target.ancestors().skip(1).find_map(|p| fs::canonicalize(p).ok()).is_some_and(|p| p.starts_with(root))
}

/// One `clonefile(2)` of a whole directory: the files share their blocks with the folder's until either side
/// writes, and the call costs one directory rather than one call per file.
#[cfg(target_os = "macos")]
fn clone_dir(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e));
    let (source, target) = (c(from)?, c(to)?);
    // SAFETY: both paths are nul-terminated; the call writes nothing this process owns.
    if unsafe { libc::clonefile(source.as_ptr(), target.as_ptr(), 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn clone_dir(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

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
        let back = fs::read_to_string(sidecar(&held))
            .ok()
            .filter(|rel| !rel.is_empty() && !rel.starts_with('/') && !rel.split('/').any(|part| part == ".." || part.is_empty()))
            .map(|rel| worktree.join(rel))
            .filter(|to| {
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
mod tests {
    use super::*;
    use crate::copy_road::rules::repo;
    use std::os::unix::fs::PermissionsExt;

    fn run(at: &Path, args: &[&str]) {
        let ran = git(at, args, WRITE_MS).unwrap();
        assert!(ran.ok(), "{args:?}: {}", ran.why());
    }

    /// A project holding what a checkout on this Mac holds: an ignored root and nested `node_modules` with a link
    /// between them as pnpm writes, an ignored `.env.local`, and an ignored `target` nobody carries.
    fn project(dir: &Path) -> PathBuf {
        let from = dir.join("work");
        repo(&from);
        fs::create_dir_all(from.join("packages/app")).unwrap();
        fs::write(from.join(".gitignore"), b"node_modules/\ntarget/\n*.local\n").unwrap();
        fs::write(from.join("packages/app/index.js"), b"app\n").unwrap();
        run(&from, &["add", "."]);
        run(&from, &["commit", "--quiet", "-m", "app"]);
        fs::create_dir_all(from.join("node_modules/.pnpm/dep")).unwrap();
        fs::write(from.join("node_modules/.pnpm/dep/index.js"), b"dep\n").unwrap();
        fs::create_dir_all(from.join("packages/app/node_modules")).unwrap();
        std::os::unix::fs::symlink("../../../node_modules/.pnpm/dep", from.join("packages/app/node_modules/dep")).unwrap();
        fs::write(from.join(".env.local"), b"KEY=1\n").unwrap();
        fs::create_dir_all(from.join("target/debug")).unwrap();
        fs::write(from.join("target/debug/big"), b"built\n").unwrap();
        from
    }

    fn carry_names() -> Vec<String> {
        ["node_modules", ".venv", "vendor"].map(str::to_owned).to_vec()
    }

    fn ask<'a>(from: &'a Path, home: &'a Path, branch: &'a str, carry: &'a [String]) -> Ask<'a> {
        Ask { from, home, project: "prj_1", branch, carry }
    }

    fn worktrees(from: &Path) -> Vec<GitWorktree> {
        listed(from).unwrap()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_new_branch_gets_a_worktree_under_the_home_with_the_config_and_one_clone_per_dependency_directory() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CLONES: AtomicUsize = AtomicUsize::new(0);
        fn counted(from: &Path, to: &Path) -> io::Result<()> {
            CLONES.fetch_add(1, Ordering::SeqCst);
            clone_dir(from, to)
        }
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let head = sha_of(&from, "HEAD").unwrap();
        let names = carry_names();
        let report = make_with(&ask(&from, &home, "feat/x", &names), counted).unwrap();
        let at = fs::canonicalize(&home).unwrap().join("worktrees/prj_1/feat-x");
        assert_eq!(report.path, at.display().to_string());
        assert!(report.made);
        assert_eq!(report.branch, "feat/x");
        assert_eq!(report.carried, [".env.local", "node_modules", "packages/app/node_modules"]);
        assert!(report.plain.is_empty(), "{:?}", report.plain);
        assert_eq!(CLONES.load(Ordering::SeqCst), 2, "one clone per directory, never one per file");
        assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
        assert_eq!(
            fs::read_to_string(at.join("packages/app/node_modules/dep/index.js")).unwrap(),
            "dep\n",
            "the link resolves inside the worktree"
        );
        assert_eq!(fs::read_to_string(at.join(".env.local")).unwrap(), "KEY=1\n");
        assert!(!at.join("target").exists(), "a directory nobody named is not carried");
        assert_eq!(fs::metadata(&at).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(git(&at, &["rev-parse", "--abbrev-ref", "HEAD"], READ_MS).unwrap().out(), "feat/x");
        assert_eq!(sha_of(&at, "HEAD").unwrap(), head, "a new branch starts at the folder's HEAD");
        assert_eq!(git(&at, &["status", "--porcelain"], READ_MS).unwrap().out(), "", "what was carried is ignored, so the tree is clean");
        assert_eq!(
            git(&from, &["rev-parse", "--abbrev-ref", "HEAD"], READ_MS).unwrap().out(),
            "main",
            "the project folder stays on its branch"
        );
    }

    #[test]
    fn an_existing_branch_twenty_commits_ahead_is_checked_out_where_its_tip_stands() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        run(&from, &["checkout", "--quiet", "-b", "ahead"]);
        fs::write(from.join(".env.local"), b"BRANCH=1\n").unwrap();
        run(&from, &["add", "--force", ".env.local"]);
        for n in 0..20 {
            fs::write(from.join("README.md"), format!("{n}\n")).unwrap();
            run(&from, &["commit", "--quiet", "-am", &format!("turn {n}")]);
        }
        let tip = sha_of(&from, "ahead").unwrap();
        run(&from, &["checkout", "--quiet", "main"]);
        fs::write(from.join(".env.local"), b"KEY=1\n").unwrap();
        let main = sha_of(&from, "main").unwrap();
        let report = make(&ask(&from, &home, "ahead", &[])).unwrap();
        assert!(report.made);
        assert_eq!(sha_of(&from, "refs/heads/ahead").unwrap(), tip, "the branch moved");
        assert_eq!(sha_of(Path::new(&report.path), "HEAD").unwrap(), tip);
        assert_eq!(sha_of(&from, "main").unwrap(), main);
        assert_eq!(fs::read_to_string(Path::new(&report.path).join("README.md")).unwrap(), "19\n");
        assert_eq!(
            fs::read_to_string(Path::new(&report.path).join(".env.local")).unwrap(),
            "BRANCH=1\n",
            "the branch's own file was overwritten"
        );
        assert!(!report.carried.contains(&".env.local".to_owned()));
    }

    #[test]
    fn a_branch_a_worktree_already_holds_is_answered_with_that_worktree_and_nothing_is_made() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let hand = dir.path().join("by-hand");
        run(&from, &["worktree", "add", "--quiet", "-b", "mine", &hand.to_string_lossy()]);
        let report = make(&ask(&from, &home, "mine", &carry_names())).unwrap();
        assert_eq!(report.path, fs::canonicalize(&hand).unwrap().display().to_string());
        assert!(!report.made, "a worktree the person made is never wsp's");
        assert!(report.carried.is_empty());
        assert!(!home.join("worktrees").exists(), "nothing was made under the home");
        // The project folder's own branch is held by the project folder.
        let report = make(&ask(&from, &home, "main", &[])).unwrap();
        assert_eq!(report.path, fs::canonicalize(&from).unwrap().display().to_string());
        assert!(!report.made);
        // A worktree wsp made earlier is found again and is still wsp's.
        let first = make(&ask(&from, &home, "again", &[])).unwrap();
        let second = make(&ask(&from, &home, "again", &[])).unwrap();
        assert_eq!(second.path, first.path);
        assert!(first.made && second.made);
    }

    #[test]
    fn two_branches_with_one_folder_name_get_two_folders() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let a = make(&ask(&from, &home, "feat/x", &[])).unwrap();
        let b = make(&ask(&from, &home, "feat-x", &[])).unwrap();
        assert!(a.path.ends_with("/prj_1/feat-x"), "{}", a.path);
        assert!(b.path.ends_with("/prj_1/feat-x-2"), "{}", b.path);
    }

    #[test]
    fn a_project_on_another_volume_than_the_home_keeps_its_worktrees_on_its_own_volume() {
        let home = Path::new("/Users/me/.wsp");
        assert_eq!(root_of(home, 1, Path::new("/"), 1), PathBuf::from("/Users/me/.wsp/worktrees"));
        assert_eq!(root_of(home, 1, Path::new("/Volumes/stick"), 2), PathBuf::from("/Volumes/stick/.wsp/worktrees"));
        let dir = tempfile::tempdir().unwrap();
        let mount = mount_of(&fs::canonicalize(dir.path()).unwrap());
        assert!(dir.path().canonicalize().unwrap().starts_with(&mount), "{}", mount.display());
        let stick = mount.join(".wsp/worktrees/prj_1/feat-x");
        assert!(made_here(&stick, Path::new("/nowhere")), "a worktree under the volume's own root is wsp's");
    }

    #[test]
    fn a_name_that_is_not_one_folder_or_not_a_branch_is_refused_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        for branch in ["-f", "a..b", "x.lock", "a b"] {
            let refused = make(&ask(&from, &home, branch, &[])).unwrap_err();
            assert_eq!(refused, format!("{branch} is not a name git takes for a branch"));
        }
        let climbing = Ask { project: "../out", ..ask(&from, &home, "ok", &[]) };
        assert!(make(&climbing).unwrap_err().contains("is not a project id"));
        let carried = ["../x".to_owned()];
        assert!(make(&ask(&from, &home, "ok", &carried)).unwrap_err().contains("is not a carried directory name"));
        assert!(!home.join("worktrees").exists());
        assert!(make(&ask(&from.join("packages"), &home, "ok", &[])).unwrap_err().contains("is not the top of a git repository"));
    }

    #[test]
    fn a_directory_a_clone_cannot_take_is_copied_byte_for_byte_with_its_links_kept() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let names = carry_names();
        let report = make_with(&ask(&from, &home, "plain", &names), |_, _| Err(io::Error::from_raw_os_error(libc::ENOTSUP))).unwrap();
        assert_eq!(report.plain, ["node_modules", "packages/app/node_modules"]);
        let at = Path::new(&report.path);
        assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
        assert!(fs::symlink_metadata(at.join("packages/app/node_modules/dep")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(at.join("packages/app/node_modules/dep/index.js")).unwrap(), "dep\n");
    }

    #[test]
    fn a_carry_that_fails_leaves_no_worktree_and_no_new_branch() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let locked = from.join("node_modules/.pnpm/dep/index.js");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let names = carry_names();
        let refused = make_with(&ask(&from, &home, "half", &names), |_, _| Err(io::Error::from_raw_os_error(libc::ENOTSUP))).unwrap_err();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(refused.contains("node_modules"), "{refused}");
        assert!(!has_branch(&from, "half"), "the branch the failed call made is still there");
        assert_eq!(worktrees(&from).len(), 1);
        let leaf = fs::canonicalize(&home).unwrap().join("worktrees/prj_1/half");
        assert!(!leaf.exists());
    }

    #[test]
    fn a_worktree_with_uncommitted_files_stays_unless_forced_and_a_clean_one_goes_with_its_branch_kept() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let names = carry_names();
        let report = make(&ask(&from, &home, "work", &names)).unwrap();
        let at = PathBuf::from(&report.path);
        fs::write(at.join("README.md"), b"edited\n").unwrap();
        fs::write(at.join("new.txt"), b"untracked\n").unwrap();
        let refused = remove(&from, &home, &at, false).unwrap_err();
        assert_eq!(refused, uncommitted(&at, 2));
        assert_eq!(
            refused,
            format!("{} has 2 files not committed, so it was not removed; commit them, or remove it with --force", at.display())
        );
        assert!(at.join("new.txt").is_file() && at.join("node_modules/.pnpm/dep/index.js").is_file(), "a refused removal took something");
        run(&at, &["add", "."]);
        run(&at, &["commit", "--quiet", "-m", "work"]);
        let tip = sha_of(&at, "HEAD").unwrap();
        let removed = remove(&from, &home, &at, false).unwrap();
        assert_eq!(removed, WorktreeRemoval { path: at.display().to_string(), rescued: None });
        assert!(!at.exists());
        assert!(held_beside(&at).is_empty(), "a removal git agreed to left its directories held, where no sweep takes them");
        assert_eq!(sha_of(&from, "refs/heads/work").unwrap(), tip, "the branch keeps its commits");
        assert_eq!(worktrees(&from).len(), 1);
        // Forced, the files go with it.
        let report = make(&ask(&from, &home, "scratch", &names)).unwrap();
        let at = PathBuf::from(&report.path);
        fs::write(at.join("new.txt"), b"untracked\n").unwrap();
        remove(&from, &home, &at, true).unwrap();
        assert!(!at.exists());
    }

    #[test]
    fn a_removal_git_refuses_leaves_the_worktree_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let names = carry_names();
        let at = PathBuf::from(make(&ask(&from, &home, "held", &names)).unwrap().path);
        run(&from, &["worktree", "lock", &at.to_string_lossy()]);
        // A make for another branch sweeps this project's folder while git is still deciding; what the removal
        // holds aside is not the sweep's to take.
        let swept = |beside: &Path| {
            let failed = sweep([beside], |p| fs::remove_dir_all(p));
            assert!(failed.is_empty(), "{failed:?}");
        };
        let refused = remove_with(&from, &home, &at, false, &swept).unwrap_err();
        assert_eq!(refused, "fatal: cannot remove a locked working tree;");
        assert_eq!(
            fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(),
            "dep\n",
            "the dependencies went with a refusal"
        );
        assert!(at.join("packages/app/node_modules/dep").exists());
        assert!(held_beside(&at).is_empty(), "a refusal left something held beside the worktree");
    }

    fn held_beside(at: &Path) -> Vec<String> {
        fs::read_dir(at.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(HOLDING_PREFIX))
            .collect()
    }

    #[test]
    fn nothing_is_carried_through_a_link_the_branch_tracks() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        run(&from, &["checkout", "--quiet", "-b", "linked"]);
        run(&from, &["rm", "--quiet", "-r", "packages/app"]);
        fs::remove_dir_all(from.join("packages/app")).unwrap();
        std::os::unix::fs::symlink(&outside, from.join("packages/app")).unwrap();
        run(&from, &["add", "packages/app"]);
        run(&from, &["commit", "--quiet", "-m", "link"]);
        run(&from, &["checkout", "--quiet", "main"]);
        fs::create_dir_all(from.join("packages/app/node_modules/pkg")).unwrap();
        let names = carry_names();
        let report = make(&ask(&from, &home, "linked", &names)).unwrap();
        assert!(!report.carried.contains(&"packages/app/node_modules".to_owned()), "{:?}", report.carried);
        assert!(!outside.join("node_modules").exists(), "a directory was carried out of the worktree");
        assert!(report.carried.contains(&"node_modules".to_owned()));
    }

    /// The id of a process that has exited, and a moment older than a git write may take.
    fn killed() -> (u32, u128) {
        let mut done = std::process::Command::new("true").spawn().unwrap();
        let pid = done.id();
        done.wait().unwrap();
        (pid, now_nanos() - u128::from(WRITE_MS + 1_000) * 1_000_000)
    }

    fn beside_names(at: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(at.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(HOLDING_PREFIX))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_hold_a_killed_removal_left_goes_back_into_its_worktree_at_the_next_make() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let names = carry_names();
        let at = PathBuf::from(make(&ask(&from, &home, "held", &names)).unwrap().path);
        let (pid, then) = killed();
        let held = hold_as(&at, pid, then);
        assert_eq!(held.len(), 2, "{held:?}");
        assert!(!at.join("node_modules").exists() && beside_names(&at).len() == 4, "{:?}", beside_names(&at));
        make(&ask(&from, &home, "other", &names)).unwrap();
        assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
        assert_eq!(fs::read_to_string(at.join("packages/app/node_modules/dep/index.js")).unwrap(), "dep\n");
        assert!(beside_names(&at).is_empty(), "{:?}", beside_names(&at));
        assert_eq!(git(&at, &["status", "--porcelain"], READ_MS).unwrap().out(), "");
    }

    #[test]
    fn a_hold_whose_process_lives_or_that_is_younger_than_a_git_write_stays_where_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let names = carry_names();
        let at = PathBuf::from(make(&ask(&from, &home, "held", &names)).unwrap().path);
        let (dead, then) = killed();
        hold_as(&at, std::process::id(), then);
        make(&ask(&from, &home, "other", &names)).unwrap();
        assert!(!at.join("node_modules").exists(), "a hold whose process lives was taken");
        let living = beside_names(&at);
        for name in living.iter().filter(|n| !n.ends_with(FROM_SUFFIX)) {
            let held = at.parent().unwrap().join(name);
            let fresh =
                at.parent().unwrap().join(name.replace(&format!("-{}-{then}-", std::process::id()), &format!("-{dead}-{}-", now_nanos())));
            fs::rename(&held, &fresh).unwrap();
            fs::rename(sidecar(&held), sidecar(&fresh)).unwrap();
        }
        make(&ask(&from, &home, "third", &names)).unwrap();
        assert!(!at.join("node_modules").exists(), "a hold younger than a git write was taken");
        assert_eq!(beside_names(&at).len(), 4);
    }

    #[test]
    fn a_hold_whose_worktree_git_already_removed_goes_on_its_way_out_at_the_next_removal() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let names = carry_names();
        let gone = PathBuf::from(make(&ask(&from, &home, "gone", &names)).unwrap().path);
        let kept = PathBuf::from(make(&ask(&from, &home, "kept", &names)).unwrap().path);
        let (pid, then) = killed();
        hold_as(&gone, pid, then);
        run(&from, &["worktree", "remove", "--force", &gone.to_string_lossy()]);
        // The removal of another worktree here takes it, and the worktree a hold of its own came back into goes whole.
        hold_as(&kept, pid, then);
        let removed = remove(&from, &home, &kept, false).unwrap();
        assert_eq!(removed.path, kept.display().to_string());
        assert!(!gone.exists() && !kept.exists());
        assert!(beside_names(&kept).is_empty(), "{:?}", beside_names(&kept));
    }

    #[test]
    fn nothing_but_a_worktree_wsp_made_of_this_folder_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let hand = dir.path().join("by-hand");
        run(&from, &["worktree", "add", "--quiet", "-b", "mine", &hand.to_string_lossy()]);
        let stray = fs::canonicalize(&home).unwrap().join("worktrees/prj_1/stray");
        fs::create_dir_all(&stray).unwrap();
        for path in [&from, &hand, &stray] {
            let refused = remove(&from, &home, path, true).unwrap_err();
            assert_eq!(refused, not_made_here(path, &fs::canonicalize(&home).unwrap()));
        }
        assert!(from.join("README.md").is_file() && hand.join("README.md").is_file() && stray.is_dir());
    }

    #[test]
    fn a_detached_worktree_saves_its_commit_to_a_ref_before_it_goes() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let at = PathBuf::from(make(&ask(&from, &home, "loose", &[])).unwrap().path);
        run(&at, &["checkout", "--quiet", "--detach"]);
        fs::write(at.join("README.md"), b"only here\n").unwrap();
        run(&at, &["commit", "--quiet", "-am", "only here"]);
        let sha = sha_of(&at, "HEAD").unwrap();
        let removed = remove(&from, &home, &at, false).unwrap();
        let name = format!("refs/rescue/prj_1/loose/{}", &sha[..12]);
        assert_eq!(removed.rescued.as_deref(), Some(name.as_str()));
        assert_eq!(sha_of(&from, &name).unwrap(), sha);
    }

    #[test]
    fn a_worktree_removed_by_hand_is_dropped_by_git_and_its_branch_can_be_made_again() {
        let dir = tempfile::tempdir().unwrap();
        let from = project(dir.path());
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let at = PathBuf::from(make(&ask(&from, &home, "again", &[])).unwrap().path);
        fs::remove_dir_all(&at).unwrap();
        let again = make(&ask(&from, &home, "again", &[])).unwrap();
        assert!(again.made && Path::new(&again.path).join("README.md").is_file(), "{again:?}");
        fs::remove_dir_all(&again.path).unwrap();
        remove(&from, &home, Path::new(&again.path), false).unwrap();
        assert_eq!(worktrees(&from).len(), 1);
    }

    #[test]
    fn the_listing_reads_paths_branches_and_the_prunable_mark() {
        let out = "worktree /a\0HEAD 1\0branch refs/heads/main\0\0worktree /b c\0HEAD 2\0detached\0\0worktree /d\0HEAD 3\0branch refs/heads/feat/x\0prunable gitdir file points to non-existent location\0\0";
        assert_eq!(
            worktrees_of(out),
            [
                GitWorktree { path: "/a".into(), branch: Some("main".into()), head: Some("1".into()), prunable: false },
                GitWorktree { path: "/b c".into(), branch: None, head: Some("2".into()), prunable: false },
                GitWorktree { path: "/d".into(), branch: Some("feat/x".into()), head: Some("3".into()), prunable: true },
            ]
        );
        assert_eq!(safe("feat/x y@{1}"), "feat-x-y--1-");
    }
}
