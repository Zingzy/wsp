// SPDX-License-Identifier: AGPL-3.0-only
//! The machine ops a host sends down a place link, as the engine's MachineBackend and Machine interfaces carry
//! them. The daemon refuses them on every socket that is not the link; the runtime crate answers them there.

use std::collections::BTreeMap;
use std::num::NonZeroU16;

use serde::{Deserialize, Serialize};

use crate::validate::{bounded, positive};
use crate::RequestId;

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
