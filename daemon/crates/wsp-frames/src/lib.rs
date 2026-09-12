// SPDX-License-Identifier: AGPL-3.0-only
//! The daemon's wire, mirrored from the protocol package's zod schemas: every
//! request, reply and event as serde types, plus the words and numbers the
//! protocol owns. The contract test under `tests/` reads one fixture set that
//! the protocol's own test reads too, so the two halves cannot drift quietly.

mod auth;
mod enums;
mod event;
mod id;
mod machine;
pub mod numbers;
mod place;
mod place_paths;
mod reply;
mod request;
mod validate;
pub mod words;

pub use auth::DaemonAuthRequest;
pub use enums::{DaemonErrorCode, FsEntryType, FsReadEncoding, GitDiffScope, ProcSignal, PtyMode, WorkspaceKind};
pub use event::{DaemonEvent, ProcEntry, Usage};
pub use id::RequestId;
pub use machine::{
    BackendFacts, BackendPricing, BaseTemplates, Capabilities, DaemonSupervisor, ExecResult, Lifecycle, LifecycleBudgets,
    MachineAnswersReply, MachineCounts, MachineErrorKind, MachineExecReply, MachineHandle, MachineHandleReply, MachineKind, MachineLife,
    MachineLinkRequest, MachineListReply, MachineListRow, MachineOp, MachineRoads, MachineSeen, MachineShape, MachineShapeReply,
    MachineSizeOffer, MachineSpec, MachineState, MachineStateReply, OnIdle, PauseMode, PlaceCapacity, PlaceImage, ResumeAsks,
    SnapshotStoragePricing, MACHINE_OPS,
};
pub use place::{
    place_link_transcript, Base64Bytes, LinkRole, PlaceAuthReply, PlaceAuthRequest, PlaceFile, PlaceNonce, PlaceProveRequest,
    PlacePublicKey, PlaceReport, PlaceSignature, Platform, WorkspaceSize,
};
pub use place_paths::{place_daemon_paths, place_owned_paths, PlaceDaemonPaths};
pub use reply::{
    DaemonErrorResponse, DaemonExecReply, Empty, False, FsEntry, FsListReply, FsReadReply, GitBranch, GitDiffFile, GitDiffReply,
    GitStatusEntry, GitStatusReply, InboxRescanReply, ListeningPort, ManifestEntry, ManifestGetReply, ManifestRecordReply,
    ManifestRestartScriptReply, PlaceLeaveReply, PortsWatchReply, ProcInspectReply, PtyAttachReply, PtyCreateReply, PtyListEntry,
    PtyListReply, Reply, True,
};
pub use request::{DaemonOp, DaemonRequest, DAEMON_OPS};
pub use validate::{is_http_url, RelayPort};
