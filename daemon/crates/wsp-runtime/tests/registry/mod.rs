// SPDX-License-Identifier: AGPL-3.0-only
//! A registry for tests: an OCI layout written to disk, and a small HTTP server over it that speaks the
//! distribution protocol's pull half. It wants a bearer token it hands out itself, sends every blob request on
//! a 302 to a second listener standing in for a registry's CDN (which refuses a request that still carries the
//! token and honours a byte range), and can be told to corrupt one blob, cut one short once, stall one once, or
//! answer the token request with another challenge. It skips TLS.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tempfile::TempDir;
use wsp_runtime::fetch::{Digest, Platform};

const INDEX_TYPE: &str = "application/vnd.oci.image.index.v1+json";
const MANIFEST_TYPE: &str = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_TYPE: &str = "application/vnd.oci.image.config.v1+json";
const LAYER_TYPE: &str = "application/vnd.oci.image.layer.v1.tar+gzip";
const REF_NAME: &str = "org.opencontainers.image.ref.name";

/// The layout on disk: `oci-layout`, `index.json` naming every image as `<repo>:<tag>`, blobs under
/// `blobs/sha256/`. Layers are gzip tars built here.
pub struct Layout {
    dir: TempDir,
    diff_ids: HashMap<Digest, Digest>,
    images: HashMap<(String, String), (Digest, Digest)>,
}

impl Layout {
    pub fn new() -> Layout {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("blobs/sha256")).unwrap();
        std::fs::write(dir.path().join("oci-layout"), r#"{"imageLayoutVersion":"1.0.0"}"#).unwrap();
        let layout = Layout { dir, diff_ids: HashMap::new(), images: HashMap::new() };
        layout.write_index();
        layout
    }

    pub fn dir(&self) -> &Path {
        self.dir.path()
    }

    /// A gzip tar layer of these entries as name, bytes, mode and owner (a name ending in `/` is a directory);
    /// its digest.
    pub fn layer(&mut self, entries: &[(&str, &[u8], u32, u64)]) -> Digest {
        let mut tar = tar::Builder::new(Vec::new());
        for (name, bytes, mode, uid) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_mode(*mode);
            header.set_uid(*uid);
            header.set_gid(*uid);
            header.set_mtime(1_700_000_000);
            if name.ends_with('/') {
                header.set_entry_type(tar::EntryType::Directory);
                header.set_size(0);
                header.set_cksum();
                tar.append_data(&mut header, name, std::io::empty()).unwrap();
            } else {
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(bytes.len() as u64);
                header.set_cksum();
                tar.append_data(&mut header, name, *bytes).unwrap();
            }
        }
        let plain = tar.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&plain).unwrap();
        let compressed = gz.finish().unwrap();
        let digest = self.put(&compressed);
        self.diff_ids.insert(digest.clone(), Digest::of(&plain));
        digest
    }

    /// An image for the host platform under `<repo>:<tag>`: a config, a manifest, and an index that also
    /// carries an attestation entry for no platform, as registries answer.
    pub fn image(&mut self, repo: &str, tag: &str, layers: &[Digest]) {
        let platform = Platform::host();
        let config = json!({
            "architecture": platform.architecture,
            "os": platform.os,
            "config": { "Cmd": ["/bin/sh"] },
            "rootfs": { "type": "layers", "diff_ids": layers.iter().map(|l| self.diff_ids[l].as_str()).collect::<Vec<_>>() }
        });
        let config_bytes = serde_json::to_vec(&config).unwrap();
        let config_digest = self.put(&config_bytes);
        let manifest = json!({
            "schemaVersion": 2,
            "mediaType": MANIFEST_TYPE,
            "config": { "mediaType": CONFIG_TYPE, "digest": config_digest.as_str(), "size": config_bytes.len() },
            "layers": layers.iter().map(|l| json!({ "mediaType": LAYER_TYPE, "digest": l.as_str(), "size": self.size(l) })).collect::<Vec<_>>()
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        let manifest_digest = self.put(&manifest_bytes);
        let attestation = json!({
            "mediaType": MANIFEST_TYPE,
            "digest": Digest::of(b"attestation").as_str(),
            "size": 1,
            "platform": { "architecture": "unknown", "os": "unknown" },
            "annotations": { "vnd.docker.reference.type": "attestation-manifest" }
        });
        let index = json!({
            "schemaVersion": 2,
            "mediaType": INDEX_TYPE,
            "manifests": [
                { "mediaType": MANIFEST_TYPE, "digest": manifest_digest.as_str(), "size": manifest_bytes.len(),
                  "platform": { "architecture": platform.architecture, "os": platform.os } },
                attestation
            ]
        });
        let index_bytes = serde_json::to_vec(&index).unwrap();
        let index_digest = self.put(&index_bytes);
        self.images.insert((repo.to_owned(), tag.to_owned()), (index_digest, manifest_digest));
        self.write_index();
    }

    /// The platform manifest's digest, what the store records as the image's manifest.
    pub fn manifest_digest(&self, repo: &str, tag: &str) -> Digest {
        self.images[&(repo.to_owned(), tag.to_owned())].1.clone()
    }

    pub fn config_digest(&self, repo: &str, tag: &str) -> Digest {
        let manifest: Value = serde_json::from_slice(&self.read(&self.manifest_digest(repo, tag))).unwrap();
        Digest::parse(manifest["config"]["digest"].as_str().unwrap()).unwrap()
    }

    /// A blob's bytes as the registry serves them.
    pub fn blob_bytes(&self, digest: &Digest) -> Vec<u8> {
        self.read(digest)
    }

    fn put(&self, bytes: &[u8]) -> Digest {
        let digest = Digest::of(bytes);
        std::fs::write(self.dir.path().join("blobs/sha256").join(digest.hex()), bytes).unwrap();
        digest
    }

    fn read(&self, digest: &Digest) -> Vec<u8> {
        std::fs::read(self.dir.path().join("blobs/sha256").join(digest.hex())).unwrap()
    }

    fn size(&self, digest: &Digest) -> u64 {
        std::fs::metadata(self.dir.path().join("blobs/sha256").join(digest.hex())).unwrap().len()
    }

    fn write_index(&self) {
        let manifests: Vec<Value> = self
            .images
            .iter()
            .map(|((repo, tag), (index, _))| {
                json!({ "mediaType": INDEX_TYPE, "digest": index.as_str(), "size": self.size(index), "annotations": { REF_NAME: format!("{repo}:{tag}") } })
            })
            .collect();
        let index = json!({ "schemaVersion": 2, "manifests": manifests });
        std::fs::write(self.dir.path().join("index.json"), serde_json::to_vec_pretty(&index).unwrap()).unwrap();
    }
}

#[derive(Default)]
struct Faults {
    corrupt: HashSet<Digest>,
    cut_after: HashMap<Digest, usize>,
    stall: HashMap<Digest, (usize, Duration)>,
    token_refuses: bool,
}

/// The server over a layout directory: the registry on one loopback port and its CDN on another, one thread
/// each, sharing one log. Every request is logged as `GET <path> [range=<range>] -> <status>`; CDN paths
/// start with `/cdn/`.
pub struct Server {
    pub addr: SocketAddr,
    log: Arc<Mutex<Vec<String>>>,
    faults: Arc<Mutex<Faults>>,
}

impl Server {
    pub fn start(layout: PathBuf) -> Server {
        let registry = TcpListener::bind("127.0.0.1:0").unwrap();
        let cdn = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = registry.local_addr().unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let faults = Arc::new(Mutex::new(Faults::default()));
        let state = Arc::new(State { layout, addr, cdn: cdn.local_addr().unwrap(), log: log.clone(), faults: faults.clone() });
        for listener in [registry, cdn] {
            let state = state.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    state.serve(stream);
                }
            });
        }
        Server { addr, log, faults }
    }

    pub fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    /// Every answer for this blob carries one flipped byte.
    pub fn corrupt(&self, digest: &Digest) {
        self.faults.lock().unwrap().corrupt.insert(digest.clone());
    }

    /// The next answer for this blob announces its full length and closes after `bytes`.
    pub fn cut_after(&self, digest: &Digest, bytes: usize) {
        self.faults.lock().unwrap().cut_after.insert(digest.clone(), bytes);
    }

    /// The next answer for this blob sends `bytes`, goes quiet for `pause`, then sends the rest.
    pub fn stall(&self, digest: &Digest, bytes: usize, pause: Duration) {
        self.faults.lock().unwrap().stall.insert(digest.clone(), (bytes, pause));
    }

    /// The token endpoint answers 401 with a challenge of its own, as a broken registry might.
    pub fn token_refuses(&self) {
        self.faults.lock().unwrap().token_refuses = true;
    }
}

struct State {
    layout: PathBuf,
    addr: SocketAddr,
    cdn: SocketAddr,
    log: Arc<Mutex<Vec<String>>>,
    faults: Arc<Mutex<Faults>>,
}

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    send_only: Option<usize>,
    pause_after: Option<(usize, Duration)>,
}

impl Answer {
    fn new(status: u16, body: Vec<u8>) -> Answer {
        Answer { status, headers: Vec::new(), body, send_only: None, pause_after: None }
    }
    fn header(mut self, name: &str, value: impl Into<String>) -> Answer {
        self.headers.push((name.to_owned(), value.into()));
        self
    }
}

impl State {
    fn serve(&self, mut stream: TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
            return;
        }
        let mut headers: HashMap<String, String> = HashMap::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
            }
        }
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_owned();
        let target = parts.next().unwrap_or("").to_owned();
        let range = headers.get("range").cloned();
        let answer = if method == "GET" { self.answer(&target, &headers, range.as_deref()) } else { Answer::new(405, Vec::new()) };
        let mut line = format!("{method} {target} ");
        if let Some(range) = &range {
            line.push_str(&format!("range={range} "));
        }
        line.push_str(&format!("-> {}", answer.status));
        self.log.lock().unwrap().push(line);

        let mut head = format!("HTTP/1.1 {} {}\r\n", answer.status, reason(answer.status));
        head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n", answer.body.len()));
        for (name, value) in &answer.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        let _ = stream.write_all(head.as_bytes());
        let body = match answer.send_only {
            Some(n) => &answer.body[..n.min(answer.body.len())],
            None => &answer.body[..],
        };
        match answer.pause_after {
            Some((n, pause)) => {
                let n = n.min(body.len());
                let _ = stream.write_all(&body[..n]);
                let _ = stream.flush();
                std::thread::sleep(pause);
                let _ = stream.write_all(&body[n..]);
            }
            None => {
                let _ = stream.write_all(body);
            }
        }
        let _ = stream.flush();
        let _ = stream.shutdown(Shutdown::Both);
    }

    fn challenge(&self, repo: &str) -> String {
        format!("Bearer realm=\"http://{}/token\",service=\"test-registry\",scope=\"repository:{repo}:pull\"", self.addr)
    }

    fn answer(&self, target: &str, headers: &HashMap<String, String>, range: Option<&str>) -> Answer {
        if let Some(query) = target.strip_prefix("/token?") {
            if self.faults.lock().unwrap().token_refuses {
                return Answer::new(401, Vec::new()).header("Www-Authenticate", self.challenge("ubuntu"));
            }
            if query.starts_with("service=test-registry&scope=repository:") {
                return Answer::new(200, br#"{"token":"tok-1"}"#.to_vec()).header("Content-Type", "application/json");
            }
            return Answer::new(400, Vec::new());
        }
        if let Some(what) = target.strip_prefix("/cdn/") {
            if headers.contains_key("authorization") {
                return Answer::new(400, b"the token must not follow a redirect to the CDN".to_vec());
            }
            let Some(digest) = Digest::parse(what).ok() else { return Answer::new(404, Vec::new()) };
            return self.blob(&digest, range);
        }
        let Some(rest) = target.strip_prefix("/v2/") else { return Answer::new(404, Vec::new()) };
        let (repo, kind, what) = match rest.rsplit_once("/manifests/") {
            Some((repo, what)) => (repo, "manifests", what),
            None => match rest.rsplit_once("/blobs/") {
                Some((repo, what)) => (repo, "blobs", what),
                None => return Answer::new(404, Vec::new()),
            },
        };
        if headers.get("authorization").map(String::as_str) != Some("Bearer tok-1") {
            return Answer::new(401, Vec::new()).header("Www-Authenticate", self.challenge(repo));
        }
        let digest = if what.starts_with("sha256:") { Digest::parse(what).ok() } else { self.tag(repo, what) };
        let Some(digest) = digest else { return Answer::new(404, Vec::new()) };
        if kind == "blobs" {
            return Answer::new(302, Vec::new()).header("Location", format!("http://{}/cdn/{digest}", self.cdn));
        }
        let Ok(body) = std::fs::read(self.layout.join("blobs/sha256").join(digest.hex())) else { return Answer::new(404, Vec::new()) };
        let value: Value = serde_json::from_slice(&body).unwrap();
        let media_type = if value.get("manifests").is_some() { INDEX_TYPE } else { MANIFEST_TYPE };
        Answer::new(200, body).header("Content-Type", media_type).header("Docker-Content-Digest", digest.as_str())
    }

    fn blob(&self, digest: &Digest, range: Option<&str>) -> Answer {
        let Ok(mut body) = std::fs::read(self.layout.join("blobs/sha256").join(digest.hex())) else { return Answer::new(404, Vec::new()) };
        let mut faults = self.faults.lock().unwrap();
        if faults.corrupt.contains(digest) {
            let middle = body.len() / 2;
            body[middle] ^= 0x55;
        }
        let cut = faults.cut_after.remove(digest);
        let stall = faults.stall.remove(digest);
        drop(faults);
        let total = body.len();
        let mut answer =
            match range.and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.strip_suffix('-')).and_then(|r| r.parse::<usize>().ok()) {
                Some(from) if from < total => {
                    Answer::new(206, body[from..].to_vec()).header("Content-Range", format!("bytes {from}-{}/{total}", total - 1))
                }
                Some(_) => return Answer::new(416, Vec::new()),
                None => Answer::new(200, body),
            };
        answer = answer.header("Content-Type", "application/octet-stream").header("Docker-Content-Digest", digest.as_str());
        answer.send_only = cut;
        answer.pause_after = stall;
        answer
    }

    fn tag(&self, repo: &str, tag: &str) -> Option<Digest> {
        let index: Value = serde_json::from_slice(&std::fs::read(self.layout.join("index.json")).ok()?).ok()?;
        let wanted = format!("{repo}:{tag}");
        index["manifests"]
            .as_array()?
            .iter()
            .find(|m| m["annotations"][REF_NAME].as_str() == Some(&wanted))
            .and_then(|m| Digest::parse(m["digest"].as_str()?).ok())
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        _ => "",
    }
}
