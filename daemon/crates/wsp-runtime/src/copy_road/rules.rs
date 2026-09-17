// SPDX-License-Identifier: AGPL-3.0-only
//! What every road shares: the git runner, the walk that reads a folder's size, the directories a copy drops so
//! they rebuild at the new path, and the two rules that turn a copy of somebody's working folder into a clean
//! checkout. git runs as argv behind no shell, with the hooks off and its messages in one language, so a folder
//! carrying a post-checkout hook cannot run it inside the copy and a refusal reads the same on every computer.

use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// How long one git read has: a rev-parse on a cold index is the slowest of them.
pub const READ_MS: u64 = 15_000;
/// How long the fetch before a reset has, which is the one git call that needs the network and the person's own
/// credentials. Past it the copy stands at the local tip and the report says the fetch did not land.
pub const FETCH_MS: u64 = 30_000;
/// How long a git call that writes the working tree has: a checkout or a worktree add writes every file of a big
/// checkout.
pub const WRITE_MS: u64 = 300_000;

/// What one git call answered.
pub struct GitRun {
    /// None when the deadline killed it.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl GitRun {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
    pub fn out(&self) -> &str {
        self.stdout.trim()
    }
    /// The last line git put its reason on, which is where git puts it.
    pub fn why(&self) -> String {
        let said = if self.stderr.trim().is_empty() { self.stdout.trim() } else { self.stderr.trim() };
        said.lines().last().unwrap_or("").to_owned()
    }
}

/// git as argv in a folder, never a shell line: the hooks are off, so nothing a checkout carries runs inside the
/// copy; the prompt is off, so a fetch needing a password fails instead of waiting for one; and the language is
/// fixed, so a caller reading git's own words reads the same ones everywhere. Both pipes are drained while the
/// call runs, so output past a pipe's buffer cannot wedge it, and the deadline kills what has not finished.
pub fn git(cwd: &Path, args: &[&str], deadline_ms: u64) -> io::Result<GitRun> {
    let mut child = Command::new("git")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut out = child.stdout.take().expect("stdout is piped");
    let mut err = child.stderr.take().expect("stderr is piped");
    let read = std::thread::scope(|scope| {
        let reading_out = scope.spawn(move || {
            let mut text = String::new();
            let _ = io::Read::read_to_string(&mut out, &mut text);
            text
        });
        let reading_err = scope.spawn(move || {
            let mut text = String::new();
            let _ = io::Read::read_to_string(&mut err, &mut text);
            text
        });
        let code = wait_by(&mut child, Duration::from_millis(deadline_ms));
        (code, reading_out.join().unwrap_or_default(), reading_err.join().unwrap_or_default())
    });
    Ok(GitRun { code: read.0, stdout: read.1, stderr: read.2 })
}

/// The child's exit code, or None where the deadline came first and it was killed. Polled rather than waited on:
/// this runs in a foreground verb with no runtime under it, and a git call that hangs on a lock must not hold the
/// process for ever.
fn wait_by(child: &mut std::process::Child, deadline: Duration) -> Option<i32> {
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) => {}
            Err(_) => return None,
        }
        if started.elapsed() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// What the walk read of a folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Walked {
    pub bytes: u64,
    pub files: u64,
}

/// The folder's apparent size and file count, `.git` left out because a road that clones the directory carries it
/// whole and a road that makes a worktree does not carry it at all. Links are counted, never followed, so a link
/// out of the folder is one entry and not the tree it points at. A folder the walk cannot read is read as far as
/// it goes: the size line is a bound on a copy, not a permission check.
pub fn walk(from: &Path) -> Walked {
    let mut walked = Walked { bytes: 0, files: 0 };
    let mut stack = vec![from.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else {
                walked.bytes += meta.len();
                walked.files += 1;
            }
        }
    }
    walked
}

/// A size as a person reads it in a refusal.
pub fn bytes_word(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let n = bytes as f64;
    if n >= GB {
        format!("{:.1} GB", n / GB)
    } else if n >= MB {
        format!("{:.0} MB", n / MB)
    } else {
        format!("{bytes} bytes")
    }
}

/// Whether this folder is the top of a git work tree, which is what a project on a computer somebody owns stands
/// on: the top is the folder itself and not a folder above it, so a subdirectory of a repo is not a project.
pub fn is_repo_top(from: &Path) -> bool {
    let Ok(read) = git(from, &["rev-parse", "--show-toplevel"], READ_MS) else { return false };
    read.ok() && fs::canonicalize(read.out()).ok() == fs::canonicalize(from).ok()
}

/// The branch a copy of this folder starts on: what the remote calls its own HEAD, else what this git would name a
/// fresh repo's first branch, else `main` where the folder has one, else the branch the folder is on now. Every
/// candidate but the first has to be a branch the folder actually holds: `init.defaultBranch` is usually set in the
/// person's own global config, so a folder whose branches are named otherwise would otherwise be copied at a branch
/// that is not there.
pub fn default_branch(from: &Path) -> String {
    if let Ok(read) = git(from, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], READ_MS) {
        if read.ok() {
            if let Some(branch) = read.out().strip_prefix("origin/") {
                if !branch.is_empty() {
                    return branch.to_owned();
                }
            }
        }
    }
    if let Ok(read) = git(from, &["config", "--get", "init.defaultBranch"], READ_MS) {
        if read.ok() && !read.out().is_empty() && has_branch(from, read.out()) {
            return read.out().to_owned();
        }
    }
    if has_branch(from, "main") {
        return "main".to_owned();
    }
    git(from, &["rev-parse", "--abbrev-ref", "HEAD"], READ_MS)
        .ok()
        .filter(GitRun::ok)
        .map_or_else(|| "main".to_owned(), |r| r.out().to_owned())
}

/// Whether the folder holds a branch of this name.
pub fn has_branch(dir: &Path, branch: &str) -> bool {
    git(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], READ_MS).is_ok_and(|r| r.ok())
}

/// A ref resolved to the sha it names in this folder, or nothing where the folder has no such ref.
pub fn sha_of(dir: &Path, reference: &str) -> Option<String> {
    let read = git(dir, &["rev-parse", "--verify", &format!("{reference}^{{commit}}")], READ_MS).ok()?;
    read.ok().then(|| read.out().to_owned()).filter(|sha| !sha.is_empty())
}

/// The path-bound directories taken out of the copy so they rebuild where it now sits, and the ones that were
/// there. A name is read as a path under the copy, so `node_modules/.cache` is one row, and a name that would
/// climb out of the copy is refused rather than removing something beside it.
pub fn exclude(to: &Path, names: &[String]) -> Result<Vec<String>, String> {
    let mut gone = Vec::new();
    for name in names {
        let at = to.join(name);
        if !at.starts_with(to) || name.split('/').any(|part| part == "..") {
            return Err(format!("{name} is not a directory inside the copy"));
        }
        if !at.exists() {
            continue;
        }
        fs::remove_dir_all(&at).map_err(|e| format!("{}: {e}", at.display()))?;
        gone.push(name.clone());
    }
    Ok(gone)
}

/// The fetch of the copy's own default branch before it is reset, in the copy's own git directory and never the
/// folder's. Answers the sha the copy should stand at when the fetch landed and the remote's branch is ahead,
/// else nothing: the fetch needs the network and the person's own credentials, and a copy that starts at the local
/// tip is a copy that works.
pub fn fetch(to: &Path, branch: &str) -> Option<String> {
    let read = git(to, &["fetch", "--quiet", "origin", branch], FETCH_MS).ok()?;
    if !read.ok() {
        return None;
    }
    sha_of(to, &format!("origin/{branch}"))
}

/// The copy made a clean checkout at the base: the branch reset to it, whatever the folder's own working tree held
/// when it was copied, and every untracked file dropped. `clean -fd` and not `-fdx`, so the dependencies and the
/// config files git ignores stay and the half-edited work does not.
pub fn reset_to(to: &Path, branch: &str, sha: &str) -> Result<(), String> {
    let checked = git(to, &["checkout", "-f", "-B", branch, sha], WRITE_MS).map_err(|e| format!("git checkout: {e}"))?;
    if !checked.ok() {
        return Err(checked.why());
    }
    let cleaned = git(to, &["clean", "-fd"], WRITE_MS).map_err(|e| format!("git clean: {e}"))?;
    if !cleaned.ok() {
        return Err(cleaned.why());
    }
    Ok(())
}

/// The names a copy carries over even though git ignores them: the files that hold what a checkout needs to run
/// and nothing a build writes. Read as one rule here because the road that copies file by file is the only reader
/// of it.
pub fn is_config_file(name: &str) -> bool {
    if name == ".env.example" || name == ".env.sample" {
        return false;
    }
    name == ".env"
        || name.starts_with(".env.")
        || name == ".envrc"
        || name == ".npmrc"
        || name.ends_with(".local")
        || name.contains(".local.")
}

/// The biggest a config file may be and still ride along: past it the file is something else wearing the name.
pub const CONFIG_FILE_MAX: u64 = 1024 * 1024;

/// The files git ignores in this folder that a copy carries: the config files at the top of the folder and in the
/// folders under it, never anything inside a directory git ignores whole. `--directory` is what draws that line:
/// an ignored directory is one entry ending in a slash, and the files listed beside it are the ones outside every
/// such directory.
pub fn config_files(from: &Path) -> Vec<String> {
    let Ok(read) = git(from, &["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], READ_MS) else { return Vec::new() };
    if !read.ok() {
        return Vec::new();
    }
    read.stdout
        .split('\0')
        .filter(|path| !path.is_empty() && !path.ends_with('/'))
        .filter(|path| path.rsplit('/').next().is_some_and(is_config_file))
        .filter(|path| from.join(path).metadata().is_ok_and(|m| m.is_file() && m.len() <= CONFIG_FILE_MAX))
        .map(str::to_owned)
        .collect()
}

/// A folder with a commit in it, which is the least a project is: what every road's tests copy.
#[cfg(test)]
pub(crate) fn repo(at: &Path) {
    fs::create_dir_all(at).unwrap();
    for args in [
        vec!["init", "--quiet", "--initial-branch", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "t"],
        vec!["config", "commit.gpgsign", "false"],
    ] {
        assert!(git(at, &args, READ_MS).unwrap().ok(), "{args:?}");
    }
    fs::write(at.join("README.md"), b"one\n").unwrap();
    assert!(git(at, &["add", "README.md"], READ_MS).unwrap().ok());
    assert!(git(at, &["commit", "--quiet", "-m", "first"], WRITE_MS).unwrap().ok());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_walk_sums_what_the_folder_holds_and_leaves_the_git_directory_out() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        repo(&at);
        fs::create_dir_all(at.join("node_modules/pkg")).unwrap();
        fs::write(at.join("node_modules/pkg/index.js"), vec![b'x'; 5000]).unwrap();
        let walked = walk(&at);
        // README.md is four bytes and the package file five thousand; the git directory holds far more than that.
        assert_eq!(walked.bytes, 5004, "{walked:?}");
        assert_eq!(walked.files, 2);
    }

    #[test]
    fn the_default_branch_is_the_remote_head_then_the_config_then_main_then_the_branch_it_is_on() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        repo(&at);
        // No remote and no config: main is there, so main it is.
        assert_eq!(default_branch(&at), "main");
        // main renamed away: the branch it is on, whatever the person's own git names a fresh repo's first branch.
        assert!(git(&at, &["branch", "--quiet", "-m", "main", "trunk"], READ_MS).unwrap().ok());
        assert_eq!(default_branch(&at), "trunk");
        // The config outranks the branch it is on, where the folder holds the branch it names.
        assert!(git(&at, &["branch", "--quiet", "release"], READ_MS).unwrap().ok());
        assert!(git(&at, &["config", "init.defaultBranch", "release"], READ_MS).unwrap().ok());
        assert_eq!(default_branch(&at), "release");
        // A config naming a branch the folder has not got is passed over rather than copied at nothing.
        assert!(git(&at, &["config", "init.defaultBranch", "nowhere"], READ_MS).unwrap().ok());
        assert_eq!(default_branch(&at), "trunk");
        // The remote's own HEAD outranks the config.
        assert!(git(&at, &["remote", "add", "origin", "https://example.invalid/x.git"], READ_MS).unwrap().ok());
        assert!(git(&at, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], READ_MS).unwrap().ok());
        assert_eq!(default_branch(&at), "trunk");
    }

    #[test]
    fn the_exclusion_removes_the_listed_directories_that_are_there_and_names_them() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        fs::create_dir_all(at.join(".next/cache")).unwrap();
        fs::create_dir_all(at.join("node_modules/.cache")).unwrap();
        fs::create_dir_all(at.join("node_modules/pkg")).unwrap();
        let gone = exclude(&at, &[".venv".to_owned(), ".next".to_owned(), "node_modules/.cache".to_owned()]).unwrap();
        assert_eq!(gone, vec![".next".to_owned(), "node_modules/.cache".to_owned()]);
        assert!(!at.join(".next").exists() && !at.join("node_modules/.cache").exists());
        assert!(at.join("node_modules/pkg").exists(), "only what was named goes");
    }

    #[test]
    fn a_name_that_climbs_out_of_the_copy_removes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        fs::create_dir_all(&at).unwrap();
        let beside = dir.path().join("beside");
        fs::create_dir_all(&beside).unwrap();
        let refused = exclude(&at, &["../beside".to_owned()]).unwrap_err();
        assert!(refused.contains("../beside"), "{refused}");
        assert!(beside.exists());
    }

    #[test]
    fn the_reset_leaves_a_clean_tree_at_the_base_with_the_ignored_files_kept() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        repo(&at);
        let base = sha_of(&at, "HEAD").unwrap();
        fs::write(at.join(".gitignore"), b".env.local\n").unwrap();
        assert!(git(&at, &["add", ".gitignore"], READ_MS).unwrap().ok());
        assert!(git(&at, &["commit", "--quiet", "-m", "ignore"], WRITE_MS).unwrap().ok());
        let with_ignore = sha_of(&at, "HEAD").unwrap();
        fs::write(at.join("README.md"), b"half edited\n").unwrap();
        fs::write(at.join("scratch.txt"), b"untracked\n").unwrap();
        fs::write(at.join(".env.local"), b"KEY=1\n").unwrap();
        reset_to(&at, "main", &with_ignore).unwrap();
        assert_eq!(fs::read_to_string(at.join("README.md")).unwrap(), "one\n", "the half-edited file is the base's again");
        assert!(!at.join("scratch.txt").exists(), "an untracked file goes");
        assert_eq!(fs::read_to_string(at.join(".env.local")).unwrap(), "KEY=1\n", "an ignored file stays");
        let status = git(&at, &["status", "--porcelain"], READ_MS).unwrap();
        assert_eq!(status.out(), "");
        assert_eq!(sha_of(&at, "HEAD").unwrap(), with_ignore);
        assert_ne!(base, with_ignore);
    }

    #[test]
    fn a_fetch_that_cannot_reach_a_remote_answers_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        repo(&at);
        assert!(git(&at, &["remote", "add", "origin", "https://127.0.0.1:1/x.git"], READ_MS).unwrap().ok());
        assert_eq!(fetch(&at, "main"), None);
        // The local tip is still the base a copy would stand at.
        assert!(sha_of(&at, "main").is_some());
    }

    #[test]
    fn a_hook_the_folder_carries_is_never_run() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        repo(&at);
        let hooks = at.join(".git/hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-checkout");
        fs::write(&hook, format!("#!/bin/sh\ntouch {}/ran\n", at.display())).unwrap();
        fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let sha = sha_of(&at, "HEAD").unwrap();
        reset_to(&at, "main", &sha).unwrap();
        assert!(!at.join("ran").exists(), "the checkout ran the folder's own hook");
    }

    #[test]
    fn the_config_files_are_the_ignored_ones_outside_every_ignored_directory_and_under_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        repo(&at);
        fs::write(at.join(".gitignore"), b"node_modules/\n.env*\n*.local\nbig.env.local\n").unwrap();
        fs::create_dir_all(at.join("node_modules/pkg")).unwrap();
        fs::write(at.join("node_modules/pkg/.npmrc"), b"x\n").unwrap();
        fs::write(at.join(".env.local"), b"KEY=1\n").unwrap();
        fs::write(at.join(".env.example"), b"KEY=\n").unwrap();
        fs::write(at.join("big.env.local"), vec![b'x'; (CONFIG_FILE_MAX + 1) as usize]).unwrap();
        fs::create_dir_all(at.join("apps/web")).unwrap();
        fs::write(at.join("apps/web/.env.local"), b"PORT=1\n").unwrap();
        let mut found = config_files(&at);
        found.sort();
        assert_eq!(found, vec![".env.local".to_owned(), "apps/web/.env.local".to_owned()], "{found:?}");
    }

    #[test]
    fn the_size_words_read_as_a_person_writes_them() {
        assert_eq!(bytes_word(512), "512 bytes");
        assert_eq!(bytes_word(3 * 1024 * 1024), "3 MB");
        assert_eq!(bytes_word(6 * 1024 * 1024 * 1024), "6.0 GB");
    }

    #[test]
    fn the_top_of_a_work_tree_is_the_folder_itself_and_never_one_under_it() {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        repo(&at);
        assert!(is_repo_top(&at));
        let under = at.join("apps");
        fs::create_dir_all(&under).unwrap();
        assert!(!is_repo_top(&under));
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        assert!(!is_repo_top(&outside));
    }
}
