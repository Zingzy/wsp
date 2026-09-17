// SPDX-License-Identifier: AGPL-3.0-only
//! The workspace manager behind the machine ops on a place link. A workspace on a computer somebody owns is that
//! computer's own system directories under a read-only overlay each, the box's /root, and one copy of a checkout
//! on it: on Linux the bundle, the runtime, the freezer and the ops boot it through youki's library and answer
//! every `machine.*` frame, the copy modules make the per-workspace copy the way the disk makes one, and the net
//! module gives each workspace its network and its published ports. This computer keeps no image: nothing is
//! pulled and nothing is built here. Every op on another platform is answered with one refusal that names it.

#[cfg(target_os = "linux")]
pub mod bundle;
pub mod copy;
#[cfg(target_os = "linux")]
pub mod copy_plain;
#[cfg(target_os = "linux")]
pub mod copy_reflink;
pub mod copy_road;
#[cfg(target_os = "linux")]
pub mod copy_snapshot;
pub mod doctor;
#[cfg(target_os = "linux")]
pub mod engine;
#[cfg(target_os = "linux")]
pub mod freeze;
#[cfg(target_os = "linux")]
pub mod init;
#[cfg(target_os = "linux")]
pub mod net;
#[cfg(target_os = "linux")]
pub mod nft;
#[cfg(target_os = "linux")]
pub mod ops;
#[cfg(target_os = "linux")]
pub mod profile;
#[cfg(target_os = "linux")]
pub mod runtime;
pub mod size;

use wsp_frames::{DaemonErrorResponse, RequestId};

/// Where the runtime keeps everything it owns on a computer somebody joined: the workspaces, their copies and the
/// checkouts those are made from. Not under any directory a workspace's overlay takes as a lower, which is what
/// `/var/lib/wsp` was: a workspace's upper would sit inside the tree it reads through the overlay, and the open
/// refuses such a root rather than serving workspaces that read their own uppers.
pub const DEFAULT_ROOT: &str = "/wsp";

/// What a machine op gets on a computer whose daemon holds no backend for it.
pub fn no_backend_refusal(op: &str) -> String {
    format!("this computer's backend has no {op}")
}

/// The reply to a machine op nothing here serves: the refusal above under the request's id.
pub fn answer_machine_op(id: Option<RequestId>, op: &str) -> DaemonErrorResponse {
    DaemonErrorResponse::new(id, no_backend_refusal(op))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_refusal_names_the_op() {
        let reply = answer_machine_op(Some(RequestId::from(7)), "machine.create");
        assert_eq!(reply.error, "this computer's backend has no machine.create");
        assert_eq!(
            serde_json::to_value(&reply).unwrap(),
            serde_json::json!({ "id": 7, "ok": false, "error": "this computer's backend has no machine.create" })
        );
    }
}
