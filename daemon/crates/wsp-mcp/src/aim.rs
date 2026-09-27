// SPDX-License-Identifier: AGPL-3.0-only
//! Which host a tool call goes to, read in the command line's order off the same files: the --host word or WSP_HOST,
//! then the address and token a turn's launch left in the environment, then the host this computer serves the state
//! file with, then the account's one host, and last this computer, where a host is started. The files are the
//! lock and the token beside the state, the relay record beside it, and one record per alias under the wsp home.
//! packages/host/src/hosts.ts `aimedHost` is the rule; the names, the sentences and the probes the helpers below are
//! held to are in record/.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::failure::Failure;
use crate::record::{self, fill};
use crate::Env;

/// Where a call dials: the host serving the state file here, a host on the account under an alias, or an address
/// with the token a launch carried for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Aim {
    Here,
    Alias { alias: String, record: HostRecord },
    Url { url: String, token: Option<String>, host_key: Option<String> },
}

/// What this computer keeps about a host on its account: its address, the device token the first dial bought, and
/// the fingerprint of the key every dial holds it to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecord {
    pub url: String,
    pub device_id: String,
    pub device_token: String,
    #[serde(default)]
    pub host_key: Option<String>,
    via: Via,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Via {
    kind: String,
    host_id: String,
}

/// The host whose lock names a state file: its pid, the ports it bound and the address it bound them on.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lock {
    pub pid: i32,
    pub port: u16,
    pub ws_port: u16,
    #[serde(default)]
    pub address: Option<String>,
    /// Read so a lock without it is no lock, as the command line's reader holds it.
    #[allow(dead_code)]
    started_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Relay {
    /// Read so a file without them is no relay record, as the command line's reader holds it.
    #[allow(dead_code)]
    relay_url: String,
    host_id: String,
    #[allow(dead_code)]
    token: String,
}

/// What a caller names when it asks where to dial: the --host word, the environment, and the wsp home.
pub struct Pick<'a> {
    pub host: Option<&'a str>,
    pub env: &'a Env,
    pub home: PathBuf,
}

/// The wsp home: the folder WSP_HOME names, unset and empty being one answer, else the default under HOME.
pub fn wsp_home(env: &Env) -> PathBuf {
    let names = record::host();
    if let Some(home) = env.get(&names.env.home).filter(|h| !h.is_empty()) {
        return PathBuf::from(home);
    }
    let user = env.get("HOME").filter(|h| !h.is_empty()).map(PathBuf::from).or_else(std::env::home_dir).unwrap_or_default();
    user.join(names.files.home)
}

pub fn aimed(state: &Path, pick: &Pick) -> Result<Aim, Failure> {
    let names = record::host();
    let words = record::words();
    let env = |name: &str| pick.env.get(name).map(|v| v.trim().to_owned());
    let named = [pick.host.map(|h| h.trim().to_owned()), env(&names.env.host)].into_iter().flatten().find(|w| !w.is_empty());
    if let Some(named) = named {
        return aim_at(&named, pick);
    }
    if let Some((url, token, host_key)) = launched(pick.env) {
        return keyed(Aim::Url { url, token: Some(token), host_key }, &words.launched_with);
    }
    if serving(state).is_some() {
        return Ok(Aim::Here);
    }
    let own = beside(state, &names.files.relay).and_then(|path| read_json::<Relay>(&path)).map(|r| r.host_id);
    let held: Vec<(String, HostRecord)> =
        account_records(&pick.home).into_iter().filter(|(_, r)| Some(&r.via.host_id) != own.as_ref()).collect();
    match held.as_slice() {
        [] => Ok(Aim::Here),
        [(alias, record)] => keyed(Aim::Alias { alias: alias.clone(), record: record.clone() }, alias),
        several => {
            let aliases: Vec<&str> = several.iter().map(|(a, _)| a.as_str()).collect();
            Err(Failure::usage(fill(&words.several_hosts, &[("count", &aliases.len().to_string()), ("aliases", &aliases.join(", "))])))
        }
    }
}

/// The address, token and pinned key a turn's launch left for it, where both of the first two are there.
pub fn launched(env: &Env) -> Option<(String, String, Option<String>)> {
    let names = record::host();
    let read = |name: &str| env.get(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    Some((read(&names.env.url)?, read(&names.env.token)?, read(&names.env.key)))
}

fn aim_at(named: &str, pick: &Pick) -> Result<Aim, Failure> {
    if is_url(named) {
        let carried = launched(pick.env).filter(|(url, _, _)| url == named);
        let (token, host_key) = carried.map_or((None, None), |(_, token, key)| (Some(token), key));
        return keyed(Aim::Url { url: named.to_owned(), token, host_key }, named);
    }
    let Some(record) = read_host(&pick.home, named) else {
        let words = record::words();
        let known: Vec<String> = account_records(&pick.home).into_iter().map(|(alias, _)| alias).collect();
        let said = if known.is_empty() {
            fill(&words.no_such_host_none, &[("alias", named)])
        } else {
            fill(&words.no_such_host_some, &[("alias", named), ("known", &known.join(", "))])
        };
        return Err(Failure::usage(said));
    };
    keyed(Aim::Alias { alias: named.to_owned(), record }, named)
}

/// An aim that carries a token holds the fingerprint of the key that host proves before the token goes anywhere; an
/// address on this computer's own loopback is what a line aimed at the host here is, and needs none.
fn keyed(aim: Aim, from: &str) -> Result<Aim, Failure> {
    let (token, key, address) = match &aim {
        Aim::Here => return Ok(aim),
        Aim::Alias { record, .. } => (Some(&record.device_token), record.host_key.as_ref(), &record.url),
        Aim::Url { url, token, host_key } => (token.as_ref(), host_key.as_ref(), url),
    };
    if token.is_none() || key.is_some() || served_hostname(address).is_some_and(|at| is_loopback(&at)) {
        return Ok(aim);
    }
    Err(Failure::auth(fill(&record::words().host_no_key, &[("where", from)])))
}

/// The host whose lock names this state file, when that process is still alive.
pub fn serving(state: &Path) -> Option<Lock> {
    let lock: Lock = read_json(&beside(state, &record::host().files.lock)?)?;
    pid_alive(lock.pid).then_some(lock)
}

/// Whether a pid is a live process, whoever owns it: a lock another login holds is still a held lock.
fn pid_alive(pid: i32) -> bool {
    // SAFETY: signal 0 checks the pid and delivers nothing.
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

/// Where the host serving this state file here answers, the token it wrote beside the file, and the address as a
/// person reads it.
pub fn here_door(state: &Path) -> Result<(String, String, String), Failure> {
    let names = record::host();
    let words = record::words();
    let Some(lock) = serving(state) else {
        return Err(Failure::new(fill(&words.no_host_serving, &[("state", &state.to_string_lossy())])));
    };
    let token_path = beside(state, &names.files.token).unwrap_or_default();
    let Some(token) = std::fs::read_to_string(&token_path).ok().map(|t| t.trim().to_owned()) else {
        return Err(Failure::auth(fill(&words.host_token_missing, &[("path", &token_path.to_string_lossy())])));
    };
    let at = authority(&dial_address(&lock), lock.ws_port);
    Ok((format!("ws://{at}"), token, at))
}

/// Where a tool on this computer dials the host a lock names: the address it bound, and loopback for the wildcard.
pub fn dial_address(lock: &Lock) -> String {
    let loopback = record::host().loopback;
    let at = lock.address.clone().unwrap_or(loopback.clone());
    if is_wildcard(&at) {
        loopback
    } else {
        at
    }
}

pub fn authority(address: &str, port: u16) -> String {
    if address.contains(':') && !address.starts_with('[') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    }
}

/// How long a dial waits for its socket and the answer to its first frame: the near window for a host here or on
/// loopback, the far one for anything reached through what sits between.
pub fn window_ms(aim: &Aim) -> u64 {
    let names = record::host();
    let address = match aim {
        Aim::Here => return names.near_window_ms,
        Aim::Alias { record, .. } => &record.url,
        Aim::Url { url, .. } => url,
    };
    if served_hostname(address).is_some_and(|at| is_loopback(&at)) {
        names.near_window_ms
    } else {
        names.far_window_ms
    }
}

fn beside(state: &Path, name: &str) -> Option<PathBuf> {
    Some(state.parent()?.join(name))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// A record written by a road that is gone, or edited into nonsense, reads as none.
fn read_host(home: &Path, alias: &str) -> Option<HostRecord> {
    if !alias_ok(alias) {
        return None;
    }
    let record: HostRecord = read_json(&home.join(record::host().files.hosts).join(format!("{alias}.json")))?;
    (record.via.kind == "account").then_some(record)
}

/// Every record under the hosts folder with its alias, by alias.
fn account_records(home: &Path) -> Vec<(String, HostRecord)> {
    let Ok(dir) = std::fs::read_dir(home.join(record::host().files.hosts)) else { return Vec::new() };
    let mut held: Vec<(String, HostRecord)> = dir
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok()?.strip_suffix(".json").map(str::to_owned))
        .filter_map(|alias| read_host(home, &alias).map(|record| (alias, record)))
        .collect();
    held.sort_by(|(a, _), (b, _)| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a)));
    held
}

/// An alias is one name, never a path: a letter or a digit, then letters, digits, dots, dashes and underscores, at
/// most 64 characters, and never a dot-dot.
fn alias_ok(alias: &str) -> bool {
    const ALIAS_MAX: usize = 64;
    let mut chars = alias.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && alias.len() <= ALIAS_MAX
        && !alias.contains("..")
}

pub fn is_url(word: &str) -> bool {
    scheme_of(word).is_some()
}

fn scheme_of(word: &str) -> Option<(&'static str, &str)> {
    let (scheme, rest) = word.split_once("://")?;
    ["https", "http", "wss", "ws"].into_iter().find(|s| s.eq_ignore_ascii_case(scheme)).map(|s| (s, rest))
}

pub fn is_loopback(address: &str) -> bool {
    if matches!(address, "localhost" | "::1" | "[::1]") {
        return true;
    }
    let parts: Vec<&str> = address.split('.').collect();
    parts.len() == 4 && parts[0] == "127" && parts[1..].iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

fn is_wildcard(address: &str) -> bool {
    matches!(address, "0.0.0.0" | "::")
}

/// An address split as a browser's URL reads what this needs of it: the scheme, the host name lowercased, the port
/// where it is not the scheme's own, and the path without its query or fragment.
struct Parts {
    scheme: &'static str,
    hostname: String,
    port: Option<String>,
    path: String,
}

fn parts(url: &str) -> Option<Parts> {
    let (scheme, rest) = scheme_of(url)?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (hostname, port) = match host_port.rfind(':') {
        Some(at) if !host_port[at..].contains(']') => (&host_port[..at], Some(&host_port[at + 1..])),
        _ => (host_port, None),
    };
    let default = if matches!(scheme, "https" | "wss") { "443" } else { "80" };
    let port = port.filter(|p| !p.is_empty() && *p != default).map(str::to_owned);
    let path = tail.split(['?', '#']).next().unwrap_or("");
    Some(Parts {
        scheme,
        hostname: hostname.to_ascii_lowercase(),
        port,
        path: if path.is_empty() { "/".to_owned() } else { path.to_owned() },
    })
}

/// The name of the computer in an address a person is pointed at: http and https alone.
pub fn served_hostname(word: &str) -> Option<String> {
    let parts = parts(word)?;
    (matches!(parts.scheme, "http" | "https") && !parts.hostname.is_empty()).then_some(parts.hostname)
}

/// The WebSocket address of a host at this address: the same authority over ws or wss, with the runtime's path on
/// the end of whatever path the address already carries.
pub fn ws_url_of(url: &str) -> Option<String> {
    let parts = parts(url)?;
    let scheme = if matches!(parts.scheme, "https" | "wss") { "wss" } else { "ws" };
    let host = parts.port.map_or(parts.hostname.clone(), |port| format!("{}:{port}", parts.hostname));
    Some(format!("{scheme}://{host}{}{}", parts.path.trim_end_matches('/'), record::host().ws_path))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn the_address_helpers_answer_every_probe_as_the_protocol_does() {
        let host = record::host();
        for (word, want) in &host.loopbacks {
            assert_eq!(is_loopback(word), *want, "is_loopback({word:?})");
        }
        for (word, want) in &host.wildcards {
            assert_eq!(is_wildcard(word), *want, "is_wildcard({word:?})");
        }
        for (word, want) in &host.urls {
            assert_eq!(is_url(word), want.is_url, "is_url({word:?})");
            assert_eq!(served_hostname(word), want.hostname, "served_hostname({word:?})");
            assert_eq!(if is_url(word) { ws_url_of(word) } else { None }, want.ws, "ws_url_of({word:?})");
        }
        for (alias, want) in &host.aliases {
            assert_eq!(alias_ok(alias), *want, "alias_ok({alias:?})");
        }
    }

    fn record_at(home: &Path, alias: &str, url: &str, host_id: &str, key: Option<&str>) {
        let dir = home.join("hosts");
        std::fs::create_dir_all(&dir).unwrap();
        let mut record = serde_json::json!({ "url": url, "deviceId": "d1", "deviceToken": "t1", "pairedAt": "x", "via": { "kind": "account", "hostId": host_id } });
        if let Some(key) = key {
            record["hostKey"] = key.into();
        }
        std::fs::write(dir.join(format!("{alias}.json")), record.to_string()).unwrap();
    }

    #[test]
    fn reads_the_command_lines_order() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let state = dir.path().join("state").join("state.json");
        let env: Env = HashMap::new();
        let pick = |host: Option<&'static str>, env: &'static Env| Pick { host, env, home: home.clone() };
        let empty: &'static Env = Box::leak(Box::new(env));
        // Nothing named, nothing serving, no account host: this computer, where a host is started.
        assert_eq!(aimed(&state, &pick(None, empty)).unwrap(), Aim::Here);
        // One account host: it, pinned. A second: the person names one.
        record_at(&home, "attic", "https://attic.example", "h-attic", Some("SHA256:k"));
        assert!(matches!(aimed(&state, &pick(None, empty)).unwrap(), Aim::Alias { alias, .. } if alias == "attic"));
        record_at(&home, "cellar", "https://cellar.example", "h-cellar", Some("SHA256:k"));
        let several = aimed(&state, &pick(None, empty)).unwrap_err();
        assert_eq!(several.kind.as_deref(), Some("usage"));
        assert!(several.message.contains("2 hosts on your account (attic, cellar)"), "{}", several.message);
        // The record whose host id is this computer's own relay record is this host, and drops out.
        std::fs::create_dir_all(state.parent().unwrap()).unwrap();
        std::fs::write(state.parent().unwrap().join("relay.json"), r#"{"relayUrl":"r","hostId":"h-cellar","token":"t"}"#).unwrap();
        assert!(matches!(aimed(&state, &pick(None, empty)).unwrap(), Aim::Alias { alias, .. } if alias == "attic"));
        // A lock whose process is alive: this computer, ahead of the account.
        std::fs::write(
            state.parent().unwrap().join("host.lock"),
            format!(r#"{{"pid":{},"port":1,"wsPort":2,"startedAt":"x"}}"#, std::process::id()),
        )
        .unwrap();
        assert_eq!(aimed(&state, &pick(None, empty)).unwrap(), Aim::Here);
        // The launch's pair goes ahead of the lock; a non-loopback pair with no key is refused.
        let launched: &'static Env = Box::leak(Box::new(
            [("WSP_HOST_URL".to_owned(), "https://far.example".to_owned()), ("WSP_HOST_TOKEN".to_owned(), "tt".to_owned())]
                .into_iter()
                .collect(),
        ));
        let refused = aimed(&state, &pick(None, launched)).unwrap_err();
        assert_eq!(refused.kind.as_deref(), Some("auth"));
        assert!(refused.message.starts_with("the launch this turn started with names a host and no key"), "{}", refused.message);
        let near: &'static Env = Box::leak(Box::new(
            [("WSP_HOST_URL".to_owned(), "http://127.0.0.1:9".to_owned()), ("WSP_HOST_TOKEN".to_owned(), "tt".to_owned())]
                .into_iter()
                .collect(),
        ));
        assert_eq!(
            aimed(&state, &pick(None, near)).unwrap(),
            Aim::Url { url: "http://127.0.0.1:9".to_owned(), token: Some("tt".to_owned()), host_key: None }
        );
        // A name on the line goes ahead of all of it, and one this computer holds no record for is refused.
        assert!(matches!(aimed(&state, &pick(Some("attic"), near)).unwrap(), Aim::Alias { alias, .. } if alias == "attic"));
        let unknown = aimed(&state, &pick(Some("nowhere"), empty)).unwrap_err();
        assert_eq!(unknown.message, "no host named nowhere is connected; this computer holds attic, cellar, and wsp login puts the hosts on your account here. Run wsp hosts for the list.");
    }
}
