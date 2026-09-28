// SPDX-License-Identifier: AGPL-3.0-only
//! A fork's first turn outlives a host that stops under it: the socket the host lets go with the stopping code is
//! dialled again, the transcript the host kept is read for the turn's end, and the fork answers with the reply. A
//! host that goes any other way is the first turn's failure, and the fork still names the workspace it made.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use wsp_mcp::Args;

const TOKEN: &str = "turn-token";

fn workspace(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "machineId": "m-1", "phase": "running", "kind": "cloud", "golden": "g", "createdAt": "c", "project": { "id": "p-1", "name": "alpha", "path": "/root/alpha", "computer": "solari" } })
}

/// What the host answers each op with on every socket but the start's.
fn answer(op: &str) -> Value {
    match op {
        "workspaces.resolve" => json!({ "workspace": workspace("ws-1", "alpha") }),
        "harnesses.list" => json!({ "harnesses": [] }),
        "projects.resolve" => json!({ "project": { "id": "p-1", "name": "alpha", "computer": "solari" } }),
        "workspaces.landing" => json!({ "capabilities": { "sizes": [] } }),
        "workspaces.create" => json!({ "workspace": workspace("ws-2", "alpha-fork") }),
        "sessions.start" => {
            json!({ "session": { "id": "s-1", "workspaceId": "ws-2", "harness": "claude", "status": "running", "threadId": "t-1" }, "outcome": "started", "turnId": "turn-1" })
        }
        "sessions.history" => json!({ "events": [
            { "type": "session.done", "workspaceId": "ws-2", "turnId": "turn-0", "result": { "status": "completed", "text": "another turn's" } },
            { "type": "session.done", "workspaceId": "ws-2", "turnId": "turn-1", "result": { "status": "completed", "text": "done while you were away" } },
        ] }),
        _ => json!({}),
    }
}

/// A host whose first socket closes with `code` right after it answers the start; every later socket answers the
/// rest. Answers the port and a count of the sockets it took.
async fn host(code: u16) -> (u16, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let sockets = Arc::new(AtomicUsize::new(0));
    let counted = sockets.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let first = counted.fetch_add(1, Ordering::SeqCst) == 0;
            tokio::spawn(async move {
                let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let asked: Value = serde_json::from_str(&text).unwrap();
                    let op = asked["op"].as_str().unwrap().to_owned();
                    if op == "auth" {
                        assert_eq!(asked["token"], TOKEN);
                    }
                    let mut reply = answer(&op);
                    reply["id"] = asked["id"].clone();
                    reply["ok"] = json!(true);
                    ws.send(Message::text(reply.to_string())).await.unwrap();
                    if first && op == "sessions.start" {
                        let _ = ws.close(Some(CloseFrame { code: CloseCode::from(code), reason: "".into() })).await;
                        return;
                    }
                }
            });
        }
    });
    (port, sockets)
}

async fn forked(code: u16) -> (Value, usize) {
    let dir = tempfile::tempdir().unwrap();
    let (port, sockets) = host(code).await;
    let lock = json!({ "pid": std::process::id(), "port": port, "startedAt": "2026-09-27T00:00:00.000Z" });
    std::fs::write(dir.path().join("host.lock"), lock.to_string()).unwrap();
    std::fs::write(dir.path().join("host-token"), format!("{TOKEN}\n")).unwrap();
    let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "fork", "arguments": { "workspace": "alpha", "task": "go" } } });
    // Fork is served with the cloud on alone.
    let env = [("WSP_HOME".to_owned(), dir.path().join("home").to_string_lossy().into_owned()), ("WSP_CLOUD".to_owned(), "1".to_owned())]
        .into_iter()
        .collect();
    let mut out = Vec::new();
    let code =
        wsp_mcp::serve(&Args { state: dir.path().join("state.json"), ..Args::default() }, &env, format!("{call}\n").as_bytes(), &mut out)
            .await;
    assert_eq!(code, 0);
    let printed: Value = serde_json::from_slice(&out).unwrap();
    (printed["result"].clone(), sockets.load(Ordering::SeqCst))
}

#[tokio::test]
async fn a_host_that_stops_under_the_first_turn_is_dialled_again_and_its_transcript_read() {
    let (result, sockets) = forked(4001).await;
    assert_eq!(result.get("isError"), None, "{result}");
    assert_eq!(
        result["structuredContent"]["turn"],
        json!({ "threadId": "t-1", "workspaceId": "ws-2", "harness": "claude", "text": "done while you were away", "outcome": "started" })
    );
    assert_eq!(sockets, 2);
}

#[tokio::test]
async fn a_host_that_goes_any_other_way_is_the_first_turns_failure() {
    let (result, sockets) = forked(1000).await;
    assert_eq!(result["isError"], true, "{result}");
    let failure = result["structuredContent"]["failure"].as_str().unwrap();
    let words: Value = serde_json::from_str(include_str!("../record/words.json")).unwrap();
    assert_eq!(failure, words["hostClosed"]);
    let said = words["workspaces"]["firstTurnFailed"]
        .as_str()
        .unwrap()
        .replace("{name}", "alpha-fork")
        .replace("{id}", "ws-2")
        .replace("{failure}", failure);
    assert_eq!(result["content"][0]["text"], said);
    assert_eq!(sockets, 1);
}
