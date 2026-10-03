// SPDX-License-Identifier: AGPL-3.0-only
//! A send whose start the host never answered before it stopped is not a turn going on: the tool server dials the
//! host again and sends the same start under the same request id, which the host that comes back answers, since the
//! host is the one that knows whether it took the message. A host that stops under the reads before the start took no
//! message, and the send says so in the recorded words.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use wsp_mcp::Args;

const TOKEN: &str = "send-token";

/// The host's answer to each op, as the record holds it for a send followed to its reply.
fn recorded() -> Value {
    let answers: Value = serde_json::from_str(include_str!("answers/send.json")).unwrap();
    answers["cases"][0]["replies"].clone()
}

struct Seen {
    sockets: AtomicUsize,
    request_ids: Mutex<Vec<String>>,
}

/// A host whose first socket closes with the stopping code at `cut` without answering it; every later socket answers
/// every op, and a history that holds the started turn's end.
async fn host(cut: &'static str) -> (u16, Arc<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Seen { sockets: AtomicUsize::new(0), request_ids: Mutex::new(Vec::new()) });
    let counted = seen.clone();
    let replies = recorded();
    let started: Value = serde_json::from_str(replies["sessions.start"].as_str().unwrap()).unwrap();
    let turn_id = started["turnId"].as_str().unwrap().to_owned();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let first = counted.sockets.fetch_add(1, Ordering::SeqCst) == 0;
            let (seen, replies, turn_id) = (counted.clone(), replies.clone(), turn_id.clone());
            tokio::spawn(async move {
                let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let asked: Value = serde_json::from_str(&text).unwrap();
                    let op = asked["op"].as_str().unwrap().to_owned();
                    if op == "auth" {
                        assert_eq!(asked["token"], TOKEN);
                    }
                    if op == "sessions.start" {
                        seen.request_ids.lock().unwrap().push(asked["requestId"].as_str().unwrap().to_owned());
                    }
                    if first && op == cut {
                        let _ = ws.close(Some(CloseFrame { code: CloseCode::from(4001), reason: "".into() })).await;
                        return;
                    }
                    let mut reply = match (op.as_str(), replies.get(op.as_str()).and_then(Value::as_str)) {
                        ("sessions.history", _) => json!({ "events": [
                            { "type": "session.done", "workspaceId": "ws-1", "sessionId": "sess-9", "turnId": turn_id, "result": { "status": "completed", "text": "taken after the restart" } },
                        ] }),
                        (_, Some(frame)) => serde_json::from_str(frame).unwrap(),
                        _ => json!({}),
                    };
                    reply["id"] = asked["id"].clone();
                    reply["ok"] = json!(true);
                    ws.send(Message::text(reply.to_string())).await.unwrap();
                }
            });
        }
    });
    (port, seen)
}

async fn sent(cut: &'static str, detach: bool) -> (Value, Arc<Seen>) {
    called(cut, "send", json!({ "thread": "thread-7f", "message": "and the tests", "detach": detach })).await
}

async fn called(cut: &'static str, tool: &str, arguments: Value) -> (Value, Arc<Seen>) {
    let dir = tempfile::tempdir().unwrap();
    let (port, seen) = host(cut).await;
    let lock = json!({ "pid": std::process::id(), "port": port, "startedAt": "2026-09-30T00:00:00.000Z" });
    std::fs::write(dir.path().join("host.lock"), lock.to_string()).unwrap();
    std::fs::write(dir.path().join("host-token"), format!("{TOKEN}\n")).unwrap();
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": arguments } });
    let env = [("WSP_HOME".to_owned(), dir.path().join("home").to_string_lossy().into_owned())].into_iter().collect();
    let mut out = Vec::new();
    let code =
        wsp_mcp::serve(&Args { state: dir.path().join("state.json"), ..Args::default() }, &env, format!("{call}\n").as_bytes(), &mut out)
            .await;
    assert_eq!(code, 0);
    let printed: Value = serde_json::from_slice(&out).unwrap();
    (printed["result"].clone(), seen)
}

fn words() -> Value {
    serde_json::from_str(include_str!("../record/words.json")).unwrap()
}

#[tokio::test]
async fn a_send_whose_start_the_host_never_answered_goes_to_the_host_that_comes_back_under_the_same_request_id() {
    let (result, seen) = sent("sessions.start", false).await;
    assert_eq!(result.get("isError"), None, "{result}");
    assert_eq!(result["structuredContent"]["text"], "taken after the restart", "{result}");
    assert_ne!(result["content"][0]["text"].as_str().unwrap(), words()["hostStopping"].as_str().unwrap());
    let ids = seen.request_ids.lock().unwrap().clone();
    assert_eq!(ids.len(), 2, "{ids:?}");
    assert_eq!(ids[0], ids[1]);
    assert_eq!(seen.sockets.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_detached_send_takes_the_same_road_back() {
    let (result, seen) = sent("sessions.start", true).await;
    assert_eq!(result.get("isError"), None, "{result}");
    let ids = seen.request_ids.lock().unwrap().clone();
    assert_eq!(ids.len(), 2, "{ids:?}");
    assert_eq!(ids[0], ids[1]);
}

#[tokio::test]
async fn a_send_whose_host_stops_before_it_sent_anything_says_the_message_was_not_delivered() {
    let (result, seen) = sent("sessions.list", false).await;
    assert_eq!(result["isError"], true, "{result}");
    assert_eq!(result["structuredContent"]["error"], words()["notDelivered"], "{result}");
    assert!(seen.request_ids.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_run_whose_host_stops_under_the_reads_before_its_start_says_the_task_was_not_delivered() {
    let (result, seen) = called("harnesses.list", "run", json!({ "project": "attic-work", "message": "build it" })).await;
    assert_eq!(result["isError"], true, "{result}");
    assert_eq!(result["structuredContent"]["error"], words()["notDelivered"], "{result}");
    assert!(seen.request_ids.lock().unwrap().is_empty());
}
