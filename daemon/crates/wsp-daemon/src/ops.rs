// SPDX-License-Identifier: AGPL-3.0-only
//! The op switch behind the door: one request text in, one reply text out, with the events an op raises going out
//! through the socket's own channel.

use std::num::NonZeroU16;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use wsp_frames::{
    numbers, words, DaemonErrorCode, DaemonErrorResponse, DaemonOp, Empty, FsReadEncoding, PtyAttachReply, PtyCreateReply, PtyListReply,
    Reply, RequestId, DAEMON_OPS, MACHINE_OPS,
};

use crate::exec::{run_exec, ExecOptions};
use crate::paths::OpError;
use crate::pty::{passwd_row, process_env, pump, PtyCreateOpts};
use crate::{frame_text as text, fs, git, paths, Ctx, Listener, Outbound};

type Detach = Box<dyn FnOnce() + Send>;

/// What one authed socket holds between frames.
pub(crate) struct Conn {
    /// Set when the auth frame named a port: only tunnel ops on it and ping are answered.
    pub(crate) scope: Option<NonZeroU16>,
    pub(crate) out: Outbound,
    /// What the socket's close undoes: every pty and mode listener an attach on it made. None once closed, so an
    /// attach still being answered when the socket went undoes itself at once instead of outliving it.
    detaches: Mutex<Option<Vec<Detach>>>,
}

impl Conn {
    pub(crate) fn new(scope: Option<NonZeroU16>, out: Outbound) -> Conn {
        Conn { scope, out, detaches: Mutex::new(Some(Vec::new())) }
    }

    fn on_close(&self, detach: Detach) {
        match &mut *self.detaches.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(pending) => pending.push(detach),
            None => detach(),
        }
    }

    pub(crate) fn close(&self) {
        let detaches = self.detaches.lock().unwrap_or_else(|e| e.into_inner()).take();
        for detach in detaches.into_iter().flatten() {
            detach();
        }
    }
}

fn ok(id: Option<RequestId>) -> String {
    text(&Reply::new(id, Empty {}))
}

fn fail(id: Option<RequestId>, error: impl Into<String>) -> String {
    text(&DaemonErrorResponse::new(id, error))
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

/// Base64 as node's Buffer reads it: padding optional, characters outside the alphabet skipped.
fn lenient_base64(text: &str) -> Vec<u8> {
    let clean: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_'))
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    let config = GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::Indifferent);
    GeneralPurpose::new(&base64::alphabet::STANDARD, config).decode(&clean).unwrap_or_default()
}

/// An op's outcome on the wire: the body under the ok envelope, or the failure with its code when it carries one.
fn answer<T: Serialize>(id: Option<RequestId>, result: Result<T, OpError>) -> String {
    match result {
        Ok(body) => text(&Reply::new(id, body)),
        Err(OpError { code: Some(code), message }) => refuse(id, code, message),
        Err(OpError { code: None, message }) => text(&DaemonErrorResponse::new(id, message)),
    }
}

pub(crate) async fn handle(conn: &Arc<Conn>, ctx: &Arc<Ctx>, raw: &str) -> String {
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
        // The leave op and the machine ops are the link's; one sentence for the one rule, as the node daemon says it.
        Some(name) if name == "place.leave" || MACHINE_OPS.contains(&name) => {
            refuse(id, DaemonErrorCode::Forbidden, words::NOT_ON_THIS_ROAD)
        }
        Some(
            name @ ("pty.create" | "pty.attach" | "pty.write" | "pty.resize" | "pty.kill" | "pty.list" | "exec" | "fs.list" | "fs.read"
            | "git.status" | "git.diff"),
        ) => {
            // The typed frame: what the protocol's schema refuses, this refuses as a bad request.
            match serde_json::from_value::<DaemonOp>(frame.clone()) {
                Ok(typed) => serve(conn, ctx, id, name, typed).await,
                Err(e) => refuse(id, DaemonErrorCode::BadRequest, e.to_string()),
            }
        }
        Some(name) if DAEMON_OPS.contains(&name) => refuse(id, DaemonErrorCode::Unsupported, not_built(name)),
        _ => fail(id, words::unknown_op(&op_word(&frame))),
    }
}

/// An op the protocol names that this daemon does not serve yet.
pub(crate) fn not_built(op: &str) -> String {
    format!("{op} is not served by this daemon yet")
}

fn no_such_pty(pty_id: &str) -> String {
    format!("no such pty: {pty_id}")
}

/// The real path a request names, inside the daemon's root or a folder the roots file names as of this op.
async fn locate(ctx: &Ctx, requested: &str) -> Result<PathBuf, OpError> {
    let root = PathBuf::from(&ctx.root);
    let roots_path = ctx.options.roots_path.clone().unwrap_or_else(|| PathBuf::from(numbers::DAEMON_ROOTS_PATH));
    let requested = requested.to_owned();
    fs::blocking(move || paths::resolve_inside(&paths::roots_now(&root, &roots_path)?, &requested)).await
}

async fn serve(conn: &Arc<Conn>, ctx: &Arc<Ctx>, id: Option<RequestId>, name: &str, op: DaemonOp) -> String {
    match op {
        DaemonOp::PtyCreate { cols, rows, shell, cwd, env } => {
            let opts = PtyCreateOpts { cols: cols.map(NonZeroU16::get), rows: rows.map(NonZeroU16::get), shell, cwd, env };
            let spawned = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).create(&opts, &process_env(), passwd_row().as_ref());
            match spawned {
                Ok(spawned) => {
                    let reply = PtyCreateReply { pty_id: spawned.id.clone(), pid: spawned.pid };
                    tokio::spawn(pump(Arc::clone(ctx), spawned));
                    text(&Reply::new(id, reply))
                }
                Err(e) => fail(id, e.to_string()),
            }
        }
        DaemonOp::PtyAttach { pty_id } => {
            let key = ctx.next_key();
            let listener = || Listener { key, out: conn.out.clone() };
            let live = {
                let mut ptys = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner());
                let Some(session) = ptys.get_mut(&pty_id) else { return fail(id, no_such_pty(&pty_id)) };
                session.attach(listener());
                session.on_exit(listener());
                session.exited.is_none().then_some(session.pid)
            };
            // An exited pty tells the newcomer so at once and is never probed again.
            if let Some(pid) = live {
                ctx.modes.attach(&pty_id, pid, listener());
            }
            let (ctx2, pty) = (Arc::clone(ctx), pty_id.clone());
            conn.on_close(Box::new(move || {
                if let Some(session) = ctx2.ptys.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&pty) {
                    session.detach(key);
                }
                ctx2.modes.detach(&pty, key);
            }));
            text(&Reply::new(id, PtyAttachReply { pty_id }))
        }
        DaemonOp::PtyWrite { pty_id, data } => match ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&pty_id) {
            Some(session) => {
                session.write(&data);
                ok(id)
            }
            None => fail(id, no_such_pty(&pty_id)),
        },
        DaemonOp::PtyResize { pty_id, cols, rows } => match ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&pty_id) {
            Some(session) => match session.resize(cols.get(), rows.get()) {
                Ok(()) => ok(id),
                Err(e) => fail(id, e.to_string()),
            },
            None => fail(id, no_such_pty(&pty_id)),
        },
        DaemonOp::PtyKill { pty_id } => {
            let mut ptys = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner());
            if ptys.get_mut(&pty_id).is_none() {
                return fail(id, no_such_pty(&pty_id));
            }
            ctx.modes.remove(&pty_id);
            ptys.destroy(&pty_id);
            ok(id)
        }
        DaemonOp::PtyList => text(&Reply::new(id, PtyListReply { ptys: ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).list() })),
        DaemonOp::Exec { cmd, timeout_ms, stdin } => {
            let env: Vec<_> = std::env::vars_os().collect();
            let opts = ExecOptions {
                timeout: Duration::from_millis(u64::from(timeout_ms.unwrap_or(numbers::EXEC_TIMEOUT_DEFAULT_MS))),
                stdin: stdin.as_deref().map(lenient_base64),
                output_max: numbers::EXEC_OUTPUT_MAX,
            };
            text(&Reply::new(id, run_exec(Path::new(&ctx.root), &env, &cmd, opts).await))
        }
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
    use tokio::sync::mpsc;

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

    fn conn(scope: Option<u16>) -> (Arc<Conn>, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(Conn::new(scope.and_then(NonZeroU16::new), Outbound(tx))), rx)
    }

    async fn reply(bench: &Bench, conn: &Arc<Conn>, frame: Value) -> Value {
        serde_json::from_str(&handle(conn, &bench.ctx, &frame.to_string()).await).unwrap()
    }

    async fn reply_raw(bench: &Bench, conn: &Arc<Conn>, raw: &str) -> Value {
        serde_json::from_str(&handle(conn, &bench.ctx, raw).await).unwrap()
    }

    #[tokio::test]
    async fn ping_answers_the_bare_ok_envelope() {
        let b = bench();
        let (c, _rx) = conn(None);
        assert_eq!(reply(&b, &c, json!({"id": 1, "op": "ping"})).await, json!({"id": 1, "ok": true}));
        assert_eq!(reply(&b, &c, json!({"id": "a", "op": "ping", "pad": "x"})).await, json!({"id": "a", "ok": true}));
        assert_eq!(reply(&b, &c, json!({"op": "ping"})).await, json!({"id": null, "ok": true}));
    }

    #[tokio::test]
    async fn invalid_json_is_answered_under_a_null_id() {
        let b = bench();
        let (c, _rx) = conn(None);
        assert_eq!(reply_raw(&b, &c, "{nope").await, json!({"id": null, "ok": false, "error": "invalid json"}));
        assert_eq!(reply_raw(&b, &c, "{\"id\": 1, \"op\": ").await, json!({"id": null, "ok": false, "error": "invalid json"}));
    }

    #[tokio::test]
    async fn a_json_value_that_is_not_an_object_is_an_unknown_op_as_the_node_daemon_reads_it() {
        let b = bench();
        let (c, _rx) = conn(None);
        for raw in ["[1,2,3]", "42", "\"x\"", "null", "true"] {
            assert_eq!(reply_raw(&b, &c, raw).await, json!({"id": null, "ok": false, "error": "unknown op: undefined"}), "{raw}");
        }
        let (scoped, _rx) = conn(Some(8123));
        assert_eq!(reply_raw(&b, &scoped, "[1,2,3]").await["code"], "forbidden");
    }

    #[tokio::test]
    async fn an_unknown_op_is_named_never_silent() {
        let b = bench();
        let (c, _rx) = conn(None);
        assert_eq!(
            reply(&b, &c, json!({"id": 3, "op": "sys.explode"})).await,
            json!({"id": 3, "ok": false, "error": "unknown op: sys.explode"})
        );
        assert_eq!(reply(&b, &c, json!({"id": 4})).await, json!({"id": 4, "ok": false, "error": "unknown op: undefined"}));
        assert_eq!(reply(&b, &c, json!({"id": 5, "op": 7})).await, json!({"id": 5, "ok": false, "error": "unknown op: 7"}));
    }

    #[tokio::test]
    async fn an_op_the_protocol_names_but_this_daemon_lacks_is_refused_by_name() {
        let b = bench();
        let (c, _rx) = conn(None);
        assert_eq!(
            reply(&b, &c, json!({"id": 1, "op": "ports.watch"})).await,
            json!({"id": 1, "ok": false, "code": "unsupported", "error": "ports.watch is not served by this daemon yet"})
        );
        let built = [
            "ping",
            "place.leave",
            "pty.create",
            "pty.attach",
            "pty.write",
            "pty.resize",
            "pty.kill",
            "pty.list",
            "exec",
            "fs.list",
            "fs.read",
            "git.status",
            "git.diff",
        ];
        for op in DAEMON_OPS.iter().filter(|op| !built.contains(op)) {
            let out = reply(&b, &c, json!({"id": 1, "op": op})).await;
            assert_eq!(out["code"], "unsupported", "{op}");
            assert_eq!(out["error"], format!("{op} is not served by this daemon yet"));
        }
    }

    #[tokio::test]
    async fn link_only_ops_are_forbidden_on_an_inbound_socket() {
        let b = bench();
        let (c, _rx) = conn(None);
        assert_eq!(
            reply(&b, &c, json!({"id": 1, "op": "place.leave"})).await,
            json!({"id": 1, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD})
        );
        for op in MACHINE_OPS {
            assert_eq!(
                reply(&b, &c, json!({"id": 2, "op": op})).await,
                json!({"id": 2, "ok": false, "code": "forbidden", "error": "not on this road"}),
                "{op}"
            );
        }
    }

    #[tokio::test]
    async fn a_port_scoped_socket_answers_ping_and_tunnel_ops_on_its_port_alone() {
        let b = bench();
        let (scoped, _rx) = conn(Some(8123));
        assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": "ping"})).await, json!({"id": 1, "ok": true}));
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
            "exec",
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
    async fn a_frame_the_protocol_refuses_is_a_bad_request_and_a_pty_nobody_opened_is_named() {
        let b = bench();
        let (c, _rx) = conn(None);
        for frame in [
            json!({"id": 1, "op": "exec", "cmd": 3}),
            json!({"id": 1, "op": "exec", "cmd": "echo x", "timeoutMs": -1}),
            json!({"id": 1, "op": "exec", "cmd": "echo x", "stdin": 3}),
            json!({"id": 1, "op": "pty.resize", "ptyId": "pty_1", "cols": "wide"}),
            json!({"id": 1, "op": "pty.resize", "ptyId": "pty_1", "cols": 0, "rows": 24}),
            json!({"id": 1, "op": "pty.create", "cols": 80, "rows": 0}),
        ] {
            let out = reply(&b, &c, frame.clone()).await;
            assert_eq!((out["ok"].as_bool(), out["code"].as_str()), (Some(false), Some("bad-request")), "{frame}");
        }
        assert_eq!(
            reply(&b, &c, json!({"id": 2, "op": "pty.write", "ptyId": "pty_9", "data": "x"})).await,
            json!({"id": 2, "ok": false, "error": "no such pty: pty_9"})
        );
        assert_eq!(reply(&b, &c, json!({"id": 3, "op": "pty.attach", "ptyId": "pty_9"})).await["error"], "no such pty: pty_9");
        assert_eq!(reply(&b, &c, json!({"id": 4, "op": "pty.kill", "ptyId": "pty_9"})).await["error"], "no such pty: pty_9");
        assert_eq!(reply(&b, &c, json!({"id": 5, "op": "pty.list"})).await, json!({"id": 5, "ok": true, "ptys": []}));
    }

    #[tokio::test]
    async fn a_frame_the_protocol_refuses_is_a_bad_request_and_a_coded_refusal_carries_its_code() {
        let b = bench();
        let (c, _rx) = conn(None);
        for frame in [
            json!({"id": 1, "op": "fs.list", "path": 7}),
            json!({"id": 1, "op": "fs.list"}),
            json!({"id": 1, "op": "fs.read", "path": "x", "encoding": "hex"}),
            json!({"id": 1, "op": "git.status"}),
            json!({"id": 1, "op": "git.diff", "cwd": ".", "scope": "all"}),
            json!({"id": 1, "op": "git.diff", "cwd": "."}),
            json!({"id": 1, "op": "git.diff", "cwd": ".", "scope": "staged", "path": 3}),
        ] {
            let out = reply(&b, &c, frame.clone()).await;
            assert_eq!((out["ok"].as_bool(), out["code"].as_str()), (Some(false), Some("bad-request")), "{frame}");
        }
        let missing = b.root.path().join("none.txt");
        assert_eq!(
            reply(&b, &c, json!({"id": 2, "op": "fs.read", "path": "none.txt"})).await,
            json!({"id": 2, "ok": false, "code": "not-found", "error": "none.txt does not exist"})
        );
        assert_eq!(reply(&b, &c, json!({"id": 3, "op": "fs.list", "path": missing})).await["code"], "not-found");
        assert_eq!(
            reply(&b, &c, json!({"id": 4, "op": "git.status", "cwd": "/etc"})).await,
            json!({"id": 4, "ok": false, "code": "outside-root", "error": "/etc resolves outside the workspace root"})
        );
        let listed = reply(&b, &c, json!({"id": 5, "op": "fs.list", "path": "."})).await;
        assert_eq!(listed, json!({"id": 5, "ok": true, "entries": [], "truncated": false, "total": 0}));
    }

    #[test]
    fn what_an_attach_registers_after_its_socket_closed_is_undone_at_once() {
        let (c, _rx) = conn(None);
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&ran);
        c.on_close(Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)));
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        c.close();
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst));
        let late = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&late);
        c.on_close(Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)));
        assert!(late.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn stdin_is_read_as_nodes_buffer_reads_base64() {
        assert_eq!(lenient_base64("aGVsbG8="), b"hello");
        assert_eq!(lenient_base64("aGVsbG8"), b"hello");
        assert_eq!(lenient_base64("aGVs\nbG8="), b"hello");
        assert_eq!(lenient_base64(""), b"");
    }
}
