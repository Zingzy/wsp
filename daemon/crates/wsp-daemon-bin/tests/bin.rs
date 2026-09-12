// SPDX-License-Identifier: AGPL-3.0-only
//! The binary as a process: the flags, the listening line, the port file, the ready line, and a wrong flag.

use std::io::Write;
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const BIN: &str = env!("CARGO_BIN_EXE_wsp-daemon");

#[tokio::test]
async fn binds_prints_the_listening_line_writes_the_port_file_and_serves_the_door() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    std::fs::File::create(&token).unwrap().write_all(b"bin-token\n").unwrap();
    let port_file = dir.path().join("daemon.port");
    let mut child = Command::new(BIN)
        .args(["--host", "127.0.0.1", "--port", "0", "--token-path"])
        .arg(&token)
        .arg("--port-file")
        .arg(&port_file)
        .arg("--root")
        .arg(dir.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line()).await.unwrap().unwrap().unwrap();
    let port: u16 = line.strip_prefix("wsp-daemon listening on 127.0.0.1:").expect("the listening line").parse().unwrap();
    assert_eq!(std::fs::read_to_string(&port_file).unwrap(), format!("{port}\n"));
    // Not root, or no Linux /proc: the two score lines come first and say so, then the ready line.
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    let ready = loop {
        let line = tokio::time::timeout(Duration::from_secs(5), stderr.next_line()).await.unwrap().unwrap().unwrap();
        if line.starts_with("oom_score_adj not set: ") || line.starts_with("priority not set: ") {
            continue;
        }
        break line;
    };
    assert!(ready.starts_with("ready in ") && ready.ends_with(" ms"), "{ready}");

    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/")).await.unwrap();
    ws.send(Message::text(json!({ "id": 1, "op": "auth", "token": "bin-token" }).to_string())).await.unwrap();
    let mut frames = Vec::new();
    for _ in 0..2 {
        if let Message::Text(t) = ws.next().await.unwrap().unwrap() {
            frames.push(serde_json::from_str::<Value>(&t).unwrap());
        }
    }
    assert_eq!(frames[0], json!({ "id": 1, "ok": true }));
    assert_eq!(frames[1]["type"], "daemon.hello");
    assert_eq!(frames[1]["root"], dir.path().to_str().unwrap());
    ws.send(Message::text(json!({ "id": 2, "op": "ping" }).to_string())).await.unwrap();
    if let Message::Text(t) = ws.next().await.unwrap().unwrap() {
        assert_eq!(serde_json::from_str::<Value>(&t).unwrap(), json!({ "id": 2, "ok": true }));
    }
    child.kill().await.unwrap();
}

#[tokio::test]
async fn a_wrong_flag_prints_the_usage_line_and_exits_2() {
    let out = Command::new(BIN).arg("--wat").output().await.unwrap();
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("--wat"), "{stderr}");
    assert!(stderr.contains("usage: wsp-daemon [--host <addr>] [--port <n>] [--token-path <file>] [--root <dir>]"), "{stderr}");
    let out = Command::new(BIN).args(["--port", "abc"]).output().await.unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--port"));
}

#[tokio::test]
async fn refuses_to_start_without_a_token_file_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    // Spawned and bounded rather than awaited outright: a daemon that wrongly started would run for good.
    let child = Command::new(BIN)
        .args(["--host", "127.0.0.1", "--port", "0", "--token-path"])
        .arg(dir.path().join("missing"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output()).await.expect("the binary exits at once").unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("wsp-daemon failed to start: daemon refuses to start without an auth token"), "{stderr}");
    assert!(out.stdout.is_empty());
}
