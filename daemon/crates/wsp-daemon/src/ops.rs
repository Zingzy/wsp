// SPDX-License-Identifier: AGPL-3.0-only
//! The op switch behind the door: one request text in, one reply text out, with the events an op raises going out
//! through the socket's own channel.

use std::num::NonZeroU16;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use wsp_frames::{
    numbers, words, DaemonErrorCode, DaemonErrorResponse, DaemonOp, Empty, FsReadEncoding, InboxRescanReply, ManifestGetReply,
    ManifestRecordReply, ManifestRestartScriptReply, PortsWatchReply, Reply, RequestId, DAEMON_OPS, MACHINE_OPS,
};

use crate::manifest::RecordInput;
use crate::paths::OpError;
use crate::tunnel::Tunnels;
use crate::{frame_text as text, fs, git, paths, Ctx, Listener, Outbound};

type Detach = Box<dyn FnOnce() + Send>;

/// What one authed socket holds between frames.
pub(crate) struct Conn {
    /// Set when the auth frame named a port: only tunnel ops on it and ping are answered.
    pub(crate) scope: Option<NonZeroU16>,
    pub(crate) out: Outbound,
    pub(crate) tunnels: Tunnels,
    /// What the socket's close undoes: every watcher listener an op on it made. None once closed, so an op still
    /// being answered when the socket went undoes itself at once instead of outliving it.
    detaches: Mutex<Option<Vec<Detach>>>,
}

impl Conn {
    pub(crate) fn new(scope: Option<NonZeroU16>, out: Outbound) -> Conn {
        Conn { scope, out, tunnels: Tunnels::default(), detaches: Mutex::new(Some(Vec::new())) }
    }

    fn on_close(&self, detach: Detach) {
        match &mut *self.detaches.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(pending) => pending.push(detach),
            None => detach(),
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.detaches.lock().unwrap_or_else(|e| e.into_inner()).is_none()
    }

    pub(crate) fn close(&self) {
        let detaches = self.detaches.lock().unwrap_or_else(|e| e.into_inner()).take();
        for detach in detaches.into_iter().flatten() {
            detach();
        }
        self.tunnels.close_all();
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
        Err(OpError { code: None, message }) => fail(id, message),
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
        Some("place.leave") => refuse(id, DaemonErrorCode::Forbidden, words::PLACE_LEAVE_ROAD_REFUSAL),
        Some(name) if MACHINE_OPS.contains(&name) => refuse(id, DaemonErrorCode::Forbidden, words::NOT_ON_THIS_ROAD),
        Some(
            name @ ("fs.list"
            | "fs.read"
            | "git.status"
            | "git.diff"
            | "ports.watch"
            | "manifest.get"
            | "manifest.record"
            | "manifest.restartScript"
            | "inbox.watch"
            | "inbox.rescan"
            | "tunnel.open"
            | "tunnel.write"
            | "tunnel.close"),
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

/// The real path a request names, inside the daemon's root or a folder the roots file names as of this op.
async fn locate(ctx: &Ctx, requested: &str) -> Result<PathBuf, OpError> {
    let root = PathBuf::from(&ctx.root);
    let roots_path = ctx.options.roots_path.clone().unwrap_or_else(|| PathBuf::from(numbers::DAEMON_ROOTS_PATH));
    let requested = requested.to_owned();
    fs::blocking(move || paths::resolve_inside(&paths::roots_now(&root, &roots_path)?, &requested)).await
}

async fn serve(conn: &Arc<Conn>, ctx: &Arc<Ctx>, id: Option<RequestId>, name: &str, op: DaemonOp) -> String {
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
        DaemonOp::PortsWatch => {
            let key = ctx.next_key();
            ctx.ports.subscribe(Listener { key, out: conn.out.clone() });
            let ctx2 = Arc::clone(ctx);
            conn.on_close(Box::new(move || ctx2.ports.unsubscribe(key)));
            ctx.ports.start(ctx);
            // The poll and the reading of what it left are one held lock, so the reply carries the seed and not a
            // state a later poll has already moved on from.
            let (events, ports) = {
                let mut watcher = ctx.ports.watcher.lock().await;
                let events = watcher.poll().await;
                (events, watcher.current())
            };
            ctx.ports.deliver(ctx, events);
            text(&Reply::new(id, PortsWatchReply { ports }))
        }
        DaemonOp::ManifestGet => {
            text(&Reply::new(id, ManifestGetReply { entries: ctx.manifest.lock().unwrap_or_else(|e| e.into_inner()).entries() }))
        }
        DaemonOp::ManifestRecord { cmd, cwd, port } => {
            let recorded = ctx.manifest.lock().unwrap_or_else(|e| e.into_inner()).record(RecordInput { cmd, cwd, port });
            match recorded {
                Ok(entry) => text(&Reply::new(id, ManifestRecordReply { entry })),
                Err(e) => fail(id, e.to_string()),
            }
        }
        DaemonOp::ManifestRestartScript => text(&Reply::new(
            id,
            ManifestRestartScriptReply { script: ctx.manifest.lock().unwrap_or_else(|e| e.into_inner()).restart_script() },
        )),
        DaemonOp::InboxWatch => match ctx.inbox.get_or_start(ctx) {
            Ok(running) => {
                let key = ctx.next_key();
                running.subscribe(Listener { key, out: conn.out.clone() });
                conn.on_close(Box::new(move || running.unsubscribe(key)));
                ok(id)
            }
            Err(e) => fail(id, e.to_string()),
        },
        DaemonOp::InboxRescan => {
            let files = ctx.inbox.get_or_start(ctx).and_then(|running| running.state.lock().unwrap_or_else(|e| e.into_inner()).rescan());
            match files {
                Ok(files) => {
                    // The events land before the reply does, on the socket's one channel.
                    for event in &files {
                        conn.out.send_event(event);
                    }
                    text(&Reply::new(id, InboxRescanReply { count: files.len() as u64 }))
                }
                Err(e) => fail(id, e.to_string()),
            }
        }
        DaemonOp::TunnelOpen { tunnel_id, port } => answer(id, Tunnels::open(conn, tunnel_id, port.get()).await.map(|()| Empty {})),
        DaemonOp::TunnelWrite { tunnel_id, data } => answer(id, conn.tunnels.write(&tunnel_id, lenient_base64(&data)).map(|()| Empty {})),
        DaemonOp::TunnelClose { tunnel_id } => {
            conn.tunnels.close(&tunnel_id);
            ok(id)
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
        options.manifest_path = Some(root.path().join("manifest.json"));
        Bench { ctx: Arc::new(Ctx::new(options).unwrap()), _token: token, root }
    }

    fn conn(scope: Option<u16>) -> (Arc<Conn>, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(Conn::new(scope.and_then(NonZeroU16::new), Outbound(tx))), rx)
    }

    async fn reply(b: &Bench, conn: &Arc<Conn>, frame: Value) -> Value {
        serde_json::from_str(&handle(conn, &b.ctx, &frame.to_string()).await).unwrap()
    }

    async fn reply_raw(b: &Bench, conn: &Arc<Conn>, raw: &str) -> Value {
        serde_json::from_str(&handle(conn, &b.ctx, raw).await).unwrap()
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
            reply(&b, &c, json!({"id": 1, "op": "pty.create", "shell": "bash"})).await,
            json!({"id": 1, "ok": false, "code": "unsupported", "error": "pty.create is not served by this daemon yet"})
        );
        let built = [
            "ping",
            "place.leave",
            "fs.list",
            "fs.read",
            "git.status",
            "git.diff",
            "ports.watch",
            "manifest.get",
            "manifest.record",
            "manifest.restartScript",
            "inbox.watch",
            "inbox.rescan",
            "tunnel.open",
            "tunnel.write",
            "tunnel.close",
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
            json!({"id": 1, "ok": false, "code": "forbidden", "error": words::PLACE_LEAVE_ROAD_REFUSAL})
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
        // A guest listening on the loopback, so the one in-scope tunnel really opens.
        let guest = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let guest_port = guest.local_addr().unwrap().port();
        let (scoped, mut rx) = conn(Some(guest_port));
        assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": "ping"})).await, json!({"id": 1, "ok": true}));
        let refused = json!({"id": 1, "ok": false, "code": "forbidden", "error": words::port_scope_refusal(guest_port)});
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
            "inbox.watch",
            "machine.create",
            "place.leave",
            "nonsense",
        ] {
            assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": op, "path": ".", "cwd": ".", "scope": "staged"})).await, refused, "{op}");
        }
        assert_eq!(reply(&b, &scoped, json!({"id": 1, "op": "tunnel.open", "tunnelId": "t", "port": guest_port + 1})).await, refused);
        assert_eq!(
            reply(&b, &scoped, json!({"id": 1, "op": "tunnel.open", "tunnelId": "t", "port": guest_port})).await,
            json!({"id": 1, "ok": true})
        );
        let (mut guest_side, _) = guest.accept().await.unwrap();
        assert_eq!(
            reply(&b, &scoped, json!({"id": 2, "op": "tunnel.write", "tunnelId": "t", "data": "R0VU"})).await,
            json!({"id": 2, "ok": true})
        );
        let mut got = [0u8; 3];
        let read = tokio::io::AsyncReadExt::read_exact(&mut guest_side, &mut got);
        tokio::time::timeout(std::time::Duration::from_secs(5), read).await.expect("the bytes reach the guest").unwrap();
        assert_eq!(&got, b"GET");
        assert_eq!(reply(&b, &scoped, json!({"id": 3, "op": "tunnel.close", "tunnelId": "t"})).await, json!({"id": 3, "ok": true}));
        let end = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&end).unwrap(), json!({"type": "tunnel.end", "tunnelId": "t"}));
        assert_eq!(reply(&b, &scoped, json!({"id": 4, "op": "tunnel.write", "tunnelId": "t", "data": ""})).await["code"], "not-found");
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
            json!({"id": 1, "op": "tunnel.open", "tunnelId": "x", "port": 0}),
            json!({"id": 1, "op": "tunnel.open", "tunnelId": "x", "port": 70000}),
            json!({"id": 1, "op": "tunnel.open", "port": 8080}),
            json!({"id": 1, "op": "tunnel.write", "tunnelId": "x"}),
            json!({"id": 1, "op": "manifest.record", "cwd": "/root"}),
            json!({"id": 1, "op": "manifest.record", "cmd": "x", "cwd": "/root", "port": "80"}),
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
        assert_eq!(
            reply(&b, &c, json!({"id": 6, "op": "tunnel.write", "tunnelId": "nobody", "data": ""})).await,
            json!({"id": 6, "ok": false, "code": "not-found", "error": "no such tunnel: nobody"})
        );
    }

    #[tokio::test]
    async fn the_manifest_round_trips_and_the_inbox_names_a_directory_it_cannot_read() {
        let b = bench();
        let (c, _rx) = conn(None);
        let recorded = reply(&b, &c, json!({"id": 1, "op": "manifest.record", "cmd": "pnpm dev", "cwd": "/root/app", "port": 5173})).await;
        assert_eq!(recorded["ok"], true);
        assert_eq!(recorded["entry"]["id"], "proc_1");
        assert_eq!((recorded["entry"]["cmd"].as_str(), recorded["entry"]["port"].as_u64()), (Some("pnpm dev"), Some(5173)));
        let listed = reply(&b, &c, json!({"id": 2, "op": "manifest.get"})).await;
        assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
        let script = reply(&b, &c, json!({"id": 3, "op": "manifest.restartScript"})).await;
        assert!(script["script"].as_str().unwrap().contains("port_listening '1435'"));
        assert!(b.root.path().join("manifest.json").exists());

        let mut options = Options::new(b._token.path());
        options.inbox_dir = Some(b.root.path().join("no-inbox"));
        options.manifest_path = Some(b.root.path().join("m2.json"));
        let without = Bench {
            ctx: Arc::new(Ctx::new(options).unwrap()),
            _token: tempfile::NamedTempFile::new().unwrap(),
            root: tempfile::tempdir().unwrap(),
        };
        let refused = reply(&without, &c, json!({"id": 4, "op": "inbox.watch"})).await;
        assert_eq!(refused["ok"], false);
        assert!(refused["error"].as_str().unwrap().contains("No such file"), "{refused}");
    }

    #[test]
    fn what_an_op_registers_after_its_socket_closed_is_undone_at_once() {
        let (c, _rx) = conn(None);
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&ran);
        c.on_close(Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)));
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!c.is_closed());
        c.close();
        assert!(c.is_closed());
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst));
        let late = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&late);
        c.on_close(Box::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst)));
        assert!(late.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn tunnel_bytes_are_read_as_nodes_buffer_reads_base64() {
        assert_eq!(lenient_base64("aGVsbG8="), b"hello");
        assert_eq!(lenient_base64("aGVsbG8"), b"hello");
        assert_eq!(lenient_base64("aGVs\nbG8="), b"hello");
        assert_eq!(lenient_base64(""), b"");
    }
}
