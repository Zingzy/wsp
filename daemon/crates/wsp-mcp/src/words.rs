// SPDX-License-Identifier: AGPL-3.0-only
//! The prose helpers a tool's text is written with, each the one of the same name in packages/protocol/src/format.ts
//! or packages/host/src/verbs.ts, ported rule for rule so a table or a title comes out in the same characters.

use crate::js;

/// `table`: columns padded to their widest cell, two spaces apart; the last column is never padded.
pub fn table(rows: &[Vec<String>]) -> Vec<String> {
    let mut widths: Vec<usize> = Vec::new();
    for row in rows {
        widths = row.iter().enumerate().map(|(i, cell)| widths.get(i).copied().unwrap_or(0).max(js::len(cell))).collect();
    }
    rows.iter()
        .map(|row| {
            let cells: Vec<String> = row
                .iter()
                .enumerate()
                .map(|(i, cell)| if i == row.len() - 1 { cell.clone() } else { js::pad_end(cell, widths.get(i).copied().unwrap_or(0)) })
                .collect();
            js::trim_end(&cells.join("  ")).to_owned()
        })
        .collect()
}

/// `cell`: a value on one line of a table, its newlines and tabs as spaces and every other control character gone.
pub fn cell(text: &str) -> String {
    text.chars()
        .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
        .filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
        .collect()
}

pub fn plural(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

/// `fmtCost`.
pub fn cost(usd: f64) -> String {
    format!("${}", js::to_fixed(usd, 2))
}

/// `fmtDuration` in its short style.
pub fn duration(ms: f64) -> String {
    if ms < 60_000.0 || !ms.is_finite() {
        return short_seconds(ms);
    }
    let total = if ms > 0.0 { js::round(ms / 1_000.0) } else { 0.0 };
    let minutes = (total / 60.0).floor();
    let seconds = total % 60.0;
    if seconds == 0.0 {
        format!("{}m", js::number(minutes))
    } else {
        format!("{}m {}s", js::number(minutes), js::number(seconds))
    }
}

fn short_seconds(ms: f64) -> String {
    if !ms.is_finite() || ms < 0.0 {
        return "0ms".to_owned();
    }
    if ms < 1_000.0 {
        return format!("{}ms", js::number(js::round(ms).max(1.0)));
    }
    if ms < 10_000.0 {
        let tenths = js::round(ms / 100.0) / 10.0;
        return if tenths >= 10.0 { "10s".to_owned() } else { format!("{}s", js::to_fixed(tenths, 1)) };
    }
    format!("{}s", js::number(js::round(ms / 1_000.0)))
}

/// `titleLine`: the first line with words on it, its white space collapsed.
pub fn title_line(text: &str) -> String {
    let first = js::lines(text).into_iter().find(|line| !js::trim(line).is_empty()).unwrap_or("");
    js::trim(&js::collapse_spaces(first)).to_owned()
}

const OPENING_TITLE_MAX: usize = 48;
const ELLIPSIS: &str = "\u{2026}";

/// `openingTitle`: the opening turn's first sentence, cut at a word to 48 characters.
pub fn opening_title(text: &str) -> String {
    let line = title_line(text);
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let sentence = chars
        .iter()
        .enumerate()
        .find(|(i, (_, c))| matches!(c, '.' | '!' | '?') && chars.get(i + 1).is_none_or(|(_, next)| js::is_space(*next)))
        .map_or(line.as_str(), |(_, (at, c))| &line[..at + c.len_utf8()]);
    cut_line(sentence, OPENING_TITLE_MAX)
}

fn without_separator_tail(text: &str) -> &str {
    text.trim_end_matches(|c: char| js::is_space(c) || matches!(c, ',' | ';' | ':'))
}

fn words_within(line: &str, room: usize) -> Option<&str> {
    let head = js::head(line, room + 1);
    let boundary = head.rfind(' ').filter(|at| *at > 0)?;
    Some(without_separator_tail(&head[..boundary]))
}

/// `cutLine`.
pub fn cut_line(text: &str, room: usize) -> String {
    if js::len(text) <= room {
        return text.to_owned();
    }
    let head = room - js::len(ELLIPSIS);
    let kept = words_within(text, head).unwrap_or_else(|| without_separator_tail(js::head(text, head)));
    format!("{kept}{ELLIPSIS}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|c| (*c).to_owned()).collect()
    }

    #[test]
    fn a_table_pads_every_column_but_the_last_by_utf16_width() {
        assert_eq!(table(&[row(&["A", "B", "C"]), row(&["🧪x", "", ""])]), vec!["A    B  C", "🧪x"]);
    }

    #[test]
    fn durations_read_as_the_chat_footer_writes_them() {
        for (ms, want) in [
            (0.4, "1ms"),
            (999.4, "999ms"),
            (1_250.0, "1.3s"),
            (9_960.0, "10s"),
            (12_400.0, "12s"),
            (60_000.0, "1m"),
            (492_000.0, "8m 12s"),
            (-1.0, "0ms"),
        ] {
            assert_eq!(duration(ms), want, "{ms}");
        }
    }

    #[test]
    fn an_opening_title_is_its_first_sentence_cut_at_a_word() {
        assert_eq!(opening_title("Fix the bug. Then ship"), "Fix the bug.");
        assert_eq!(opening_title("  \nsee v1.2 now"), "see v1.2 now");
        assert_eq!(
            opening_title("one two three four five six seven eight nine ten eleven"),
            "one two three four five six seven eight nine\u{2026}"
        );
        assert_eq!(opening_title(&"x".repeat(60)), format!("{}\u{2026}", "x".repeat(47)));
    }
}
