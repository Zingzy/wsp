// SPDX-License-Identifier: AGPL-3.0-only
//! The Rust half of the contract: the fixture set under daemon/fixtures/contract, which the protocol package's
//! own test reads with the zod schemas, read here with the serde types. Every accept frame must deserialize and
//! serialize back to the same JSON, every reject frame must fail, and every word and number must match.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use wsp_frames::{
    numbers, words, DaemonAuthRequest, DaemonEvent, DaemonRequest, MachineLinkRequest, PlaceAuthRequest, PlaceProveRequest, DAEMON_OPS,
    MACHINE_OPS,
};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contract")
}

fn read_frames(path: &Path) -> Vec<Value> {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let frames: Vec<Value> = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert!(!frames.is_empty(), "{} holds no frames", path.display());
    frames
}

/// Which files sit in a fixture folder, as (name, accept or reject, path).
fn cases(folder: &str) -> Vec<(String, bool, PathBuf)> {
    let dir = fixtures().join(folder);
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let path = entry.unwrap().path();
        let file = path.file_name().unwrap().to_str().unwrap().to_owned();
        let (name, accept) = if let Some(n) = file.strip_suffix(".accept.json") {
            (n.to_owned(), true)
        } else if let Some(n) = file.strip_suffix(".reject.json") {
            (n.to_owned(), false)
        } else {
            panic!("{} is neither an accept nor a reject file", path.display());
        };
        out.push((name, accept, path));
    }
    out.sort();
    assert!(!out.is_empty(), "{} is empty", dir.display());
    out
}

/// Equal as JSON values, with numbers compared by value so 80 and 80.0 are one number.
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w))),
        _ => a == b,
    }
}

fn round_trip<T: DeserializeOwned + Serialize>(frame: &Value, at: &str) -> Value {
    let parsed: T = serde_json::from_value(frame.clone()).unwrap_or_else(|e| panic!("{at}: refused an accept frame {frame}: {e}"));
    let back = serde_json::to_value(&parsed).unwrap();
    assert!(json_eq(frame, &back), "{at}: {frame} came back as {back}");
    back
}

fn refuses<T: DeserializeOwned>(frame: &Value, at: &str) {
    assert!(serde_json::from_value::<T>(frame.clone()).is_err(), "{at}: accepted a reject frame {frame}");
}

#[test]
fn every_request_frame_reads_as_the_protocol_does() {
    let mut seen = Vec::new();
    for (op, accept, path) in cases("frames") {
        let at = path.display().to_string();
        if accept {
            seen.push(op.clone());
        }
        for frame in read_frames(&path) {
            let tag = frame.get("op").and_then(Value::as_str).map(str::to_owned);
            match (op.as_str(), accept) {
                ("auth", true) => {
                    round_trip::<DaemonAuthRequest>(&frame, &at);
                }
                ("auth", false) => refuses::<DaemonAuthRequest>(&frame, &at),
                ("place.auth", true) => {
                    round_trip::<PlaceAuthRequest>(&frame, &at);
                }
                ("place.auth", false) => refuses::<PlaceAuthRequest>(&frame, &at),
                ("place.prove", true) => {
                    round_trip::<PlaceProveRequest>(&frame, &at);
                }
                ("place.prove", false) => refuses::<PlaceProveRequest>(&frame, &at),
                (name, true) if name.starts_with("machine.") => {
                    round_trip::<MachineLinkRequest>(&frame, &at);
                }
                (name, false) if name.starts_with("machine.") => refuses::<MachineLinkRequest>(&frame, &at),
                (_, true) => {
                    round_trip::<DaemonRequest>(&frame, &at);
                }
                (_, false) => refuses::<DaemonRequest>(&frame, &at),
            }
            if accept {
                assert_eq!(tag.as_deref(), Some(op.as_str()), "{at}: an accept frame names another op");
            }
        }
    }
    let mut expected: Vec<String> =
        DAEMON_OPS.iter().chain(MACHINE_OPS.iter()).chain(["auth", "place.auth", "place.prove"].iter()).map(|s| (*s).to_owned()).collect();
    expected.sort();
    assert_eq!(seen, expected, "every op has one accept file and every accept file names an op");
}

#[test]
fn every_event_frame_reads_as_the_protocol_does() {
    let mut seen = Vec::new();
    for (kind, accept, path) in cases("events") {
        let at = path.display().to_string();
        for frame in read_frames(&path) {
            if accept {
                let back = round_trip::<DaemonEvent>(&frame, &at);
                assert_eq!(back.get("type").and_then(Value::as_str), Some(kind.as_str()), "{at}: an accept frame names another type");
            } else {
                refuses::<DaemonEvent>(&frame, &at);
            }
        }
        if accept {
            seen.push(kind);
        }
    }
    let mut expected = vec![
        "browser.open",
        "callback.port",
        "daemon.hello",
        "inbox.file",
        "localhost.url",
        "port.close",
        "port.open",
        "proc.snapshot",
        "pty.data",
        "pty.exit",
        "pty.mode",
        "sys.sample",
        "tunnel.data",
        "tunnel.end",
    ];
    expected.sort_unstable();
    assert_eq!(seen, expected);
}

/// The sample arguments the fixture renders every sentence with a hole in it at.
const SAMPLE_OP: &str = "sys.explode";
const SAMPLE_PORT: u16 = 8123;
const SAMPLE_URL: &str = "http://192.168.1.20:7080";
const SAMPLE_REASON: &str = "connect ECONNREFUSED";
const SAMPLE_KIND: &str = "cloud";

fn rendered_words() -> BTreeMap<&'static str, String> {
    let mut m = BTreeMap::new();
    m.insert("AUTH_TOKEN_REFUSED", words::AUTH_TOKEN_REFUSED.to_owned());
    m.insert("AUTH_FIRST_FRAME", words::AUTH_FIRST_FRAME.to_owned());
    m.insert("AUTH_TOO_MANY_BYTES", words::AUTH_TOO_MANY_BYTES.to_owned());
    m.insert("AUTH_NO_FRAME_IN_TIME", words::AUTH_NO_FRAME_IN_TIME.to_owned());
    m.insert("INVALID_JSON", words::INVALID_JSON.to_owned());
    m.insert("NO_TOKEN_AT_START", words::NO_TOKEN_AT_START.to_owned());
    m.insert("FAILED_TO_START", words::FAILED_TO_START.to_owned());
    m.insert("PLACE_LEAVE_ROAD_REFUSAL", words::PLACE_LEAVE_ROAD_REFUSAL.to_owned());
    m.insert("NOT_ON_THIS_ROAD", words::NOT_ON_THIS_ROAD.to_owned());
    m.insert("NOT_ON_THIS_KIND", words::NOT_ON_THIS_KIND.to_owned());
    m.insert("HOST_REFUSED_PLACE", words::HOST_REFUSED_PLACE.to_owned());
    m.insert("NO_PLACE_FILE", words::NO_PLACE_FILE.to_owned());
    m.insert("LINK_CLOSE_STOPPING", words::LINK_CLOSE_STOPPING.to_owned());
    m.insert("LINK_CLOSE_ATTEMPT_OVER", words::LINK_CLOSE_ATTEMPT_OVER.to_owned());
    m.insert("LINK_CLOSE_QUIET", words::LINK_CLOSE_QUIET.to_owned());
    m.insert("unknownOp", words::unknown_op(SAMPLE_OP));
    m.insert("portScopeRefusal", words::port_scope_refusal(SAMPLE_PORT));
    m.insert("notOnThisKind", words::not_on_this_kind(SAMPLE_KIND));
    m.insert("hostKeyRefusal", words::host_key_refusal(SAMPLE_URL));
    m.insert("listeningLine", words::listening_line(numbers::DEFAULT_HOST, numbers::DEFAULT_PORT));
    m.insert("readyLine", words::ready_line(12));
    m.insert("oomNotSet", words::oom_not_set(SAMPLE_REASON));
    m.insert("priorityNotSet", words::priority_not_set(SAMPLE_REASON));
    m.insert("linkCouldNotDial", words::link_could_not_dial(SAMPLE_URL, SAMPLE_REASON));
    m.insert("linkNoAnswerIn", words::link_no_answer_in(SAMPLE_URL, 10));
    m.insert("linkNotAFrame", words::link_not_a_frame(SAMPLE_URL));
    m.insert("linkRefused", words::link_refused(SAMPLE_URL, words::HOST_REFUSED_PLACE));
    m.insert("linkUnreadableAuthReply", words::link_unreadable_auth_reply(SAMPLE_URL, SAMPLE_REASON));
    m.insert("linkNoAnswerToDial", words::link_no_answer_to_dial(SAMPLE_URL));
    m.insert("linkLinked", words::link_linked(SAMPLE_URL));
    m.insert("linkQuiet", words::link_quiet(SAMPLE_URL, 30));
    m
}

fn rendered_numbers() -> BTreeMap<&'static str, Value> {
    let mut m = BTreeMap::new();
    m.insert("DAEMON_VERSION", Value::from(numbers::DAEMON_VERSION));
    m.insert("DEFAULT_HOST", Value::from(numbers::DEFAULT_HOST));
    m.insert("DEFAULT_PORT", Value::from(numbers::DEFAULT_PORT));
    m.insert("DEFAULT_TOKEN_PATH", Value::from(numbers::DEFAULT_TOKEN_PATH));
    m.insert("DEFAULT_INBOX_DIR", Value::from(numbers::DEFAULT_INBOX_DIR));
    m.insert("DEFAULT_MANIFEST_PATH", Value::from(numbers::DEFAULT_MANIFEST_PATH));
    m.insert("DEFAULT_RUN_DIR", Value::from(numbers::DEFAULT_RUN_DIR));
    m.insert("DEFAULT_LOG_DIR", Value::from(numbers::DEFAULT_LOG_DIR));
    m.insert("GUEST_DAEMON_DIR", Value::from(numbers::GUEST_DAEMON_DIR));
    m.insert("DAEMON_ROOTS_PATH", Value::from(numbers::DAEMON_ROOTS_PATH));
    m.insert("OPEN_SHIM_PATH", Value::from(numbers::OPEN_SHIM_PATH));
    m.insert("XDG_OPEN_PATH", Value::from(numbers::XDG_OPEN_PATH));
    m.insert("OPEN_SOCKET_PATH", Value::from(numbers::OPEN_SOCKET_PATH));
    m.insert("PRE_AUTH_MAX_BYTES", Value::from(numbers::PRE_AUTH_MAX_BYTES));
    m.insert("AUTH_DEADLINE_MS", Value::from(numbers::AUTH_DEADLINE_MS));
    m.insert("AUTH_CLOSE_CODE", Value::from(words::AUTH_CLOSE_CODE));
    m.insert("TUNNEL_CAP", Value::from(numbers::TUNNEL_CAP));
    m.insert("EXEC_BODY_MAX", Value::from(numbers::EXEC_BODY_MAX));
    m.insert("EXEC_OUTPUT_MAX", Value::from(numbers::EXEC_OUTPUT_MAX));
    m.insert("EXEC_TIMEOUT_DEFAULT_MS", Value::from(numbers::EXEC_TIMEOUT_DEFAULT_MS));
    m.insert("EXEC_TIMEOUT_MAX_MS", Value::from(numbers::EXEC_TIMEOUT_MAX_MS));
    m.insert("EXEC_DEADLINE_EXIT", Value::from(numbers::EXEC_DEADLINE_EXIT));
    m.insert("FS_READ_CAP_BYTES", Value::from(numbers::FS_READ_CAP_BYTES));
    m.insert("FS_LIST_CAP_ENTRIES", Value::from(numbers::FS_LIST_CAP_ENTRIES));
    m.insert("GIT_DIFF_CAP_BYTES", Value::from(numbers::GIT_DIFF_CAP_BYTES));
    m.insert("SCROLLBACK_CAP_BYTES", Value::from(numbers::SCROLLBACK_CAP_BYTES));
    m.insert("CMDLINE_BYTES", Value::from(numbers::CMDLINE_BYTES));
    m.insert("PORT_CMDLINE_CAP_BYTES", Value::from(numbers::PORT_CMDLINE_CAP_BYTES));
    m.insert("PROC_CAP", Value::from(numbers::PROC_CAP));
    m.insert("PID_MAX", Value::from(numbers::PID_MAX));
    m.insert("OPEN_BODY_CAP", Value::from(numbers::OPEN_BODY_CAP));
    m.insert("OPEN_URL_MAX", Value::from(numbers::OPEN_URL_MAX));
    m.insert("PLACE_LINK_NONCE_BYTES", Value::from(numbers::PLACE_LINK_NONCE_BYTES));
    m.insert("DAEMON_OOM_SCORE_ADJ", Value::from(numbers::DAEMON_OOM_SCORE_ADJ));
    m.insert("DAEMON_NICE", Value::from(numbers::DAEMON_NICE));
    m.insert("WORK_OOM_SCORE_ADJ", Value::from(numbers::WORK_OOM_SCORE_ADJ));
    m.insert("workScoreLine", Value::from(numbers::work_score_line()));
    m
}

fn committed<T: DeserializeOwned>(file: &str) -> BTreeMap<String, T> {
    let path = fixtures().join(file);
    serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn every_word_matches_the_committed_fixture() {
    let ours = rendered_words();
    let theirs: BTreeMap<String, String> = committed("words.json");
    let our_keys: Vec<&str> = ours.keys().copied().collect();
    let their_keys: Vec<&str> = theirs.keys().map(String::as_str).collect();
    assert_eq!(our_keys, their_keys, "words.json and the Rust words name the same sentences");
    for (key, sentence) in &ours {
        assert_eq!(&theirs[*key], sentence, "words.json[{key}]");
    }
}

#[test]
fn every_number_matches_the_committed_fixture() {
    let ours = rendered_numbers();
    let theirs: BTreeMap<String, Value> = committed("numbers.json");
    let our_keys: Vec<&str> = ours.keys().copied().collect();
    let their_keys: Vec<&str> = theirs.keys().map(String::as_str).collect();
    assert_eq!(our_keys, their_keys, "numbers.json and the Rust numbers name the same constants");
    for (key, value) in &ours {
        assert!(json_eq(&theirs[*key], value), "numbers.json[{key}] is {} here and {} there", value, theirs[*key]);
    }
}
