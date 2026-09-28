// SPDX-License-Identifier: AGPL-3.0-only
//! The few JavaScript rules a line the TypeScript package writes depends on, so the same line comes out here: how a
//! number prints, how toFixed rounds, which characters `\s` and trim take, and a string's length, which is counted in
//! UTF-16 units wherever a column is padded or a title is cut.

/// A character `\s` matches and trim takes off: the white space and the line terminators of ECMAScript, which is not
/// Rust's set (Rust counts U+0085 and not U+FEFF).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_space)
}

/// `text.replace(/\s+/g, " ")`.
pub fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `text.split(/\r?\n/)`.
pub fn lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    lines
}

/// A string's `length`.
pub fn len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte offset where the first `units` UTF-16 units of `text` end, never inside a character.
pub fn offset(text: &str, units: usize) -> usize {
    let mut counted = 0;
    for (at, c) in text.char_indices() {
        counted += c.len_utf16();
        if counted > units {
            return at;
        }
    }
    text.len()
}

/// `text.slice(0, units)`.
pub fn head(text: &str, units: usize) -> &str {
    &text[..offset(text, units)]
}

/// `text.padEnd(width)`.
pub fn pad_end(text: &str, width: usize) -> String {
    let short = width.saturating_sub(len(text));
    format!("{text}{}", " ".repeat(short))
}

/// `Math.round`: halves go up, toward positive infinity.
pub fn round(x: f64) -> f64 {
    let down = x.floor();
    if x - down >= 0.5 {
        down + 1.0
    } else {
        down
    }
}

/// `String(x)`: Number::toString, the shortest digits that read back as `x` laid out as ECMAScript lays them out.
pub fn number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let exp = format!("{:e}", x.abs());
    let (mantissa, e) = exp.split_once('e').unwrap_or((&exp, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = e.parse::<i32>().unwrap_or(0) + 1;
    let laid = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e < 0 { format!("-{}", -e) } else { format!("+{e}") };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{laid}")
}

/// `x.toFixed(digits)`: the exact value rounded to that many places, a tie going away from zero, where Rust's own
/// formatting would take it to the even digit.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number(x);
    }
    let exact = format!("{:.1100}", x.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let kept = &fraction[..digits];
    let dropped = &fraction[digits..];
    let mut number: Vec<u8> = format!("{whole}{kept}").into_bytes();
    if dropped.as_bytes().first().is_some_and(|d| *d >= b'5') {
        let mut at = number.len();
        loop {
            if at == 0 {
                number.insert(0, b'1');
                break;
            }
            at -= 1;
            if number[at] == b'9' {
                number[at] = b'0';
            } else {
                number[at] += 1;
                break;
            }
        }
    }
    let number = String::from_utf8(number).unwrap_or_default();
    let split = number.len() - digits;
    let (whole, fraction) = number.split_at(split);
    let sign = if x < 0.0 { "-" } else { "" };
    if digits == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        for (x, want) in [
            (0.30000000000000004, "0.30000000000000004"),
            (30.0, "30"),
            (1.5e-5, "0.000015"),
            (1e-7, "1e-7"),
            (1.25e-7, "1.25e-7"),
            (1e21, "1e+21"),
            (123456789012.0, "123456789012"),
            (-2.5, "-2.5"),
            (0.1, "0.1"),
            (1e20, "100000000000000000000"),
        ] {
            assert_eq!(number(x), want, "{x}");
        }
    }

    #[test]
    fn to_fixed_takes_a_tie_away_from_zero() {
        for (x, digits, want) in [
            (0.125, 2, "0.13"),
            (0.5, 0, "1"),
            (2.5, 0, "3"),
            (0.25, 1, "0.3"),
            (1.005, 2, "1.00"),
            (9.995, 2, "9.99"),
            (99.5, 0, "100"),
            (0.0, 2, "0.00"),
            (1.25, 2, "1.25"),
        ] {
            assert_eq!(to_fixed(x, digits), want, "{x}");
        }
    }

    #[test]
    fn spaces_and_lengths_are_javascripts() {
        assert_eq!(collapse_spaces("a \u{feff}\t b\u{85}c"), "a b\u{85}c");
        assert_eq!(trim("\u{a0} x \u{3000}"), "x");
        assert_eq!(len("a🧪é"), 4);
        assert_eq!(head("a🧪é", 2), "a");
        assert_eq!(pad_end("🧪", 4), "🧪  ");
        assert_eq!(lines("a\r\nb\nc\r"), vec!["a", "b", "c\r"]);
    }
}
