// SPDX-License-Identifier: AGPL-3.0-only
//! The branch a copy's remote starts every copy on: the one reading the status a host reads, the push's own guard
//! and a stopped copy's count all take, so none of them can call another branch the default.

use std::path::Path;

use super::{check, rev_exists, run_git, stdout_text, GitLine, Runs};
use crate::paths::OpError;

/// Where a branch's base is looked for, in order: origin's HEAD where a remote set it, else a local main or master.
/// Both roads read it, the running one through git and the stopped one off the files.
pub(crate) const DEFAULT_BRANCHES: [&str; 3] = ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"];

/// The first of those that names a commit here, by its short name. origin/HEAD counts only where the branch it
/// names is still there: a remote that renamed its default branch and a prune leave it naming nothing.
pub(crate) async fn default_branch<R: Runs>(runner: &R, cwd: &Path) -> Result<Option<String>, OpError> {
    for name in DEFAULT_BRANCHES {
        if name.ends_with("/HEAD") {
            let named = run_git(runner, cwd, &GitLine::new(&["symbolic-ref", "-q", "--short", name]), None, None).await?;
            check(&named, "symbolic-ref")?;
            let target = stdout_text(&named).trim().to_owned();
            if named.code == Some(0) && rev_exists(runner, cwd, &target).await? {
                return Ok(Some(target));
            }
        } else if rev_exists(runner, cwd, name).await? {
            return Ok(Some(name.trim_start_matches("refs/heads/").to_owned()));
        }
    }
    Ok(None)
}

/// A default branch read off origin/HEAD by the branch's own name, as a person and a push name it.
pub(crate) fn by_own_name(read: String) -> String {
    read.strip_prefix("origin/").map_or_else(|| read.clone(), str::to_owned)
}

/// The branch the copy's remote starts every copy on, by its own name: the one reading the status a host reads and
/// the push's own guard both take, so neither can call another branch the default.
pub(crate) async fn default_branch_name<R: Runs>(runner: &R, cwd: &Path) -> Result<Option<String>, OpError> {
    Ok(default_branch(runner, cwd).await?.map(by_own_name))
}
