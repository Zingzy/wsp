// SPDX-License-Identifier: AGPL-3.0-only
//! JSON in the bytes the TypeScript server writes it in. A view passes through as the host wrote it, and the host
//! writes with JSON.stringify, so its key order and its numbers are already JavaScript's: laying those bytes out
//! again, two spaces a level, is `jsonLine(obj, 2)` without reading one value. serde_json's own map would sort the
//! keys, and its ordered map is a feature every crate of this workspace would be built with.

use std::fmt::Write;

use serde::Serialize;

/// DEL and the C1 controls as \u escapes, as the protocol's escapeC1 writes them: JSON leaves them raw, and a terminal
/// acts on a raw C1 byte as it does on ESC. They only ever stand inside a string, so the value parses the same.
pub fn escape_c1(text: String) -> String {
    let c1 = |c: char| ('\u{7f}'..='\u{9f}').contains(&c);
    if !text.chars().any(c1) {
        return text;
    }
    let mut out = String::with_capacity(text.len() + 16);
    for c in text.chars() {
        if c1(c) {
            let _ = write!(out, "\\u{:04x}", c as u32);
        } else {
            out.push(c);
        }
    }
    out
}

/// `jsonLine(value)` when `indent` is false and `jsonLine(value, 2)` when it is true.
pub fn js_line<T: Serialize + ?Sized>(value: &T, indent: bool) -> String {
    let compact = serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned());
    escape_c1(if indent { laid_out(&compact) } else { compact })
}

/// JSON text with every space outside its strings taken out: a recorded file read back as the one line stdio wants.
pub fn compact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    walk(text, |token| match token {
        Token::Space => {}
        Token::Open(c) | Token::Close(c) | Token::Comma(c) | Token::Colon(c) | Token::Other(c) => out.push(c),
        Token::Empty(open, close) => {
            out.push(open);
            out.push(close);
        }
    });
    out
}

/// Compact JSON laid out as JSON.stringify lays it out with an indent of two: a newline and the indent after every
/// opening bracket and comma and before every closing one, a space after each colon, and an empty object or array
/// kept on its one line.
pub fn laid_out(compact: &str) -> String {
    let mut out = String::with_capacity(compact.len() * 2);
    let mut depth = 0usize;
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        out.extend(std::iter::repeat_n("  ", depth));
    };
    walk(compact, |token| match token {
        Token::Space => {}
        Token::Open(c) => {
            depth += 1;
            out.push(c);
            newline(&mut out, depth);
        }
        Token::Close(c) => {
            depth = depth.saturating_sub(1);
            newline(&mut out, depth);
            out.push(c);
        }
        Token::Comma(c) => {
            out.push(c);
            newline(&mut out, depth);
        }
        Token::Colon(c) => {
            out.push(c);
            out.push(' ');
        }
        Token::Empty(open, close) => {
            out.push(open);
            out.push(close);
        }
        Token::Other(c) => out.push(c),
    });
    out
}

enum Token {
    Space,
    Open(char),
    Close(char),
    Empty(char, char),
    Comma(char),
    Colon(char),
    /// A character inside a string, or of a number or a literal.
    Other(char),
}

/// The characters of JSON text, told apart only as far as laying it out needs: inside a string everything is text.
fn walk(text: &str, mut each: impl FnMut(Token)) {
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            each(Token::Other(c));
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                each(Token::Other(c));
            }
            '{' | '[' => {
                let close = if c == '{' { '}' } else { ']' };
                while chars.peek().is_some_and(|n| n.is_ascii_whitespace()) {
                    chars.next();
                }
                if chars.peek() == Some(&close) {
                    chars.next();
                    each(Token::Empty(c, close));
                } else {
                    each(Token::Open(c));
                }
            }
            '}' | ']' => each(Token::Close(c)),
            ',' => each(Token::Comma(c)),
            ':' => each(Token::Colon(c)),
            c if c.is_ascii_whitespace() => each(Token::Space),
            c => each(Token::Other(c)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lays_out_as_json_stringify_does_with_two_spaces() {
        let compact = r#"{"a":[],"b":{},"c":[1,{"d":"x, y: {z}","e":null}],"f":"q\"}"}"#;
        let want = "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": \"x, y: {z}\",\n      \"e\": null\n    }\n  ],\n  \"f\": \"q\\\"}\"\n}";
        assert_eq!(laid_out(compact), want);
        assert_eq!(super::compact(want), compact);
        assert_eq!(laid_out("[]"), "[]");
        assert_eq!(laid_out("\"a\""), "\"a\"");
    }

    #[test]
    fn escapes_del_and_the_c1_controls_and_nothing_else() {
        assert_eq!(escape_c1("a\u{7f}b\u{85}c\u{9f}d\u{a0}é".to_owned()), "a\\u007fb\\u0085c\\u009fd\u{a0}é");
        assert_eq!(escape_c1("plain".to_owned()), "plain");
    }
}
