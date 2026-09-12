// SPDX-License-Identifier: AGPL-3.0-only
use serde::{Deserialize, Serialize};

/// Which kind of machine a daemon serves, which picks the modules its readings come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    Cloud,
    Local,
    Ssh,
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
            WorkspaceKind::Ssh => "ssh",
            WorkspaceKind::Place => "place",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProcSignal {
    #[serde(rename = "TERM")]
    Term,
    #[serde(rename = "KILL")]
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FsReadEncoding {
    Utf8,
    Base64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitDiffScope {
    Branch,
    Unstaged,
    Staged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryType {
    File,
    Dir,
    Symlink,
}

/// The slave termios ICANON bit as a word: line when set, raw when not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PtyMode {
    Line,
    Raw,
}
