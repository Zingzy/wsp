// SPDX-License-Identifier: AGPL-3.0-only
//! What the TypeScript package recorded for this server under record/: the handshake's words, the sentences a refusal
//! is said in, the exit classes, and where the host is found and how long each step waits. Every word and number
//! here has its home in that package; packages/host/test/mcp-record.test.ts writes these files and fails until they
//! are written again after a change there. Each is read when it is needed, so a list answered with no host reads
//! nothing but the handshake.

use std::collections::HashMap;

use serde::Deserialize;

const SERVER: &str = include_str!("../record/server.json");
const WORDS: &str = include_str!("../record/words.json");
const EXIT: &str = include_str!("../record/exit.json");
const HOST: &str = include_str!("../record/host.json");

/// A record this build carries and cannot read is a build that never passed its own tests.
fn read<T: for<'de> Deserialize<'de>>(name: &str, text: &str) -> T {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("record/{name} does not read: {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub name: String,
    pub version: String,
    pub instructions: Instructions,
    pub protocol_versions: Vec<String>,
    pub latest_protocol_version: String,
}

/// What the server greets with, with WSP_CLOUD off and on: the TypeScript server words it for the state it runs in.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instructions {
    pub cloud_off: String,
    pub cloud_on: String,
}

pub fn server() -> Server {
    read("server.json", SERVER)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Words {
    pub no_host_serving: String,
    pub host_token_missing: String,
    pub no_answer: String,
    pub no_answer_within: String,
    pub host_closed: String,
    pub host_stopping: String,
    pub no_such_host_none: String,
    pub no_such_host_some: String,
    pub several_hosts: String,
    pub address_not_paired: String,
    pub host_no_key: String,
    pub launched_with: String,
    pub device_refused: String,
    pub scoped_no_pair: String,
    pub starting_host: String,
    pub no_host_answered: String,
    pub host_exited: String,
}

pub fn words() -> Words {
    read("words.json", WORDS)
}

/// A recorded sentence with each `{name}` in it filled.
pub fn fill(template: &str, fills: &[(&str, &str)]) -> String {
    fills.iter().fold(template.to_owned(), |said, (name, value)| said.replace(&format!("{{{name}}}"), value))
}

#[derive(Deserialize)]
pub struct Exit {
    pub codes: HashMap<String, i32>,
    pub kinds: HashMap<String, String>,
}

pub fn exit() -> Exit {
    read("exit.json", EXIT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub files: Files,
    pub env: EnvNames,
    pub started_by: String,
    pub ws_path: String,
    pub near_window_ms: u64,
    pub far_window_ms: u64,
    pub close_grace_ms: u64,
    pub unauthorized_close: u16,
    pub stopping_close: u16,
    pub start_wait_ms: u64,
    pub poll_ms: u64,
    pub probe_ms: u64,
    /// What a tool dials in place of the wildcard a host bound.
    pub loopback: String,
    /// Words held to the address helpers and the alias rule, each with the answer the TypeScript one gives it.
    #[cfg(test)]
    pub loopbacks: HashMap<String, bool>,
    #[cfg(test)]
    pub wildcards: HashMap<String, bool>,
    #[cfg(test)]
    pub urls: HashMap<String, UrlProbe>,
    #[cfg(test)]
    pub aliases: HashMap<String, bool>,
    #[cfg(test)]
    pub clouds: HashMap<String, bool>,
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlProbe {
    pub is_url: bool,
    pub hostname: Option<String>,
    pub ws: Option<String>,
}

/// File names beside the state file (lock, token, log, relay), under the wsp home (hosts), and the home under the
/// person's own folder.
#[derive(Deserialize)]
pub struct Files {
    pub lock: String,
    pub token: String,
    pub log: String,
    pub relay: String,
    pub hosts: String,
    pub home: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvNames {
    pub host: String,
    pub home: String,
    pub url: String,
    pub token: String,
    pub key: String,
    pub started_by: String,
    pub cloud: String,
}

pub fn host() -> Host {
    read("host.json", HOST)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_record_reads_and_every_sentence_is_filled() {
        let server = server();
        assert!(server.protocol_versions.contains(&server.latest_protocol_version));
        let _ = (exit(), host());
        let words = words();
        let noted = fill(&words.no_host_serving, &[("state", "/s/state.json")]);
        assert!(noted.contains("/s/state.json") && !noted.contains('{'), "{noted}");
    }
}
