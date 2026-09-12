// SPDX-License-Identifier: AGPL-3.0-only
//! The workspace manager behind the machine ops on a place link. The layer store and the registry fetch hold the
//! image; on Linux the bundle, the runtime, the freezer and the ops run workspaces from it through youki's library
//! and answer every `machine.*` frame, the net module gives each workspace its network and its published ports,
//! and the snapshot module saves a workspace's upper directory as a layer the store holds. Every op on another
//! platform is answered with one refusal that names it.

#[cfg(target_os = "linux")]
pub mod bundle;
pub mod fetch;
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
#[cfg(target_os = "linux")]
pub mod snapshot;
pub mod store;

use wsp_frames::{DaemonErrorResponse, RequestId};

/// Where the runtime keeps everything it owns on a computer somebody joined, layers under it.
pub const DEFAULT_ROOT: &str = "/var/lib/wsp";

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
