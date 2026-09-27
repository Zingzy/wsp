// SPDX-License-Identifier: AGPL-3.0-only
//! A host as far as a tool call reaches one, shared by the cases that dial it.

use std::collections::BTreeMap;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// A host on loopback that takes the token it was given and answers each op with its recorded frame, under the id
/// it was asked with.
pub async fn host(token: &'static str, replies: BTreeMap<String, String>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let replies = replies.clone();
            tokio::spawn(async move {
                let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
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
