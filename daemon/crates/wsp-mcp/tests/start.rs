// SPDX-License-Identifier: AGPL-3.0-only
//! A call with no host serving the state file brings one up with the wsp the server was handed, as `wsp up` on
//! free ports marked as a verb's own, and answers once that host serves; a wsp that exits first is the answer.

mod common;

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use wsp_mcp::{Args, Env};

/// A wsp that writes down how it was run and then does what `body` says.
fn stub(dir: &Path, body: &str) -> PathBuf {
    let path = dir.join("wsp");
    std::fs::write(&path, format!("#!/bin/sh\necho \"$WSP_STARTED_BY $*\" > \"{}\"\n{body}\n", dir.join("ran").display())).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

async fn computers(state: PathBuf, wsp: &Path, env: &Env) -> Value {
    let asked = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "computers", "arguments": {} } });
    let mut out = Vec::new();
    let args = Args { state, wsp: vec![wsp.to_string_lossy().into_owned()], ..Args::default() };
    assert_eq!(wsp_mcp::serve(&args, env, format!("{asked}\n").as_bytes(), &mut out).await, 0);
    serde_json::from_slice::<Value>(&out).unwrap()["result"].clone()
}

fn env_in(dir: &Path) -> Env {
    [("WSP_HOME".to_owned(), dir.join("home").to_string_lossy().into_owned()), ("PATH".to_owned(), "/usr/bin:/bin".to_owned())]
        .into_iter()
        .collect()
}

#[tokio::test]
async fn brings_up_the_wsp_it_was_handed_and_answers_once_that_host_serves() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state").join("state.json");
    let empty = r#"{"id":1,"ok":true,"places":[]}"#.to_owned();
    let ws_port =
        common::host("started-token", BTreeMap::from([("places.list".to_owned(), empty.clone()), ("cost.spend".to_owned(), empty)])).await;
    // The app's port answers any request with a status line, which is all the probe asks of it.
    let app = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let app_port = app.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = app.accept().await {
            let _ = tcp.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await;
        }
    });
    // The host it starts takes the lock under this process's pid, which is alive, and writes its token beside it.
    let lock = json!({ "pid": std::process::id(), "port": app_port, "wsPort": ws_port, "startedAt": "2026-09-27T00:00:00.000Z" });
    let folder = state.parent().unwrap().display().to_string();
    let wsp = stub(
        dir.path(),
        &format!("sleep 0.3\necho started-token > '{folder}/host-token'\necho '{lock}' > '{folder}/host.lock'\necho serving"),
    );
    let answered = computers(state.clone(), &wsp, &env_in(dir.path())).await;
    assert_eq!(answered["structuredContent"], json!({ "computers": [], "spend": [] }), "{answered}");
    let ran = std::fs::read_to_string(dir.path().join("ran")).unwrap();
    assert_eq!(ran.trim(), format!("verb up --state {} --port 0 --ws-port 0", state.display()));
    assert_eq!(std::fs::read_to_string(state.parent().unwrap().join("host.log")).unwrap(), "serving\n");
}

#[tokio::test]
async fn a_wsp_that_exits_before_it_serves_answers_with_what_it_said_or_how_it_ended() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state").join("state.json");
    std::fs::create_dir_all(state.parent().unwrap()).unwrap();
    // A log already holding an older start's lines: only what this child said is the answer.
    std::fs::write(state.parent().unwrap().join("host.log"), "an older start\n").unwrap();
    let said = stub(dir.path(), "echo 'the state is served by another login' >&2\nexit 1");
    let answered = computers(state.clone(), &said, &env_in(dir.path())).await;
    assert_eq!(answered["structuredContent"], json!({ "error": "the state is served by another login", "class": "provider", "exit": 1 }));
    let silent = stub(dir.path(), "exit 7");
    let answered = computers(state.clone(), &silent, &env_in(dir.path())).await;
    let log = state.parent().unwrap().join("host.log");
    let want = format!("the host for {} exited with 7 before it served; its log is {}", state.display(), log.display());
    assert_eq!(answered["content"][0]["text"], want.as_str());
}
