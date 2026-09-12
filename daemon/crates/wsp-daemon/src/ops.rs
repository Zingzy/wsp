// SPDX-License-Identifier: AGPL-3.0-only
//! The op switch behind the door: one request text in, one reply text out.

use std::num::NonZeroU16;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use wsp_frames::{
    numbers, words, DaemonErrorCode, DaemonErrorResponse, DaemonOp, Empty, FsReadEncoding, Reply, RequestId, DAEMON_OPS, MACHINE_OPS,
};

use crate::paths::OpError;
use crate::{fs, git, paths, Ctx};

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

/// An op's outcome on the wire: the body under the ok envelope, or the failure with its code when it carries one.
fn answer<T: Serialize>(id: Option<RequestId>, result: Result<T, OpError>) -> String {
    match result {
        Ok(body) => text(&Reply::new(id, body)),
        Err(OpError { code: Some(code), message }) => refuse(id, code, message),
        Err(OpError { code: None, message }) => text(&DaemonErrorResponse::new(id, message)),
    }
}

pub(crate) async fn handle(conn: &Conn, ctx: &Arc<Ctx>, raw: &str) -> String {
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
        Some(name @ ("fs.list" | "fs.read" | "git.status" | "git.diff")) => {
            // The typed frame: what the protocol's schema refuses, this refuses as a bad request.
            match serde_json::from_value::<DaemonOp>(frame.clone()) {
                Ok(typed) => serve(ctx, id, name, typed).await,
                Err(e) => refuse(id, DaemonErrorCode::BadRequest, e.to_string()),
            }
        }
        Some(name) if DAEMON_OPS.contains(&name) => refuse(id, DaemonErrorCode::Unsupported, not_built(name)),
        _ => text(&DaemonErrorResponse::new(id, words::unknown_op(&op_word(&frame)))),
    }
}

/// An op the protocol names that this daemon does not serve yet.
pub(crate) fn not_built(op: &str) -> String {
    format!("{op} is not served by this daemon yet")
}

/// The real path a request names, inside the daemon's root or a folder the roots file names as of this op.
async fn locate(ctx: &Ctx, requested: &str) -> Result<PathBuf, OpError> {
    let root = PathBuf::from(&ctx.root);
    let roots_path = ctx.options.roots_path.clone().unwrap_or_else(|| PathBuf::from(numbers::DAEMON_ROOTS_PATH));
    let requested = requested.to_owned();
    fs::blocking(move || paths::resolve_inside(&paths::roots_now(&root, &roots_path)?, &requested)).await
}

async fn serve(ctx: &Arc<Ctx>, id: Option<RequestId>, name: &str, op: DaemonOp) -> String {
    match op {
        DaemonOp::FsList { path, gitignore } => {
            let listed = async { fs::list_dir(locate(ctx, &path).await?, gitignore == Some(true), numbers::FS_LIST_CAP_ENTRIES).await };
            answer(id, listed.await)
        }
        DaemonOp::FsRead { path, encoding } => {
            let read = async {
                fs::read_file_bounded(locate(ctx, &path).await?, encoding.unwrap_or(FsReadEncoding::Utf8), numbers::FS_READ_CAP_BYTES).await
            };
            answer(id, read.await)
        }
        DaemonOp::GitStatus { cwd } => answer(id, async { git::git_status(&locate(ctx, &cwd).await?).await }.await),
        DaemonOp::GitDiff { cwd, scope, path } => {
            let diff = async { git::git_diff(&locate(ctx, &cwd).await?, scope, path.as_deref(), numbers::GIT_DIFF_CAP_BYTES).await };
            answer(id, diff.await)
        }
        _ => refuse(id, DaemonErrorCode::Unsupported, not_built(name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Options;
    use serde_json::json;
    use std::io::Write;

    struct Bench {
        ctx: Arc<Ctx>,
        _token: tempfile::NamedTempFile,
        root: tempfile::TempDir,
    }

    fn bench() -> Bench {
        let mut token = tempfile::NamedTempFile::new().unwrap();
        writeln!(token, "t").unwrap();
        let root = tempfile::tempdir().unwrap();
        let mut options = Options::new(token.path());
        options.root = Some(root.path().to_path_buf());
        options.roots_path = Some(root.path().join("roots"));
        Bench { ctx: Arc::new(Ctx::new(options)), _token: token, root }
    }

    fn open() -> Conn {
        Conn { scope: None }
    }

    async fn reply(b: &Bench, conn: &Conn, frame: Value) -> Value {
        serde_json::from_str(&handle(conn, &b.ctx, &frame.to_string()).await).unwrap()
    }

    async fn reply_raw(b: &Bench, conn: &Conn, raw: &str) -> Value {
        serde_json::from_str(&handle(conn, &b.ctx, raw).await).unwrap()
    }

    #[tokio::test]
    async fn ping_answers_the_bare_ok_envelope() {
        let b = bench();
        assert_eq!(reply(&b, &open(), json!({"id": 1, "op": "ping"})).await, json!({"id": 1, "ok": true}));
        assert_eq!(reply(&b, &open(), json!({"id": "a", "op": "ping", "pad": "x"})).await, json!({"id": "a", "ok": true}));
        assert_eq!(reply(&b, &open(), json!({"op": "ping"})).await, json!({"id": null, "ok": true}));
    }

    #[tokio::test]
    async fn invalid_json_is_answered_under_a_null_id() {
        let b = bench();
        assert_eq!(reply_raw(&b, &open(), "{nope").await, json!({"id": null, "ok": false, "error": "invalid json"}));
        assert_eq!(reply_raw(&b, &open(), "{\"id\": 1, \"op\": ").await, json!({"id": null, "ok": false, "error": "invalid json"}));
    }

    #[tokio::test]
    async fn a_json_value_that_is_not_an_object_is_an_unknown_op_as_the_node_daemon_reads_it() {
        let b = bench();
        for raw in ["[1,2,3]", "42", "\"x\"", "null", "true"] {
            assert_eq!(reply_raw(&b, &open(), raw).await, json!({"id": null, "ok": false, "error": "unknown op: undefined"}), "{raw}");
        }
        let scoped = Conn { scope: NonZeroU16::new(8123) };
        assert_eq!(reply_raw(&b, &scoped, "[1,2,3]").await["code"], "forbidden");
    }

    #[tokio::test]
    async fn an_unknown_op_is_named_never_silent() {
        let b = bench();
        assert_eq!(
            reply(&b, &open(), json!({"id": 3, "op": "sys.explode"})).await,
            json!({"id": 3, "ok": false, "error": "unknown op: sys.explode"})
        );
        assert_eq!(reply(&b, &open(), json!({"id": 4})).await, json!({"id": 4, "ok": false, "error": "unknown op: undefined"}));
        assert_eq!(reply(&b, &open(), json!({"id": 5, "op": 7})).await, json!({"id": 5, "ok": false, "error": "unknown op: 7"}));
    }

    #[tokio::test]
    async fn an_op_the_protocol_names_but_this_daemon_lacks_is_refused_by_name() {
        let b = bench();
        assert_eq!(
            reply(&b, &open(), json!({"id": 1, "op": "pty.create", "shell": "bash"})).await,
            json!({"id": 1, "ok": false, "code": "unsupported", "error": "pty.create is not served by this daemon yet"})
        );
        let built = ["ping", "place.leave", "fs.list", "fs.read", "git.status", "git.diff"];
        for op in DAEMON_OPS.iter().filter(|op| !built.contains(op)) {
            let out = reply(&b, &open(), json!({"id": 1, "op": op})).await;
            assert_eq!(out["code"], "unsupported", "{op}");
            assert_eq!(out["error"], format!("{op} is not served by this daemon yet"));
        }
    }

    #[tokio::test]
    async fn link_only_ops_are_forbidden_on_an_inbound_socket() {
        let b = bench();
        assert_eq!(
            reply(&b, &open(), json!({"id": 1, "op": "place.leave"})).await,
            json!({"id": 1, "ok": false, "code": "forbidden", "error": words::PLACE_LEAVE_ROAD_REFUSAL})
        );
        for op in MACHINE_OPS {
            assert_eq!(
                reply(&b, &open(), json!({"id": 2, "op": op})).await,
                json!({"id": 2, "ok": false, "code": "forbidden", "error": "not on this road"}),
                "{op}"
            );
        }
    }

    #[tokio::test]
    async fn a_port_scoped_socket_answers_ping_and_tunnel_ops_on_its_port_alone() {
        let b = bench();
        let scoped = Conn { scope: NonZeroU16::new(8123) };
        assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": "ping"})).await, json!({"id": 1, "ok": true}));
        let refused = json!({"id": 1, "ok": false, "code": "forbidden", "error": "this socket is scoped to port 8123: only tunnel ops on it and ping are allowed"});
        for op in [
            "pty.create",
            "pty.list",
            "fs.list",
            "fs.read",
            "git.status",
            "git.diff",
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
            assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": op, "path": ".", "cwd": ".", "scope": "staged"})).await, refused, "{op}");
        }
        assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": "tunnel.open", "tunnelId": "t", "port": 8124})).await, refused);
        let in_scope = reply(&b, &scoped, json!({"id": 1, "op": "tunnel.open", "tunnelId": "t", "port": 8123})).await;
        assert_ne!(in_scope["error"], refused["error"]);
        assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": "tunnel.write", "tunnelId": "t", "data": ""})).await["code"], "unsupported");
        assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": "tunnel.close", "tunnelId": "t"})).await["code"], "unsupported");
    }

    #[tokio::test]
    async fn a_frame_the_protocol_refuses_is_a_bad_request_and_a_coded_refusal_carries_its_code() {
        let b = bench();
        for frame in [
            json!({"id": 1, "op": "fs.list", "path": 7}),
            json!({"id": 1, "op": "fs.list"}),
            json!({"id": 1, "op": "fs.read", "path": "x", "encoding": "hex"}),
            json!({"id": 1, "op": "git.status"}),
            json!({"id": 1, "op": "git.diff", "cwd": ".", "scope": "all"}),
            json!({"id": 1, "op": "git.diff", "cwd": "."}),
            json!({"id": 1, "op": "git.diff", "cwd": ".", "scope": "staged", "path": 3}),
        ] {
            let out = reply(&b, &open(), frame.clone()).await;
            assert_eq!((out["ok"].as_bool(), out["code"].as_str()), (Some(false), Some("bad-request")), "{frame}");
        }
        let missing = b.root.path().join("none.txt");
        assert_eq!(
            reply(&b, &open(), json!({"id": 2, "op": "fs.read", "path": "none.txt"})).await,
            json!({"id": 2, "ok": false, "code": "not-found", "error": "none.txt does not exist"})
        );
        assert_eq!(reply(&b, &open(), json!({"id": 3, "op": "fs.list", "path": missing})).await["code"], "not-found");
        assert_eq!(
            reply(&b, &open(), json!({"id": 4, "op": "git.status", "cwd": "/etc"})).await,
            json!({"id": 4, "ok": false, "code": "outside-root", "error": "/etc resolves outside the workspace root"})
        );
        let listed = reply(&b, &open(), json!({"id": 5, "op": "fs.list", "path": "."})).await;
        assert_eq!(listed, json!({"id": 5, "ok": true, "entries": [], "truncated": false, "total": 0}));
    }
}
