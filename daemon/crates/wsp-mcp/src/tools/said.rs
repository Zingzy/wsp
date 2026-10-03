// SPDX-License-Identifier: AGPL-3.0-only
//! What the thread and turn tools say: their sentences as record/turns.json holds them, written there by
//! packages/host/test/mcp-record-turns.ts off the functions that say them, and the figures they are filled with in
//! the forms packages/protocol/src/format.ts writes a number, a length of time, a price or a size.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turns {
    pub several_threads: String,
    pub no_thread: String,
    pub other_version: String,
    pub gone: String,
    pub gone_with: String,
    pub stopped: HashMap<String, String>,
    pub stop_under_one: String,
    pub stop_under_some: String,
    pub stopped_task: HashMap<String, String>,
    pub stop_task_said: String,
    pub renamed: HashMap<String, String>,
    pub rename_failed_silent: String,
    pub agents: HashMap<String, String>,
    pub thread_without_id: String,
    pub thread_forgot: String,
    pub no_open_ask: String,
    pub answer_roads: Vec<AnswerRoad>,
    pub answered: String,
    pub answer_words: HashMap<String, String>,
    pub asks: Asks,
    pub finished: String,
    pub finished_bare: String,
    pub timed_out_one: String,
    pub timed_out_some: String,
    pub restarted: Restarted,
    pub host_did_not_stop: String,
    pub cwd_not_absolute: String,
    pub empty_task: String,
    pub no_adapter: String,
    pub no_adapter_none: String,
    pub picks: Picks,
    pub no_thread_target: String,
    pub guest_names_workspace: String,
    pub no_workspace_for_folder: String,
    pub thread_opened: String,
    pub opened_thread: String,
    pub no_result: String,
    pub no_thread_stamped: String,
    pub turn_failed: String,
    pub turn_no_result: String,
    pub after_cut: String,
    pub asleep_again: String,
    pub stays_awake: String,
    pub stays_awake_naps: String,
    pub files: Files,
    pub turn_token_env: String,
    pub notify_me: String,
    pub recipe: Recipe,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerRoad {
    pub effect: String,
    pub said: String,
    pub no_such_answer: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asks {
    pub command: String,
    pub skill: String,
    pub server: String,
    pub plain: String,
    pub plain_detail: String,
    pub write: String,
    pub write_in: String,
    pub write_size: String,
}

#[derive(Deserialize)]
pub struct Restarted {
    pub none: String,
    pub one: String,
    pub some: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Picks {
    pub not_one: HashMap<String, String>,
    pub legacy: String,
    pub takes_no_effort: String,
    pub no_fast: String,
    pub refused: String,
    pub built_in_list: String,
    pub built_in_table: String,
    /// An access that is none of wsp's words, refused with them named.
    pub access_words: String,
    pub access_not_taken: String,
    pub no_access_words: String,
    /// A word the agent maps to none of its modes, as a start refuses it, with `{said}` the sentence above.
    pub access_refused: String,
    /// wsp's access words, in the order a refusal names the ones an agent takes.
    pub access_choices: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Files {
    pub not_a_file: String,
    pub guest: String,
    pub refused: String,
    pub too_many: String,
    pub empty: String,
    pub image_too_big: String,
    pub file_too_big: String,
    pub untyped: String,
    pub image_max_bytes: u64,
    pub file_max_bytes: u64,
    pub max: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub out_not_absolute: String,
    pub project_not_absolute: String,
    pub agents_title: String,
    pub tools_title: String,
    pub tick_on: String,
    pub tick_off: String,
    pub gutter: String,
    pub group_labels: HashMap<String, String>,
    pub floor_line: String,
    pub floor_applies: HashMap<String, bool>,
    pub unknown_size: String,
    pub totals: String,
    pub totals_unknown: String,
    pub pin_latest: String,
    pub commands_title: String,
    pub commands_shown: usize,
    pub commands_head: Vec<String>,
    pub none: String,
    pub more: String,
    pub not_scanned: String,
    pub sign_ins_title: String,
    pub sign_ins_head: Vec<String>,
    pub also_title: HashMap<String, String>,
}

/// The record this build carries; one it cannot read is a build that never passed its own tests.
pub fn turns() -> &'static Turns {
    static TURNS: OnceLock<Turns> = OnceLock::new();
    TURNS.get_or_init(|| {
        serde_json::from_str(include_str!("../../record/turns.json")).unwrap_or_else(|e| panic!("record/turns.json does not read: {e}"))
    })
}

/// A number as JavaScript prints it in a template: a whole one without a point.
pub fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Math.round: halves go up, toward positive infinity.
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// Number.prototype.toFixed: the nearest, and of two as near the larger, where Rust's own formatting takes the even.
pub fn to_fixed(x: f64, digits: usize) -> String {
    let long = format!("{:.*}", digits + 80, x.abs());
    let point = long.find('.').unwrap_or(long.len());
    let tail = &long[point + 1 + digits..];
    if tail.starts_with('5') && tail[1..].bytes().all(|b| b == b'0') {
        let nudged = x.abs() + 0.5 * 10f64.powi(-(digits as i32));
        let up = format!("{:.*}", digits, nudged);
        return if x < 0.0 { format!("-{up}") } else { up };
    }
    format!("{:.*}", digits, x)
}

/// A duration in the short style: ms under a second, tenths under ten, whole seconds under a minute, then minutes
/// and seconds.
pub fn fmt_duration(ms: f64) -> String {
    if ms < 60_000.0 || !ms.is_finite() {
        if !ms.is_finite() || ms < 0.0 {
            return "0ms".to_owned();
        }
        if ms < 1_000.0 {
            return format!("{}ms", js_number(js_round(ms).max(1.0)));
        }
        if ms < 10_000.0 {
            let tenths = js_round(ms / 100.0) / 10.0;
            return if tenths >= 10.0 { "10s".to_owned() } else { format!("{}s", to_fixed(tenths, 1)) };
        }
        return format!("{}s", js_number(js_round(ms / 1_000.0)));
    }
    let total = if ms > 0.0 { js_round(ms / 1_000.0) as i64 } else { 0 };
    let minutes = total / 3_600 * 60 + (total % 3_600) / 60;
    let seconds = total % 60;
    if seconds == 0 {
        format!("{minutes}m")
    } else {
        format!("{minutes}m {seconds}s")
    }
}

/// How long until an idle window takes a machine: minutes, then hours and minutes, then days and hours.
pub fn fmt_uptime(ms: f64) -> String {
    let minutes = if ms.is_finite() && ms > 0.0 { (ms / 60_000.0).floor() as i64 } else { 0 };
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h {}m", minutes % 60);
    }
    format!("{}d {}h", hours / 24, hours % 24)
}

pub fn fmt_cost(usd: f64) -> String {
    format!("${}", to_fixed(usd, 2))
}

const KIB: f64 = 1024.0;
const MIB: f64 = KIB * 1024.0;
const GIB: f64 = MIB * 1024.0;

pub fn fmt_bytes(n: f64) -> String {
    if n < KIB {
        return format!("{} B", js_number(n));
    }
    if n < MIB {
        return format!("{} KB", js_number(js_round(n / KIB)));
    }
    if n < GIB {
        return format!("{} MB", js_number(js_round(n / MIB)));
    }
    let gb = n / GIB;
    let tenth = to_fixed(gb, 1);
    let whole = tenth.parse::<f64>().is_ok_and(|t| t.fract() == 0.0);
    format!("{} GB", if whole { js_number(js_round(gb)) } else { tenth })
}

pub fn plural(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

/// What JavaScript's \s and trim() take for white space.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// Every run of white space as one space, trimmed: `.replace(/\s+/g, " ").trim()`.
pub fn collapsed(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut spaced = false;
    for c in js_trim(text).chars() {
        if js_space(c) {
            spaced = true;
        } else {
            if spaced {
                out.push(' ');
                spaced = false;
            }
            out.push(c);
        }
    }
    out
}

/// The last line with anything on it, its white space collapsed.
pub fn last_line(text: &str) -> Option<String> {
    text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).rfind(|line| !js_trim(line).is_empty()).map(collapsed)
}

/// A string's length as JavaScript counts it, in UTF-16 units, which is what its padding pads to.
pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn pad_end(text: &str, width: usize) -> String {
    format!("{text}{}", " ".repeat(width.saturating_sub(js_len(text))))
}

pub fn pad_start(text: &str, width: usize) -> String {
    format!("{}{text}", " ".repeat(width.saturating_sub(js_len(text))))
}

/// The first `n` UTF-16 units, as `.slice(0, n)` cuts.
pub fn js_head(text: &str, n: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(n).collect::<Vec<_>>())
}

/// A thread by the first eight characters of its id, as every line names one.
pub fn thread_word(id: &str) -> String {
    js_head(id, 8)
}

/// A value inside a sentence as JSON.stringify quotes it, less the quotes the sentence already carries.
pub fn quoted_inside(text: &str) -> String {
    let json = serde_json::to_string(text).unwrap_or_default();
    json[1..json.len() - 1].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn figures_read_as_javascript_writes_them() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(0.1 + 0.2, 2), "0.30");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(fmt_cost(0.125), "$0.13");
        assert_eq!(fmt_duration(0.2), "1ms");
        assert_eq!(fmt_duration(999.5), "1000ms");
        assert_eq!(fmt_duration(1_000.0), "1.0s");
        assert_eq!(fmt_duration(9_960.0), "10s");
        assert_eq!(fmt_duration(59_600.0), "60s");
        assert_eq!(fmt_duration(60_000.0), "1m");
        assert_eq!(fmt_duration(81_456.0), "1m 21s");
        assert_eq!(fmt_duration(3_600_000.0 + 61_000.0), "61m 1s");
        assert_eq!(fmt_bytes(1023.0), "1023 B");
        assert_eq!(fmt_bytes(2048.0), "2 KB");
        assert_eq!(fmt_bytes(5_300_000.0), "5 MB");
        assert_eq!(fmt_bytes(1_600_000_000.0), "1.5 GB");
        assert_eq!(fmt_bytes(2.0 * GIB), "2 GB");
        assert_eq!(fmt_uptime(90_000_000.0), "1d 1h");
        assert_eq!(last_line("a\r\n\n  last \u{a0} line \n\n"), Some("last line".to_owned()));
        assert_eq!(last_line(" \n "), None);
        assert_eq!(collapsed("\u{85}x"), "\u{85}x");
        assert_eq!(pad_end("🧪", 3), "🧪 ");
    }

    #[test]
    fn the_record_reads() {
        let turns = turns();
        assert!(turns.agents.contains_key("claude"));
        assert_eq!(turns.answer_roads.len(), 2);
    }
}
