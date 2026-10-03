// SPDX-License-Identifier: AGPL-3.0-only
//! Replies carry no op, so each op with a body of its own has a struct here and rides the one envelope.

use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize, Serializer};
use ts_rs::TS;

use crate::{
    CheckState, DaemonErrorCode, FsEntryType, HostItemKind, MachineErrorKind, MergeMethod, Mergeable, PullRequestState, ReactionContent,
    RequestId, ReviewState, Usage,
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
    /// How many stashes the repository holds, work no branch carries and no remote has; absent where there are none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stashes: Option<u64>,
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

/// One step of a computer's kept readings: the mean cpu and load over it, the last memory and disk in it, and the
/// instant it starts, ms epoch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SysPoint {
    pub at: i64,
    pub cpu: f64,
    pub load1: f64,
    pub mem: Usage,
    pub disk: Usage,
}

/// What a sys.history answered: the steps with a reading in them, oldest first, their width, and whether the range
/// held more steps than one answer carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SysHistoryReply {
    pub points: Vec<SysPoint>,
    pub step_ms: u64,
    pub truncated: bool,
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
    /// A turn range names each HEAD move the turn did not write (a checkout, pull, merge, rebase or reset) as one
    /// line, oldest first, with no files of its own; empty for a plain diff and for a turn that only wrote its own
    /// commits and edits.
    pub moved: Vec<String>,
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
    /// Who opened it, by the host's own login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub author: Option<String>,
    /// The fork its head lives on, where that is not the repository itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fork: Option<PullRequestFork>,
    /// Armed to merge once its checks pass: by which method, and who armed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_merge: Option<PullRequestAutoMerge>,
}

/// A merge armed to land once a pull request's checks pass.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestAutoMerge {
    pub method: MergeMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<String>,
}

/// A pull request's head on someone's fork: whose, and whether its author let the repository's maintainers push there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestFork {
    pub owner: String,
    pub pushable: bool,
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
    /// When it started and when it finished, as ISO times; absent while it has not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completed_at: Option<String>,
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

/// What a git.checkpointDrop took away: how many of the thread's checkpoint refs went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointDropReply {
    pub dropped: u64,
}

/// One worktree of a repository as git lists it: where it is, the branch it holds and the commit it stands at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    /// Absent on a detached worktree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub branch: Option<String>,
    /// Absent on a bare repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub head: Option<String>,
    /// Its folder is gone and git still holds its record.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub prunable: bool,
}

/// Every worktree of the repository a checkout belongs to, the repository's own folder first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreesReply {
    pub worktrees: Vec<GitWorktree>,
}

/// One local branch: its name, the commit it stands at, when that commit was made, its upstream and the worktree
/// holding it, where one does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitLocalBranch {
    pub name: String,
    pub oid: String,
    /// Seconds since the epoch.
    pub committed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub upstream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub worktree: Option<String>,
}

/// The checkout's local branches, newest commit first, and the one it is on; absent when it is detached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchesReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current: Option<String>,
    pub branches: Vec<GitLocalBranch>,
    /// More branches than the reply carries; the oldest were left out.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
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

/// An issue, or a pull request read as the issue it also is: its text and its conversation, each body cut as a page
/// cuts it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct IssueRead {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub body: String,
    pub state: String,
    pub comments: Vec<IssueComment>,
}

/// One comment of an issue's conversation, by its author's login, with when as an ISO time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub author: String,
    pub body: String,
    pub at: String,
}

/// What a git.issueRead read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitIssueReadReply {
    pub issue: IssueRead,
}

/// The branch a git.prCheckout left the copy on, which tracks the pull request's head.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrCheckoutReply {
    pub branch: String,
}

/// A pull request's diff, cut on a file's boundary at REVIEW_DIFF_MAX_BYTES, with every file the cut left out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrDiffReply {
    pub diff: String,
    pub truncated: bool,
    pub left: Vec<String>,
}

/// A posted review's page, and the ids of the comments that went into its body because their line is outside the diff.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrReviewReply {
    pub url: String,
    pub folded: Vec<String>,
}

/// One commit of a pull request: its id, its subject and the rest of its message, when it was made as an ISO time, and
/// its author; and where the host's API answered for it, its parents (two on a merge), its line counts and every
/// check on it rolled into one word.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCommit {
    pub oid: String,
    pub subject: String,
    pub body: String,
    pub at: String,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parents: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub additions: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deletions: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub check: Option<CheckState>,
}

/// One review left on a pull request: its id, which the comments it left on lines name, who and their association,
/// the state it left, its body whole, and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReview {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<u64>,
    /// Its node id, which a reaction names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub node_id: Option<String>,
    pub author: String,
    /// The author's association with the repository, GitHub's word in lower case: owner, member, collaborator,
    /// contributor, first_time_contributor, first_timer, mannequin or none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub association: Option<String>,
    /// The host's word in lower case: approved, changes_requested, commented, dismissed, pending.
    pub state: String,
    pub body: String,
    pub at: String,
    /// Every reaction left on it; none is no list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reactions: Option<Vec<PullRequestReaction>>,
}

/// A reviewer's latest verdict on a pull request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestVerdict {
    pub author: String,
    pub state: String,
    pub at: String,
}

/// One comment in a pull request's conversation: its id, who and their association, whether a bot wrote it, the face
/// the host shows for its author, its body whole, its link and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestComment {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub node_id: Option<String>,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub association: Option<String>,
    pub bot: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub avatar: Option<String>,
    pub body: String,
    pub url: String,
    pub at: String,
    /// Every reaction left on it; none is no list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reactions: Option<Vec<PullRequestReaction>>,
}

/// One comment left on a line of a pull request's diff: the file and line it is on, the line it was on once the line
/// moved away, the side of the diff, who, whether a bot wrote it and its face, the body whole, its link and when; the
/// diff's lines down to the commented one, the comment it answers, the review it was left in, and whether its thread
/// is resolved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewComment {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub node_id: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub side: Option<String>,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub association: Option<String>,
    pub bot: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub avatar: Option<String>,
    pub body: String,
    pub url: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hunk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reply_to: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub review_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resolved: Option<bool>,
    /// The node id of its review thread, which resolving names, on its first comment and on every reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread_id: Option<String>,
    /// Every reaction left on it; none is no list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reactions: Option<Vec<PullRequestReaction>>,
}

/// One reaction left on an item: which, how many left it, and whether the person signed in to the host's command line
/// is one of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReaction {
    pub content: ReactionContent,
    pub count: u64,
    pub mine: bool,
}

/// A reply posted as the person: the new comment in the conversation, or the new comment under a thread on a line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrReplyReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub comment: Option<PullRequestComment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub review_comment: Option<PullRequestReviewComment>,
}

/// A review thread resolved or unresolved as the person: its node id and where it stands now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrResolveReply {
    pub thread_id: String,
    pub resolved: bool,
}

/// A reaction added or taken off as the person: the item's node id and every reaction on it now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrReactReply {
    pub subject: String,
    pub reactions: Vec<PullRequestReaction>,
}

/// One label on a pull request: its name, its colour as six hex digits, and what it means where its repository says.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestLabel {
    pub name: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
}

/// A review asked for and not yet given: a person by login, or a team by its slug.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewRequest {
    pub name: String,
    pub team: bool,
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

/// A pull request as its page reads: title, body, the author, when it opened, last moved and settled, who merged it
/// into which commit, labels, the reviews asked for and each reviewer's latest verdict, assignees, commits, reviews,
/// the conversation, the comments on lines and the files. No body on it is cut.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitPrViewReply {
    pub title: String,
    pub body: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub closed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub merged_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub merged_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub merge_commit: Option<String>,
    pub labels: Vec<PullRequestLabel>,
    pub review_requests: Vec<PullRequestReviewRequest>,
    pub latest_reviews: Vec<PullRequestVerdict>,
    pub assignees: Vec<String>,
    pub commits: Vec<PullRequestCommit>,
    pub reviews: Vec<PullRequestReview>,
    pub comments: Vec<PullRequestComment>,
    pub review_comments: Vec<PullRequestReviewComment>,
    pub files: Vec<PullRequestFile>,
    /// What the read left out, where it reached a cap; absent where it read everything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cut: Option<PullRequestPageCut>,
}

/// The parts of a page read only in part: commits past gh's first 100, which carry no lines or checks of their own,
/// reviews before the newest 100, which carry no id, and review threads before the newest 100, whose comments do not
/// say whether they are resolved. Each is present only where true.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestPageCut {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub commits: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reviews: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub threads: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub comments: Option<bool>,
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

/// The branch a checkout was put on, or a branch fetched into, and the commit it now stands at: what git.startOn,
/// git.switchNew and git.fetchBranch answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitStartOnReply {
    pub branch: String,
    pub oid: String,
}

/// How far a head is from a base on the git host: not pushed where the host lacks the head, else the commits each has
/// that the other lacks and the host's own word for the two (ahead, behind, diverged, identical).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchCompareReply {
    pub pushed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ahead_by: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub behind_by: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<String>,
}

/// What a merge of another branch did: merged with how many commits it brought and the commit it left, or nothing
/// merged and the files that conflict, the checkout left exactly as it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GitMergeInReply {
    pub branch: String,
    pub merged: bool,
    pub commits: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub oid: Option<String>,
    /// The other branch's commit the merge took, which the lead's copy holds from then on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub head: Option<String>,
    pub conflicts: Vec<String>,
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
