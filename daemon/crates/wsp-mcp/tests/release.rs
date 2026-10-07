// SPDX-License-Identifier: AGPL-3.0-only
//! A host of another release, on loopback at the address a turn's launch left: the tool server refuses at its auth
//! answer in the whole line the TypeScript server answers, asks nothing past the token, and a host of its own release
//! or one that names none is served as before.

use std::path::Path;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use wsp_mcp::{Args, Env};

const TOKEN: &str = "scoped-token";

/// A host in the clear that answers auth naming `release` and the road it comes back by, where a release is given, and
/// every other op with no places or threads; asked to restart, it lets the socket go as a host on its way down does.
/// What it was asked, in order.
async fn host(release: Option<&'static str>, road: &'static str) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let noted = asked.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let frame: Value = serde_json::from_str(&text).unwrap();
                let op = frame["op"].as_str().unwrap().to_owned();
                noted.lock().unwrap().push(op.clone());
                let mut answer = json!({ "id": frame["id"], "ok": true, "places": [], "adds": [], "pending": [], "sessions": [] });
                if let (true, Some(release)) = (op == "auth", release) {
                    answer["version"] = Value::from(release);
                    answer["road"] = Value::from(road);
                }
                if ws.send(Message::text(answer.to_string())).await.is_err() || op == "host.restart" {
                    break;
                }
            }
        }
    });
    (port, asked)
}

fn launched_at(dir: &Path, port: u16) -> Env {
    let names: Value = serde_json::from_str(include_str!("../record/host.json")).unwrap();
    let name = |n: &str| names["env"][n].as_str().unwrap().to_owned();
    [
        ("WSP_HOME".to_owned(), dir.join("home").to_string_lossy().into_owned()),
        (name("url"), format!("http://127.0.0.1:{port}")),
        (name("token"), TOKEN.to_owned()),
    ]
    .into_iter()
    .collect()
}

async fn line_of(dir: &Path, env: &Env, guest: bool) -> String {
    call(dir, env, guest, "computers").await
}

async fn call(dir: &Path, env: &Env, guest: bool, tool: &str) -> String {
    let asked = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": {} } });
    let args = Args { state: dir.join("state.json"), guest, ..Args::default() };
    let mut out = Vec::new();
    assert_eq!(wsp_mcp::serve(&args, env, format!("{asked}\n").as_bytes(), &mut out).await, 0);
    String::from_utf8(out).unwrap().trim_end_matches('\n').to_owned()
}

#[tokio::test]
async fn a_host_of_another_release_is_refused_in_the_line_the_typescript_server_answers() {
    let recorded: Value = serde_json::from_str(include_str!("release.json")).unwrap();
    let theirs: &'static str = Box::leak(recorded["theirs"].as_str().unwrap().to_owned().into_boxed_str());
    let road: &'static str = Box::leak(recorded["road"].as_str().unwrap().to_owned().into_boxed_str());
    for guest in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (port, asked) = host(Some(theirs), road).await;
        let printed = line_of(dir.path(), &launched_at(dir.path(), port), guest).await;
        assert_eq!(printed, recorded["line"].as_str().unwrap().replace("{port}", &port.to_string()), "guest {guest}");
        assert_eq!(*asked.lock().unwrap(), vec!["auth".to_owned()], "nothing is asked past the token");
    }
}

#[tokio::test]
async fn a_host_of_this_release_or_one_that_names_none_is_served() {
    let server: Value = serde_json::from_str(include_str!("../record/server.json")).unwrap();
    let mine: &'static str = Box::leak(server["version"].as_str().unwrap().to_owned().into_boxed_str());
    for release in [Some(mine), None] {
        let dir = tempfile::tempdir().unwrap();
        let (port, asked) = host(release, "service").await;
        let printed: Value = serde_json::from_str(&line_of(dir.path(), &launched_at(dir.path(), port), false).await).unwrap();
        assert_eq!(printed["result"].get("isError"), None, "{printed}");
        assert!(asked.lock().unwrap().contains(&"places.list".to_owned()));
    }
}

#[tokio::test]
async fn the_restart_tool_dials_past_the_release_check_that_names_it_as_the_fix() {
    let dir = tempfile::tempdir().unwrap();
    let (port, asked) = host(Some("0.0.1"), "service").await;
    let printed: Value = serde_json::from_str(&call(dir.path(), &launched_at(dir.path(), port), false, "restart").await).unwrap();
    assert_eq!(printed["result"].get("isError"), None, "{printed}");
    assert_eq!(printed["result"]["structuredContent"], json!({ "running": [] }));
    assert!(asked.lock().unwrap().contains(&"host.restart".to_owned()), "{:?}", asked.lock().unwrap());
}
