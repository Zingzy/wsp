// SPDX-License-Identifier: AGPL-3.0-only
//! The op switch behind the door: one request text in, one reply text out.

use std::num::NonZeroU16;

use serde_json::Value;
use wsp_frames::{words, DaemonErrorCode, DaemonErrorResponse, Empty, Reply, RequestId, DAEMON_OPS, MACHINE_OPS};

/// What one authed socket holds between frames.
pub(crate) struct Conn {
    /// Set when the auth frame named a port: only tunnel ops on it and ping are answered.
    pub(crate) scope: Option<NonZeroU16>,
}

/// Every reply is one JSON object; serialising the envelope types cannot fail.
fn text(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("a reply serialises")
}

fn ok(id: Option<RequestId>) -> String {
    text(&Reply::new(id, Empty {}))
}

fn refuse(id: Option<RequestId>, code: DaemonErrorCode, error: impl Into<String>) -> String {
    text(&DaemonErrorResponse::new(id, error).with_code(code))
}

/// The id as the reply echoes it: the string or number the frame carried, null for anything else.
fn id_of(frame: &Value) -> Option<RequestId> {
    frame.get("id").and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// The op as the unknown-op sentence names it: the string itself, or the JSON of whatever else was there.
fn op_word(frame: &Value) -> String {
    match frame.get("op") {
        None => "undefined".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// A port-scoped socket is there to tunnel one port; ping keeps it alive and nothing else is its business.
fn in_port_scope(port: NonZeroU16, frame: &Value) -> bool {
    match frame.get("op").and_then(Value::as_str) {
        Some("ping" | "tunnel.write" | "tunnel.close") => true,
        Some("tunnel.open") => frame.get("port").and_then(Value::as_u64) == Some(u64::from(port.get())),
        _ => false,
    }
}

pub(crate) fn handle(conn: &Conn, raw: &str) -> String {
    // Any JSON value is a frame, as the node daemon reads it; a non-object simply carries no op and no id.
    let Ok(frame) = serde_json::from_str::<Value>(raw) else {
        return text(&DaemonErrorResponse::new(None, words::INVALID_JSON));
    };
    let id = id_of(&frame);
    if let Some(port) = conn.scope {
        if !in_port_scope(port, &frame) {
            return refuse(id, DaemonErrorCode::Forbidden, words::port_scope_refusal(port.get()));
        }
    }
    let op = frame.get("op").and_then(Value::as_str);
    match op {
        Some("ping") => ok(id),
        Some("place.leave") => refuse(id, DaemonErrorCode::Forbidden, words::PLACE_LEAVE_ROAD_REFUSAL),
        Some(name) if MACHINE_OPS.contains(&name) => refuse(id, DaemonErrorCode::Forbidden, words::NOT_ON_THIS_ROAD),
        Some(name) if DAEMON_OPS.contains(&name) => refuse(id, DaemonErrorCode::Unsupported, not_built(name)),
        _ => text(&DaemonErrorResponse::new(id, words::unknown_op(&op_word(&frame)))),
    }
}

/// An op the protocol names that this daemon does not serve yet.
pub(crate) fn not_built(op: &str) -> String {
    format!("{op} is not served by this daemon yet")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open() -> Conn {
        Conn { scope: None }
    }

    fn reply(conn: &Conn, frame: Value) -> Value {
        serde_json::from_str(&handle(conn, &frame.to_string())).unwrap()
    }

    #[test]
    fn ping_answers_the_bare_ok_envelope() {
        assert_eq!(reply(&open(), json!({"id": 1, "op": "ping"})), json!({"id": 1, "ok": true}));
        assert_eq!(reply(&open(), json!({"id": "a", "op": "ping", "pad": "x"})), json!({"id": "a", "ok": true}));
        assert_eq!(reply(&open(), json!({"op": "ping"})), json!({"id": null, "ok": true}));
    }

    #[test]
    fn invalid_json_is_answered_under_a_null_id() {
        let out: Value = serde_json::from_str(&handle(&open(), "{nope")).unwrap();
        assert_eq!(out, json!({"id": null, "ok": false, "error": "invalid json"}));
        let out: Value = serde_json::from_str(&handle(&open(), "{\"id\": 1, \"op\": ")).unwrap();
        assert_eq!(out, json!({"id": null, "ok": false, "error": "invalid json"}));
    }

    #[test]
    fn a_json_value_that_is_not_an_object_is_an_unknown_op_as_the_node_daemon_reads_it() {
        for raw in ["[1,2,3]", "42", "\"x\"", "null", "true"] {
            let out: Value = serde_json::from_str(&handle(&open(), raw)).unwrap();
            assert_eq!(out, json!({"id": null, "ok": false, "error": "unknown op: undefined"}), "{raw}");
        }
        let scoped = Conn { scope: NonZeroU16::new(8123) };
        let out: Value = serde_json::from_str(&handle(&scoped, "[1,2,3]")).unwrap();
        assert_eq!(out["code"], "forbidden");
    }

    #[test]
    fn an_unknown_op_is_named_never_silent() {
        assert_eq!(
            reply(&open(), json!({"id": 3, "op": "sys.explode"})),
            json!({"id": 3, "ok": false, "error": "unknown op: sys.explode"})
        );
        assert_eq!(reply(&open(), json!({"id": 4})), json!({"id": 4, "ok": false, "error": "unknown op: undefined"}));
        assert_eq!(reply(&open(), json!({"id": 5, "op": 7})), json!({"id": 5, "ok": false, "error": "unknown op: 7"}));
    }

    #[test]
    fn an_op_the_protocol_names_but_this_daemon_lacks_is_refused_by_name() {
        assert_eq!(
            reply(&open(), json!({"id": 1, "op": "pty.create", "shell": "bash"})),
            json!({"id": 1, "ok": false, "code": "unsupported", "error": "pty.create is not served by this daemon yet"})
        );
        for op in DAEMON_OPS.iter().filter(|op| !matches!(**op, "ping" | "place.leave")) {
            let out = reply(&open(), json!({"id": 1, "op": op}));
            assert_eq!(out["code"], "unsupported", "{op}");
            assert_eq!(out["error"], format!("{op} is not served by this daemon yet"));
        }
    }

    #[test]
    fn link_only_ops_are_forbidden_on_an_inbound_socket() {
        assert_eq!(
            reply(&open(), json!({"id": 1, "op": "place.leave"})),
            json!({"id": 1, "ok": false, "code": "forbidden", "error": words::PLACE_LEAVE_ROAD_REFUSAL})
        );
        for op in MACHINE_OPS {
            assert_eq!(
                reply(&open(), json!({"id": 2, "op": op})),
                json!({"id": 2, "ok": false, "code": "forbidden", "error": "not on this road"}),
                "{op}"
            );
        }
    }

    #[test]
    fn a_port_scoped_socket_answers_ping_and_tunnel_ops_on_its_port_alone() {
        let scoped = Conn { scope: NonZeroU16::new(8123) };
        assert_eq!(reply(&scoped, json!({"id": 1, "op": "ping"})), json!({"id": 1, "ok": true}));
        let refused = json!({"id": 1, "ok": false, "code": "forbidden", "error": "this socket is scoped to port 8123: only tunnel ops on it and ping are allowed"});
        for op in [
            "pty.create",
            "pty.list",
            "fs.list",
            "git.status",
            "ports.watch",
            "sys.watch",
            "proc.watch",
            "proc.inspect",
            "proc.kill",
            "manifest.get",
            "machine.create",
            "place.leave",
            "nonsense",
        ] {
            assert_eq!(reply(&scoped, json!({"id": 1, "op": op})), refused, "{op}");
        }
        assert_eq!(reply(&scoped, json!({"id": 1, "op": "tunnel.open", "tunnelId": "t", "port": 8124})), refused);
        let in_scope = reply(&scoped, json!({"id": 1, "op": "tunnel.open", "tunnelId": "t", "port": 8123}));
        assert_ne!(in_scope["error"], refused["error"]);
        assert_eq!(reply(&scoped, json!({"id": 1, "op": "tunnel.write", "tunnelId": "t", "data": ""}))["code"], "unsupported");
        assert_eq!(reply(&scoped, json!({"id": 1, "op": "tunnel.close", "tunnelId": "t"}))["code"], "unsupported");
    }
}
