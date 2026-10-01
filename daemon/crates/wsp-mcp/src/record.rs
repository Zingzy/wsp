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
    /// The tools whose work reads this computer, which a guest is not served: its caller means the machine it is on.
    pub reads_here: Vec<String>,
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
    /// A send whose start the host stopped under and no host came back to take.
    pub not_delivered: String,
    pub no_such_host_none: String,
    pub no_such_host_some: String,
    pub several_hosts: String,
    pub address_not_paired: String,
    pub host_no_key: String,
    pub launched_with: String,
    pub device_refused: String,
    pub pair_key: String,
    pub device_auth_old_host: String,
    pub scoped_no_pair: String,
    pub starting_host: String,
    pub no_host_answered: String,
    pub host_exited: String,
    /// The id a target names the computer the host runs on by.
    pub here_place_id: String,
    /// Each catalog entry's name by its id: what a line calls an agent.
    pub agent_names: HashMap<String, String>,
    pub other_version: String,
    pub no_such_place: String,
    pub places_fix: String,
    pub aimed_usage: String,
    pub aimed_both: String,
    pub project_unnamed: String,
    pub project_off_computer: String,
    pub tools_project_bare: String,
    pub skills_sh_placeless: String,
    pub unset_variable: String,
    pub not_header: String,
    pub unclosed_quote: String,
    pub project_scope: String,
    pub no_skill_hits: String,
    pub skill_hit_columns: Vec<String>,
    pub preview_bytes: u64,
    pub preview_cut: String,
    pub is_in: String,
    pub is_in_also: String,
    pub agent_copy: String,
    pub gone_from: String,
    pub turned_on: String,
    pub turned_off: String,
    pub turned_on_in: String,
    pub turned_off_in: String,
    pub tools_added: String,
    pub server_tools_head: String,
    pub server_tools_held: String,
    pub server_tools_refused: String,
    pub server_tools_none: String,
    pub server_tool_columns: Vec<String>,
    /// Command lines, each with the words the TypeScript split gives it, or none where a quote is never closed.
    #[cfg(test)]
    pub command_words: HashMap<String, Option<Vec<String>>>,
    pub workspaces: crate::tools::workspace::Words,
    pub host_would_not_read: String,
    pub both_targets: HashMap<String, String>,
    pub folder_here: String,
    pub folder_on: String,
    pub no_thread: String,
    pub threads_start_with: String,
    pub no_messages: String,
    pub no_reply: String,
    pub newer_turn: String,
    pub no_terminal_config: String,
    /// Each verb's usage line by the name of its tool, which a refusal of a reply this build cannot read ends with.
    pub usages: HashMap<String, String>,
    pub defaults: crate::tools::defaults::Words,
}

pub fn words() -> Words {
    read("words.json", WORDS)
}

/// A recorded sentence with each `{name}` in it filled, in one pass over the template: a value is never read again,
/// so one that holds a placeholder's name stands as given. A `{name}` no fill names stays as it is.
pub fn fill(template: &str, fills: &[(&str, &str)]) -> String {
    let mut said = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        said.push_str(&rest[..open]);
        let named = rest[open + 1..].find('}').and_then(|close| {
            let name = &rest[open + 1..open + 1 + close];
            fills.iter().find(|(n, _)| *n == name).map(|(_, value)| (*value, open + close + 2))
        });
        match named {
            Some((value, past)) => {
                said.push_str(value);
                rest = &rest[past..];
            }
            None => {
                said.push('{');
                rest = &rest[open + 1..];
            }
        }
    }
    said.push_str(rest);
    said
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
    /// The words after the wsp that bring a host up, with `{state}` where the state file goes.
    pub up_args: Vec<String>,
    pub poll_ms: u64,
    pub probe_ms: u64,
    /// What a tool dials in place of the wildcard a host bound.
    pub loopback: String,
    /// The word a client's seal stands in the place id's slot with, in its transcript and its key derivation.
    pub seal_client: String,
    /// The reason a socket is closed with when a frame on it does not open under the agreed key.
    pub seal_refusal: String,
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
    /// The key this computer signs an admission with, beside the hosts it holds.
    #[serde(rename = "deviceKey")]
    pub device_key: String,
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
        assert_eq!(fill("{a} and {b}, {c} {a}", &[("a", "{b}"), ("b", "x}")]), "{b} and x}, {c} {b}");
        assert_eq!(fill("{ {a}", &[("a", "1")]), "{ 1");
    }

    #[test]
    fn a_value_that_reads_like_a_placeholder_is_said_as_it_is() {
        assert_eq!(fill("{name} is in {path}.", &[("name", "{path}"), ("path", "~/x")]), "{path} is in ~/x.");
        assert_eq!(fill("{a} {unfilled} {", &[("a", "1")]), "1 {unfilled} {");
    }
}
