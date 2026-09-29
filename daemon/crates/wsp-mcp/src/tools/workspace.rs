// SPDX-License-Identifier: AGPL-3.0-only
//! What the workspace and image tools share: a workspace or a project named the way a person names one, the threads
//! a drop takes with it, the machine woken before work, the agents switch read off the arguments, the state word a
//! machine is in, and the few ways JavaScript writes a value that a sentence here has to write the same. Every
//! sentence is recorded under `workspaces` in record/words.json by packages/host/test/mcp-record-workspaces.ts.

use std::collections::{BTreeSet, HashMap};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Number, Value};

use crate::client::Client;
use crate::failure::Failure;
use crate::record::{self, fill};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Words {
    pub other_version_resolve: String,
    pub gone_bare: String,
    pub gone_said: String,
    pub state_lines: HashMap<String, String>,
    pub rebuild_refused: HashMap<String, String>,
    pub on_machine: String,
    pub renamed: String,
    pub agents_set: String,
    pub agents_off: String,
    pub agents_one: String,
    pub agents_many: String,
    pub agents_nothing: String,
    pub forgot_one: String,
    pub forgot_many: String,
    pub on_delete: HashMap<String, OnDelete>,
    pub delete_notice_one: String,
    pub delete_notice_many: String,
    pub deleted_one: String,
    pub deleted_many: String,
    pub delete_kept: String,
    pub kept_fallback: String,
    pub kept_none: String,
    pub kept_one: String,
    pub kept_many: String,
    pub already_newest: String,
    pub moved: String,
    pub no_project_image: String,
    pub remove_kept: String,
    pub remove_notice: String,
    pub removed_gone: String,
    pub removed_now: String,
    pub no_sealed_image: String,
    pub image_no_vault: String,
    pub copy_current: String,
    pub copy_stale: String,
    pub installs_latest: String,
    pub logins_held: Vec<String>,
    pub sum_shown: usize,
    pub catalog_names: HashMap<String, String>,
    pub road_words: HashMap<String, String>,
    pub added_project: String,
    pub this_mac: String,
    pub this_computer: String,
    pub here_place_id: String,
    pub no_project_yet: String,
    pub name_the_project: String,
    pub copy_takes_none: String,
    pub size_refused: String,
    pub no_project_image_named: String,
    pub project_image_of_other: String,
    pub cwd_not_absolute: String,
    pub pushed_one: String,
    pub pushed_many: String,
    pub pr_line: String,
    pub left_one: String,
    pub left_many: String,
    pub first_turn_failed: String,
}

/// What a delete says it will do to a machine and what it says once it did: a kind's own words, a copy's, or a
/// create that never made a machine.
#[derive(Deserialize)]
pub struct OnDelete {
    pub asked: String,
    pub done: String,
}

pub fn words() -> Words {
    record::words().workspaces
}

/// The recorded sentence for one of something or for a count of them, the count filled.
pub fn counted(n: u64, one: &str, many: &str) -> String {
    if n == 1 {
        one.to_owned()
    } else {
        fill(many, &[("count", &n.to_string())])
    }
}

/// The same for a count the host sent, written as it sent it.
pub fn counted_number(n: &Number, one: &str, many: &str) -> String {
    if n.as_f64() == Some(1.0) {
        one.to_owned()
    } else {
        fill(many, &[("count", &n.to_string())])
    }
}

/// An op's fields as a map, in the order given.
pub fn params<const N: usize>(pairs: [(&str, Value); N]) -> Map<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// A view the host sent read for the fields a tool needs, while the view itself passes through in its own bytes.
pub fn read<T: DeserializeOwned>(raw: &RawValue, op: &str) -> Result<T, Failure> {
    serde_json::from_str(raw.get()).map_err(|e| Failure::new(format!("{op}: {e}")))
}

/// A workspace as a tool reads it before it acts: what names it, the state its record is in, and what a delete
/// and a create say about it. packages/protocol's WorkspaceOut is the shape.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub machine_id: String,
    pub phase: Phase,
    #[serde(default)]
    pub kind: Option<Kind>,
    #[serde(default)]
    pub gone: Option<String>,
    #[serde(default)]
    pub copy: Option<Copy>,
    #[serde(default)]
    pub wake_refused: Option<String>,
    pub project: ProjectRef,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Running,
    Pausing,
    Napping,
    Waking,
    Gone,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Cloud,
    Local,
}

impl Kind {
    pub fn word(self) -> &'static str {
        match self {
            Kind::Cloud => "cloud",
            Kind::Local => "local",
        }
    }
}

#[derive(Deserialize)]
pub struct Copy {
    pub path: String,
}

#[derive(Deserialize)]
pub struct ProjectRef {
    pub id: String,
}

/// The workspace a person names, by id or by the one name it carries: the host reads the name off the list it
/// prints. A view this build cannot read is a host of another version, said in the command line's words.
pub async fn workspace_of(client: &Client, reference: &str) -> Result<Workspace, Failure> {
    #[derive(Deserialize)]
    struct Resolved {
        #[serde(default)]
        workspace: Option<Value>,
    }
    let resolved: Resolved = client.request("workspaces.resolve", params([("ref", Value::from(reference))])).await?;
    resolved.workspace.and_then(|w| serde_json::from_value(w).ok()).ok_or_else(|| Failure::new(words().other_version_resolve))
}

/// The one state word's key: the phase leads, and the machine's own state and the daemon reach only change it where
/// they contradict it. packages/protocol/src/workspace-state.ts `workspaceState` is the rule.
pub fn state_of(phase: Phase, machine: Option<&str>, reach: Option<&str>) -> &'static str {
    if machine == Some("gone") {
        return "gone";
    }
    match phase {
        Phase::Pausing => "pausing",
        Phase::Napping => "paused",
        Phase::Waking => "waking",
        Phase::Gone => "gone",
        Phase::Running => match (machine, reach) {
            (Some("paused"), _) => "paused",
            (Some("starting"), _) => "waking",
            (_, Some("unreachable" | "no-daemon" | "zombie")) => "unreachable",
            _ => "running",
        },
    }
}

/// The line a verb that moved a workspace prints: its name and the state its phase reads as.
pub fn state_line(name: &str, phase: Phase) -> String {
    let words = words();
    fill(&words.state_lines[state_of(phase, None, None)], &[("name", name)])
}

/// The state line with the machine now under the workspace, which a rebuild and a move change.
pub fn rebuilt_line(name: &str, phase: Phase, machine: &str) -> String {
    fill(&words().on_machine, &[("state", &state_line(name, phase)), ("machine", machine)])
}

/// Why a verb a gone machine cannot take is refused, with the provider's words when the record holds them.
pub fn gone_refusal(name: &str, action: &str, said: Option<&str>) -> Failure {
    let words = words();
    Failure::new(match said.filter(|s| !s.is_empty()) {
        Some(said) => fill(&words.gone_said, &[("name", name), ("action", action), ("words", said)]),
        None => fill(&words.gone_bare, &[("name", name), ("action", action)]),
    })
}

/// Wakes the machine a verb works on and answers with its view as the runtime left it; a gone one is refused in the
/// verb's own word first. packages/host/src/verbs.ts `awake` is the rule.
pub async fn awake(client: &Client, workspace: &Workspace, action: &str) -> Result<Box<RawValue>, Failure> {
    if state_of(workspace.phase, None, None) == "gone" {
        return Err(gone_refusal(&workspace.name, action, workspace.gone.as_deref()));
    }
    #[derive(Deserialize)]
    struct Woken {
        workspace: Box<RawValue>,
    }
    let woken: Woken = client.request("workspaces.wake", params([("workspaceId", Value::from(workspace.id.as_str()))])).await?;
    Ok(woken.workspace)
}

/// How many threads the workspace holds: its turns folded by the thread each belongs to, a turn with no thread being
/// one of its own.
pub async fn thread_count(client: &Client, workspace_id: &str) -> Result<u64, Failure> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Session {
        id: String,
        #[serde(default)]
        thread_id: Option<String>,
    }
    #[derive(Deserialize)]
    struct Sessions {
        sessions: Vec<Session>,
    }
    let listed: Sessions = client.request("sessions.list", params([("workspaceId", Value::from(workspace_id))])).await?;
    let threads: BTreeSet<String> = listed.sessions.into_iter().map(|s| s.thread_id.unwrap_or(s.id)).collect();
    Ok(threads.len() as u64)
}

/// What the agents arguments ask of the host: nothing when none was named, and a cap named alone tightens the switch
/// as it stands. The schema has already held the caps to whole numbers at their least.
pub fn agents_asked(spawn: Option<&str>, max_machines: Option<&Number>, max_depth: Option<&Number>) -> Option<Map<String, Value>> {
    if spawn.is_none() && max_machines.is_none() && max_depth.is_none() {
        return None;
    }
    let mut asked = Map::new();
    if let Some(spawn) = spawn {
        asked.insert("spawn".to_owned(), Value::from(spawn == "on"));
    }
    if let Some(n) = max_machines {
        asked.insert("maxMachines".to_owned(), Value::Number(n.clone()));
    }
    if let Some(n) = max_depth {
        asked.insert("maxDepth".to_owned(), Value::Number(n.clone()));
    }
    Some(asked)
}

/// The switch as one line: off, or on with the machines it may hold.
pub fn agents_line(agents: Option<&Agents>) -> String {
    let words = words();
    match agents {
        Some(Agents { spawn: true, max_machines }) => {
            if max_machines.as_f64() == Some(1.0) {
                words.agents_one
            } else {
                fill(&words.agents_many, &[("count", &max_machines.to_string())])
            }
        }
        _ => words.agents_off,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agents {
    pub spawn: bool,
    pub max_machines: Number,
}

/// A string as JSON.stringify writes it, less its quotes: the part of a sentence that quotes a word as it was given.
pub fn quoted_inner(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap_or_default();
    quoted[1..quoted.len() - 1].to_owned()
}

/// One POSIX sh word: single quotes keep every byte, and an embedded quote closes, escapes and reopens.
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// A name as a list of names prints it: quoted as JSON when a comma in it would read as two.
fn listed_name(name: &str) -> String {
    if name.contains(',') {
        serde_json::to_string(name).unwrap_or_default()
    } else {
        name.to_owned()
    }
}

pub fn name_list<S: AsRef<str>>(names: &[S]) -> String {
    names.iter().map(|n| listed_name(n.as_ref())).collect::<Vec<_>>().join(", ")
}

/// Strings in the order JavaScript's default sort puts them: by UTF-16 code unit, which differs from a byte order
/// past the Basic Multilingual Plane.
pub fn js_sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names
}

/// The first `n` UTF-16 code units of a string, as String.prototype.slice(0, n) takes them.
pub fn js_prefix(text: &str, n: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(n).collect::<Vec<_>>())
}

/// `n` with `noun`, the noun plural unless there is one.
pub fn plural(n: &Number, noun: &str) -> String {
    let s = if n.as_f64() == Some(1.0) { "" } else { "s" };
    format!("{n} {noun}{s}")
}

/// Number.prototype.toFixed: the nearest decimal at `digits` places, a tie going to the larger, read off the
/// double's exact value.
pub fn to_fixed(x: f64, digits: usize) -> String {
    let exact = format!("{:.1100}", x.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).map(|b| b - b'0').collect();
    let rest = &fraction.as_bytes()[digits.min(fraction.len())..];
    if rest.first().is_some_and(|&d| d >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, 1);
                break;
            }
            i -= 1;
            if kept[i] == 9 {
                kept[i] = 0;
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let point = kept.len() - digits;
    let digits_text: String = kept.iter().map(|d| char::from(b'0' + d)).collect();
    let body = if digits == 0 { digits_text } else { format!("{}.{}", &digits_text[..point], &digits_text[point..]) };
    if x < 0.0 && kept.iter().any(|&d| d != 0) {
        format!("-{body}")
    } else {
        body
    }
}

/// A number as JavaScript writes it in a template, for the whole and short decimal values a sentence here holds.
pub fn js_number(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e21 {
        format!("{x:.0}")
    } else {
        x.to_string()
    }
}

const KIB: f64 = 1024.0;
const MIB: f64 = KIB * 1024.0;
const GIB: f64 = MIB * 1024.0;

/// A byte count as every line that shows one writes it. packages/protocol/src/format.ts `fmtBytes` is the rule.
pub fn fmt_bytes(n: f64) -> String {
    let round = |v: f64| js_number((v + 0.5).floor());
    if n < KIB {
        return format!("{} B", js_number(n));
    }
    if n < MIB {
        return format!("{} KB", round(n / KIB));
    }
    if n < GIB {
        return format!("{} MB", round(n / MIB));
    }
    let gb = n / GIB;
    let tenths = to_fixed(gb, 1);
    let whole = tenths.parse::<f64>().is_ok_and(|t| t.fract() == 0.0);
    format!("{} GB", if whole { round(gb) } else { tenths })
}

/// A rate in dollars an hour, at the fewest places that do not round the price away. `fmtRate` is the rule.
pub fn fmt_rate(usd: f64) -> String {
    let mils = to_fixed(usd, 3);
    format!("${}/hr", if mils.ends_with('0') { to_fixed(usd, 2) } else { mils })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_as_javascript_does() {
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(0.09000000000000001, 3), "0.090");
        assert_eq!(to_fixed(9.99, 1), "10.0");
        assert_eq!(to_fixed(0.018, 2), "0.02");
        assert_eq!(to_fixed(4.0, 1), "4.0");
    }

    #[test]
    fn bytes_and_rates_read_as_the_protocol_writes_them() {
        assert_eq!(fmt_bytes(900.0), "900 B");
        assert_eq!(fmt_bytes(1_288_490_188.0), "1.2 GB");
        assert_eq!(fmt_bytes(2_147_483_648.0), "2 GB");
        assert_eq!(fmt_rate(0.09000000000000001), "$0.09/hr");
        assert_eq!(fmt_rate(0.018), "$0.018/hr");
        assert_eq!(fmt_rate(1.5), "$1.50/hr");
    }

    #[test]
    fn names_sort_by_utf16_and_list_with_commas_quoted() {
        assert_eq!(js_sorted(vec!["\u{ff5e}".into(), "\u{1f9ea}".into(), "a".into()]), vec!["a", "\u{1f9ea}", "\u{ff5e}"]);
        assert_eq!(name_list(&["a, b", "c"]), r#""a, b", c"#);
    }
}
