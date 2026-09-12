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
use wsp_frames::{numbers, words, DaemonAuthRequest, DaemonEvent, DaemonRequest, PlaceAuthRequest, PlaceProveRequest, DAEMON_OPS};

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
    // The machine ops join the set with the branch that puts them in the protocol, which is what the set is read from.
    let mut expected: Vec<String> =
        DAEMON_OPS.iter().chain(["auth", "place.auth", "place.prove"].iter()).map(|s| (*s).to_owned()).collect();
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

/// The fixture set is generated from the protocol package's exports, so its keys are that package's names and a
/// sentence with a hole in it is kept as a template whose braces name what the daemon fills in. This table is the
/// one place a Rust name meets a fixture key, and every hole is rendered with the same placeholder word the protocol
/// test renders it with, so the two halves compare the same text. Sentences the node daemon never emits and no
/// client matches on (the bin's failure prefix, the link's close reasons, the ready line) stay Rust-only.
fn rendered_words() -> BTreeMap<&'static str, String> {
    let mut m = BTreeMap::new();
    m.insert("tokenRefused", words::AUTH_TOKEN_REFUSED.to_owned());
    m.insert("firstFrameNotAuth", words::AUTH_FIRST_FRAME.to_owned());
    m.insert("preAuthBytesExceeded", words::AUTH_TOO_MANY_BYTES.to_owned());
    m.insert("authDeadlinePassed", words::AUTH_NO_FRAME_IN_TIME.to_owned());
    m.insert("invalidJson", words::INVALID_JSON.to_owned());
    m.insert("noToken", words::NO_TOKEN_AT_START.to_owned());
    m.insert("unknownOp", words::unknown_op("{op}"));
    m.insert("portScopeRefusal", words::port_scope_refusal("{port}"));
    m.insert("placeLeaveRoadRefusal", words::PLACE_LEAVE_ROAD_REFUSAL.to_owned());
    m.insert("notOnThisKind", words::NOT_ON_THIS_KIND.to_owned());
    m.insert("hostKeyRefusal", words::host_key_refusal("{url}"));
    m.insert("listening", words::listening_line("{host}", "{port}"));
    m.insert("sysSamplerStarted", words::SYS_SAMPLER_STARTED.to_owned());
    m.insert("sysSamplerStopped", words::SYS_SAMPLER_STOPPED.to_owned());
    m.insert("procSamplerStarted", words::PROC_SAMPLER_STARTED.to_owned());
    m.insert("procSamplerStopped", words::PROC_SAMPLER_STOPPED.to_owned());
    m.insert("noPlaceFile", words::NO_PLACE_FILE.to_owned());
    m.insert("linked", words::link_linked("{url}"));
    m.insert("hostQuiet", words::link_quiet("{url}", "{seconds}"));
    m.insert("dialUnanswered", words::link_no_answer_to_dial("{url}"));
    m.insert("dialTimedOut", words::link_no_answer_in("{url}", "{seconds}"));
    m.insert("dialFailed", words::link_could_not_dial("{url}", "{error}"));
    m.insert("notAFrame", words::link_not_a_frame("{url}"));
    m.insert("authUnreadable", words::link_unreadable_auth_reply("{url}", "{error}"));
    m.insert("hostRefused", words::link_refused("{url}", "{refusal}"));
    m
}

/// The numbers the set pins, under the protocol's names. The run and log dirs, the exec timeout ceiling, the auth
/// close code and the second spelling of the open body cap are Rust-only until the protocol exports them.
fn rendered_numbers() -> BTreeMap<&'static str, Value> {
    let mut m = BTreeMap::new();
    m.insert("daemonVersion", Value::from(numbers::DAEMON_VERSION));
    m.insert("execBodyMax", Value::from(numbers::EXEC_BODY_MAX));
    m.insert("execOutputMax", Value::from(numbers::EXEC_OUTPUT_MAX));
    m.insert("execTimeoutDefaultMs", Value::from(numbers::EXEC_TIMEOUT_DEFAULT_MS));
    m.insert("execDeadlineExit", Value::from(numbers::EXEC_DEADLINE_EXIT));
    m.insert("placeLinkNonceBytes", Value::from(numbers::PLACE_LINK_NONCE_BYTES));
    m.insert("preAuthMaxBytes", Value::from(numbers::PRE_AUTH_MAX_BYTES));
    m.insert("authDeadlineMs", Value::from(numbers::AUTH_DEADLINE_MS));
    m.insert("tunnelCap", Value::from(numbers::TUNNEL_CAP));
    m.insert("fsReadCapBytes", Value::from(numbers::FS_READ_CAP_BYTES));
    m.insert("fsListCapEntries", Value::from(numbers::FS_LIST_CAP_ENTRIES));
    m.insert("gitDiffCapBytes", Value::from(numbers::GIT_DIFF_CAP_BYTES));
    m.insert("ptyScrollbackCapBytes", Value::from(numbers::SCROLLBACK_CAP_BYTES));
    m.insert("procCmdlineBytes", Value::from(numbers::CMDLINE_BYTES));
    m.insert("portCommandBytes", Value::from(numbers::PORT_CMDLINE_CAP_BYTES));
    m.insert("procCap", Value::from(numbers::PROC_CAP));
    m.insert("pidMax", Value::from(numbers::PID_MAX));
    m.insert("openBodyMax", Value::from(numbers::OPEN_BODY_CAP));
    m.insert("daemonDefaultHost", Value::from(numbers::DEFAULT_HOST));
    m.insert("daemonDefaultPort", Value::from(numbers::DEFAULT_PORT));
    m.insert("daemonTokenPath", Value::from(numbers::DEFAULT_TOKEN_PATH));
    m.insert("daemonRootsPath", Value::from(numbers::DAEMON_ROOTS_PATH));
    m.insert("guestInboxDir", Value::from(numbers::DEFAULT_INBOX_DIR));
    m.insert("guestManifestPath", Value::from(numbers::DEFAULT_MANIFEST_PATH));
    m.insert("openShimPath", Value::from(numbers::OPEN_SHIM_PATH));
    m.insert("xdgOpenPath", Value::from(numbers::XDG_OPEN_PATH));
    m.insert("openSocketPath", Value::from(numbers::OPEN_SOCKET_PATH));
    m.insert("guestDaemonDir", Value::from(numbers::GUEST_DAEMON_DIR));
    m.insert("daemonOomScoreAdj", Value::from(numbers::DAEMON_OOM_SCORE_ADJ));
    m.insert("daemonNice", Value::from(numbers::DAEMON_NICE));
    m.insert("workOomScoreAdj", Value::from(numbers::WORK_OOM_SCORE_ADJ));
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
