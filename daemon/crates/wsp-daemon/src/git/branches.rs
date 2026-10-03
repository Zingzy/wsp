// SPDX-License-Identifier: AGPL-3.0-only
//! What a checkout's repository holds by way of places to work: its worktrees and its local branches, read off git
//! at each ask and never kept.

use std::path::Path;

use wsp_frames::{GitBranchesReply, GitLocalBranch, GitWorktreesReply};
use wsp_runtime::copy_road::branch::worktrees_of;

use super::checkpoint::ran;
use super::{run_git, stdout_text, Runs};
use crate::paths::OpError;

/// The most branches one reply carries, newest commit first.
pub(crate) const BRANCHES_MAX: usize = 500;

pub(crate) async fn worktrees<R: Runs>(runner: &R, cwd: &Path) -> Result<GitWorktreesReply, OpError> {
    let listed = run_git(runner, cwd, &["worktree", "list", "--porcelain", "-z"], None, None).await?;
    ran(&listed, "worktree list")?;
    Ok(GitWorktreesReply { worktrees: worktrees_of(&stdout_text(&listed)) })
}

pub(crate) async fn branches<R: Runs>(runner: &R, cwd: &Path) -> Result<GitBranchesReply, OpError> {
    let count = format!("--count={}", BRANCHES_MAX + 1);
    let format = "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(upstream:short)%00%(worktreepath)";
    let listed = run_git(runner, cwd, &["for-each-ref", "--sort=-committerdate", &count, format, "refs/heads"], None, None).await?;
    ran(&listed, "for-each-ref")?;
    let mut branches: Vec<GitLocalBranch> = stdout_text(&listed).lines().filter_map(branch_of).collect();
    let truncated = branches.len() > BRANCHES_MAX;
    branches.truncate(BRANCHES_MAX);
    let head = run_git(runner, cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], None, None).await?;
    let current = (head.code == Some(0)).then(|| stdout_text(&head).trim().to_owned()).filter(|b| !b.is_empty());
    Ok(GitBranchesReply { current, branches, truncated })
}

fn branch_of(line: &str) -> Option<GitLocalBranch> {
    let mut parts = line.split('\0');
    let name = parts.next()?.strip_prefix("refs/heads/")?.to_owned();
    let oid = parts.next()?.to_owned();
    let committed = parts.next()?.parse().unwrap_or(0);
    let some = |part: Option<&str>| part.filter(|p| !p.is_empty()).map(str::to_owned);
    Some(GitLocalBranch { name, oid, committed, upstream: some(parts.next()), worktree: some(parts.next()) })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use wsp_frames::{DaemonErrorCode, GitWorktree};

    use super::*;
    use crate::git::here::Here;

    fn git(at: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(at).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("work");
        fs::create_dir_all(at.join("src")).unwrap();
        git(&at, &["init", "-q", "-b", "main"]);
        fs::write(at.join("one.txt"), "one\n").unwrap();
        git(&at, &["add", "-A"]);
        git(&at, &["commit", "-q", "-m", "start"]);
        let at = at.canonicalize().unwrap();
        (dir, at)
    }

    #[tokio::test]
    async fn the_worktrees_are_every_one_git_lists_the_repositorys_own_first() {
        let (dir, at) = repo();
        let head = git(&at, &["rev-parse", "HEAD"]);
        let beside = dir.path().canonicalize().unwrap().join("beside");
        git(&at, &["worktree", "add", "-q", "-b", "feat/x", beside.to_str().unwrap()]);
        let loose = dir.path().canonicalize().unwrap().join("loose");
        git(&at, &["worktree", "add", "-q", "--detach", loose.to_str().unwrap()]);
        fs::remove_dir_all(&loose).unwrap();
        let read = worktrees(&Here::new(), &at.join("src")).await.unwrap();
        let path = |p: &Path| p.display().to_string();
        assert_eq!(
            read.worktrees,
            [
                GitWorktree { path: path(&at), branch: Some("main".into()), head: Some(head.clone()), prunable: false },
                GitWorktree { path: path(&beside), branch: Some("feat/x".into()), head: Some(head.clone()), prunable: false },
                GitWorktree { path: path(&loose), branch: None, head: Some(head), prunable: true },
            ]
        );
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(worktrees(&Here::new(), plain.path()).await.err().unwrap().code, Some(DaemonErrorCode::NotAGitRepo));
    }

    #[tokio::test]
    async fn the_branches_come_newest_first_with_their_upstream_and_worktree_and_the_one_the_checkout_is_on() {
        let (dir, at) = repo();
        let old = git(&at, &["rev-parse", "HEAD"]);
        git(&at, &["branch", "old"]);
        git(&at, &["checkout", "-q", "-b", "new"]);
        fs::write(at.join("two.txt"), "two\n").unwrap();
        git(&at, &["add", "-A"]);
        Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "later"])
            .env("GIT_COMMITTER_DATE", "2030-01-01T00:00:00Z")
            .current_dir(&at)
            .status()
            .unwrap();
        git(&at, &["config", "branch.new.remote", "."]);
        git(&at, &["config", "branch.new.merge", "refs/heads/main"]);
        let beside = dir.path().canonicalize().unwrap().join("beside");
        git(&at, &["worktree", "add", "-q", beside.to_str().unwrap(), "old"]);
        let read = branches(&Here::new(), &at).await.unwrap();
        assert_eq!(read.current.as_deref(), Some("new"));
        assert!(!read.truncated);
        let names: Vec<&str> = read.branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names[0], "new", "{names:?}");
        let new = &read.branches[0];
        assert_eq!(new.upstream.as_deref(), Some("main"));
        assert_eq!(new.worktree.as_deref(), Some(at.to_str().unwrap()));
        assert_eq!(new.committed, 1_893_456_000);
        let held = read.branches.iter().find(|b| b.name == "old").unwrap();
        assert_eq!((held.oid.as_str(), held.worktree.as_deref()), (old.as_str(), Some(beside.to_str().unwrap())));
        let main = read.branches.iter().find(|b| b.name == "main").unwrap();
        assert_eq!((main.upstream.as_deref(), main.worktree.as_deref()), (None, None));
        git(&at, &["checkout", "-q", "--detach"]);
        assert_eq!(branches(&Here::new(), &at).await.unwrap().current, None, "a detached checkout is on no branch");
    }

    #[tokio::test]
    async fn past_the_most_a_reply_carries_the_oldest_branches_are_left_out_and_it_says_so() {
        let (_dir, at) = repo();
        let head = git(&at, &["rev-parse", "HEAD"]);
        let lines: String = (0..=BRANCHES_MAX).map(|n| format!("create refs/heads/b{n} {head}\n")).collect();
        let mut fed =
            Command::new("git").args(["update-ref", "--stdin"]).current_dir(&at).stdin(std::process::Stdio::piped()).spawn().unwrap();
        std::io::Write::write_all(fed.stdin.as_mut().unwrap(), lines.as_bytes()).unwrap();
        assert!(fed.wait().unwrap().success());
        let read = branches(&Here::new(), &at).await.unwrap();
        assert_eq!(read.branches.len(), BRANCHES_MAX);
        assert!(read.truncated);
    }
}
