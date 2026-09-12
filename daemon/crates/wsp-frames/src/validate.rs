// SPDX-License-Identifier: AGPL-3.0-only
//! The bounds the zod schemas put on strings and numbers, applied at deserialization so a frame the protocol
//! refuses is one these types refuse too.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

/// zod's .max counts UTF-16 code units, which is what a JavaScript string's length is.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub(crate) fn bounded<'de, D, const MIN: usize, const MAX: usize>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(d)?;
    let len = js_len(&s);
    if len < MIN {
        return Err(de::Error::custom(format!("string must be at least {MIN} characters, got {len}")));
    }
    if len > MAX {
        return Err(de::Error::custom(format!("string must be at most {MAX} characters, got {len}")));
    }
    Ok(s)
}

pub(crate) fn bounded_list<'de, D, const EACH: usize, const MAX: usize>(d: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let list = Vec::<String>::deserialize(d)?;
    if list.len() > MAX {
        return Err(de::Error::custom(format!("at most {MAX} entries, got {}", list.len())));
    }
    if let Some(long) = list.iter().find(|s| js_len(s) > EACH) {
        return Err(de::Error::custom(format!("entry longer than {EACH} characters: {long}")));
    }
    Ok(list)
}

pub(crate) fn non_empty_list<'de, D>(d: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let list = Vec::<String>::deserialize(d)?;
    if list.is_empty() {
        return Err(de::Error::custom("at least one entry"));
    }
    Ok(list)
}

/// The protocol's isHttpUrl: http or https, then anything that is not whitespace or a control character.
pub fn is_http_url(url: &str) -> bool {
    let bytes = url.as_bytes();
    let rest = if bytes.len() >= 7 && bytes[..7].eq_ignore_ascii_case(b"http://") {
        &url[7..]
    } else if bytes.len() >= 8 && bytes[..8].eq_ignore_ascii_case(b"https://") {
        &url[8..]
    } else {
        return false;
    };
    !rest.is_empty() && !rest.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub(crate) fn http_url<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(d)?;
    if !is_http_url(&s) {
        return Err(de::Error::custom("http or https URL"));
    }
    Ok(s)
}

pub(crate) fn positive<'de, D>(d: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    match Option::<u32>::deserialize(d)? {
        Some(0) => Err(de::Error::custom("must be positive")),
        other => Ok(other),
    }
}

pub(crate) fn exec_timeout<'de, D>(d: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    match positive(d)? {
        Some(ms) if ms > crate::numbers::EXEC_TIMEOUT_MAX_MS => Err(de::Error::custom("timeoutMs above the cap")),
        other => Ok(other),
    }
}

/// A port the host may forward: the protocol's RelayPort, 1024 to 65535.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct RelayPort(u16);

impl RelayPort {
    pub const MIN: u16 = 1024;

    pub fn new(port: u16) -> Option<RelayPort> {
        (port >= Self::MIN).then_some(RelayPort(port))
    }

    pub fn get(self) -> u16 {
        self.0
    }
}

impl<'de> Deserialize<'de> for RelayPort {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let port = u16::deserialize(d)?;
        RelayPort::new(port).ok_or_else(|| de::Error::custom(format!("port must be between {} and 65535", RelayPort::MIN)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_urls_are_read_as_the_protocol_reads_them() {
        assert!(is_http_url("http://localhost:8123/"));
        assert!(is_http_url("HTTPS://Accounts.Example/auth?x=1"));
        assert!(!is_http_url("http://"));
        assert!(!is_http_url("ftp://x"));
        assert!(!is_http_url("https://a b"));
        assert!(!is_http_url("https://a\u{1f}b"));
        assert!(!is_http_url("日本語://x"));
        assert!(!is_http_url("ħttps://x"));
    }

    #[test]
    fn js_length_counts_utf16_units() {
        assert_eq!(js_len("abc"), 3);
        assert_eq!(js_len("日本語"), 3);
        assert_eq!(js_len("😀"), 2);
    }
}
