// SPDX-License-Identifier: AGPL-3.0-only
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which kind of machine a daemon serves, which picks the modules its readings come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    Cloud,
    Local,
    Place,
}

impl WorkspaceKind {
    /// The kind a word names on the wire, or nothing for a word that is not one.
    pub fn from_word(word: &str) -> Option<WorkspaceKind> {
        serde_json::from_value(serde_json::Value::String(word.to_owned())).ok()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WorkspaceKind::Cloud => "cloud",
            WorkspaceKind::Local => "local",
            WorkspaceKind::Place => "place",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "kebab-case")]
pub enum DaemonErrorCode {
    Unsupported,
    OutsideRoot,
    NotFound,
    NotADirectory,
    NotAFile,
    NotAGitRepo,
    BadRequest,
    Forbidden,
    /// No command line for the git host this remote names is on this computer, so the pull request waits; the push
    /// itself went through, which is why a client reads this as a note beside the push rather than as a failure.
    NoHostCli,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum ProcSignal {
    #[serde(rename = "TERM")]
    Term,
    #[serde(rename = "KILL")]
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum FsReadEncoding {
    Utf8,
    Base64,
}

/// What fs.search looks for: file paths, or lines of text inside the files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum FsSearchMode {
    Files,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum GitDiffScope {
    Branch,
    Unstaged,
    Staged,
    /// Everything a commit could take: the worktree against HEAD, staged and unstaged edits folded together, and
    /// every untracked file as a new one.
    Head,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryType {
    File,
    Dir,
    Symlink,
}

/// Where a pull request stands, in the three words every host of them has: open, merged, or closed unmerged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    Open,
    Merged,
    Closed,
}

/// Whether a pull request can merge into its base as the host reads it; unknown while the host is still working it out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum Mergeable {
    Mergeable,
    Conflicting,
    Unknown,
}

/// Where a pull request's review stands: nothing asked, approved, changes asked for, or a review the base requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    None,
    Approved,
    ChangesAsked,
    Required,
}

/// One check on a pull request's head, in the one word the host's command line gives every check whatever ran it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Pass,
    Fail,
    Pending,
    Skipped,
    Cancelled,
}

/// How a pull request lands on its base: a merge commit, one squashed commit, or its commits rebased on top.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

/// Which of a git host's two open lists an item came off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "kebab-case")]
pub enum HostItemKind {
    PullRequest,
    Issue,
}

/// The slave termios ICANON bit as a word: line when set, raw when not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum PtyMode {
    Line,
    Raw,
}
