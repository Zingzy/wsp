// SPDX-License-Identifier: AGPL-3.0-only
//! The registry client: an anonymous token from the registry's own challenge, the manifest list down to the
//! platform's manifest, blobs by digest with the sha256 checked as the bytes arrive, and a blob cut short picked
//! up from the bytes already on disk.

use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.index.v1+json, \
     application/vnd.docker.distribution.manifest.list.v2+json, \
     application/vnd.oci.image.manifest.v1+json, \
     application/vnd.docker.distribution.manifest.v2+json";
/// A manifest or a token reply is small; a body past this is not one.
const SMALL_BODY_MAX: u64 = 4 * 1024 * 1024;
const COPY_BUFFER: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// One request's body budget, total, not per read. A blob request that moved bytes before it ran out is asked
/// for again from where it stopped, so a slow link finishes and a stalled one answers by name.
const BODY_TIMEOUT: Duration = Duration::from_secs(60);
const DOCKER_HUB: &str = "https://registry-1.docker.io";

/// A content address as registries and manifests write it: `sha256:` and 64 lowercase hex digits.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Digest(String);

impl Digest {
    pub fn parse(text: &str) -> Result<Digest, Error> {
        let hex = text.strip_prefix("sha256:").ok_or_else(|| Error::BadDigest(text.to_owned()))?;
        if hex.len() != 64 || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(Error::BadDigest(text.to_owned()));
        }
        Ok(Digest(text.to_owned()))
    }

    pub fn of(bytes: &[u8]) -> Digest {
        Digest::from_hash(Sha256::digest(bytes).as_slice())
    }

    fn from_hash(hash: &[u8]) -> Digest {
        let mut text = String::with_capacity(71);
        text.push_str("sha256:");
        for byte in hash {
            text.push_str(&format!("{byte:02x}"));
        }
        Digest(text)
    }

    /// The 64 hex digits alone, as a file is named.
    pub fn hex(&self) -> &str {
        &self.0[7..]
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Digest {
    type Error = Error;
    fn try_from(text: String) -> Result<Digest, Error> {
        Digest::parse(&text)
    }
}

impl From<Digest> for String {
    fn from(digest: Digest) -> String {
        digest.0
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Where an image's bytes come from: the registry by URL, the repository under it, and the tag or digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub registry: String,
    pub repository: String,
    pub reference: String,
}

impl Reference {
    /// An image name as people write it: `ubuntu:24.04`, `ghcr.io/org/app@sha256:...`, `localhost:5000/x`.
    /// A first segment with a dot or a colon, or `localhost`, is a registry host, plain http on the loopback;
    /// anything else is Docker Hub, where a bare name lives under `library/`.
    pub fn parse(name: &str) -> Result<Reference, Error> {
        let bad = || Error::BadName(name.to_owned());
        if name.is_empty() || name.contains(char::is_whitespace) {
            return Err(bad());
        }
        let (host, path) = match name.split_once('/') {
            Some((first, rest)) if first == "localhost" || first.contains('.') || first.contains(':') => (Some(first), rest),
            _ => (None, name),
        };
        let (path, reference) = match path.rsplit_once('@') {
            Some((p, digest)) => (p, Digest::parse(digest)?.0),
            None => match path.rsplit_once(':') {
                Some((p, tag)) if !tag.contains('/') => (p, tag.to_owned()),
                _ => (path, "latest".to_owned()),
            },
        };
        let repository_ok = path
            .split('/')
            .all(|part| !part.is_empty() && part.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-')));
        let reference_ok = reference.starts_with("sha256:")
            || (!reference.is_empty()
                && reference.len() <= 128
                && reference.bytes().all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-')));
        if !repository_ok || !reference_ok || !host.is_none_or(host_ok) {
            return Err(bad());
        }
        Ok(match host {
            Some(host) => {
                let scheme = if is_loopback(host) { "http" } else { "https" };
                Reference { registry: format!("{scheme}://{host}"), repository: path.to_owned(), reference }
            }
            None => {
                let repository = if path.contains('/') { path.to_owned() } else { format!("library/{path}") };
                Reference { registry: DOCKER_HUB.to_owned(), repository, reference }
            }
        })
    }

    fn url(&self, kind: &str, what: &str) -> String {
        format!("{}/v2/{}/{kind}/{what}", self.registry, self.repository)
    }
}

/// A registry host: a name or address, with a numeric port or none.
fn host_ok(host: &str) -> bool {
    let (name, port) = match host.strip_prefix('[') {
        Some(rest) => match rest.split_once(']') {
            Some((address, "")) => (address, ""),
            Some((address, port)) => match port.strip_prefix(':') {
                Some(port) => (address, port),
                None => return false,
            },
            None => return false,
        },
        None => host.rsplit_once(':').unwrap_or((host, "")),
    };
    let name_ok = !name.is_empty() && name.bytes().all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b':'));
    let port_ok = port.is_empty() || (port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()));
    name_ok && port_ok
}

fn is_loopback(host: &str) -> bool {
    let host = host.rsplit_once(':').map_or(host, |(h, _)| h);
    host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

impl fmt::Display for Reference {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sep = if self.reference.starts_with("sha256:") { '@' } else { ':' };
        write!(f, "{}/{}{sep}{}", self.registry, self.repository, self.reference)
    }
}

/// The platform a manifest list is narrowed to: this daemon's, in the words registries use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Platform {
    pub os: String,
    pub architecture: String,
}

impl Platform {
    pub fn host() -> Platform {
        let architecture = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            other => other,
        };
        Platform { os: "linux".to_owned(), architecture: architecture.to_owned() }
    }
}

/// One blob a manifest names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Descriptor {
    #[serde(rename = "mediaType")]
    pub media_type: String,
    pub digest: Digest,
    pub size: u64,
}

impl Descriptor {
    /// Whether the layer is a gzip tar, a plain tar, or something this runtime cannot unpack.
    pub fn layer_encoding(&self) -> Result<LayerEncoding, Error> {
        match self.media_type.as_str() {
            "application/vnd.oci.image.layer.v1.tar+gzip"
            | "application/vnd.oci.image.layer.v1.tar+gzip.nondistributable"
            | "application/vnd.docker.image.rootfs.diff.tar.gzip"
            | "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip" => Ok(LayerEncoding::Gzip),
            "application/vnd.oci.image.layer.v1.tar" | "application/vnd.docker.image.rootfs.diff.tar" => Ok(LayerEncoding::Plain),
            other => Err(Error::UnsupportedLayer { digest: self.digest.clone(), media_type: other.to_owned() }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerEncoding {
    Gzip,
    Plain,
}

/// The platform's manifest, verified against its digest: the config and the layers in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub digest: Digest,
    pub config: Descriptor,
    pub layers: Vec<Descriptor>,
}

#[derive(Deserialize)]
struct IndexEntry {
    digest: Digest,
    #[serde(default)]
    platform: Option<Platform>,
}

#[derive(Deserialize)]
struct ManifestBody {
    #[serde(default)]
    manifests: Option<Vec<IndexEntry>>,
    #[serde(default)]
    config: Option<Descriptor>,
    #[serde(default)]
    layers: Option<Vec<Descriptor>>,
}

#[derive(Deserialize)]
struct TokenBody {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
}

#[derive(Debug)]
pub enum Error {
    BadName(String),
    BadDigest(String),
    /// The wire failed under the request: connect, TLS, a cut body, a timeout.
    Transport {
        url: String,
        detail: String,
    },
    Status {
        url: String,
        status: u16,
    },
    /// The registry asked for a token and then refused the one it gave.
    Denied {
        url: String,
    },
    /// The registry answered a resume with something other than the bytes from the offset asked.
    BadResume {
        url: String,
        status: u16,
    },
    Digest {
        expected: Digest,
        actual: Digest,
    },
    NoPlatform {
        reference: String,
        platform: Platform,
    },
    Manifest {
        url: String,
        detail: String,
    },
    UnsupportedLayer {
        digest: Digest,
        media_type: String,
    },
    Io(io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::BadName(name) => write!(f, "not an image name: {name}"),
            Error::BadDigest(text) => write!(f, "not a sha256 digest: {text}"),
            Error::Transport { url, detail } => write!(f, "{url}: {detail}"),
            Error::Status { url, status } => write!(f, "{url}: HTTP {status}"),
            Error::Denied { url } => write!(f, "{url}: the registry refused its own token"),
            Error::BadResume { url, status } => write!(f, "{url}: asked to resume, answered HTTP {status}"),
            Error::Digest { expected, actual } => write!(f, "digest mismatch: expected {expected}, the bytes hash to {actual}"),
            Error::NoPlatform { reference, platform } => {
                write!(f, "{reference} has no manifest for {}/{}", platform.os, platform.architecture)
            }
            Error::Manifest { url, detail } => write!(f, "{url}: not a manifest: {detail}"),
            Error::UnsupportedLayer { digest, media_type } => write!(f, "layer {digest} is {media_type}, which this runtime cannot unpack"),
            Error::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Error {
        Error::Io(e)
    }
}

/// One client per pull: it keeps the token the registry handed it.
pub struct Client {
    agent: ureq::Agent,
    token: Option<String>,
}

impl Default for Client {
    fn default() -> Client {
        Client::new()
    }
}

impl Client {
    pub fn new() -> Client {
        Client::with_body_timeout(BODY_TIMEOUT)
    }

    /// A client whose body budget per request is `body_timeout` instead of the default.
    pub fn with_body_timeout(body_timeout: Duration) -> Client {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(RESPONSE_TIMEOUT))
            .timeout_recv_body(Some(body_timeout))
            .user_agent("wsp-daemon")
            .build();
        Client { agent: ureq::Agent::new_with_config(config), token: None }
    }

    /// The tag or digest down to the manifest for `platform`, its digest checked against the bytes.
    pub fn manifest(&mut self, from: &Reference, platform: &Platform) -> Result<Manifest, Error> {
        let url = from.url("manifests", &from.reference);
        let (body, header_digest) = self.small_body(&url, Some(MANIFEST_ACCEPT))?;
        let digest = match Digest::parse(&from.reference) {
            Ok(asked) => asked,
            Err(_) => header_digest.unwrap_or_else(|| Digest::of(&body)),
        };
        let actual = Digest::of(&body);
        if actual != digest {
            return Err(Error::Digest { expected: digest, actual });
        }
        let parsed: ManifestBody =
            serde_json::from_slice(&body).map_err(|e| Error::Manifest { url: url.clone(), detail: e.to_string() })?;
        if let Some(entries) = parsed.manifests {
            let chosen = entries
                .into_iter()
                .find(|e| e.platform.as_ref() == Some(platform))
                .ok_or_else(|| Error::NoPlatform { reference: from.to_string(), platform: platform.clone() })?;
            let url = from.url("manifests", chosen.digest.as_str());
            let (body, _) = self.small_body(&url, Some(MANIFEST_ACCEPT))?;
            let actual = Digest::of(&body);
            if actual != chosen.digest {
                return Err(Error::Digest { expected: chosen.digest, actual });
            }
            let parsed: ManifestBody =
                serde_json::from_slice(&body).map_err(|e| Error::Manifest { url: url.clone(), detail: e.to_string() })?;
            return Manifest::from_body(parsed, chosen.digest, &url);
        }
        Manifest::from_body(parsed, digest, &url)
    }

    /// The blob into `file`, appended after whatever it already holds, hashed whole and checked at the end. A
    /// file that already hashes to the digest is the blob and costs no request. A body cut or timed out after
    /// moving bytes is asked for again from where it stopped; one that moved none fails by name. A wrong hash
    /// is the caller's to discard.
    pub fn blob(&mut self, from: &Reference, digest: &Digest, file: &mut File) -> Result<u64, Error> {
        let url = from.url("blobs", digest.as_str());
        file.seek(SeekFrom::Start(0))?;
        let mut hasher = Sha256::new();
        let mut have = io::copy(file, &mut hasher)?;
        if have > 0 && &Digest::from_hash(hasher.clone().finalize().as_slice()) == digest {
            return Ok(have);
        }
        loop {
            let mut response = self.get(&url, None, (have > 0).then_some(have))?;
            match (response.status().as_u16(), have) {
                (206, offset) if offset > 0 => {
                    let expected = format!("bytes {offset}-");
                    let range = response.headers().get("content-range").and_then(|v| v.to_str().ok()).unwrap_or("");
                    if !range.starts_with(&expected) {
                        return Err(Error::BadResume { url, status: 206 });
                    }
                }
                (200, offset) => {
                    if offset > 0 {
                        (have, hasher) = start_over(file)?;
                    }
                }
                (416, offset) if offset > 0 => {
                    (have, hasher) = start_over(file)?;
                    continue;
                }
                (status, 0) => return Err(Error::Status { url, status }),
                (status, _) => return Err(Error::BadResume { url, status }),
            }
            let mut reader = response.body_mut().with_config().limit(u64::MAX).reader();
            let mut buffer = vec![0u8; COPY_BUFFER];
            let moved_from = have;
            let outcome = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break Ok(()),
                    Ok(n) => {
                        hasher.update(&buffer[..n]);
                        file.write_all(&buffer[..n])?;
                        have += n as u64;
                    }
                    Err(e) => break Err(e),
                }
            };
            match outcome {
                Ok(()) => break,
                Err(_) if have > moved_from => continue,
                Err(e) => return Err(Error::Transport { url, detail: e.to_string() }),
            }
        }
        file.flush()?;
        let actual = Digest::from_hash(hasher.finalize().as_slice());
        if &actual != digest {
            return Err(Error::Digest { expected: digest.clone(), actual });
        }
        Ok(have)
    }

    fn small_body(&mut self, url: &str, accept: Option<&str>) -> Result<(Vec<u8>, Option<Digest>), Error> {
        let response = self.get(url, accept, None)?;
        read_small(response, url)
    }

    /// One GET, with the token if there is one. A 401 that names a token realm is answered once: the token is
    /// fetched with a plain request, which takes no challenge itself, and the GET is sent again.
    fn get(&mut self, url: &str, accept: Option<&str>, from_byte: Option<u64>) -> Result<ureq::http::Response<ureq::Body>, Error> {
        let response = self.send(url, accept, from_byte)?;
        if response.status().as_u16() != 401 {
            return Ok(response);
        }
        let challenge = response.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).and_then(parse_challenge);
        let Some(token_url) = challenge else {
            return Err(Error::Status { url: url.to_owned(), status: 401 });
        };
        self.token = None;
        let (body, _) = read_small(self.send(&token_url, None, None)?, &token_url)?;
        let parsed: TokenBody =
            serde_json::from_slice(&body).map_err(|e| Error::Manifest { url: token_url.clone(), detail: e.to_string() })?;
        self.token = parsed.token.or(parsed.access_token);
        if self.token.is_none() {
            return Err(Error::Manifest { url: token_url, detail: "no token in the reply".to_owned() });
        }
        let response = self.send(url, accept, from_byte)?;
        if response.status().as_u16() == 401 {
            return Err(Error::Denied { url: url.to_owned() });
        }
        Ok(response)
    }

    fn send(&self, url: &str, accept: Option<&str>, from_byte: Option<u64>) -> Result<ureq::http::Response<ureq::Body>, Error> {
        let mut request = self.agent.get(url);
        if let Some(accept) = accept {
            request = request.header("Accept", accept);
        }
        if let Some(token) = &self.token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        if let Some(offset) = from_byte {
            request = request.header("Range", format!("bytes={offset}-"));
        }
        request.call().map_err(|e| Error::Transport { url: url.to_owned(), detail: e.to_string() })
    }
}

/// A manifest or a token reply: the whole body, capped, and the digest header when the registry sends one.
fn read_small(mut response: ureq::http::Response<ureq::Body>, url: &str) -> Result<(Vec<u8>, Option<Digest>), Error> {
    let status = response.status().as_u16();
    if status != 200 {
        return Err(Error::Status { url: url.to_owned(), status });
    }
    let header_digest = response.headers().get("docker-content-digest").and_then(|v| v.to_str().ok()).and_then(|v| Digest::parse(v).ok());
    let body = response
        .body_mut()
        .with_config()
        .limit(SMALL_BODY_MAX)
        .read_to_vec()
        .map_err(|e| Error::Transport { url: url.to_owned(), detail: e.to_string() })?;
    Ok((body, header_digest))
}

/// The partial emptied, for a registry that would not resume it.
fn start_over(file: &mut File) -> io::Result<(u64, Sha256)> {
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    Ok((0, Sha256::new()))
}

impl Manifest {
    fn from_body(body: ManifestBody, digest: Digest, url: &str) -> Result<Manifest, Error> {
        match (body.config, body.layers) {
            (Some(config), Some(layers)) => Ok(Manifest { digest, config, layers }),
            _ => Err(Error::Manifest { url: url.to_owned(), detail: "no config and layers".to_owned() }),
        }
    }
}

/// `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:x:pull"` into the
/// URL that hands out the token; anything but a Bearer challenge with a realm is not one.
fn parse_challenge(header: &str) -> Option<String> {
    let params = header.strip_prefix("Bearer ")?;
    let mut realm = None;
    let mut query = Vec::new();
    for part in params.split(',') {
        let (key, value) = part.trim().split_once('=')?;
        let value = value.trim_matches('"');
        match key.trim() {
            "realm" => realm = Some(value.to_owned()),
            "service" | "scope" => query.push(format!("{}={}", key.trim(), percent_encode(value))),
            _ => {}
        }
    }
    let realm = realm?;
    if query.is_empty() {
        return Some(realm);
    }
    let sep = if realm.contains('?') { '&' } else { '?' };
    Some(format!("{realm}{sep}{}", query.join("&")))
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' | b'/' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(registry: &str, repository: &str, reference: &str) -> Reference {
        Reference { registry: registry.to_owned(), repository: repository.to_owned(), reference: reference.to_owned() }
    }

    #[test]
    fn a_bare_name_is_docker_hub_under_library() {
        assert_eq!(Reference::parse("ubuntu:24.04").unwrap(), reference(DOCKER_HUB, "library/ubuntu", "24.04"));
        assert_eq!(Reference::parse("ubuntu").unwrap(), reference(DOCKER_HUB, "library/ubuntu", "latest"));
        assert_eq!(Reference::parse("zingzy/wsp-box:1").unwrap(), reference(DOCKER_HUB, "zingzy/wsp-box", "1"));
    }

    #[test]
    fn a_host_with_a_dot_or_a_port_is_a_registry_and_the_loopback_is_plain_http() {
        assert_eq!(Reference::parse("ghcr.io/org/app:v2").unwrap(), reference("https://ghcr.io", "org/app", "v2"));
        assert_eq!(Reference::parse("127.0.0.1:5000/ubuntu:24.04").unwrap(), reference("http://127.0.0.1:5000", "ubuntu", "24.04"));
        assert_eq!(Reference::parse("localhost/x").unwrap(), reference("http://localhost", "x", "latest"));
        let digest = "sha256:".to_owned() + &"a".repeat(64);
        assert_eq!(Reference::parse(&format!("ghcr.io/org/app@{digest}")).unwrap(), reference("https://ghcr.io", "org/app", &digest));
    }

    #[test]
    fn a_bad_name_or_digest_is_refused_by_name() {
        assert!(matches!(Reference::parse(""), Err(Error::BadName(_))));
        assert!(matches!(Reference::parse("a b"), Err(Error::BadName(_))));
        assert!(matches!(Reference::parse("ubuntu?x"), Err(Error::BadName(_))));
        assert!(matches!(Reference::parse("ubuntu#x"), Err(Error::BadName(_))));
        assert!(matches!(Reference::parse("ubuntu:a/b"), Err(Error::BadName(_))));
        assert!(matches!(Reference::parse("Ubuntu:24.04"), Err(Error::BadName(_))));
        assert!(matches!(Reference::parse("org//app"), Err(Error::BadName(_))));
        assert!(matches!(Reference::parse("ghcr.io/org/app:"), Err(Error::BadName(_))));
        assert!(matches!(Reference::parse("ghcr.io:x/app"), Err(Error::BadName(_))));
        assert!(matches!(Reference::parse("[::1/app"), Err(Error::BadName(_))));
        assert_eq!(Reference::parse("[::1]:5000/app").unwrap().registry, "http://[::1]:5000");
        assert!(matches!(Reference::parse("ubuntu@sha256:zz"), Err(Error::BadDigest(_))));
        assert!(matches!(Digest::parse("md5:abc"), Err(Error::BadDigest(_))));
        assert!(matches!(Digest::parse(&("sha256:".to_owned() + &"A".repeat(64))), Err(Error::BadDigest(_))));
    }

    #[test]
    fn the_challenge_becomes_the_token_url() {
        let header = r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/ubuntu:pull""#;
        assert_eq!(
            parse_challenge(header).unwrap(),
            "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/ubuntu:pull"
        );
        assert_eq!(parse_challenge("Basic realm=\"x\""), None);
        assert_eq!(parse_challenge("Bearer realm=\"http://r/t\"").unwrap(), "http://r/t");
    }

    #[test]
    fn the_host_platform_uses_registry_words() {
        let p = Platform::host();
        assert_eq!(p.os, "linux");
        assert!(p.architecture == "amd64" || p.architecture == "arm64", "{}", p.architecture);
    }
}
