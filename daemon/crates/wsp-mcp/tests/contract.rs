// SPDX-License-Identifier: AGPL-3.0-only
//! Every answer the TypeScript server recorded, replayed: a host that answers each op with the frame it answered
//! there, and the one line this server prints for the same call, which must be the recorded line byte for byte, and
//! the ops it asked the host on the way, which must be the ones recorded with the same fields.
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
    #[serde(default)]
    pushed: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    closes: Option<String>,
    /// The command line a recipe tool runs and what it printed; the case holds the words it must be run with.
    #[serde(default)]
    wsp: Option<Wsp>,
    /// The platform the answer names this computer by; another platform's answer is not this computer's to print.
    #[serde(default)]
    platform: Option<String>,
    /// Recorded with the cloud on, which is the only state some tools are served in.
    #[serde(default)]
    cloud: bool,
    line: String,
    asked: Vec<Value>,
}

#[derive(Deserialize)]
struct Wsp {
    argv: Vec<String>,
    stdout: String,
    stderr: String,
    exit: i32,
}

/// A wsp that writes the words it was run with beside itself and prints what the recorded one printed.
fn fake_wsp(dir: &Path, wsp: &Wsp) -> std::path::PathBuf {
    let script = dir.join("wsp");
    std::fs::write(dir.join("stdout"), &wsp.stdout).unwrap();
    std::fs::write(dir.join("stderr"), &wsp.stderr).unwrap();
    let at = dir.display();
    let body = format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{at}/argv'\ncat '{at}/stdout'\ncat '{at}/stderr' >&2\nexit {}\n", wsp.exit);
    std::fs::write(&script, body).unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    script
}

fn this_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
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
    // The record's clocks were written in UTC; a read prints the time of day in this process's zone.
    std::env::set_var("TZ", "UTC");
    let answers = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("answers");
    let mut replayed = 0;
    for file in std::fs::read_dir(&answers).unwrap() {
        let recorded: Answers = serde_json::from_str(&std::fs::read_to_string(file.unwrap().path()).unwrap()).unwrap();
        for case in recorded.cases {
            if case.platform.as_deref().is_some_and(|p| p != this_platform()) {
                continue;
            }
            let dir = tempfile::tempdir().unwrap();
            let script = common::Script { replies: case.replies, pushed: case.pushed, closes: case.closes };
            let (port, frames) = common::scripted("contract-token", script).await;
            let state = served_state(dir.path(), port, "contract-token");
            let wsp = case.wsp.as_ref().map(|wsp| vec![fake_wsp(dir.path(), wsp).to_string_lossy().into_owned()]).unwrap_or_default();
            let asked = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": recorded.tool, "arguments": case.arguments } });
            let input = format!("{asked}\n");
            let mut out = Vec::new();
            let home = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
            let mut env: wsp_mcp::Env = case.env.into_iter().collect();
            env.insert("WSP_HOME".to_owned(), home("home"));
            env.insert("HOME".to_owned(), home("user"));
            if case.cloud {
                env.insert("WSP_CLOUD".to_owned(), "1".to_owned());
            }
            let code = wsp_mcp::serve(&Args { state: state.clone(), wsp, ..Args::default() }, &env, input.as_bytes(), &mut out).await;
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
            if let Some(wsp) = &case.wsp {
                let ran = std::fs::read_to_string(dir.path().join("argv")).unwrap();
                let asked: Vec<String> = wsp.argv.iter().map(|w| w.replace("{state}", &state.to_string_lossy())).collect();
                assert_eq!(ran.lines().collect::<Vec<_>>(), asked, "{} {}: the words wsp was run with", recorded.tool, case.case);
            }
            replayed += 1;
        }
    }
    assert!(replayed > 0, "no recorded answer under {}", answers.display());
}
