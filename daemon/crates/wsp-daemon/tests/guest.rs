// SPDX-License-Identifier: AGPL-3.0-only
//! The guest relay on real sockets: one client standing for a process inside the machine and one standing for the
//! host's reach, against a bound daemon. What is proved here is the routing and nothing else, since the daemon
//! reads neither the token a session carries nor the messages that ride it.

use std::io::Write;
use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wsp_daemon::{Daemon, Options};
use wsp_frames::{numbers, words};

const TOKEN: &str = "test-token-123";
const WAIT: Duration = Duration::from_secs(5);

struct Running {
    addr: SocketAddr,
    _token: tempfile::NamedTempFile,
    _root: tempfile::TempDir,
}

async fn start() -> Running {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    writeln!(token, "{TOKEN}").unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut options = Options::new(token.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    options.root = Some(root.path().to_path_buf());
    options.manifest_path = Some(root.path().join("manifest.json"));
    let daemon = Daemon::bind(options).await.unwrap();
    let addr = daemon.local_addr();
    tokio::spawn(daemon.run());
    Running { addr, _token: token, _root: root }
}

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
    /// Events that arrived while a reply was being waited for. The daemon writes a handler's events ahead of its
    /// reply on the one channel, so a request that dropped them would hide exactly what these cases assert.
    seen: std::collections::VecDeque<Value>,
}

impl Client {
    /// Dials, auths and swallows the hello, so what a case reads next is its own.
    async fn connect(addr: SocketAddr) -> Client {
        let (ws, _) = connect_async(format!("ws://{addr}/")).await.unwrap();
        let mut c = Client { ws, next_id: 1, seen: std::collections::VecDeque::new() };
        let authed = c.request("auth", json!({ "token": TOKEN })).await;
        assert_eq!(authed["ok"], json!(true));
        assert_eq!(c.next_frame().await["type"], "daemon.hello");
        c
    }

    async fn next_frame(&mut self) -> Value {
        let msg = tokio::time::timeout(WAIT, self.ws.next()).await.expect("a frame within five seconds");
        match msg {
            Some(Ok(Message::Text(t))) => serde_json::from_str(&t).unwrap(),
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    /// The next event, out of what a request already took off the socket before anything else.
    async fn next_event(&mut self) -> Value {
        if let Some(held) = self.seen.pop_front() {
            return held;
        }
        loop {
            let frame = self.next_frame().await;
            if frame.get("type").is_some() {
                return frame;
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
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
        loop {
            let read = self.next_frame().await;
            if read.get("id") == Some(&json!(id)) {
                return read;
            }
            self.seen.push_back(read);
        }
    }

    async fn close(mut self) {
        let _ = self.ws.close(None).await;
        while let Some(Ok(_)) = self.ws.next().await {}
    }
}

fn opening(kind: &str) -> Value {
    json!({ "kind": kind, "token": "dev-1.tok", "turnToken": "9f", "argv": ["threads", "--json"], "cwd": "/root" })
}

async fn opened(client: &mut Client, kind: &str) -> String {
    let reply = client.request("guest.open", opening(kind)).await;
    assert_eq!(reply["ok"], json!(true), "{reply}");
    reply["session"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_session_reaches_the_watcher_whole_and_its_answer_reaches_the_guest() {
    let d = start().await;
    let mut host = Client::connect(d.addr).await;
    assert_eq!(host.request("guest.watch", json!({})).await["ok"], json!(true));
    let mut guest = Client::connect(d.addr).await;
    let session = opened(&mut guest, "cli").await;

    let event = host.next_event().await;
    assert_eq!(
        event,
        json!({ "type": "guest.opened", "session": session, "kind": "cli", "token": "dev-1.tok", "turnToken": "9f", "argv": ["threads", "--json"], "cwd": "/root" })
    );
    guest.request("guest.send", json!({ "message": { "hello": 1 } })).await;
    assert_eq!(host.next_event().await, json!({ "type": "guest.message", "session": session, "message": { "hello": 1 } }));

    host.request("guest.reply", json!({ "session": session, "message": { "stream": "out", "text": "rows\n" } })).await;
    assert_eq!(
        guest.next_event().await,
        json!({ "type": "guest.message", "session": session, "message": { "stream": "out", "text": "rows\n" } })
    );
    host.request("guest.close", json!({ "session": session })).await;
    assert_eq!(guest.next_event().await, json!({ "type": "guest.closed", "session": session }));
}

#[tokio::test]
async fn one_session_per_socket_and_a_send_with_none_is_refused() {
    let d = start().await;
    let mut host = Client::connect(d.addr).await;
    host.request("guest.watch", json!({})).await;
    let mut guest = Client::connect(d.addr).await;
    opened(&mut guest, "mcp").await;
    let second = guest.request("guest.open", opening("mcp")).await;
    assert_eq!(second["ok"], json!(false));
    assert_eq!(second["code"], "bad-request");

    let mut stranger = Client::connect(d.addr).await;
    let sent = stranger.request("guest.send", json!({ "message": 1 })).await;
    assert_eq!((sent["ok"].clone(), sent["code"].clone()), (json!(false), json!("bad-request")));
}

#[tokio::test]
async fn only_a_socket_that_asked_to_watch_may_answer_or_end_a_session() {
    let d = start().await;
    let mut host = Client::connect(d.addr).await;
    host.request("guest.watch", json!({})).await;
    let mut guest = Client::connect(d.addr).await;
    let session = opened(&mut guest, "cli").await;

    let mut stranger = Client::connect(d.addr).await;
    for op in ["guest.reply", "guest.close"] {
        let refused = stranger.request(op, json!({ "session": session, "message": {} })).await;
        assert_eq!(refused, json!({ "id": refused["id"], "ok": false, "code": "forbidden", "error": words::GUEST_NOT_WATCHER }), "{op}");
    }
    // The session stood through both refusals.
    host.request("guest.reply", json!({ "session": session, "message": { "exit": 0 } })).await;
    assert_eq!(guest.next_event().await["message"], json!({ "exit": 0 }));
}

#[tokio::test]
async fn frames_with_nobody_watching_wait_and_reach_the_next_watcher_in_order() {
    let d = start().await;
    let mut guest = Client::connect(d.addr).await;
    let session = opened(&mut guest, "cli").await;
    guest.request("guest.send", json!({ "message": { "n": 1 } })).await;
    guest.request("guest.send", json!({ "message": { "n": 2 } })).await;

    let mut host = Client::connect(d.addr).await;
    host.request("guest.watch", json!({})).await;
    assert_eq!(host.next_event().await["type"], "guest.opened");
    assert_eq!(host.next_event().await["message"], json!({ "n": 1 }));
    assert_eq!(host.next_event().await["message"], json!({ "n": 2 }));
    assert_eq!(session, "g0");
}

#[tokio::test]
async fn a_queue_past_its_cap_ends_the_session_to_the_guest() {
    let d = start().await;
    let mut guest = Client::connect(d.addr).await;
    let session = opened(&mut guest, "cli").await;
    // The open is the first frame held, so the cap is reached by one fewer message than the cap itself.
    for n in 0..numbers::GUEST_QUEUE_CAP_FRAMES - 1 {
        assert_eq!(guest.request("guest.send", json!({ "message": n })).await["ok"], json!(true), "message {n}");
    }
    guest.request("guest.send", json!({ "message": "one too many" })).await;
    assert_eq!(guest.next_event().await, json!({ "type": "guest.closed", "session": session, "error": words::GUEST_QUEUE_FULL }));
}

#[tokio::test]
async fn a_message_over_the_cap_is_refused_and_the_session_stands() {
    let d = start().await;
    let mut host = Client::connect(d.addr).await;
    host.request("guest.watch", json!({})).await;
    let mut guest = Client::connect(d.addr).await;
    let session = opened(&mut guest, "mcp").await;
    assert_eq!(host.next_event().await["type"], "guest.opened");

    let huge = "x".repeat(numbers::GUEST_MESSAGE_CAP_BYTES);
    let refused = guest.request("guest.send", json!({ "message": huge })).await;
    assert_eq!((refused["ok"].clone(), refused["code"].clone()), (json!(false), json!("bad-request")));
    guest.request("guest.send", json!({ "message": "small" })).await;
    assert_eq!(host.next_event().await, json!({ "type": "guest.message", "session": session, "message": "small" }));
}

#[tokio::test]
async fn a_guest_that_goes_with_nobody_watching_leaves_its_close_for_the_next_watcher() {
    let d = start().await;
    let mut guest = Client::connect(d.addr).await;
    let session = opened(&mut guest, "mcp").await;
    // Nobody is watching: the host restarted, or its link is between sockets. The guest's end going is the last
    // thing that session has to say, and a host that never hears it holds its own row and its socket for good.
    guest.close().await;

    let mut host = Client::connect(d.addr).await;
    host.request("guest.watch", json!({})).await;
    assert_eq!(
        host.next_event().await,
        json!({ "type": "guest.opened", "session": session, "kind": "mcp", "token": "dev-1.tok", "turnToken": "9f", "argv": ["threads", "--json"], "cwd": "/root" })
    );
    assert_eq!(host.next_event().await, json!({ "type": "guest.closed", "session": session }));
    // The row went with the frame: a second watcher hears the session once and no more.
    let mut second = Client::connect(d.addr).await;
    second.request("guest.watch", json!({})).await;
    let refused = second.request("guest.reply", json!({ "session": session, "message": {} })).await;
    assert_eq!((refused["ok"].clone(), refused["code"].clone()), (json!(false), json!("not-found")));
}

#[tokio::test]
async fn the_guest_socket_going_ends_its_session_upward_and_a_watcher_going_does_not() {
    let d = start().await;
    let mut host = Client::connect(d.addr).await;
    host.request("guest.watch", json!({})).await;
    let mut guest = Client::connect(d.addr).await;
    let session = opened(&mut guest, "cli").await;
    assert_eq!(host.next_event().await["type"], "guest.opened");

    // The watcher goes; the session stands and its next message reaches whoever watches after it.
    host.close().await;
    guest.request("guest.send", json!({ "message": { "held": true } })).await;
    let mut second = Client::connect(d.addr).await;
    second.request("guest.watch", json!({})).await;
    assert_eq!(second.next_event().await, json!({ "type": "guest.message", "session": session, "message": { "held": true } }));

    guest.close().await;
    assert_eq!(second.next_event().await, json!({ "type": "guest.closed", "session": session }));
}
