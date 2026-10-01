// SPDX-License-Identifier: AGPL-3.0-only
//! The daemon's wire: every request, reply and event as serde types, plus the
//! words and numbers the protocol owns. Each wire type writes its TypeScript
//! into the protocol package, which re-exports it (`scripts/ts-types.sh`); a
//! zod schema there that still parses a frame is held to the type written
//! here. The contract test under `tests/` reads one fixture set that the
//! protocol's own test reads too, so the two halves cannot drift quietly.

mod auth;
mod checkpoint;
mod copy;
mod enums;
mod event;
mod guest;
mod id;
mod landed;
mod machine;
pub mod numbers;
mod place;
mod place_paths;
mod reply;
mod request;
mod shell;
mod shim;
mod validate;
pub mod words;

pub use auth::DaemonAuthRequest;
pub use checkpoint::{checkpoint_copy_part, checkpoint_id_ok, checkpoint_prefix, CHECKPOINT_REFS};
pub use copy::{Carried, CopyAsk, CopyReport, CopyRoadName};
pub use enums::{
    CheckState, DaemonErrorCode, FsEntryType, FsReadEncoding, FsSearchMode, GitDiffScope, HostItemKind, MergeMethod, Mergeable, ProcSignal,
    PtyMode, PullRequestState, ReviewEvent, ReviewSide, ReviewState, WorkspaceKind,
};
pub use event::{DaemonEvent, ProcEntry, Usage};
pub use guest::{GuestCliMessage, GuestKind, GuestOpen, GuestOpenReply, GuestStream};
pub use id::RequestId;
pub use landed::{landed_files_script, own_marks, OWN_MARK};
pub use machine::{
    BackendFacts, BackendPricing, BaseTemplates, Bind, Capabilities, CopyWord, DaemonSupervisor, ExecResult, Lifecycle, LifecycleBudgets,
    MachineAnswersReply, MachineCounts, MachineErrorKind, MachineExecReply, MachineHandle, MachineHandleReply, MachineKind,
    MachineLinkRequest, MachineListReply, MachineListRow, MachineOp, MachineReachReply, MachineReading, MachineReadingReply, MachineRoads,
    MachineSeen, MachineShape, MachineShapeReply, MachineSizeOffer, MachineSpec, MachineState, MachineStateReply, OnIdle, PauseMode,
    PlaceCapacity, PlaceImage, PreviewReach, ResumeAsks, Share, SnapshotStoragePricing, WorkspaceCopy, MACHINE_OPS,
    MACHINE_OPS_ON_ANY_ROAD,
};
pub use place::{
    place_link_transcript, place_refusal_transcript, Base64Bytes, LinkEphemerals, LinkRole, PlaceAuthRefusal, PlaceAuthReply,
    PlaceAuthRequest, PlaceClient, PlaceEphemeral, PlaceFile, PlaceNonce, PlaceProveRequest, PlacePublicKey, PlaceReport, PlaceSignature,
    Platform, WorkspaceSize,
};
pub use place_paths::{place_daemon_paths, place_owned_paths, place_provision_paths, probe_path, PlaceDaemonPaths, PlaceProvisionPaths};
pub use reply::{
    DaemonErrorResponse, DaemonExecReply, Empty, False, FsEntry, FsFilesReply, FsListReply, FsReadReply, FsSearchHit, FsSearchReply,
    FsWriteReply, GitBranch, GitBranchCompareReply, GitCheckpointReply, GitCommitReply, GitDiffFile, GitDiffReply, GitDiscardReply,
    GitIssueReadReply, GitMergeInReply, GitPrCheckoutReply, GitPrDiffReply, GitPrListReply, GitPrMergeReply, GitPrReadReply, GitPrReply,
    GitPrReviewReply, GitPrViewReply, GitPushReply, GitRepoReadReply, GitRestoreReply, GitRunLogReply, GitSnapshotReply, GitStartOnReply,
    GitStatusEntry, GitStatusReply, GitUpdateReply, HostFolder, HostFolderListing, HostItem, InboxRescanReply, IssueComment, IssueRead,
    ListeningPort, ManifestEntry, ManifestGetReply, ManifestRecordReply, ManifestRestartScriptReply, PlaceLeaveReply, PlaceUpdateReply,
    PortsWatchReply, ProcInspectReply, PtyAttachReply, PtyCreateReply, PtyListEntry, PtyListReply, PullRequest, PullRequestCheck,
    PullRequestCheckRun, PullRequestComment, PullRequestCommit, PullRequestFile, PullRequestFork, PullRequestReview,
    PullRequestReviewComment, Reply, SshStartReply, SysHistoryReply, SysPoint, True,
};
pub use request::{DaemonOp, DaemonRequest, ReviewComment, DAEMON_OPS, GUEST_OPS};
pub use shell::shell_quote;
pub use shim::guest_wsp_shim;
pub use validate::{is_http_url, is_plain_path, is_under_path, RelayPort};
