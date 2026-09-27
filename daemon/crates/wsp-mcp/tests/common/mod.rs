// SPDX-License-Identifier: AGPL-3.0-only
//! A host as far as a tool call reaches one, shared by the cases that dial it.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

/// The close a host sends as it stops, which a wait dials through.
const STOPPING_CLOSE: u16 = 4001;

/// What a host answers: each op with its recorded frame, the frames it pushes right behind each reply to an op, and
/// the op after whose reply it lets the socket go as it stops. An op with no recorded frame is refused as the
/// recorded host refused it, and the events are subscribed to without one.
#[derive(Default, Clone)]
pub struct Script {
    pub replies: BTreeMap<String, String>,
    pub pushed: BTreeMap<String, Vec<String>>,
    pub closes: Option<String>,
}

/// A host on loopback that takes the token it was given and answers as `script` says, under the id each op was asked
/// with, and every op past the token and the events it was asked, without its id. One port, as the host's: a plain
/// request gets a status line, which is all a probe asks, and the runtime's socket is upgraded on its path alone.
// The path check is tungstenite's handshake callback, whose error type is tungstenite's to size.
#[allow(clippy::result_large_err)]
pub async fn scripted(token: &'static str, script: Script) -> (u16, Arc<Mutex<Vec<Value>>>) {
    let asked_all = Arc::new(Mutex::new(Vec::new()));
    let noted = asked_all.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let script = script.clone();
            let noted = noted.clone();
            tokio::spawn(async move {
                let mut head = [0u8; 2048];
                let read = tcp.peek(&mut head).await.unwrap();
                if !String::from_utf8_lossy(&head[..read]).to_ascii_lowercase().contains("upgrade: websocket") {
                    let _ = tcp.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await;
                    return;
                }
                let on_path = |asked: &Request, answer: Response| {
                    assert_eq!(asked.uri().path(), "/ws", "the runtime's socket is dialled on its path");
                    Ok(answer)
                };
                let mut ws = tokio_tungstenite::accept_hdr_async(tcp, on_path).await.unwrap();
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let asked: Value = serde_json::from_str(&text).unwrap();
                    let id = asked["id"].as_u64().unwrap();
                    let op = asked["op"].as_str().unwrap();
                    if op != "auth" && op != "events.subscribe" {
                        let mut frame = asked.clone();
                        frame.as_object_mut().unwrap().remove("id");
                        if frame.get("requestId").is_some() {
                            frame["requestId"] = json!("<request id>");
                        }
                        noted.lock().unwrap().push(frame);
                    }
                    let reply = if op == "auth" {
                        assert_eq!(asked["token"], token);
                        json!({ "id": id, "ok": true }).to_string()
                    } else if let Some(recorded) = script.replies.get(op) {
                        // The recorded frame opens with the id it was recorded under; the rest is the host's bytes.
                        let rest = recorded.strip_prefix(r#"{"id":1,"#).expect("a frame recorded with its id first");
                        format!(r#"{{"id":{id},{rest}"#)
                    } else if op == "events.subscribe" {
                        json!({ "id": id, "ok": true }).to_string()
                    } else {
                        json!({ "id": id, "ok": false, "error": format!("{op} is not in this record") }).to_string()
                    };
                    let mut sent = ws.send(Message::text(reply)).await.is_ok();
                    for frame in script.pushed.get(op).into_iter().flatten() {
                        sent = sent && ws.send(Message::text(frame.clone())).await.is_ok();
                    }
                    if !sent {
                        break;
                    }
                    if script.closes.as_deref() == Some(op) {
                        let stopping = CloseFrame { code: CloseCode::from(STOPPING_CLOSE), reason: "".into() };
                        let _ = ws.close(Some(stopping)).await;
                        break;
                    }
                }
            });
        }
    });
    (port, asked_all)
}
