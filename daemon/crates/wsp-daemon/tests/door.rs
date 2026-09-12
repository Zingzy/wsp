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
use wsp_frames::{numbers, words};

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
    let r = c.request("pty.create", json!({ "shell": "bash" })).await;
    assert_eq!(r, json!({ "id": 2, "ok": false, "code": "unsupported", "error": "pty.create is not served by this daemon yet" }));
    let r = c.request("machine.create", json!({})).await;
    assert_eq!(r, json!({ "id": 3, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD }));
    let r = c.request("place.leave", json!({})).await;
    assert_eq!(r, json!({ "id": 4, "ok": false, "code": "forbidden", "error": words::PLACE_LEAVE_ROAD_REFUSAL }));
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
