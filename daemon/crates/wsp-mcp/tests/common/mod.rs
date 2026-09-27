// SPDX-License-Identifier: AGPL-3.0-only
//! A host as far as a tool call reaches one, shared by the cases that dial it.

use std::collections::BTreeMap;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

/// A host on loopback that takes the token it was given and answers each op with its recorded frame, under the id
/// it was asked with. One port, as the host's: a plain request gets a status line, which is all a probe asks, and
/// the runtime's socket is upgraded on its path alone.
// The path check is tungstenite's handshake callback, whose error type is tungstenite's to size.
#[allow(clippy::result_large_err)]
pub async fn host(token: &'static str, replies: BTreeMap<String, String>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let replies = replies.clone();
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
                    let reply = if op == "auth" {
                        assert_eq!(asked["token"], token);
                        json!({ "id": id, "ok": true }).to_string()
                    } else {
                        // The recorded frame opens with the id it was recorded under; the rest is the host's bytes.
                        let recorded = &replies[op];
                        let rest = recorded.strip_prefix(r#"{"id":1,"#).expect("a frame recorded with its id first");
                        format!(r#"{{"id":{id},{rest}"#)
                    };
                    ws.send(Message::text(reply)).await.unwrap();
                }
            });
        }
    });
    port
}
