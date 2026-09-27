// SPDX-License-Identifier: AGPL-3.0-only
//! Every answer the TypeScript server recorded, replayed: a host that answers each op with the frame it answered
//! there, and the one line this server prints for the same call, which must be the recorded line byte for byte.
//! The recording is packages/host/test/mcp-record.test.ts; a tool with no answers file has nothing held here.

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};
use wsp_mcp::Args;

#[derive(Deserialize)]
struct Answers {
    tool: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    case: String,
    arguments: Value,
    replies: BTreeMap<String, String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    line: String,
    asked: Vec<Value>,
}

/// A state folder a host on this port serves: the lock naming this process, which is alive, and the token beside it.
fn served_state(dir: &Path, port: u16, token: &str) -> std::path::PathBuf {
    let state = dir.join("state.json");
    let lock = json!({ "pid": std::process::id(), "port": port, "startedAt": "2026-09-27T00:00:00.000Z" });
    std::fs::write(dir.join("host.lock"), lock.to_string()).unwrap();
    std::fs::write(dir.join("host-token"), format!("{token}\n")).unwrap();
    state
}

#[tokio::test]
async fn every_recorded_answer_is_printed_byte_for_byte() {
    let answers = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("answers");
    let mut replayed = 0;
    for file in std::fs::read_dir(&answers).unwrap() {
        let recorded: Answers = serde_json::from_str(&std::fs::read_to_string(file.unwrap().path()).unwrap()).unwrap();
        for case in recorded.cases {
            let dir = tempfile::tempdir().unwrap();
            let (port, frames) = common::host_asked("contract-token", case.replies).await;
            let state = served_state(dir.path(), port, "contract-token");
            let asked = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": recorded.tool, "arguments": case.arguments } });
            let input = format!("{asked}\n");
            let mut out = Vec::new();
            let mut env: wsp_mcp::Env = case.env.into_iter().collect();
            env.insert("WSP_HOME".to_owned(), dir.path().join("home").to_string_lossy().into_owned());
            let code = wsp_mcp::serve(&Args { state, ..Args::default() }, &env, input.as_bytes(), &mut out).await;
            assert_eq!(code, 0);
            let printed = String::from_utf8(out).unwrap();
            assert_eq!(printed, format!("{}\n", case.line), "{} {}", recorded.tool, case.case);
            let in_order = |mut frames: Vec<Value>| {
                frames.sort_by_key(Value::to_string);
                frames
            };
            assert_eq!(
                in_order(frames.lock().unwrap().clone()),
                in_order(case.asked),
                "{} {}: what the host was asked",
                recorded.tool,
                case.case
            );
            replayed += 1;
        }
    }
    assert!(replayed > 0, "no recorded answer under {}", answers.display());
}
