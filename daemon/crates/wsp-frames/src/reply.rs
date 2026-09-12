// SPDX-License-Identifier: AGPL-3.0-only
//! Replies carry no op, so each op with a body of its own has a struct here and rides the one envelope.

use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize, Serializer};

use crate::{DaemonErrorCode, FsEntryType, MachineErrorKind, RequestId};

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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply<T> {
    pub id: Option<RequestId>,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonErrorResponse {
    pub id: Option<RequestId>,
    pub ok: False,
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<DaemonErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MachineErrorKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Empty {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyCreateReply {
    pub pty_id: String,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyAttachReply {
    pub pty_id: String,
}

/// One live or exited pty the daemon still holds; exited ones stay until pty.kill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PtyListEntry {
    pub id: String,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub exited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PtyListReply {
    pub ptys: Vec<PtyListEntry>,
}

/// One listening TCP port as the watcher reads it. pid is null where no owner was found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListeningPort {
    pub port: u16,
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inode: Option<u64>,
    pub uid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub loopback: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortsWatchReply {
    pub ports: Vec<ListeningPort>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub id: String,
    pub cmd: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestGetReply {
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestRecordReply {
    pub entry: ManifestEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestRestartScriptReply {
    pub script: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboxRescanReply {
    pub count: u64,
}

/// cwd is null when unreadable; threads is absent where the machine's processes module cannot count them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcInspectReply {
    pub pid: u32,
    pub cwd: Option<String>,
    pub ports: Vec<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threads: Option<u32>,
    pub children: Vec<u32>,
}

/// name is the entry's own name in the listed directory; size is 0 for anything but a file; mtime is epoch ms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FsEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: FsEntryType,
    pub size: u64,
    pub mtime: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FsListReply {
    pub entries: Vec<FsEntry>,
    pub truncated: bool,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FsReadReply {
    pub content: String,
    pub size: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitBranch {
    pub oid: String,
    pub head: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub xy: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitStatusReply {
    pub branch: GitBranch,
    pub entries: Vec<GitStatusEntry>,
    pub root: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitDiffFile {
    pub path: String,
    pub patch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GitDiffReply {
    pub base: Option<String>,
    pub files: Vec<GitDiffFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonExecReply {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceLeaveReply {
    pub swept: Vec<String>,
}
