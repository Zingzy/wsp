// SPDX-License-Identifier: AGPL-3.0-only
//! The machine ops a host sends down a place link, as the engine's MachineBackend and Machine interfaces carry
//! them. The daemon refuses them on every socket that is not the link; the runtime crate answers them there.

use std::collections::BTreeMap;
use std::num::NonZeroU16;

use serde::{Deserialize, Serialize};

use crate::validate::{bounded, positive};
use crate::{RequestId, WorkspaceSize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MachineKind {
    Sandbox,
    Desktop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnIdle {
    Pause,
    Kill,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSpec {
    pub kind: MachineKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_mb: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_gb: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub envs: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_idle: Option<OnIdle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineLife {
    pub first_life: bool,
}

/// The engine's own error kinds, carried on a refused frame; absent is the link's own: the place is not connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MachineErrorKind {
    Concurrency,
    Plan,
    Missing,
    Conflict,
    SnapshotUnavailable,
    Transient,
    Auth,
    Unknown,
    Absent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineLinkRequest {
    pub id: RequestId,
    #[serde(flatten)]
    pub op: MachineOp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum MachineOp {
    #[serde(rename = "machine.backend")]
    Backend,
    #[serde(rename = "machine.capacity")]
    Capacity,
    #[serde(rename = "machine.checkKey")]
    CheckKey,
    #[serde(rename = "machine.create")]
    Create { spec: MachineSpec },
    #[serde(rename = "machine.get", rename_all = "camelCase")]
    Get { machine_id: String },
    #[serde(rename = "machine.list")]
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        labels: Option<BTreeMap<String, String>>,
    },
    #[serde(rename = "machine.deleteSnapshot", rename_all = "camelCase")]
    DeleteSnapshot { snapshot_id: String },
    #[serde(rename = "machine.listSnapshots")]
    ListSnapshots,
    #[serde(rename = "machine.promoteSnapshot", rename_all = "camelCase")]
    PromoteSnapshot { snapshot_id: String, name: String },
    #[serde(rename = "machine.getTemplate", rename_all = "camelCase")]
    GetTemplate { template_id: String },
    #[serde(rename = "machine.listTemplates")]
    ListTemplates,
    #[serde(rename = "machine.deleteTemplate", rename_all = "camelCase")]
    DeleteTemplate { template_id: String },
    #[serde(rename = "machine.exec", rename_all = "camelCase")]
    Exec {
        machine_id: String,
        #[serde(deserialize_with = "bounded::<_, 0, { crate::numbers::EXEC_BODY_MAX }>")]
        cmd: String,
        #[serde(default, deserialize_with = "positive", skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u32>,
    },
    #[serde(rename = "machine.snapshot", rename_all = "camelCase")]
    Snapshot { machine_id: String, name: String, life: MachineLife },
    #[serde(rename = "machine.pause", rename_all = "camelCase")]
    Pause { machine_id: String },
    #[serde(rename = "machine.resume", rename_all = "camelCase")]
    Resume { machine_id: String },
    #[serde(rename = "machine.kill", rename_all = "camelCase")]
    Kill { machine_id: String },
    #[serde(rename = "machine.state", rename_all = "camelCase")]
    State { machine_id: String },
    #[serde(rename = "machine.describe", rename_all = "camelCase")]
    Describe { machine_id: String },
    #[serde(rename = "machine.facts", rename_all = "camelCase")]
    Facts { machine_id: String },
    #[serde(rename = "machine.metrics", rename_all = "camelCase")]
    Metrics { machine_id: String },
    #[serde(rename = "machine.daemonAnswers", rename_all = "camelCase")]
    DaemonAnswers {
        machine_id: String,
        #[serde(default, deserialize_with = "positive", skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u32>,
    },
    #[serde(rename = "machine.previewUrl", rename_all = "camelCase")]
    PreviewUrl { machine_id: String, port: NonZeroU16 },
    #[serde(rename = "machine.downloadUrl", rename_all = "camelCase")]
    DownloadUrl { machine_id: String, path: String },
    #[serde(rename = "machine.uploadUrl", rename_all = "camelCase")]
    UploadUrl { machine_id: String, path: String },
    #[serde(rename = "machine.putBytes", rename_all = "camelCase")]
    PutBytes {
        machine_id: String,
        path: String,
        #[serde(deserialize_with = "bounded::<_, 0, 32>")]
        upload_id: String,
        seq: u64,
        last: bool,
        data: String,
        #[serde(default, deserialize_with = "positive", skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u32>,
    },
}

/// The op names above, which the daemon refuses on every socket but the link.
pub const MACHINE_OPS: [&str; 26] = [
    "machine.backend",
    "machine.capacity",
    "machine.checkKey",
    "machine.create",
    "machine.get",
    "machine.list",
    "machine.deleteSnapshot",
    "machine.listSnapshots",
    "machine.promoteSnapshot",
    "machine.getTemplate",
    "machine.listTemplates",
    "machine.deleteTemplate",
    "machine.exec",
    "machine.snapshot",
    "machine.pause",
    "machine.resume",
    "machine.kill",
    "machine.state",
    "machine.describe",
    "machine.facts",
    "machine.metrics",
    "machine.daemonAnswers",
    "machine.previewUrl",
    "machine.downloadUrl",
    "machine.uploadUrl",
    "machine.putBytes",
];

/// The provider word for a machine's state: a napping workspace's machine reads `paused` here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MachineState {
    Starting,
    Running,
    Paused,
    Gone,
}

/// How a backend pauses: memory keeps the processes and every byte they hold, disk is a stop and a saved copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PauseMode {
    Memory,
    Disk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonSupervisor {
    Systemd,
    Entrypoint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSizeOffer {
    pub cpu: f64,
    pub mem_mb: u64,
    pub rate_usd_per_hour: f64,
}

/// The backend's own flags, as the protocol's Capabilities carries them; the app degrades on these, never on probing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub live_clone_forks: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_mode: Option<PauseMode>,
    pub resize: bool,
    pub replaces_machine: bool,
    pub preview_urls: bool,
    pub signed_urls: bool,
    pub containers: bool,
    pub callback_relay: bool,
    pub disk_snapshots: bool,
    pub snapshot_listing: bool,
    pub templates: bool,
    pub sizes: Vec<MachineSizeOffer>,
    pub kept: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStoragePricing {
    pub free_gb: f64,
    pub usd_per_gb_month: f64,
    pub billed_from: String,
}

/// Pricing as a wire carries it: the numbers, never the function the engine builds from them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendPricing {
    pub default_size: WorkspaceSize,
    pub snapshot_storage: SnapshotStoragePricing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder_disk_gb: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeAsks {
    pub every_ms: u64,
    pub for_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleBudgets {
    pub wake_attempts: u32,
    pub daemon_answers_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_asks: Option<ResumeAsks>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lifecycle {
    pub budgets: LifecycleBudgets,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BaseTemplates {
    pub sandbox: String,
    pub desktop: String,
}

/// What a backend says about itself once, when a link opens: the machine.backend reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendFacts {
    pub offer: String,
    pub capabilities: Capabilities,
    pub pricing: BackendPricing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<Lifecycle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_templates: Option<BaseTemplates>,
}

/// Which optional calls a handle carries, so the client builds a machine whose methods are present exactly where
/// the backend's are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineRoads {
    pub preview_url: bool,
    pub daemon_answers: bool,
    pub put_bytes: bool,
    pub describe: bool,
    pub facts: bool,
    pub metrics: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSeen {
    pub state: MachineState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// One machine as the place hands it over.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineHandle {
    pub id: String,
    pub kind: MachineKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen: Option<MachineSeen>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replayed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_supervisor: Option<DaemonSupervisor>,
    pub roads: MachineRoads,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineListRow {
    pub id: String,
    pub state: MachineState,
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<WorkspaceSize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineShape {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_mb: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_gb: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceImage {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineCounts {
    pub running: u64,
    pub paused: u64,
}

/// What the computer holding a backend has left for one more machine: the machine.capacity reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceCapacity {
    pub cores: u64,
    pub mem_mb: u64,
    pub mem_room_mb: u64,
    pub machine_mem_mb: u64,
    pub disk_free_bytes: u64,
    pub images: Vec<PlaceImage>,
    pub machines: MachineCounts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineHandleReply {
    pub machine: MachineHandle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineListReply {
    pub machines: Vec<MachineListRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineExecReply {
    pub result: ExecResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineStateReply {
    pub state: MachineState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineShapeReply {
    pub shape: MachineShape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineAnswersReply {
    pub answers: bool,
}
