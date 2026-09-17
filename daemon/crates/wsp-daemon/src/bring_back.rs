// SPDX-License-Identifier: AGPL-3.0-only
//! Work leaves a workspace through git and nothing else: the branch the agent made is pushed to the project's
//! remote, and the branch the work started from is never pushed at all.

use std::path::Path;

use wsp_frames::{words, GitPushReply};

use crate::git::{check, default_branch, parse_porcelain_v2, rev_exists, run_git, stdout_text};
use crate::paths::OpError;

/// Files of the diffstat one push carries; past it git prints its own "N more files" line and the reply stays a
/// thing a person reads rather than a whole tree.
const STAT_FILES: &str = "--stat-count=50";

/// The remote a push goes to: origin where there is one, else the first the checkout names.
async fn remote_name(cwd: &Path) -> Result<String, OpError> {
    let listed = run_git(cwd, &["remote"], None, None).await?;
    check(&listed, "remote")?;
    let text = stdout_text(&listed);
    let mut names = text.lines().map(str::trim).filter(|n| !n.is_empty());
    let first = names.next().map(str::to_owned);
    match first {
        None => Err(OpError::plain(words::NO_REMOTE)),
        Some(one) => Ok(if text.lines().any(|n| n.trim() == "origin") { "origin".to_owned() } else { one }),
    }
}

/// Where that remote points, which is what says which git host this project lives on.
pub(crate) async fn remote_url(cwd: &Path) -> Result<(String, String), OpError> {
    let name = remote_name(cwd).await?;
    let url = run_git(cwd, &["remote", "get-url", &name], None, None).await?;
    check(&url, "remote get-url")?;
    Ok((name, stdout_text(&url).trim().to_owned()))
}

/// The branch this checkout is on; a detached head is on none, and there is nothing to bring back from one.
pub(crate) async fn branch_at(cwd: &Path) -> Result<String, OpError> {
    let head = run_git(cwd, &["symbolic-ref", "-q", "--short", "HEAD"], None, None).await?;
    check(&head, "symbolic-ref")?;
    let branch = stdout_text(&head).trim().to_owned();
    if head.code != Some(0) || branch.is_empty() {
        return Err(OpError::plain(words::NOT_ON_A_BRANCH));
    }
    Ok(branch)
}

/// The branch the work started from when the caller named none: what the remote says its default is, read as the
/// branch's own name rather than the remote's word for it, else a main or a master here. A checkout with none is
/// measured against nothing, and every commit on it is ahead.
pub(crate) async fn base_of(cwd: &Path, remote: &str, named: Option<&str>) -> Result<String, OpError> {
    if let Some(base) = named {
        return Ok(base.to_owned());
    }
    let read = default_branch(cwd).await?;
    Ok(read.map_or_else(String::new, |b| b.strip_prefix(&format!("{remote}/")).unwrap_or(&b).to_owned()))
}

/// The branch a bring back would carry: the one this checkout is on, refused when it is the base itself. One home
/// for the rule, so the push and the pull request refuse the base alike.
pub(crate) async fn head_for(cwd: &Path, base: &str) -> Result<String, OpError> {
    let branch = branch_at(cwd).await?;
    if branch == base {
        return Err(OpError::plain(words::on_base_refusal(base)));
    }
    Ok(branch)
}

/// What the ahead count and the diffstat are measured from: the base branch here, else the remote's copy of it.
/// Neither, on a checkout whose base has never been fetched, leaves every commit of the branch ahead.
async fn base_ref(cwd: &Path, remote: &str, base: &str) -> Result<Option<String>, OpError> {
    for rev in [base.to_owned(), format!("{remote}/{base}")] {
        if rev_exists(cwd, &rev).await? {
            return Ok(Some(rev));
        }
    }
    Ok(None)
}

/// How many commits the branch has that the base lacks.
async fn ahead_of(cwd: &Path, from: Option<&str>) -> Result<u64, OpError> {
    let range = from.map_or_else(|| "HEAD".to_owned(), |base| format!("{base}..HEAD"));
    let counted = run_git(cwd, &["rev-list", "--count", &range], None, None).await?;
    check(&counted, "rev-list")?;
    Ok(stdout_text(&counted).trim().parse().unwrap_or(0))
}

/// Changes in the checkout that no commit holds, ignored files apart: what a person is told they are leaving behind.
async fn uncommitted(cwd: &Path) -> Result<u64, OpError> {
    let status = run_git(cwd, &["status", "--porcelain=v2", "--branch", "-z"], None, None).await?;
    check(&status, "status")?;
    let (_, entries) = parse_porcelain_v2(&stdout_text(&status));
    Ok(entries.iter().filter(|e| e.xy != "!!").count() as u64)
}

/// The diffstat of what the branch carries over the base, git's own lines; empty where the base is not here to
/// measure against.
async fn stat_over(cwd: &Path, from: Option<&str>) -> Result<Vec<String>, OpError> {
    let Some(base) = from else { return Ok(Vec::new()) };
    let range = format!("{base}...HEAD");
    let diffed = run_git(cwd, &["diff", "--stat", STAT_FILES, &range], None, None).await?;
    check(&diffed, "diff --stat")?;
    Ok(stdout_text(&diffed).lines().map(|l| l.trim_end().to_owned()).filter(|l| !l.is_empty()).collect())
}

/// Pushes the branch this checkout is on, with the base guard ahead of it and the counts a person reads beside it.
pub(crate) async fn push(cwd: &Path, named: Option<&str>) -> Result<GitPushReply, OpError> {
    let remote = remote_name(cwd).await?;
    let base = base_of(cwd, &remote, named).await?;
    let branch = head_for(cwd, &base).await?;
    let from = base_ref(cwd, &remote, &base).await?;
    let ahead = ahead_of(cwd, from.as_deref()).await?;
    if ahead == 0 {
        return Err(OpError::plain(words::nothing_ahead(&branch, &base)));
    }
    let left = uncommitted(cwd).await?;
    let stat = stat_over(cwd, from.as_deref()).await?;
    let pushed = run_git(cwd, &["push", "-u", &remote, &branch], None, None).await?;
    if pushed.code != Some(0) {
        let said = pushed.stderr.trim();
        return Err(OpError::plain(format!("git push failed: {}", if said.is_empty() { stdout_text(&pushed) } else { said.to_owned() })));
    }
    Ok(GitPushReply { branch, base, remote, ahead, uncommitted: left, stat })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::Command;

    use super::*;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@x")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@x")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    /// A checkout on main with one commit, its own bare origin beside it, and main pushed there.
    struct Repo {
        dir: tempfile::TempDir,
    }

    impl Repo {
        fn new() -> Repo {
            let dir = tempfile::Builder::new().prefix("wsp-bring-back-").tempdir().unwrap();
            let repo = dir.path().join("work");
            let origin = dir.path().join("origin.git");
            std::fs::create_dir_all(&repo).unwrap();
            git(dir.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
            git(&repo, &["init", "-q", "-b", "main"]);
            git(&repo, &["config", "commit.gpgsign", "false"]);
            std::fs::write(repo.join("README.md"), "# readme\n").unwrap();
            git(&repo, &["add", "-A"]);
            git(&repo, &["commit", "-q", "-m", "first"]);
            git(&repo, &["remote", "add", "origin", origin.to_str().unwrap()]);
            git(&repo, &["push", "-q", "-u", "origin", "main"]);
            Repo { dir }
        }

        fn at(&self) -> PathBuf {
            self.dir.path().join("work")
        }

        fn origin(&self) -> PathBuf {
            self.dir.path().join("origin.git")
        }

        fn commit(&self, name: &str) {
            std::fs::write(self.at().join(name), "x\n").unwrap();
            git(&self.at(), &["add", name]);
            git(&self.at(), &["commit", "-q", "-m", name]);
        }
    }

    #[tokio::test]
    async fn a_push_from_the_base_branch_names_the_base_and_pushes_nothing() {
        let repo = Repo::new();
        repo.commit("on-main.txt");
        let err = push(&repo.at(), Some("main")).await.unwrap_err();
        assert_eq!(err.message, words::on_base_refusal("main"));
        let landed = git(&repo.origin(), &["rev-parse", "main"]);
        assert_eq!(landed.trim(), git(&repo.at(), &["rev-parse", "HEAD~1"]).trim());
    }

    #[tokio::test]
    async fn a_checkout_on_no_branch_says_there_is_nothing_to_bring_back_yet() {
        let repo = Repo::new();
        repo.commit("one.txt");
        git(&repo.at(), &["checkout", "-q", "--detach", "HEAD"]);
        assert_eq!(push(&repo.at(), Some("main")).await.unwrap_err().message, words::NOT_ON_A_BRANCH);
    }

    #[tokio::test]
    async fn a_branch_the_base_already_holds_every_commit_of_is_refused_by_name() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "quiet"]);
        assert_eq!(push(&repo.at(), Some("main")).await.unwrap_err().message, words::nothing_ahead("quiet", "main"));
    }

    #[tokio::test]
    async fn a_branch_ahead_is_pushed_with_its_upstream_and_the_reply_counts_what_travelled() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "work"]);
        repo.commit("one.txt");
        repo.commit("two.txt");
        std::fs::write(repo.at().join("dirty.txt"), "not committed\n").unwrap();
        let reply = push(&repo.at(), Some("main")).await.unwrap();
        assert_eq!((reply.branch.as_str(), reply.base.as_str(), reply.remote.as_str()), ("work", "main", "origin"));
        assert_eq!((reply.ahead, reply.uncommitted), (2, 1));
        assert!(reply.stat.iter().any(|l| l.contains("one.txt")), "{:?}", reply.stat);
        assert!(reply.stat.last().is_some_and(|l| l.contains("2 files changed")), "{:?}", reply.stat);
        assert_eq!(git(&repo.origin(), &["rev-parse", "work"]).trim(), git(&repo.at(), &["rev-parse", "HEAD"]).trim());
        // -u is what the push carried, so the next one from inside the workspace needs no remote named.
        assert_eq!(git(&repo.at(), &["rev-parse", "--abbrev-ref", "work@{upstream}"]).trim(), "origin/work");
    }

    #[tokio::test]
    async fn a_checkout_with_nowhere_to_push_says_so() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "work"]);
        repo.commit("one.txt");
        git(&repo.at(), &["remote", "remove", "origin"]);
        assert_eq!(push(&repo.at(), Some("main")).await.unwrap_err().message, words::NO_REMOTE);
    }

    #[tokio::test]
    async fn the_base_is_measured_against_the_remote_copy_where_the_branch_is_not_here() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "work"]);
        repo.commit("one.txt");
        git(&repo.at(), &["branch", "-q", "-D", "main"]);
        let reply = push(&repo.at(), Some("main")).await.unwrap();
        assert_eq!((reply.ahead, reply.base.as_str()), (1, "main"));
    }

    #[tokio::test]
    async fn a_push_that_names_no_base_takes_the_branch_the_checkout_reads_as_its_default() {
        let repo = Repo::new();
        git(&repo.at(), &["switch", "-q", "-c", "work"]);
        repo.commit("one.txt");
        let reply = push(&repo.at(), None).await.unwrap();
        assert_eq!((reply.base.as_str(), reply.ahead), ("main", 1));
        // And on that default branch itself the guard still fires, which is the whole reason the base is read.
        git(&repo.at(), &["switch", "-q", "main"]);
        repo.commit("two.txt");
        assert_eq!(push(&repo.at(), None).await.unwrap_err().message, words::on_base_refusal("main"));
    }

    #[tokio::test]
    async fn the_remote_is_origin_where_there_is_one_and_the_first_named_otherwise() {
        let repo = Repo::new();
        assert_eq!(remote_url(&repo.at()).await.unwrap().0, "origin");
        git(&repo.at(), &["remote", "rename", "origin", "elsewhere"]);
        let (name, url) = remote_url(&repo.at()).await.unwrap();
        assert_eq!(name, "elsewhere");
        assert!(url.ends_with("origin.git"), "{url}");
    }
}
