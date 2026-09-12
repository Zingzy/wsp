// SPDX-License-Identifier: AGPL-3.0-only
//! URLs a tool asked to open, read as the node daemon reads them. A sign-in URL's redirect_uri names the callback
//! port the host forwards; a plain local URL names a port the host forwards to the laptop's loopback.

use wsp_frames::is_http_url;
use wsp_frames::{numbers, RelayPort};

/// Hosts a sign-in's redirect comes back to on the machine itself.
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];
/// Hosts a dial of localhost on the machine reaches: the loopback names and the wildcard binds servers print.
const LOCAL_HOSTS: [&str; 5] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"];

struct Url {
    hostname: String,
    port: Option<u16>,
    query: String,
}

/// Enough of a URL to read its host, port and query: the scheme, an authority without userinfo, the port when it is
/// explicit and not the scheme's default, and the query without the fragment.
fn parse_url(s: &str) -> Option<Url> {
    let at = s.find("://")?;
    let scheme = s[..at].to_ascii_lowercase();
    let mut letters = scheme.chars();
    if !letters.next()?.is_ascii_alphabetic() || !letters.all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return None;
    }
    let rest = &s[at + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if host_port.is_empty() {
        return None;
    }
    let (hostname, port) = if let Some(inner) = host_port.strip_prefix('[') {
        let close = inner.find(']')?;
        let tail = &inner[close + 1..];
        let port = match tail.strip_prefix(':') {
            Some(p) => Some(p),
            None if tail.is_empty() => None,
            None => return None,
        };
        (format!("[{}]", inner[..close].to_ascii_lowercase()), port)
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) => (h.to_ascii_lowercase(), Some(p)),
            None => (host_port.to_ascii_lowercase(), None),
        }
    };
    let port = match port {
        None | Some("") => None,
        Some(p) => {
            if !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n: u32 = p.parse().ok()?;
            if n > 65535 {
                return None;
            }
            Some(n as u16)
        }
    };
    let port = match (scheme.as_str(), port) {
        ("http", Some(80)) | ("https", Some(443)) => None,
        (_, p) => p,
    };
    let after = rest[end..].split('#').next().unwrap_or("");
    let query = after.split_once('?').map(|(_, q)| q.to_owned()).unwrap_or_default();
    Some(Url { hostname, port, query })
}

/// Percent-decoding as a query string is read: a plus is a space.
fn form_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(b) => {
                    out.push(b);
                    i += 2;
                }
                Err(_) => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Url {
    fn query_param(&self, name: &str) -> Option<String> {
        self.query.split('&').find_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(k) == name).then(|| form_decode(v))
        })
    }
}

fn valid_port(n: u32) -> Option<u16> {
    u16::try_from(n).ok().and_then(RelayPort::new).map(RelayPort::get)
}

/// Which port on the machine a sign-in URL's redirect_uri names, for the forward to bind on the laptop: absent when
/// the page does not come back to the machine, when the redirect names no explicit port, or when the port is one
/// the laptop could not bind.
pub(crate) fn callback_port_of(url: &str) -> Option<u16> {
    let target = parse_url(&parse_url(url)?.query_param("redirect_uri")?)?;
    if !LOOPBACK_HOSTS.contains(&target.hostname.as_str()) {
        return None;
    }
    valid_port(u32::from(target.port?))
}

/// The port a plain local URL names: http or https, a local host and an explicit port.
pub(crate) fn localhost_port_of(url: &str) -> Option<u16> {
    let parsed = parse_url(url)?;
    if !is_http_url(url) || !LOCAL_HOSTS.contains(&parsed.hostname.as_str()) {
        return None;
    }
    valid_port(u32::from(parsed.port?))
}

/// A host the WHATWG parser behind node's URL would refuse: empty, or carrying a code point no host may (a percent
/// sign, an angle bracket, a backslash, a caret, a bar, a control character).
fn host_ok(hostname: &str) -> bool {
    !hostname.is_empty() && !hostname.chars().any(|c| matches!(c, '%' | '<' | '>' | '\\' | '^' | '|') || c.is_control())
}

/// The protocol's isHttpUrl as the open socket applies it: http or https with nothing unprintable, at most
/// OPEN_URL_MAX characters as a JavaScript string counts them, and a URL the parser can read a host out of.
pub(crate) fn is_open_url(url: &str) -> bool {
    if url.encode_utf16().count() > numbers::OPEN_URL_MAX || !is_http_url(url) {
        return false;
    }
    parse_url(url).is_some_and(|u| host_ok(u.hostname.trim_start_matches('[').trim_end_matches(']')))
}

#[cfg(test)]
mod tests {
    use super::*;

    // URLs as the tools build them (measurement 2026-09-03); state and challenge values are placeholders.
    const WRANGLER: &str = "https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread&state=S&code_challenge=C&code_challenge_method=S256";
    // A flow whose redirect is a hosted page the person copies a code from: no callback port on the machine.
    const HOSTED_CALLBACK: &str = "https://accounts.example/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.example%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=C&code_challenge_method=S256&state=S";
    const GH_DEVICE: &str = "https://github.com/login/device";

    #[test]
    fn callback_port_of_reads_the_redirect_uri_as_the_protocol_does() {
        assert_eq!(callback_port_of(WRANGLER), Some(8976));
        assert_eq!(callback_port_of(HOSTED_CALLBACK), None);
        // A hosted redirect with an explicit port is still not a port on this machine.
        assert_eq!(callback_port_of("https://a.test/x?redirect_uri=https%3A%2F%2Fplatform.example%3A8443%2Fcb"), None);
        assert_eq!(callback_port_of(GH_DEVICE), None);
        assert_eq!(callback_port_of("https://a.test/x?redirect_uri=http%3A%2F%2F127.0.0.1%3A45543%2Fcb"), Some(45543));
        assert_eq!(callback_port_of("https://a.test/x?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A8080%2Fcb"), Some(8080));
        // A redirect with no explicit port, and one to a port the laptop cannot bind, name nothing.
        assert_eq!(callback_port_of("https://a.test/x?redirect_uri=http%3A%2F%2F127.0.0.1%2Foauth%2Fcallback"), None);
        assert_eq!(callback_port_of("https://a.test/x?redirect_uri=http%3A%2F%2Flocalhost%3A631%2Fcb"), None);
        assert_eq!(callback_port_of("not a url"), None);
    }

    #[test]
    fn localhost_port_of_a_url_a_tool_asked_to_open() {
        for (url, port) in [
            ("http://localhost:8123/", Some(8123)),
            ("http://127.0.0.1:5173", Some(5173)),
            ("https://0.0.0.0:8443/x", Some(8443)),
            ("http://[::1]:3000/", Some(3000)),
            ("http://[::]:9000", Some(9000)),
            ("HTTP://LOCALHOST:8080/", Some(8080)),
            ("http://localhost:80/", None),
            ("http://localhost/", None),
            ("http://localhost:631/", None),
            ("http://192.168.1.20:8080/", None),
            ("http://example.test:8080/", None),
            ("ftp://localhost:2121/", None),
            ("http://localhost:70000/", None),
            ("localhost:8123", None),
            ("", None),
        ] {
            assert_eq!(localhost_port_of(url), port, "{url}");
        }
    }

    #[test]
    fn is_open_url_is_the_protocols_rule_with_the_parse_check_behind_it() {
        for url in [WRANGLER, GH_DEVICE, "HTTPS://X.TEST/A", "https://[::1]:8976/cb", "http://localhost:8123/"] {
            assert!(is_open_url(url), "{url}");
        }
        let long = format!("https://x.test/{}", "a".repeat(numbers::OPEN_URL_MAX));
        for url in [
            "https://%",
            "https://[::1",
            "https://exa%mple.com/x",
            "https://x.test/a b",
            "file:///etc/passwd",
            "http://",
            "http://:8080/",
            &long,
        ] {
            assert!(!is_open_url(url), "{url}");
        }
    }
}
