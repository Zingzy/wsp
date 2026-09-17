// SPDX-License-Identifier: AGPL-3.0-only
//! The machine ops a host sends down a place link, as the engine's MachineBackend and Machine interfaces carry
//! them. The runtime crate answers them there; the daemon refuses them on every socket that is not the link, but
//! for the two read-only ones a person at the computer itself asks of it.

use std::collections::BTreeMap;
use std::num::NonZeroU16;

use serde::{Deserialize, Serialize};

use crate::validate::{bounded, plain_path, plain_path_opt, positive};
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
    /// The workspace gets the box's container engine through this daemon's fenced socket; refused where the box has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<bool>,
    /// The project this workspace is made with, on a computer the person owns: a checkout on that computer, copied
    /// once for this workspace and mounted read-write inside it at the project's real path. Absent is a workspace
    /// of the computer with no project in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<WorkspaceCopy>,
    /// The logins this computer holds for every workspace on it, each mounted into this one. Absent is a
    /// workspace that shares none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shares: Option<Vec<Share>>,
}

/// One file the computer running a workspace keeps outside every one of them and mounts into each at `target`:
/// a login signed in once on that computer, read-write, so a refresh inside one workspace is the computer's own
/// refresh rather than a copy going stale. `source` lives under the daemon's logins directory and a create
/// refuses one that does not; `target` is where the tool reads it inside, both absolute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Share {
    #[serde(deserialize_with = "plain_path")]
    pub source: String,
    #[serde(deserialize_with = "plain_path")]
    pub target: String,
}

/// Where a workspace's copy comes from and where it lands inside: both absolute paths, the first on the computer,
/// the second in the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceCopy {
    #[serde(deserialize_with = "plain_path")]
    pub from: String,
    #[serde(deserialize_with = "plain_path")]
    pub at: String,
}

/// How a computer makes a workspace's copy of a checkout: a reflink shares blocks with it, a snapshot is a btrfs
/// subvolume snapshot of it, a plain copy writes every byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CopyWord {
    Reflink,
    Snapshot,
    Plain,
}

impl CopyWord {
    /// The word the report carries and the host reads.
    pub fn word(self) -> &'static str {
        match self {
            CopyWord::Reflink => "reflink",
            CopyWord::Snapshot => "snapshot",
            CopyWord::Plain => "plain",
        }
    }
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
    /// How far the snapshot job a `machine.snapshot` answered with has got: the host asks again until it reads done.
    #[serde(rename = "machine.snapshotJob")]
    SnapshotJob { job: String },
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
pub const MACHINE_OPS: [&str; 27] = [
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
    "machine.snapshotJob",
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

/// The two of them a client on the computer itself may ask, holding the daemon's own token: what this computer is
/// running and one workspace's reading. Both only read, so neither is the link's to keep; every other op in
/// MACHINE_OPS makes, moves or ends something and stays the link's alone.
pub const MACHINE_OPS_ON_ANY_ROAD: [&str; 2] = ["machine.list", "machine.metrics"];

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
    pub replaces_machine: bool,
    pub preview_urls: bool,
    pub signed_urls: bool,
    pub callback_relay: bool,
    pub disk_snapshots: bool,
    /// A copy may be taken from any life of the machine, not only its first; false where the provider refuses a
    /// machine that was resumed.
    pub snapshots_any_life: bool,
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
    /// Where this computer keeps the logins every workspace on it shares, absolute. Absent from a backend that
    /// shares none, which is every provider: a machine somebody else runs has no file of this person's on it.
    #[serde(default, deserialize_with = "plain_path_opt", skip_serializing_if = "Option::is_none")]
    pub logins: Option<String>,
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
    /// One sentence on a create or a fork whose size the computer would not give as asked, naming what it gave
    /// instead; the record holds the size itself, so this is said once and never read back for a number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
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
    /// What the machine has written since it booted, where the backend can read that: a workspace's upper directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_bytes: Option<u64>,
}

/// One workspace as the computer running it reads it, in one frame: the sizes its cgroup was written with, what it
/// holds of them now, and where its processes, its files and its address are. Every figure is read at the moment of
/// the ask rather than sampled, so a row drawn from it is true of that moment and of no moment since; a workspace
/// that is not running carries the sizes and the paths and none of the live figures.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineReading {
    pub state: MachineState,
    /// The cores and the memory the workspace was given, as they were applied rather than as they were asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_mb: Option<u64>,
    /// What its cgroup holds this moment, against the cap memMb names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_bytes: Option<u64>,
    /// The processor time its cgroup has spent since the workspace booted; a rate is the difference between two
    /// readings, which is the caller's to take.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_usage_usec: Option<u64>,
    /// How long its first process has been running, which a wake starts again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime_ms: Option<u64>,
    /// Every process in its cgroup and in the cgroups under it, which is what a container engine inside it makes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub procs: Option<u64>,
    /// The address it answers on inside the computer's own network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub cgroup: String,
    /// The overlay directory holding everything it has written since it was made, which is what a snapshot saves.
    pub upper: String,
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
    /// What the workspaces on this computer hold of it right now, summed over the ones that are not stopped:
    /// the cores their quotas name and the memory their caps name. Absent from a backend that counts neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_taken: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_taken_mb: Option<u64>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineReadingReply {
    pub reading: MachineReading,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineAnswersReply {
    pub answers: bool,
}

/// Where a host dials one port of a machine: a URL, the token the route wants and when it expires. A route on a
/// place's own loopback carries no token and never expires, which the two empty values say.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReach {
    pub url: String,
    pub token: String,
    pub expires_at: u64,
}

impl PreviewReach {
    /// What a reach that never expires carries, node's Number.MAX_SAFE_INTEGER, as the Docker backend answers it.
    pub const NEVER: u64 = 9_007_199_254_740_991;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineReachReply {
    pub reach: PreviewReach,
}

/// One snapshot as the store lists it: sizeBytes is the snapshot's own layer, never the chain under it, so storage
/// sums honestly; parent is the snapshot the workspace was made from, null at a root.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRow {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, deserialize_with = "nullable", skip_serializing_if = "Option::is_none")]
    pub parent: Option<Option<String>>,
}

/// A field that is absent, null or a value, kept apart: serde reads null as absent unless told otherwise.
fn nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TemplateStatus {
    Building,
    Ready,
    Failed,
}

/// One template as the provider reports it; a promoted snapshot reads ready at once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRow {
    pub id: String,
    pub name: String,
    pub status: TemplateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// A snapshot is a job: the reply names it, and `machine.snapshotJob` under that name says how far it has got.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineSnapshotReply {
    pub job: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotJobState {
    Running,
    Done,
}

/// One reading of a snapshot job: the layer's bytes written so far, the upper directory's bytes once they have
/// been counted, and the snapshot's id once the job is done. A job that failed is a refusal with its reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSnapshotJobReply {
    pub state: SnapshotJobState,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineSnapshotsReply {
    pub snapshots: Vec<SnapshotRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachinePromoteReply {
    pub template_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineTemplateReply {
    pub template: TemplateRow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineTemplatesReply {
    pub templates: Vec<TemplateRow>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spec_carries_the_logins_the_computer_shares_and_a_spec_without_them_carries_no_key() {
        let bare = MachineSpec {
            kind: MachineKind::Sandbox,
            template: None,
            from_snapshot: None,
            cpu: None,
            mem_mb: None,
            disk_gb: None,
            envs: None,
            labels: None,
            on_idle: None,
            idle_timeout_ms: None,
            idempotency_key: None,
            engine: None,
            copy: None,
            shares: None,
        };
        let written = serde_json::to_string(&bare).unwrap();
        assert_eq!(written, r#"{"kind":"sandbox"}"#);
        assert_eq!(serde_json::from_str::<MachineSpec>(&written).unwrap(), bare);
        let shared = MachineSpec {
            shares: Some(vec![Share {
                source: "/var/lib/wsp/logins/codex/auth.json".to_owned(),
                target: "/root/.codex/auth.json".to_owned(),
            }]),
            ..bare
        };
        let written = serde_json::to_string(&shared).unwrap();
        assert_eq!(
            written,
            r#"{"kind":"sandbox","shares":[{"source":"/var/lib/wsp/logins/codex/auth.json","target":"/root/.codex/auth.json"}]}"#
        );
        assert_eq!(serde_json::from_str::<MachineSpec>(&written).unwrap(), shared);
        // Both paths are read by the wire's own rule: a bind mount is the one thing a slip cannot be taken back.
        for bad in [
            r#"{"kind":"sandbox","shares":[{"source":"logins/codex/auth.json","target":"/root/.codex/auth.json"}]}"#,
            r#"{"kind":"sandbox","shares":[{"source":"/var/lib/wsp/logins/../../root/.ssh/id","target":"/root/.codex/auth.json"}]}"#,
            r#"{"kind":"sandbox","shares":[{"source":"/var/lib/wsp/logins/codex/auth.json","target":"/root/../etc/passwd"}]}"#,
        ] {
            assert!(serde_json::from_str::<MachineSpec>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_backend_says_where_the_logins_it_shares_live_and_only_as_a_path() {
        let facts = r#"{"offer":"runtime","capabilities":{"liveCloneForks":false,"replacesMachine":true,"previewUrls":false,"signedUrls":false,"callbackRelay":false,"diskSnapshots":true,"snapshotsAnyLife":false,"snapshotListing":true,"templates":true,"sizes":[],"kept":false},"pricing":{"defaultSize":{"cpu":2,"memMb":4096},"snapshotStorage":{"freeGb":0,"usdPerGbMonth":0,"billedFrom":""}}}"#;
        assert_eq!(serde_json::from_str::<BackendFacts>(facts).unwrap().logins, None);
        let shared = facts.replace(r#"{"offer":"runtime""#, r#"{"logins":"/var/lib/wsp/logins","offer":"runtime""#);
        assert_eq!(serde_json::from_str::<BackendFacts>(&shared).unwrap().logins.as_deref(), Some("/var/lib/wsp/logins"));
        let relative = facts.replace(r#"{"offer":"runtime""#, r#"{"logins":"logins","offer":"runtime""#);
        assert!(serde_json::from_str::<BackendFacts>(&relative).is_err());
    }
}
