// SPDX-License-Identifier: AGPL-3.0-only
//! The door on a real socket: every auth and hello case the node daemon's suite pins, driven the way its clients
//! drive it, with a WebSocket client for the frames and a raw TCP stream where the case is about wire bytes.

use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wsp_daemon::{Daemon, Options};
use wsp_frames::{numbers, words, DaemonEvent};

const TOKEN: &str = "test-token-123";

struct Running {
    addr: SocketAddr,
    token: tempfile::NamedTempFile,
    root: tempfile::TempDir,
}

async fn start(auth_deadline_ms: Option<u64>) -> Running {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    writeln!(token, "{TOKEN}").unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut options = Options::new(token.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    options.root = Some(root.path().to_path_buf());
    options.auth_deadline_ms = auth_deadline_ms;
    let daemon = Daemon::bind(options).await.unwrap();
    let addr = daemon.local_addr();
    tokio::spawn(daemon.run());
    Running { addr, token, root }
}

fn rotate(token: &Path, to: &str) {
    std::fs::write(token, format!("{to}\n")).unwrap();
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// What one client saw: every frame in arrival order, and the close if the daemon closed it.
struct Client {
    ws: Ws,
    frames: Vec<Value>,
    next_id: u64,
}

#[derive(Debug, PartialEq)]
struct Closed {
    code: u16,
    reason: String,
}

impl Client {
    async fn open(addr: SocketAddr, path: &str) -> Client {
        let (ws, _) = connect_async(format!("ws://{addr}{path}")).await.unwrap();
        Client { ws, frames: Vec::new(), next_id: 1 }
    }

    /// Dials and sends the auth frame first, as every real client does, then waits for its answer or the close.
    async fn connect(addr: SocketAddr, token: &str, scope: Option<u32>) -> (Client, Option<Closed>) {
        let mut c = Client::open(addr, "/").await;
        let mut auth = json!({ "id": 1, "op": "auth", "token": token });
        if let Some(port) = scope {
            auth["port"] = json!(port);
        }
        c.next_id = 2;
        c.ws.send(Message::text(auth.to_string())).await.unwrap();
        let closed = c.read_until_reply(1).await;
        (c, closed)
    }

    async fn send_raw(&mut self, frame: Value) {
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
    }

    /// Reads frames until the reply to id arrives (Ok(reply)) or the socket closes.
    async fn read_until_reply(&mut self, id: u64) -> Option<Closed> {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await.expect("the daemon answers within five seconds") {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    let done = v.get("id") == Some(&json!(id));
                    self.frames.push(v);
                    if done {
                        return None;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let frame = frame.expect("a close with a code");
                    return Some(Closed { code: frame.code.into(), reason: frame.reason.to_string() });
                }
                Some(Ok(_)) => continue,
                None | Some(Err(_)) => return Some(Closed { code: 1006, reason: String::new() }),
            }
        }
    }

    async fn request(&mut self, op: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let mut frame = json!({ "id": id, "op": op });
        for (k, v) in params.as_object().unwrap() {
            frame[k] = v.clone();
        }
        self.send_raw(frame).await;
        assert_eq!(self.read_until_reply(id).await, None, "the socket closed while {op} was pending");
        self.frames.last().unwrap().clone()
    }

    async fn wait_closed(&mut self) -> Closed {
        self.read_until_reply(u64::MAX).await.expect("the daemon closes the socket")
    }

    /// Reads whatever arrives for the given time, so events pushed without a request are seen.
    async fn listen(&mut self, for_: Duration) {
        let deadline = tokio::time::Instant::now() + for_;
        while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            self.frames.push(serde_json::from_str(&t).unwrap());
        }
    }

    /// Reads until an event of the type arrives that the test accepts, or the wait runs out.
    async fn wait_event(&mut self, ty: &str, within: Duration, accept: impl Fn(&Value) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        if self.events(ty).iter().any(&accept) {
            return true;
        }
        while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(&t).unwrap();
                let hit = v["type"] == ty && accept(&v);
                self.frames.push(v);
                if hit {
                    return true;
                }
            }
        }
        false
    }

    /// Reads until the pty text seen so far contains the marker, or the wait runs out.
    async fn wait_text(&mut self, marker: &str, within: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        while !self.pty_text().contains(marker) {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => self.frames.push(serde_json::from_str(&t).unwrap()),
                Ok(Some(Ok(_))) => continue,
                _ => return false,
            }
        }
        true
    }

    fn events(&self, ty: &str) -> Vec<Value> {
        self.frames.iter().filter(|f| f["type"] == ty).cloned().collect()
    }

    /// The text every pty.data event carried, in order.
    fn pty_text(&self) -> String {
        self.events("pty.data").iter().map(|e| e["data"].as_str().unwrap_or("")).collect()
    }

    /// Every event this client saw is one the protocol parses: the zod half of the contract, on live traffic.
    fn every_event_parses(&self) {
        for frame in self.frames.iter().filter(|f| f.get("type").is_some()) {
            serde_json::from_value::<DaemonEvent>(frame.clone()).unwrap_or_else(|e| panic!("{frame}: {e}"));
        }
    }
}

const WAIT: Duration = Duration::from_secs(5);
const MCP_REMOTE: &str = "https://mcp.linear.app/authorize?response_type=code&client_id=X&code_challenge=C&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A22227%2Foauth%2Fcallback&state=S&scope=read+write&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp";

async fn authed(d: &Running) -> Client {
    let (c, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    c
}

/// A bash pty with no profile of its own, attached; the id it got.
async fn bash_pty(c: &mut Client) -> String {
    let created = c.request("pty.create", json!({ "cols": 80, "rows": 24, "shell": "bash" })).await;
    assert_eq!(created["ok"], true, "{created}");
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    assert!(created["pid"].as_u64().unwrap() > 0);
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    pty_id
}

/// A TCP stream past a hand-written upgrade, for the cases about bytes rather than frames.
async fn upgraded(addr: SocketAddr) -> TcpStream {
    let mut raw = TcpStream::connect(addr).await.unwrap();
    let request = format!("GET / HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    raw.write_all(request.as_bytes()).await.unwrap();
    let mut buf = vec![0u8; 4096];
    let n = raw.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 101"), "the upgrade is answered");
    raw
}

/// Reads until the peer ends the connection (EOF or a reset), within five seconds.
async fn ends(raw: &mut TcpStream) -> bool {
    let mut buf = [0u8; 1024];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, raw.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) => return true,
            Ok(Ok(_)) => continue,
            Err(_) => return false,
        }
    }
}

#[tokio::test]
async fn closes_4401_with_one_sentence_when_the_auth_frame_carries_the_wrong_token() {
    let d = start(None).await;
    let (c, closed) = Client::connect(d.addr, "wrong", None).await;
    assert_eq!(closed, Some(Closed { code: 4401, reason: words::AUTH_TOKEN_REFUSED.to_owned() }));
    assert!(c.frames.is_empty());
}

#[tokio::test]
async fn a_query_token_does_not_authenticate() {
    let d = start(None).await;
    let mut c = Client::open(d.addr, &format!("/?token={TOKEN}")).await;
    c.send_raw(json!({ "id": 1, "op": "ping" })).await;
    let closed = c.read_until_reply(1).await.unwrap();
    assert_eq!(closed.code, 4401);
    assert!(c.frames.is_empty());
}

#[tokio::test]
async fn closes_a_socket_whose_first_frame_is_not_auth_before_any_handler_runs() {
    let d = start(None).await;
    let mut c = Client::open(d.addr, "/").await;
    c.send_raw(json!({ "id": 1, "op": "pty.create", "shell": "bash" })).await;
    c.send_raw(json!({ "id": 2, "op": "auth", "token": TOKEN })).await;
    c.send_raw(json!({ "id": 3, "op": "pty.create", "shell": "bash" })).await;
    let closed = c.wait_closed().await;
    assert_eq!(closed, Closed { code: 4401, reason: words::AUTH_FIRST_FRAME.to_owned() });
    assert!(c.frames.is_empty(), "no reply reached the peer: {:?}", c.frames);
}

#[tokio::test]
async fn a_malformed_frame_from_a_peer_that_never_authed_ends_that_socket_and_nothing_else() {
    let d = start(None).await;
    let mut raw = upgraded(d.addr).await;
    // RSV1 set with no extension negotiated: the framing refuses the frame.
    raw.write_all(&[0xc1, 0x80, 0, 0, 0, 0]).await.unwrap();
    assert!(ends(&mut raw).await, "the daemon ends the malformed peer's connection");
    let (mut c, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn closes_4401_a_socket_that_sends_more_than_a_few_kib_before_its_auth_frame_and_keeps_serving() {
    let d = start(None).await;
    let mut c = Client::open(d.addr, "/").await;
    c.send_raw(json!({ "id": 1, "op": "auth", "token": TOKEN, "pad": "x".repeat(16 * 1024) })).await;
    let closed = c.wait_closed().await;
    assert_eq!(closed, Closed { code: 4401, reason: words::AUTH_TOO_MANY_BYTES.to_owned() });
    assert!(c.frames.is_empty());
    // The cap is for the pre-auth window only: an authed socket sends the same bytes and is answered.
    let (mut authed, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_eq!(authed.request("ping", json!({ "pad": "x".repeat(16 * 1024) })).await["ok"], true);
}

#[tokio::test]
async fn counts_wire_bytes_not_assembled_messages_a_peer_that_never_finishes_a_huge_frame_is_cut_at_the_cap() {
    let d = start(None).await;
    let mut raw = upgraded(d.addr).await;
    // One masked text frame announcing 50 MiB, then only 8 KiB of it: under the message cap, so the framing would buffer.
    let mut header = vec![0x81u8, 0x80 | 127];
    header.extend_from_slice(&(50u64 * 1024 * 1024).to_be_bytes());
    header.extend_from_slice(&[0, 0, 0, 0]);
    header.extend(std::iter::repeat_n(0x20u8, 8 * 1024));
    raw.write_all(&header).await.unwrap();
    let mut close = [0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(5), raw.read(&mut close)).await.unwrap().unwrap();
    assert!(n >= 4, "a close frame came back");
    assert_eq!(close[0], 0x88, "the first frame back is a close");
    assert_eq!(u16::from_be_bytes([close[2], close[3]]), 4401);
    let reason = String::from_utf8_lossy(&close[4..n]).into_owned();
    assert_eq!(reason, words::AUTH_TOO_MANY_BYTES);
    // Anything more from that peer ends the connection outright.
    raw.write_all(&vec![0x20u8; 8 * 1024]).await.unwrap();
    assert!(ends(&mut raw).await);
    let (mut c, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn a_socket_authed_for_one_port_is_answered_ping_and_tunnel_ops_on_that_port_alone() {
    let d = start(None).await;
    let guest_port = 8123u32;
    let (mut c, closed) = Client::connect(d.addr, TOKEN, Some(guest_port)).await;
    assert_eq!(closed, None);
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
    let refused = json!({ "ok": false, "code": "forbidden", "error": words::port_scope_refusal(guest_port as u16) });
    for (op, params) in [
        ("pty.create", json!({ "shell": "bash" })),
        ("pty.list", json!({})),
        ("fs.list", json!({ "path": "." })),
        ("git.status", json!({ "cwd": "." })),
        ("ports.watch", json!({})),
        ("sys.watch", json!({})),
        ("proc.watch", json!({})),
        ("proc.inspect", json!({ "pid": 1 })),
        ("proc.kill", json!({ "pid": 1, "signal": "TERM" })),
        ("manifest.get", json!({})),
        ("exec", json!({ "cmd": "echo hello" })),
        ("tunnel.open", json!({ "tunnelId": "other", "port": guest_port + 1 })),
    ] {
        let mut r = c.request(op, params).await;
        r.as_object_mut().unwrap().remove("id");
        assert_eq!(r, refused, "{op}");
    }
    // In scope: the tunnel op reaches the switch, where this daemon does not serve it yet.
    let r = c.request("tunnel.open", json!({ "tunnelId": "t1", "port": guest_port })).await;
    assert_eq!(r["code"], "unsupported");
    // An unscoped socket on the same token gets past the scope check on every op.
    let (mut full, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_ne!(full.request("pty.list", json!({})).await["code"], "forbidden");
}

#[tokio::test]
async fn refuses_an_auth_frame_whose_port_is_not_a_port() {
    let d = start(None).await;
    let (_, closed) = Client::connect(d.addr, TOKEN, Some(70000)).await;
    assert_eq!(closed, Some(Closed { code: 4401, reason: words::AUTH_FIRST_FRAME.to_owned() }));
    let (_, closed) = Client::connect(d.addr, TOKEN, Some(0)).await;
    assert_eq!(closed, Some(Closed { code: 4401, reason: words::AUTH_FIRST_FRAME.to_owned() }));
}

#[tokio::test]
async fn ignores_an_exported_token_the_file_is_the_only_source() {
    std::env::set_var("WSP_DAEMON_TOKEN", "fromenv");
    let d = start(None).await;
    rotate(d.token.path(), "fromfile");
    let (_, closed) = Client::connect(d.addr, "fromenv", None).await;
    assert_eq!(closed.map(|c| c.code), Some(4401));
    let (mut file, closed) = Client::connect(d.addr, "fromfile", None).await;
    assert_eq!(closed, None);
    assert_eq!(file.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn closes_a_socket_that_sends_nothing_before_the_auth_deadline() {
    let d = start(Some(60)).await;
    let mut c = Client::open(d.addr, "/").await;
    let closed = c.wait_closed().await;
    assert_eq!(closed, Closed { code: 4401, reason: words::AUTH_NO_FRAME_IN_TIME.to_owned() });
}

#[tokio::test]
async fn checks_each_auth_frame_against_the_token_file_as_it_is_now() {
    let d = start(None).await;
    rotate(d.token.path(), "first");
    let (mut c1, closed) = Client::connect(d.addr, "first", None).await;
    assert_eq!(closed, None);
    assert_eq!(c1.request("ping", json!({})).await["ok"], true);
    rotate(d.token.path(), "second");
    let (_, stale) = Client::connect(d.addr, "first", None).await;
    assert_eq!(stale.map(|c| c.code), Some(4401));
    let (mut fresh, closed) = Client::connect(d.addr, "second", None).await;
    assert_eq!(closed, None);
    assert_eq!(fresh.request("ping", json!({})).await["ok"], true);
    // An authed socket stays authed through the rotation; only new dials are checked.
    assert_eq!(c1.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn answers_the_auth_frame_then_greets_with_its_root_and_version_before_anything_else() {
    let d = start(None).await;
    let (mut c, closed) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(closed, None);
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
    assert_eq!(
        c.frames[..2],
        [
            json!({ "id": 1, "ok": true }),
            json!({ "type": "daemon.hello", "root": d.root.path().to_str().unwrap(), "version": numbers::DAEMON_VERSION })
        ]
    );
    assert_eq!(c.frames[2], json!({ "id": 2, "ok": true }));
}

#[tokio::test]
async fn answers_an_op_it_does_not_know_with_an_error_naming_it_never_with_silence() {
    let d = start(None).await;
    let (mut c, _) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(c.request("sys.explode", json!({})).await, json!({ "id": 2, "ok": false, "error": "unknown op: sys.explode" }));
}

#[tokio::test]
async fn answers_invalid_json_under_a_null_id_and_keeps_the_socket() {
    let d = start(None).await;
    let (mut c, _) = Client::connect(d.addr, TOKEN, None).await;
    c.ws.send(Message::text("{not json")).await.unwrap();
    // The hello is still in the stream; the answer to the bad frame is the first reply after it.
    let answer = loop {
        match c.ws.next().await.unwrap().unwrap() {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v.get("type").is_none() {
                    break v;
                }
            }
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(answer, json!({ "id": null, "ok": false, "error": "invalid json" }));
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn answers_a_json_value_that_is_not_an_object_as_an_unknown_op_as_the_node_daemon_does() {
    let d = start(None).await;
    let (mut c, _) = Client::connect(d.addr, TOKEN, None).await;
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
    for raw in ["[1,2,3]", "42", "\"x\""] {
        c.ws.send(Message::text(raw)).await.unwrap();
        match c.ws.next().await.unwrap().unwrap() {
            Message::Text(t) => assert_eq!(
                serde_json::from_str::<Value>(&t).unwrap(),
                json!({ "id": null, "ok": false, "error": "unknown op: undefined" }),
                "{raw}"
            ),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(c.request("ping", json!({})).await["ok"], true);
}

#[tokio::test]
async fn refuses_an_op_the_protocol_names_but_this_daemon_lacks_by_name() {
    let d = start(None).await;
    let (mut c, _) = Client::connect(d.addr, TOKEN, None).await;
    let r = c.request("fs.list", json!({ "path": "." })).await;
    assert_eq!(r, json!({ "id": 2, "ok": false, "code": "unsupported", "error": "fs.list is not served by this daemon yet" }));
    let r = c.request("machine.create", json!({})).await;
    assert_eq!(r, json!({ "id": 3, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD }));
    let r = c.request("place.leave", json!({})).await;
    assert_eq!(r, json!({ "id": 4, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD }));
}

#[tokio::test]
async fn refuses_to_start_without_a_token_to_check_against() {
    let missing = Options::new("/nonexistent/wsp-daemon-token");
    let err = Daemon::bind(missing).await.err().expect("no daemon without a token");
    assert_eq!(err.to_string(), words::NO_TOKEN_AT_START);
    let blank = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(blank.path(), "  \n").unwrap();
    let mut options = Options::new(blank.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    assert_eq!(Daemon::bind(options).await.err().map(|e| e.to_string()), Some(words::NO_TOKEN_AT_START.to_owned()));
}

#[tokio::test]
async fn exec_answers_a_command_on_an_authed_socket() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let res = c.request("exec", json!({ "cmd": "echo hello; pwd", "timeoutMs": 5000 })).await;
    assert_eq!((res["ok"].as_bool(), res["exitCode"].as_i64(), res["truncated"].as_bool()), (Some(true), Some(0), Some(false)));
    let stdout = res["stdout"].as_str().unwrap();
    assert!(stdout.contains("hello"), "{stdout}");
    // The daemon's root, not its working directory: a place's daemon is rooted at the person's home.
    assert!(stdout.contains(d.root.path().to_str().unwrap()), "{stdout}");
    assert_eq!(res["stderr"], "");
}

#[tokio::test]
async fn exec_refuses_a_frame_whose_cmd_is_not_a_string_and_one_whose_timeout_is_not_a_positive_integer() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    assert_eq!(c.request("exec", json!({ "cmd": 3 })).await["ok"], false);
    assert_eq!(c.request("exec", json!({ "cmd": "echo x", "timeoutMs": -1 })).await["ok"], false);
    assert_eq!(c.request("exec", json!({ "cmd": "echo x", "stdin": 3 })).await["ok"], false);
    // stdin is base64 bytes and the deadline is the request's own.
    let res = c.request("exec", json!({ "cmd": "cat", "stdin": "aGVsbG8=", "timeoutMs": 5000 })).await;
    assert_eq!(res["stdout"], "hello");
    let late = c.request("exec", json!({ "cmd": "sleep 5; echo late", "timeoutMs": 200 })).await;
    assert_eq!(late["exitCode"], numbers::EXEC_DEADLINE_EXIT);
    assert_eq!(late["stdout"], "");
}

#[tokio::test]
async fn serves_ptys_that_survive_a_client_disconnect_replaying_to_the_next_client() {
    let d = start(None).await;
    let mut c1 = authed(&d).await;
    let pty_id = bash_pty(&mut c1).await;
    assert_eq!(c1.request("pty.write", json!({ "ptyId": pty_id, "data": "echo WIRE-$((20+3))\n" })).await["ok"], true);
    assert!(c1.wait_text("WIRE-23", WAIT).await, "{:?}", c1.pty_text());
    c1.every_event_parses();
    drop(c1);

    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut c2 = authed(&d).await;
    let listed = c2.request("pty.list", json!({})).await;
    let entry = listed["ptys"].as_array().unwrap().iter().find(|p| p["id"] == pty_id).cloned().expect("the pty is still held");
    assert_eq!((entry["exited"].as_bool(), entry["cols"].as_u64(), entry["rows"].as_u64()), (Some(false), Some(80), Some(24)));

    assert_eq!(c2.request("pty.write", json!({ "ptyId": pty_id, "data": "echo SECOND-CLIENT\n" })).await["ok"], true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(c2.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c2.wait_text("SECOND-CLIENT", WAIT).await, "{:?}", c2.pty_text());
    let seen = c2.pty_text();
    assert!(seen.contains("WIRE-23"), "{seen:?}");
    assert!(seen.contains("SECOND-CLIENT"), "{seen:?}");
    assert_eq!(c2.request("nonsense.op", json!({})).await["ok"], false);
    c2.every_event_parses();
    assert_eq!(c2.request("pty.kill", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c2.request("pty.list", json!({})).await["ptys"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn pty_exit_carries_the_shells_code_and_a_late_attach_hears_it_at_once() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let pty_id = bash_pty(&mut c).await;
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "exit 7\n" })).await["ok"], true);
    assert!(c.wait_event("pty.exit", WAIT, |_| true).await, "the pty exits");
    let exit = &c.events("pty.exit")[0];
    assert_eq!((exit["ptyId"].as_str(), exit["exitCode"].as_i64()), (Some(pty_id.as_str()), Some(7)));
    assert!(exit.get("signal").is_none(), "{exit}");
    let listed = c.request("pty.list", json!({})).await;
    assert_eq!(listed["ptys"].as_array().unwrap().iter().find(|p| p["id"] == pty_id).unwrap()["exited"], true);
    // A late attach to the dead pty still replays what it printed and says it exited, before the reply.
    let mut c2 = authed(&d).await;
    assert_eq!(c2.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert_eq!(c2.events("pty.exit").len(), 1, "{:?}", c2.frames);
    assert!(c2.pty_text().contains("exit 7"), "{:?}", c2.pty_text());
    assert!(c2.events("pty.mode").is_empty());
    c.every_event_parses();
    c2.every_event_parses();
}

#[tokio::test]
async fn a_printed_url_in_a_pty_names_the_callback_port_even_when_no_shim_ran() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let created = c.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    let line = format!("printf '%s\\n' 'Visit: {MCP_REMOTE}'\n");
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": line })).await["ok"], true);
    assert!(c.wait_event("callback.port", WAIT, |_| true).await, "{:?}", c.frames);
    c.listen(Duration::from_millis(300)).await;
    assert_eq!(c.events("callback.port"), [json!({ "type": "callback.port", "port": 22227 })]);
    assert!(c.events("browser.open").is_empty());
    c.every_event_parses();
}

#[tokio::test]
async fn a_local_url_printed_in_a_pty_becomes_one_localhost_url_with_its_port_on_every_authed_socket() {
    let d = start(None).await;
    let mut a = authed(&d).await;
    let mut b = authed(&d).await;
    let created = a.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    // The typed command echoes with the URL in it and the output prints it again: one event.
    let line = "printf '%s\\n' 'Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ...'\n";
    assert_eq!(a.request("pty.write", json!({ "ptyId": pty_id, "data": line })).await["ok"], true);
    assert!(a.wait_event("localhost.url", WAIT, |_| true).await, "{:?}", a.frames);
    assert!(b.wait_event("localhost.url", WAIT, |_| true).await, "{:?}", b.frames);
    a.listen(Duration::from_millis(300)).await;
    b.listen(Duration::from_millis(300)).await;
    assert_eq!(a.events("localhost.url"), [json!({ "type": "localhost.url", "port": 8123 })]);
    assert_eq!(b.events("localhost.url"), [json!({ "type": "localhost.url", "port": 8123 })]);
    assert!(a.events("callback.port").is_empty() && a.events("browser.open").is_empty());
    a.every_event_parses();
    b.every_event_parses();
}

#[tokio::test]
async fn a_port_scoped_socket_hears_nothing_a_pty_prints() {
    let d = start(None).await;
    let mut a = authed(&d).await;
    let (mut scoped, closed) = Client::connect(d.addr, TOKEN, Some(8123)).await;
    assert_eq!(closed, None);
    let created = a.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    let line = "printf '%s\\n' 'Local: http://localhost:5173/'\n";
    assert_eq!(a.request("pty.write", json!({ "ptyId": pty_id, "data": line })).await["ok"], true);
    assert!(a.wait_event("localhost.url", WAIT, |_| true).await);
    scoped.listen(Duration::from_millis(300)).await;
    assert!(scoped.events("localhost.url").is_empty(), "{:?}", scoped.frames);
}

#[tokio::test]
async fn the_shell_it_spawns_is_a_login_shell_that_reads_the_profile_of_the_home_it_is_given() {
    let d = start(None).await;
    let home = tempfile::tempdir().unwrap();
    for rc in [".profile", ".bash_profile", ".zprofile"] {
        std::fs::write(home.path().join(rc), "echo WSP-LOGIN-PROFILE\n").unwrap();
    }
    let mut c = authed(&d).await;
    let home_str = home.path().to_str().unwrap();
    let env = json!({ "HOME": home_str, "ZDOTDIR": home_str });
    let created = c.request("pty.create", json!({ "cols": 80, "rows": 24, "cwd": home_str, "env": env })).await;
    assert_eq!(created["ok"], true, "{created}");
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c.wait_text("WSP-LOGIN-PROFILE", WAIT).await, "{:?}", c.pty_text());
    // The pty starts where the request said, with the environment it named.
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "echo CWD=$PWD HOME=$HOME\n" })).await["ok"], true);
    let want = format!("CWD={home_str} HOME={home_str}\r");
    assert!(c.wait_text(&want, WAIT).await, "{:?}", c.pty_text());
    c.every_event_parses();
}

#[tokio::test]
async fn pty_mode_on_attach_reads_the_real_slave_and_a_resize_reaches_the_shell() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let pty_id = bash_pty(&mut c).await;
    assert!(c.wait_event("pty.mode", WAIT, |e| e["foreground"] == "bash").await, "{:?}", c.frames);
    assert_eq!(c.request("pty.resize", json!({ "ptyId": pty_id, "cols": 120, "rows": 40 })).await["ok"], true);
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "stty size\n" })).await["ok"], true);
    assert!(c.wait_text("40 120", WAIT).await, "{:?}", c.pty_text());
    let listed = c.request("pty.list", json!({})).await;
    let entry = listed["ptys"].as_array().unwrap().iter().find(|p| p["id"] == pty_id).cloned().unwrap();
    assert_eq!((entry["cols"].as_u64(), entry["rows"].as_u64()), (Some(120), Some(40)));
    // At its prompt bash holds the slave in whichever mode readline left it; cat in the foreground is cooked, echo on.
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "cat\n" })).await["ok"], true);
    assert!(c.wait_event("pty.mode", WAIT, |e| e["foreground"] == "cat").await, "{:?}", c.events("pty.mode"));
    let mode = c.events("pty.mode").into_iter().find(|e| e["foreground"] == "cat").unwrap();
    assert_eq!(mode, json!({ "type": "pty.mode", "ptyId": pty_id, "mode": "line", "echo": true, "foreground": "cat" }));
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "\x03" })).await["ok"], true);
    assert!(c.wait_event("pty.mode", WAIT, |e| e["foreground"] == "bash").await, "{:?}", c.events("pty.mode"));
    c.every_event_parses();
}

#[tokio::test]
async fn a_heartbeat_is_not_held_behind_a_long_exec_on_the_same_socket() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    c.send_raw(json!({ "id": 100, "op": "exec", "cmd": "sleep 1", "timeoutMs": 5000 })).await;
    c.send_raw(json!({ "id": 101, "op": "ping" })).await;
    assert_eq!(c.read_until_reply(101).await, None);
    assert!(c.frames.iter().all(|f| f["id"] != 100), "the ping was answered before the exec finished: {:?}", c.frames);
    assert_eq!(c.read_until_reply(100).await, None);
    assert_eq!(c.frames.last().unwrap()["exitCode"], 0);
}

#[tokio::test]
async fn a_flood_through_a_pty_arrives_whole_and_the_exit_comes_after_its_last_byte() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let pty_id = bash_pty(&mut c).await;
    // Two million bytes of yes: with ONLCR each y is three bytes on the wire, then a marker, then the exit.
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "yes | head -c 2000000; echo TAIL; exit 3\n" })).await["ok"], true);
    assert!(c.wait_event("pty.exit", Duration::from_secs(30), |_| true).await, "the flood and the exit land within the wait");
    let text = c.pty_text();
    assert!(text.len() >= 3_000_000, "{} bytes reached the socket", text.len());
    assert!(text.contains("TAIL"), "the marker after the flood reached the socket before the exit");
    assert_eq!(c.events("pty.exit")[0]["exitCode"], 3);
    let last = c.frames.last().unwrap();
    assert_eq!(last["type"], "pty.exit", "the exit is the last frame, after every byte");
    c.every_event_parses();
}

#[tokio::test]
async fn a_cwd_that_is_not_a_directory_refuses_the_create_and_names_it() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let r = c.request("pty.create", json!({ "shell": "bash", "cwd": "/nonexistent/dir" })).await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["error"], "cwd is not a directory: /nonexistent/dir");
    assert!(c.request("pty.list", json!({})).await["ptys"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn starts_in_the_home_directory_not_wherever_the_daemon_runs() {
    let d = start(None).await;
    let mut c = authed(&d).await;
    let home = std::env::var("HOME").expect("the test process has a HOME");
    let created = c.request("pty.create", json!({ "cols": 80, "rows": 24, "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "echo CWD=$PWD\n" })).await["ok"], true);
    let want = format!("CWD={home}\r");
    assert!(c.wait_text(&want, WAIT).await, "{:?}", c.pty_text());
}
