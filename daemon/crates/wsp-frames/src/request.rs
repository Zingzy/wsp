// SPDX-License-Identifier: AGPL-3.0-only
use std::collections::BTreeMap;
use std::num::{NonZeroU16, NonZeroU32};

use serde::{Deserialize, Serialize};

use crate::validate::{bounded, exec_timeout};
use crate::{FsReadEncoding, GitDiffScope, ProcSignal, RequestId};

/// One request on an authed socket: the id the reply echoes and the op with its parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonRequest {
    pub id: RequestId,
    #[serde(flatten)]
    pub op: DaemonOp,
}

/// Every op the protocol's DaemonRequest names, keyed on `op` as the zod discriminated union is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum DaemonOp {
    #[serde(rename = "pty.create", rename_all = "camelCase")]
    PtyCreate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cols: Option<NonZeroU16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rows: Option<NonZeroU16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<BTreeMap<String, String>>,
    },
    #[serde(rename = "pty.attach", rename_all = "camelCase")]
    PtyAttach { pty_id: String },
    #[serde(rename = "pty.write", rename_all = "camelCase")]
    PtyWrite { pty_id: String, data: String },
    #[serde(rename = "pty.resize", rename_all = "camelCase")]
    /// A size of zero is refused here as node-pty refuses it; the protocol's number says only "number".
    PtyResize { pty_id: String, cols: NonZeroU16, rows: NonZeroU16 },
    #[serde(rename = "pty.kill", rename_all = "camelCase")]
    PtyKill { pty_id: String },
    #[serde(rename = "pty.list")]
    PtyList,
    #[serde(rename = "ports.watch")]
    PortsWatch,
    #[serde(rename = "manifest.get")]
    ManifestGet,
    #[serde(rename = "manifest.record", rename_all = "camelCase")]
    ManifestRecord {
        cmd: String,
        cwd: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
    },
    #[serde(rename = "manifest.restartScript")]
    ManifestRestartScript,
    #[serde(rename = "inbox.watch")]
    InboxWatch,
    #[serde(rename = "inbox.rescan")]
    InboxRescan,
    #[serde(rename = "sys.watch")]
    SysWatch,
    #[serde(rename = "proc.watch")]
    ProcWatch,
    #[serde(rename = "proc.unwatch")]
    ProcUnwatch,
    #[serde(rename = "proc.inspect")]
    ProcInspect { pid: NonZeroU32 },
    #[serde(rename = "proc.kill")]
    ProcKill { pid: NonZeroU32, signal: ProcSignal },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "fs.list", rename_all = "camelCase")]
    FsList {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gitignore: Option<bool>,
    },
    #[serde(rename = "fs.read", rename_all = "camelCase")]
    FsRead {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encoding: Option<FsReadEncoding>,
    },
    #[serde(rename = "git.status")]
    GitStatus { cwd: String },
    #[serde(rename = "git.diff", rename_all = "camelCase")]
    GitDiff {
        cwd: String,
        scope: GitDiffScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    #[serde(rename = "tunnel.open", rename_all = "camelCase")]
    TunnelOpen { tunnel_id: String, port: NonZeroU16 },
    #[serde(rename = "tunnel.write", rename_all = "camelCase")]
    TunnelWrite { tunnel_id: String, data: String },
    #[serde(rename = "tunnel.close", rename_all = "camelCase")]
    TunnelClose { tunnel_id: String },
    #[serde(rename = "exec", rename_all = "camelCase")]
    Exec {
        #[serde(deserialize_with = "bounded::<_, 0, { crate::numbers::EXEC_BODY_MAX }>")]
        cmd: String,
        #[serde(default, deserialize_with = "exec_timeout", skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stdin: Option<String>,
    },
    #[serde(rename = "place.leave")]
    PlaceLeave,
}

/// The op names above, in the protocol's order; the daemon's switch reads this to tell an op it knows from one it
/// does not.
pub const DAEMON_OPS: [&str; 27] = [
    "pty.create",
    "pty.attach",
    "pty.write",
    "pty.resize",
    "pty.kill",
    "pty.list",
    "ports.watch",
    "manifest.get",
    "manifest.record",
    "manifest.restartScript",
    "inbox.watch",
    "inbox.rescan",
    "sys.watch",
    "proc.watch",
    "proc.unwatch",
    "proc.inspect",
    "proc.kill",
    "ping",
    "fs.list",
    "fs.read",
    "git.status",
    "git.diff",
    "tunnel.open",
    "tunnel.write",
    "tunnel.close",
    "exec",
    "place.leave",
];
