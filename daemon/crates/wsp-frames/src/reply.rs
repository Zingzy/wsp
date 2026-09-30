// SPDX-License-Identifier: AGPL-3.0-only
//! Replies carry no op, so each op with a body of its own has a struct here and rides the one envelope.

use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize, Serializer};
use ts_rs::TS;

use crate::{
    CheckState, DaemonErrorCode, FsEntryType, HostItemKind, MachineErrorKind, MergeMethod, Mergeable, PullRequestState, RequestId,
    ReviewState,
};

/// The literal `true` the ok envelope carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct True;

/// The literal `false` the error envelope carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct False;

macro_rules! literal_bool {
    ($name:ident, $value:literal) => {
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_bool($value)
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct V;
                impl Visitor<'_> for V {
                    type Value = $name;
                    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                        write!(f, "the literal {}", $value)
                    }
                    fn visit_bool<E: de::Error>(self, v: bool) -> Result<$name, E> {
                        if v == $value {
                            Ok($name)
                        } else {
                            Err(E::custom(format!("expected {}", $value)))
                        }
                    }
                }
                d.deserialize_bool(V)
            }
        }
    };
}
literal_bool!(True, true);
literal_bool!(False, false);

/// The ok envelope: the request's id (null when it carried none), ok, and the op's own fields beside them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Reply<T> {
    pub id: Option<RequestId>,
    #[ts(type = "true")]
    pub ok: True,
    #[serde(flatten)]
    pub body: T,
}

impl<T> Reply<T> {
    pub fn new(id: Option<RequestId>, body: T) -> Self {
        Reply { id, ok: True, body }
    }
}

/// The error envelope. code is set by the ops that name a refusal a client can branch on; kind and status travel
/// only on a machine op's refusal, so a backend's own error keeps its meaning across a link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DaemonErrorResponse {
    pub id: Option<RequestId>,
    #[ts(type = "false")]
    pub ok: False,
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub code: Option<DaemonErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<MachineErrorKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<u16>,
}

impl DaemonErrorResponse {
    pub fn new(id: Option<RequestId>, error: impl Into<String>) -> Self {
        DaemonErrorResponse { id, ok: False, error: error.into(), code: None, kind: None, status: None }
    }

    pub fn with_code(mut self, code: DaemonErrorCode) -> Self {
        self.code = Some(code);
        self
    }
}

/// A reply with nothing beside the envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Empty {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PtyCreateReply {
    pub pty_id: String,
    /// The process this terminal's shell runs under, numbered as the computer the daemon runs on numbers it: the
    /// shell itself for a pty on that computer, and for one inside a workspace the process the exec made there,
    /// which is the pane's broker and which the daemon signals a resize to. A workspace numbers its own
    /// processes, so this is not the number one inside reads for itself.
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PtyAttachReply {
    pub pty_id: String,
}

/// One live or exited pty the daemon still holds; exited ones stay until pty.kill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PtyListEntry {
    pub id: String,
    /// The same number `PtyCreateReply` answered for this terminal, and the same reading.
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub exited: bool,
    /// Set on a pty that runs a reply's command and still belongs to that reply: no pane adopts it until pty.tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reply: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PtyListReply {
    pub ptys: Vec<PtyListEntry>,
}

/// One listening TCP port as the watcher reads it. pid is null where no owner was found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ListeningPort {
    pub port: u16,
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inode: Option<u64>,
    pub uid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub process: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    pub loopback: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PortsWatchReply {
    pub ports: Vec<ListeningPort>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub id: String,
    pub cmd: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub port: Option<u16>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ManifestGetReply {
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ManifestRecordReply {
    pub entry: ManifestEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ManifestRestartScriptReply {
    pub script: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InboxRescanReply {
    pub count: u64,
}

/// cwd is null when unreadable; threads is absent where the machine's processes module cannot count them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProcInspectReply {
    pub pid: u32,
    pub cwd: Option<String>,
    pub ports: Vec<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub threads: Option<u32>,
    pub children: Vec<u32>,
}

/// name is the entry's own name in the listed directory; size is 0 for anything but a file; mtime is epoch ms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FsEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: FsEntryType,
    pub size: u64,
    pub mtime: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FsListReply {
    pub entries: Vec<FsEntry>,
    pub truncated: bool,
    pub total: u64,
}

/// The checkout's files under the folder asked about, relative to it, in git's order; truncated where there were more
/// than the cap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FsFilesReply {
    pub files: Vec<String>,
    pub truncated: bool,
}

/// One fs.search hit: a path relative to the folder searched, and in text mode the line it is on (from 1) and that
/// line's text, cut to a few hundred characters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FsSearchHit {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
}

/// truncated: the walk stopped at a cap or at its time budget before it had looked everywhere.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FsSearchReply {
    pub hits: Vec<FsSearchHit>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FsReadReply {
    pub content: String,
    pub size: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FsWriteReply {
    pub bytes: u64,
}

/// One folder a folder picker lists, and whether git tracks it; a repo a repos listing found carries its branch,
/// absent on a detached head, and when git last wrote there, in ms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct HostFolder {
    pub path: String,
    pub repo: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub touched_at: Option<i64>,
}

/// One level of folders: the folder listed, the roots every level is browsed from, the folders directly inside it
/// and how many were left out for being hidden.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HostFolderListing {
    pub dir: String,
    pub roots: Vec<String>,
    pub folders: Vec<HostFolder>,
    pub hidden: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitBranch {
    pub oid: String,
    pub head: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub xy: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusReply {
    pub branch: GitBranch,
    pub entries: Vec<GitStatusEntry>,
    pub root: String,
    /// The entries were not read: a stopped workspace's branch is read off its git directory alone, so an empty
    /// list here says nothing about edits never committed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub edits_unread: bool,
    /// Ahead and behind were not counted: the history of a stopped workspace's copy was too long or too slow to walk
    /// within the daemon's budget, so the zeros say nothing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub counts_unknown: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitDiffFile {
    pub path: String,
    /// added, modified, deleted, renamed or copied, off git's own status letter.
    pub kind: String,
    /// Lines added and removed; a binary file counts none.
    pub additions: u32,
    pub deletions: u32,
    pub patch: String,
    /// The id git gives the file's contents in the worktree now; absent for a file that is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blob: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitDiscardReply {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitReply {
    pub oid: String,
    pub subject: String,
    pub files_changed: u64,
    pub insertions: u64,
    pub deletions: u64,
}

/// The commit a git.snapshot recorded, by its full sha.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitSnapshotReply {
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GitDiffReply {
    pub base: Option<String>,
    pub files: Vec<GitDiffFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DaemonExecReply {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaceLeaveReply {
    pub swept: Vec<String>,
}

/// What the last part of an update is answered with before the agent ends: where the binary landed, so the host's
/// line names the path a person would look at, and what stood there before it, which is kept beside it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PlaceUpdateReply {
    pub at: String,
    pub kept: String,
}

/// One pull request as its host's command line answered with it, read off that command's JSON and never its prose:
/// where it stands, its branch and its head, whether it can merge, its review, every check on its head, its size,
/// and how many commits its base has that its head lacks, which the host alone can count without a fetch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub state: PullRequestState,
    /// The git host it lives on, as the remote's url names it: github.com and the like.
    pub host: String,
    pub draft: bool,
    pub base: String,
    pub branch: String,
    /// The commit its head is at, which a merge names so it lands only the commit a person saw.
    pub head_oid: String,
    /// That commit's subject, which a message about a check that failed on it names.
    pub head_subject: String,
    pub mergeable: Mergeable,
    /// The host's own word for why it can or cannot merge now, in lower case: clean, blocked, behind, dirty and the like.
    pub merge_state: String,
    pub review: ReviewState,
    pub checks: Vec<PullRequestCheck>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub commits: u64,
    /// Commits the base has that the head lacks; absent where the host did not answer or the pull request is not open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub behind_base: Option<u64>,
}

/// One check on a pull request's head: its name, the workflow it runs in, its state, and for a job the host runs
/// itself the run and the job whose failed log can be read; a check another service reports carries its link alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheck {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workflow: Option<String>,
    pub state: CheckState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run: Option<PullRequestCheckRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
}

/// The run and the job a check is, where the host's own runner ran it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheckRun {
    pub run_id: u64,
    pub job_id: u64,
}

/// One open pull request or issue as its host's command line listed it, with its body as it stands now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct HostItem {
    pub kind: HostItemKind,
    pub number: u64,
    pub title: String,
    /// Cut at GIT_PR_LIST_BODY_CAP characters, ending in an ellipsis where it was.
    pub body: String,
    pub url: String,
}

/// The repository's open pull requests, then its open issues. Where nothing can be listed, since no signed-in
/// command line for the host is on the computer, the list is empty and `noCliFor` names the host, for the client to
/// say on which computer; a list the command line refused otherwise is left out with its first line as the note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrListReply {
    pub items: Vec<HostItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub no_cli_for: Option<String>,
}

/// The checkpoint a git.checkpoint took: its ref, the commit it names, and whether the tree differs from the one
/// that ref named before, which a turn that changed nothing reads as false.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointReply {
    #[serde(rename = "ref")]
    pub checkpoint_ref: String,
    pub commit: String,
    pub changed: bool,
}

/// What a git.restore did: the checkpoint of the tree as it stood just before, which restores it again, and how
/// many files the restore wrote or removed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitRestoreReply {
    pub before: String,
    pub files: u64,
}

/// What a push carried: the branch, the branch it is measured against, the remote it went to, how many commits it
/// has that the base lacks, how many changes were left uncommitted here and the diffstat of what travelled.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPushReply {
    pub branch: String,
    pub base: String,
    pub remote: String,
    pub ahead: u64,
    pub uncommitted: u64,
    pub stat: Vec<String>,
}

/// The pull request for the branch, and whether this call is what opened it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrReply {
    pub pr: PullRequest,
    pub created: bool,
}

/// The pull request for the branch or the number asked about, absent where the host knows none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrReadReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pr: Option<PullRequest>,
}

/// One commit of a pull request: its id, its subject, when it was made as an ISO time, and its author.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCommit {
    pub oid: String,
    pub subject: String,
    pub at: String,
    pub author: String,
}

/// One review left on a pull request: who, the state it left, its body cut at GIT_PR_LIST_BODY_CAP, and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReview {
    pub author: String,
    /// The host's word in lower case: approved, changes_requested, commented, dismissed, pending.
    pub state: String,
    pub body: String,
    pub at: String,
}

/// One comment in a pull request's conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestComment {
    pub author: String,
    pub body: String,
    pub at: String,
}

/// One comment left on a line of a pull request's diff: the file and line it is on, absent once the line moved away,
/// the side of the diff, who, the body, its link and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewComment {
    pub id: u64,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub side: Option<String>,
    pub author: String,
    pub body: String,
    pub url: String,
    pub at: String,
}

/// One file a pull request changes, with its counts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

/// A pull request as its page reads: title, body, the author and when it was last updated, commits, reviews, the
/// conversation, the comments on lines and the files, every body cut at GIT_PR_LIST_BODY_CAP.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrViewReply {
    pub title: String,
    pub body: String,
    pub author: String,
    pub updated_at: String,
    pub commits: Vec<PullRequestCommit>,
    pub reviews: Vec<PullRequestReview>,
    pub comments: Vec<PullRequestComment>,
    pub review_comments: Vec<PullRequestReviewComment>,
    pub files: Vec<PullRequestFile>,
}

/// The failed steps of one job's log, its last CHECK_LOG_LINES lines at most; truncated where there were more.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitRunLogReply {
    pub lines: Vec<String>,
    pub truncated: bool,
}

/// What a merge did: merged now, or merging once its checks pass where it was asked to wait for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrMergeReply {
    pub merged: bool,
    pub auto_armed: bool,
}

/// How a repository lets its pull requests land: the methods it allows, the one its page offers first, and whether it
/// lets one merge by itself once its checks pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoReadReply {
    pub methods: Vec<MergeMethod>,
    pub default_method: MergeMethod,
    pub auto_merge: bool,
}

/// What an update from the base did: merged with how many commits it brought, or nothing merged and the files that
/// conflict, the checkout left exactly as it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitUpdateReply {
    /// The base it merged from, as the branch's own name.
    pub base: String,
    pub merged: bool,
    pub commits: u64,
    pub conflicts: Vec<String>,
}

/// Where a machine's own ssh server listens on its loopback, and the host key it proves itself with, one OpenSSH
/// public key line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SshStartReply {
    pub port: u16,
    pub host_key: String,
}
