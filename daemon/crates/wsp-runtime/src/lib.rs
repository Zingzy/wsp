// SPDX-License-Identifier: AGPL-3.0-only
//! The workspace manager behind the machine ops on a place link. Until a backend exists here, every machine op
//! the link carries is answered with one refusal that names it.

use wsp_frames::{DaemonErrorResponse, RequestId};

/// What a machine op gets on a computer whose daemon holds no backend yet.
pub fn no_backend_refusal(op: &str) -> String {
    format!("this computer's backend has no {op}")
}

/// The reply to any machine op on the link: the refusal above under the request's id.
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
