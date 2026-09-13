// SPDX-License-Identifier: AGPL-3.0-only
//! The fenced engine socket: a workspace that asked for one gets a Unix socket at the path a Docker client
//! expects, served by this daemon as one HTTP proxy over the box's own engine socket. What passes: the container,
//! image, network, volume, exec, logs and attach routes, ping and version. Nothing under /plugins, /swarm or
//! /system, no build and no info: the engine is one blast radius on the box, and the socket a workspace holds is
//! its own containers alone. Every create is labelled with the workspace's id and every listing filtered by it,
//! every route naming a container, an exec, a network or a volume is refused unless that thing wears the label,
//! and a create that asks for the box (privileged, capabilities, devices, security options, the box's pid, ipc or
//! network namespace, a bind outside the workspace's project folders) is refused with one sentence. Published
//! ports land on the box's loopback at a port the engine picks, and the workspace reaches each at
//! 127.0.0.1:<the port it asked for> through a listener this daemon holds inside its network namespace. Images
//! stay shared: what one workspace pulls, every workspace and the box see.
//!
//! One engine connection per client request, both sides told to close: the Docker client pools connections and
//! sends its next request on an idle one, and the head of every request has to be read here, so keep-alive is
//! turned off rather than framed. An upgrade (exec start, attach) is copied raw once the head has passed.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use wsp_frames::numbers::DAEMON_ROOTS_PATH;

use crate::doctor::{Engine, Facts};

/// The label every container, network and volume a workspace makes wears, with the workspace's id as its value.
pub const LABEL: &str = "wsp.workspace";
/// The ports a container's create asked for on the workspace's loopback, `80/tcp=18080,...`, kept on the container
/// since the engine binds an ephemeral port on the box instead and the two are joined after the start.
pub const PORTS_LABEL: &str = "wsp.ports";
/// Where the socket's directory is bound inside the workspace.
pub const INSIDE_DIR: &str = "/run/wsp";
pub const SOCKET_NAME: &str = "docker.sock";
/// The path a Docker client dials, a symlink into `INSIDE_DIR`: /var/run is /run on the images a workspace runs.
pub const CLIENT_PATH: &str = "/run/docker.sock";
/// The doctor's sentence on a box with no engine, which a create that asked for one is refused with.
pub const NO_ENGINE: &str =
    "this computer has no container engine; a project's docker compose runs here once you install Docker or podman on it";
const DOCKER_SOCKET: &str = "/var/run/docker.sock";
const PODMAN_SOCKET: &str = "/run/podman/podman.sock";
/// The most a request body read here may weigh; a compose service's create body is a few kilobytes.
const BODY_MAX: usize = 4 * 1024 * 1024;
const HEAD_MAX: usize = 64 * 1024;
const LOOPBACK: &str = "127.0.0.1";
/// The network modes that name no network of the box's.
const PLAIN_NETWORKS: [&str; 4] = ["", "default", "bridge", "none"];

#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Error {
        Error(e.to_string())
    }
}

/// The engine's socket on the box, by the engine the doctor found.
pub fn engine_socket(engine: Engine) -> Option<&'static Path> {
    match engine {
        Engine::None => None,
        Engine::Docker => Some(Path::new(DOCKER_SOCKET)),
        Engine::Podman => Some(Path::new(PODMAN_SOCKET)),
    }
}

/// The socket a workspace's proxy dials, or the one sentence a create asking for an engine is refused with.
pub fn socket_of(facts: &Facts) -> Result<PathBuf, String> {
    let socket = engine_socket(facts.engine).ok_or_else(|| NO_ENGINE.to_owned())?;
    if !socket.exists() {
        return Err(format!(
            "{} is on this computer but its socket {} is not there; start its service and a workspace's socket follows",
            facts.engine.word(),
            socket.display()
        ));
    }
    Ok(socket.to_path_buf())
}

/// What a request is, off its method and path, before its body is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Forwarded as it came: ping, version, and every image route.
    Pass,
    Refused(String),
    /// A container create: fenced and labelled.
    Create,
    /// A listing, filtered to the workspace's label: containers, networks, volumes, events.
    List,
    /// A network or volume create: labelled.
    Labelled,
    /// A route naming one container, which must be the workspace's; `verb` is what follows the id.
    Container {
        id: String,
        verb: Option<String>,
    },
    /// A route naming one exec, whose container must be the workspace's.
    Exec {
        id: String,
    },
    Network {
        id: String,
        verb: Option<String>,
    },
    Volume {
        name: String,
    },
}

fn not_served(path: &str) -> String {
    format!("{path} is not served on a workspace's socket, which serves its own containers, images, networks, volumes and execs alone")
}

/// The route of one request. The versioned prefix Docker clients send is dropped for the reading and kept on the wire.
pub fn route(method: &str, path: &str) -> Route {
    let bare = path.split('?').next().unwrap_or(path);
    let mut segments: Vec<&str> = bare.split('/').filter(|s| !s.is_empty()).collect();
    if segments.first().is_some_and(|s| s.starts_with("v1.")) {
        segments.remove(0);
    }
    let seg = |i: usize| segments.get(i).copied();
    match (seg(0), seg(1), seg(2)) {
        (Some("_ping"), None, _) | (Some("version"), None, _) => Route::Pass,
        (Some("images"), _, _) => Route::Pass,
        (Some("events"), None, _) => Route::List,
        (Some("build"), _, _) | (Some("session"), _, _) => Route::Refused(
            "image builds are not served on a workspace's socket yet; pull the image, or build it on the computer itself".into(),
        ),
        (Some("containers"), Some("create"), None) if method == "POST" => Route::Create,
        (Some("containers"), Some("json"), None) => Route::List,
        (Some("containers"), Some("prune"), None) | (Some("networks"), Some("prune"), None) | (Some("volumes"), Some("prune"), None) => {
            Route::Refused(format!("{bare} reaches everything on this computer; remove the workspace's own by name"))
        }
        (Some("containers"), Some(id), verb) => Route::Container { id: id.to_owned(), verb: verb.map(str::to_owned) },
        (Some("exec"), Some(id), _) => Route::Exec { id: id.to_owned() },
        (Some("networks"), None, _) => Route::List,
        (Some("networks"), Some("create"), None) if method == "POST" => Route::Labelled,
        (Some("networks"), Some(id), verb) => Route::Network { id: id.to_owned(), verb: verb.map(str::to_owned) },
        (Some("volumes"), None, _) => Route::List,
        (Some("volumes"), Some("create"), None) if method == "POST" => Route::Labelled,
        (Some("volumes"), Some(name), None) => Route::Volume { name: name.to_owned() },
        _ => Route::Refused(not_served(bare)),
    }
}

/// What a fenced create body named beyond itself: the containers and networks it joins, each checked for the label
/// before the create goes, and the ports it asked for on the workspace's loopback.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Fenced {
    pub ports: BTreeMap<String, u16>,
    pub containers: Vec<String>,
    pub networks: Vec<String>,
}

fn non_empty(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
        Some(Value::Null) | None => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn word(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

/// A container another container shares a namespace or volumes with, off `container:<id>` or `<id>[:ro]`.
fn named_container(mode: &str) -> Option<String> {
    mode.strip_prefix("container:").map(|rest| rest.split(':').next().unwrap_or(rest).to_owned())
}

/// The fence over a container create: the body is rewritten in place and what it named beyond itself answered, or
/// the one sentence the create is refused with. `map_bind` turns a bind source inside the workspace into the box
/// path the engine mounts, or refuses it.
pub fn fence_create(body: &mut Value, workspace: &str, map_bind: &dyn Fn(&str) -> Result<PathBuf, String>) -> Result<Fenced, String> {
    let mut fenced = Fenced::default();
    if !body.is_object() {
        return Err("a container create carries a JSON object".into());
    }
    let host = body.get("HostConfig").cloned().unwrap_or_else(|| json!({}));
    if host.get("Privileged").and_then(Value::as_bool) == Some(true) {
        return Err("a privileged container is root on this computer, so a workspace cannot ask for one".into());
    }
    if non_empty(host.get("CapAdd")) {
        return Err("a workspace's container runs with the engine's default capabilities; CapAdd is refused".into());
    }
    if non_empty(host.get("Devices")) || non_empty(host.get("DeviceRequests")) || non_empty(host.get("DeviceCgroupRules")) {
        return Err("a workspace's container gets no device of this computer; Devices is refused".into());
    }
    if non_empty(host.get("SecurityOpt")) {
        return Err("a workspace's container keeps the engine's seccomp and AppArmor defaults; SecurityOpt is refused".into());
    }
    if host.get("PublishAllPorts").and_then(Value::as_bool) == Some(true) {
        return Err("a workspace publishes ports one by one on this computer's loopback; PublishAllPorts is refused".into());
    }
    let pid = word(host.get("PidMode"));
    match pid {
        "" => {}
        "host" => return Err("a workspace's container cannot share this computer's pid namespace; PidMode host is refused".into()),
        _ => match named_container(pid) {
            Some(id) => fenced.containers.push(id),
            None => return Err(format!("PidMode {pid} is not one a workspace's container may ask for")),
        },
    }
    let ipc = word(host.get("IpcMode"));
    match ipc {
        "" | "none" | "private" | "shareable" => {}
        "host" => return Err("a workspace's container cannot share this computer's ipc namespace; IpcMode host is refused".into()),
        _ => match named_container(ipc) {
            Some(id) => fenced.containers.push(id),
            None => return Err(format!("IpcMode {ipc} is not one a workspace's container may ask for")),
        },
    }
    let network = word(host.get("NetworkMode"));
    if network == "host" {
        return Err("a workspace's container cannot join this computer's network; NetworkMode host is refused".into());
    }
    if let Some(id) = named_container(network) {
        fenced.containers.push(id);
    } else if !PLAIN_NETWORKS.contains(&network) {
        fenced.networks.push(network.to_owned());
    }
    if let Some(endpoints) = body.pointer("/NetworkingConfig/EndpointsConfig").and_then(Value::as_object) {
        fenced.networks.extend(endpoints.keys().filter(|k| !PLAIN_NETWORKS.contains(&k.as_str())).cloned());
    }
    for from in host.get("VolumesFrom").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = from.as_str().map(|s| s.split(':').next().unwrap_or(s)) {
            fenced.containers.push(id.to_owned());
        }
    }
    let mut binds = Vec::new();
    for bind in host.get("Binds").and_then(Value::as_array).into_iter().flatten() {
        let Some(text) = bind.as_str() else { return Err("a bind is a string of the form source:destination".into()) };
        let (source, rest) = text.split_once(':').ok_or_else(|| format!("{text} is not a bind of the form source:destination"))?;
        if source.starts_with('/') {
            let mapped = map_bind(source)?;
            binds.push(Value::String(format!("{}:{rest}", mapped.display())));
        } else {
            binds.push(bind.clone());
        }
    }
    let mut mounts = Vec::new();
    for mount in host.get("Mounts").and_then(Value::as_array).into_iter().flatten() {
        let mut mount = mount.clone();
        if mount.get("Type").and_then(Value::as_str) == Some("bind") {
            let source = word(mount.get("Source")).to_owned();
            let mapped = map_bind(&source)?;
            mount["Source"] = Value::String(mapped.display().to_string());
        }
        mounts.push(mount);
    }
    let mut bindings = serde_json::Map::new();
    for (port, given) in host.get("PortBindings").and_then(Value::as_object).into_iter().flatten() {
        let asked = given
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|b| b.get("HostPort").and_then(Value::as_str).and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0));
        if let Some(asked) = asked {
            fenced.ports.insert(port.clone(), asked);
        }
        bindings.insert(port.clone(), json!([{ "HostIp": LOOPBACK, "HostPort": "" }]));
    }
    let host_config = body.as_object_mut().and_then(|o| o.entry("HostConfig").or_insert_with(|| json!({})).as_object_mut());
    if let Some(host_config) = host_config {
        if !binds.is_empty() {
            host_config.insert("Binds".into(), Value::Array(binds));
        }
        if !mounts.is_empty() {
            host_config.insert("Mounts".into(), Value::Array(mounts));
        }
        if !bindings.is_empty() {
            host_config.insert("PortBindings".into(), Value::Object(bindings));
        }
    }
    let labels = body.as_object_mut().and_then(|o| o.entry("Labels").or_insert_with(|| json!({})).as_object_mut());
    if let Some(labels) = labels {
        labels.insert(LABEL.into(), Value::String(workspace.to_owned()));
        if !fenced.ports.is_empty() {
            labels.insert(PORTS_LABEL.into(), Value::String(ports_word(&fenced.ports)));
        }
    }
    Ok(fenced)
}

fn ports_word(ports: &BTreeMap<String, u16>) -> String {
    ports.iter().map(|(port, asked)| format!("{port}={asked}")).collect::<Vec<_>>().join(",")
}

fn ports_of_word(word: &str) -> BTreeMap<String, u16> {
    word.split(',')
        .filter_map(|pair| {
            let (port, asked) = pair.split_once('=')?;
            Some((port.to_owned(), asked.parse().ok()?))
        })
        .collect()
}

/// The fence over an exec create: a privileged exec is root on the box as a privileged container is.
pub fn fence_exec(body: &Value) -> Result<(), String> {
    if body.get("Privileged").and_then(Value::as_bool) == Some(true) {
        return Err("a privileged exec is root on this computer, so a workspace cannot ask for one".into());
    }
    Ok(())
}

/// A network or volume create with the workspace's label on it.
pub fn label_create(body: &mut Value, workspace: &str) -> Result<(), String> {
    let labels =
        body.as_object_mut().ok_or_else(|| "a create carries a JSON object".to_owned())?.entry("Labels").or_insert_with(|| json!({}));
    if labels.is_null() {
        *labels = json!({});
    }
    labels.as_object_mut().ok_or_else(|| "Labels is an object".to_owned())?.insert(LABEL.into(), Value::String(workspace.to_owned()));
    Ok(())
}

/// The query of a listing with the workspace's label added to its filters, whatever filters it carried.
pub fn filtered_query(query: Option<&str>, workspace: &str) -> Result<String, String> {
    let want = format!("{LABEL}={workspace}");
    let mut parts: Vec<String> = Vec::new();
    let mut filtered = false;
    for pair in query.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key != "filters" {
            parts.push(pair.to_owned());
            continue;
        }
        let text = percent_decode_str(value).decode_utf8().map_err(|e| format!("filters: {e}"))?;
        let mut filters: Value = serde_json::from_str(&text).map_err(|e| format!("filters: {e}"))?;
        let object = filters.as_object_mut().ok_or_else(|| "filters is a JSON object".to_owned())?;
        // The engine refuses one filters object in two forms, and compose sends the older map form.
        let map_form = object.values().any(Value::is_object);
        match object.get_mut("label") {
            Some(Value::Array(labels)) => labels.push(Value::String(want.clone())),
            Some(Value::Object(labels)) => {
                labels.insert(want.clone(), Value::Bool(true));
            }
            _ if map_form => {
                object.insert("label".into(), json!({ want.clone(): true }));
            }
            _ => {
                object.insert("label".into(), json!([want]));
            }
        }
        parts.push(format!("filters={}", utf8_percent_encode(&filters.to_string(), NON_ALPHANUMERIC)));
        filtered = true;
    }
    if !filtered {
        parts.push(format!("filters={}", utf8_percent_encode(&json!({ "label": [want] }).to_string(), NON_ALPHANUMERIC)));
    }
    Ok(parts.join("&"))
}

/// The box path the engine mounts for a bind source inside the workspace: the path under the rootfs, resolved, and
/// only where it sits under one of the project folders the roots file names, resolved too, so a link inside pointing
/// out of the workspace is refused as the box path it would reach.
pub fn map_bind(rootfs: &Path, roots_file: &Path, source: &str) -> Result<PathBuf, String> {
    let roots: Vec<String> = fs::read_to_string(roots_file)
        .map(|text| text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default();
    if roots.is_empty() {
        return Err(format!("this workspace has no project folder yet, so a container can bind nothing of it; {source} is refused"));
    }
    if !source.starts_with('/') {
        return Err(format!("a bind mount's source is an absolute path inside the workspace, and {source} is not"));
    }
    let mapped =
        fs::canonicalize(rootfs.join(source.trim_start_matches('/'))).map_err(|_| format!("{source} is not there in the workspace"))?;
    for root in &roots {
        let Ok(real) = fs::canonicalize(rootfs.join(root.trim_start_matches('/'))) else { continue };
        if mapped == real || mapped.starts_with(&real) {
            return Ok(mapped);
        }
    }
    Err(format!("a bind mount's source must sit under a project folder of this workspace ({}), and {source} does not", roots.join(", ")))
}

/// The ports a container's create asked for, joined to the box ports the engine bound: (inside, box) pairs.
pub fn published_ports(inspect: &Value) -> Vec<(u16, u16)> {
    let asked =
        inspect.pointer("/Config/Labels").and_then(|l| l.get(PORTS_LABEL)).and_then(Value::as_str).map(ports_of_word).unwrap_or_default();
    let mut out = Vec::new();
    for (port, bindings) in inspect.pointer("/NetworkSettings/Ports").and_then(Value::as_object).into_iter().flatten() {
        let bound = bindings
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|b| b.get("HostPort").and_then(Value::as_str).and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0));
        if let Some(bound) = bound {
            out.push((asked.get(port).copied().unwrap_or(bound), bound));
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// Where a workspace's published ports are joined: the daemon holds a listener inside the workspace for each.
pub trait Ports: Send + Sync {
    fn published(&self, workspace: &str, inside: u16, box_port: u16);
}

/// One workspace's fence: what its socket may reach and how its paths map.
pub struct Fence {
    pub workspace: String,
    pub rootfs: PathBuf,
    pub engine: PathBuf,
    pub ports: Arc<dyn Ports>,
}

impl Fence {
    fn roots_file(&self) -> PathBuf {
        self.rootfs.join(DAEMON_ROOTS_PATH.trim_start_matches('/'))
    }

    fn map_bind(&self, source: &str) -> Result<PathBuf, String> {
        map_bind(&self.rootfs, &self.roots_file(), source)
    }
}

/// One HTTP request head as parsed off the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub content_length: Option<usize>,
    pub chunked: bool,
    pub upgrade: bool,
}

/// Bytes up to and including the blank line that ends a head, and whatever came after it.
async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut held = Vec::with_capacity(1024);
    let mut buf = [0u8; 4096];
    loop {
        if let Some(at) = held.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = held.split_off(at + 4);
            return Ok((held, rest));
        }
        if held.len() > HEAD_MAX {
            return Err(io::Error::other("a request head over 64 KiB"));
        }
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        held.extend_from_slice(&buf[..n]);
    }
}

fn parse_request(head: &[u8]) -> Result<Head, String> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(head) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => return Err("an incomplete request head".into()),
        Err(e) => return Err(format!("a request head that does not parse: {e}")),
    }
    let method = request.method.ok_or("a request without a method")?.to_owned();
    let path = request.path.ok_or("a request without a path")?.to_owned();
    let headers: Vec<(String, String)> =
        request.headers.iter().map(|h| (h.name.to_owned(), String::from_utf8_lossy(h.value).into_owned())).collect();
    let find = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_owned());
    let content_length = find("content-length").and_then(|v| v.parse().ok());
    let chunked = find("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let upgrade = find("connection").is_some_and(|v| v.to_ascii_lowercase().contains("upgrade")) || find("upgrade").is_some();
    Ok(Head { method, path, headers, content_length, chunked, upgrade })
}

/// The head as this proxy sends it on: the path given, the body's length named when known, and the connection told
/// to close unless the request is an upgrade, whose connection headers ride along as they came.
fn request_head(head: &Head, path: &str, body_length: Option<usize>) -> Vec<u8> {
    let mut out = format!("{} {} HTTP/1.1\r\n", head.method, path);
    for (name, value) in &head.headers {
        let lower = name.to_ascii_lowercase();
        if lower == "content-length" || (lower == "connection" && !head.upgrade) {
            continue;
        }
        if lower == "transfer-encoding" && body_length.is_some() {
            continue;
        }
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(n) = body_length {
        out.push_str(&format!("Content-Length: {n}\r\n"));
    }
    if !head.upgrade {
        out.push_str("Connection: close\r\n");
    }
    out.push_str("\r\n");
    out.into_bytes()
}

/// A response head as the engine sent it, with the connection told to close unless it is an upgrade. Answers the
/// status too.
fn response_head(head: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut response = httparse::Response::new(&mut headers);
    match response.parse(head) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => return Err("an incomplete response head".into()),
        Err(e) => return Err(format!("a response head that does not parse: {e}")),
    }
    let status = response.code.ok_or("a response without a status")?;
    if status == 101 {
        return Ok((status, head.to_vec()));
    }
    let mut out = format!("HTTP/1.1 {status} {}\r\n", response.reason.unwrap_or(""));
    for h in response.headers.iter() {
        if h.name.eq_ignore_ascii_case("connection") {
            continue;
        }
        out.push_str(&format!("{}: {}\r\n", h.name, String::from_utf8_lossy(h.value)));
    }
    out.push_str("Connection: close\r\n\r\n");
    Ok((status, out.into_bytes()))
}

fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < body.len() {
        let Some(line_end) = body[at..].windows(2).position(|w| w == b"\r\n") else { break };
        let size_text = String::from_utf8_lossy(&body[at..at + line_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        at += line_end + 2;
        if size == 0 {
            break;
        }
        let end = (at + size).min(body.len());
        out.extend_from_slice(&body[at..end]);
        at = end + 2;
    }
    out
}

fn json_message(status: u16, message: &str) -> Vec<u8> {
    let body = json!({ "message": message }).to_string();
    let reason = match status {
        403 => "Forbidden",
        404 => "Not Found",
        400 => "Bad Request",
        _ => "Bad Gateway",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// One request of this daemon's own to the engine: the status and the body as JSON, null where there was none.
pub async fn ask(engine: &Path, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), Error> {
    let mut stream = UnixStream::connect(engine).await.map_err(|e| Error(format!("{}: {e}", engine.display())))?;
    let text = body.map(Value::to_string).unwrap_or_default();
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n");
    if body.is_some() {
        request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", text.len()));
    }
    request.push_str("\r\n");
    request.push_str(&text);
    stream.write_all(request.as_bytes()).await?;
    let (head, mut rest) = read_head(&mut stream).await?;
    stream.read_to_end(&mut rest).await?;
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut response = httparse::Response::new(&mut headers);
    let status = match response.parse(&head) {
        Ok(httparse::Status::Complete(_)) => response.code.ok_or_else(|| Error("a response without a status".into()))?,
        _ => return Err(Error("the engine answered with a head that does not parse".into())),
    };
    let chunked = response.headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("transfer-encoding") && String::from_utf8_lossy(h.value).to_ascii_lowercase().contains("chunked")
    });
    let bytes = if chunked { dechunk(&rest) } else { rest };
    let value = if bytes.iter().all(u8::is_ascii_whitespace) { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    Ok((status, value))
}

/// The engine's inspect of a container the workspace owns, or none for one it does not (or that is not there).
async fn owned_container(fence: &Fence, id: &str) -> Result<Option<Value>, Error> {
    let (status, inspect) = ask(&fence.engine, "GET", &format!("/containers/{}/json", encoded(id)), None).await?;
    if status != 200 {
        return Ok(None);
    }
    let ours = inspect.pointer("/Config/Labels").and_then(|l| l.get(LABEL)).and_then(Value::as_str) == Some(fence.workspace.as_str());
    Ok(ours.then_some(inspect))
}

async fn owned_network(fence: &Fence, id: &str) -> Result<bool, Error> {
    let (status, inspect) = ask(&fence.engine, "GET", &format!("/networks/{}", encoded(id)), None).await?;
    Ok(status == 200 && inspect.get("Labels").and_then(|l| l.get(LABEL)).and_then(Value::as_str) == Some(fence.workspace.as_str()))
}

async fn owned_volume(fence: &Fence, name: &str) -> Result<bool, Error> {
    let (status, inspect) = ask(&fence.engine, "GET", &format!("/volumes/{}", encoded(name)), None).await?;
    Ok(status == 200 && inspect.get("Labels").and_then(|l| l.get(LABEL)).and_then(Value::as_str) == Some(fence.workspace.as_str()))
}

/// The container an exec belongs to, when the engine knows the exec.
async fn exec_container(fence: &Fence, id: &str) -> Result<Option<String>, Error> {
    let (status, inspect) = ask(&fence.engine, "GET", &format!("/exec/{}/json", encoded(id)), None).await?;
    Ok((status == 200).then(|| inspect.get("ContainerID").and_then(Value::as_str).map(str::to_owned)).flatten())
}

fn encoded(word: &str) -> String {
    utf8_percent_encode(word, NON_ALPHANUMERIC).to_string()
}

/// What one request comes to after the fence: the head to send, the body to send, and whether a start's port hook
/// runs once the engine has answered; or the response the client gets instead.
enum Verdict {
    Forward { head: Vec<u8>, body: Vec<u8>, started: bool },
    Answer(Vec<u8>),
}

async fn read_body<S: AsyncRead + Unpin>(stream: &mut S, head: &Head, mut rest: Vec<u8>) -> Result<Vec<u8>, String> {
    if head.chunked {
        return Err("a chunked body on a route this socket reads whole".into());
    }
    let wanted = head.content_length.unwrap_or(0);
    if wanted > BODY_MAX {
        return Err(format!("a body of {wanted} bytes, over the {BODY_MAX} this socket reads"));
    }
    while rest.len() < wanted {
        let mut buf = vec![0u8; (wanted - rest.len()).min(64 * 1024)];
        let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the body ended early".into());
        }
        rest.extend_from_slice(&buf[..n]);
    }
    Ok(rest)
}

fn json_body(bytes: &[u8]) -> Result<Value, String> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    serde_json::from_slice(bytes).map_err(|e| format!("a body that is not JSON: {e}"))
}

fn no_such(kind: &str, id: &str) -> Vec<u8> {
    json_message(404, &format!("No such {kind}: {id}"))
}

fn split_query(path: &str) -> (&str, Option<&str>) {
    match path.split_once('?') {
        Some((bare, query)) => (bare, Some(query)),
        None => (path, None),
    }
}

/// One request judged: the fence's reading of the head, the body where the route needs it, and every name it
/// carries checked against the label.
async fn judge<S: AsyncRead + Unpin>(fence: &Fence, stream: &mut S, head: &Head, rest: Vec<u8>) -> Verdict {
    let refused = |sentence: String| Verdict::Answer(json_message(403, &sentence));
    let failed = |e: Error| Verdict::Answer(json_message(502, &format!("the engine did not answer: {e}")));
    let (bare, query) = split_query(&head.path);
    match route(&head.method, &head.path) {
        Route::Refused(sentence) => refused(sentence),
        Route::Pass => Verdict::Forward { head: request_head(head, &head.path, None), body: rest, started: false },
        Route::List => match filtered_query(query, &fence.workspace) {
            Ok(filtered) => Verdict::Forward { head: request_head(head, &format!("{bare}?{filtered}"), None), body: rest, started: false },
            Err(e) => Verdict::Answer(json_message(400, &e)),
        },
        Route::Create => {
            let body = match read_body(stream, head, rest).await.and_then(|b| json_body(&b)) {
                Ok(body) => body,
                Err(e) => return Verdict::Answer(json_message(400, &e)),
            };
            let mut body = body;
            let fenced = match fence_create(&mut body, &fence.workspace, &|source| fence.map_bind(source)) {
                Ok(fenced) => fenced,
                Err(sentence) => return refused(sentence),
            };
            for id in &fenced.containers {
                match owned_container(fence, id).await {
                    Ok(Some(_)) => {}
                    Ok(None) => return Verdict::Answer(no_such("container", id)),
                    Err(e) => return failed(e),
                }
            }
            for name in &fenced.networks {
                match owned_network(fence, name).await {
                    Ok(true) => {}
                    Ok(false) => return Verdict::Answer(no_such("network", name)),
                    Err(e) => return failed(e),
                }
            }
            let text = body.to_string().into_bytes();
            Verdict::Forward { head: request_head(head, &head.path, Some(text.len())), body: text, started: false }
        }
        Route::Labelled => {
            let body = match read_body(stream, head, rest).await.and_then(|b| json_body(&b)) {
                Ok(body) => body,
                Err(e) => return Verdict::Answer(json_message(400, &e)),
            };
            let mut body = body;
            if let Err(e) = label_create(&mut body, &fence.workspace) {
                return Verdict::Answer(json_message(400, &e));
            }
            let text = body.to_string().into_bytes();
            Verdict::Forward { head: request_head(head, &head.path, Some(text.len())), body: text, started: false }
        }
        Route::Container { id, verb } => {
            match owned_container(fence, &id).await {
                Ok(Some(_)) => {}
                Ok(None) => return Verdict::Answer(no_such("container", &id)),
                Err(e) => return failed(e),
            }
            if verb.as_deref() == Some("exec") && head.method == "POST" {
                let body = match read_body(stream, head, rest).await.and_then(|b| json_body(&b)) {
                    Ok(body) => body,
                    Err(e) => return Verdict::Answer(json_message(400, &e)),
                };
                if let Err(sentence) = fence_exec(&body) {
                    return refused(sentence);
                }
                let text = body.to_string().into_bytes();
                return Verdict::Forward { head: request_head(head, &head.path, Some(text.len())), body: text, started: false };
            }
            let started = verb.as_deref() == Some("start") && head.method == "POST";
            Verdict::Forward { head: request_head(head, &head.path, None), body: rest, started }
        }
        Route::Exec { id } => {
            let container = match exec_container(fence, &id).await {
                Ok(Some(container)) => container,
                Ok(None) => return Verdict::Answer(no_such("exec instance", &id)),
                Err(e) => return failed(e),
            };
            match owned_container(fence, &container).await {
                Ok(Some(_)) => Verdict::Forward { head: request_head(head, &head.path, None), body: rest, started: false },
                Ok(None) => Verdict::Answer(no_such("exec instance", &id)),
                Err(e) => failed(e),
            }
        }
        Route::Network { id, verb } => {
            match owned_network(fence, &id).await {
                Ok(true) => {}
                Ok(false) => return Verdict::Answer(no_such("network", &id)),
                Err(e) => return failed(e),
            }
            if matches!(verb.as_deref(), Some("connect" | "disconnect")) {
                let body = match read_body(stream, head, rest).await.and_then(|b| json_body(&b)) {
                    Ok(body) => body,
                    Err(e) => return Verdict::Answer(json_message(400, &e)),
                };
                let container = word(body.get("Container")).to_owned();
                match owned_container(fence, &container).await {
                    Ok(Some(_)) => {}
                    Ok(None) => return Verdict::Answer(no_such("container", &container)),
                    Err(e) => return failed(e),
                }
                let text = body.to_string().into_bytes();
                return Verdict::Forward { head: request_head(head, &head.path, Some(text.len())), body: text, started: false };
            }
            Verdict::Forward { head: request_head(head, &head.path, None), body: rest, started: false }
        }
        Route::Volume { name } => match owned_volume(fence, &name).await {
            Ok(true) => Verdict::Forward { head: request_head(head, &head.path, None), body: rest, started: false },
            Ok(false) => Verdict::Answer(no_such("volume", &name)),
            Err(e) => failed(e),
        },
    }
}

/// The container a start route named, off its path, for the port hook.
fn container_of(path: &str) -> Option<String> {
    match route("POST", path) {
        Route::Container { id, .. } => Some(id),
        _ => None,
    }
}

/// One client connection: one request, judged, forwarded on a fresh engine connection, the answer copied back and
/// both sides closed. A start that the engine took joins the container's published ports afterwards.
async fn handle(fence: Arc<Fence>, mut client: UnixStream) -> Result<(), Error> {
    let (head_bytes, rest) = read_head(&mut client).await?;
    let head = match parse_request(&head_bytes) {
        Ok(head) => head,
        Err(e) => {
            client.write_all(&json_message(400, &e)).await?;
            return Ok(());
        }
    };
    let (mut forward, body, started) = match judge(&fence, &mut client, &head, rest).await {
        Verdict::Answer(bytes) => {
            client.write_all(&bytes).await?;
            let _ = client.shutdown().await;
            return Ok(());
        }
        Verdict::Forward { head, body, started } => (head, body, started),
    };
    forward.extend_from_slice(&body);
    let mut engine = match UnixStream::connect(&fence.engine).await {
        Ok(engine) => engine,
        Err(e) => {
            client.write_all(&json_message(502, &format!("the engine at {} did not answer: {e}", fence.engine.display()))).await?;
            return Ok(());
        }
    };
    engine.write_all(&forward).await?;
    let (answer_head, answer_rest) = read_head(&mut engine).await?;
    let (status, answer) = match response_head(&answer_head) {
        Ok(parsed) => parsed,
        Err(e) => {
            client.write_all(&json_message(502, &e)).await?;
            return Ok(());
        }
    };
    client.write_all(&answer).await?;
    client.write_all(&answer_rest).await?;
    let _ = tokio::io::copy_bidirectional(&mut client, &mut engine).await;
    let _ = client.shutdown().await;
    if started && status == 204 {
        if let Some(id) = container_of(&head.path) {
            if let Ok(Some(inspect)) = owned_container(&fence, &id).await {
                for (inside, box_port) in published_ports(&inspect) {
                    fence.ports.published(&fence.workspace, inside, box_port);
                }
            }
        }
    }
    Ok(())
}

/// The accept loop of one workspace's socket; ends when its task is aborted.
pub async fn serve(listener: UnixListener, fence: Arc<Fence>) {
    loop {
        match listener.accept().await {
            Ok((client, _)) => {
                let fence = Arc::clone(&fence);
                tokio::spawn(async move {
                    let _ = handle(fence, client).await;
                });
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
        }
    }
}

/// Binds the workspace's socket in its directory on the box, a stale file from an earlier life removed first.
pub fn bind(dir: &Path) -> io::Result<UnixListener> {
    fs::create_dir_all(dir)?;
    let path = dir.join(SOCKET_NAME);
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    UnixListener::bind(&path)
}

/// The symlink a Docker client inside follows to the socket, written into the rootfs; one already there stands.
pub fn link_client_path(rootfs: &Path) -> io::Result<()> {
    let at = rootfs.join(CLIENT_PATH.trim_start_matches('/'));
    if let Some(parent) = at.parent() {
        fs::create_dir_all(parent)?;
    }
    match std::os::unix::fs::symlink(format!("{INSIDE_DIR}/{SOCKET_NAME}"), &at) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

async fn listed(engine: &Path, path: &str, key: &str, workspace: &str) -> Result<Vec<Value>, Error> {
    let query = filtered_query(None, workspace).map_err(Error)?;
    let (status, rows) = ask(engine, "GET", &format!("{path}?all=1&{query}"), None).await?;
    if status != 200 {
        return Err(Error(format!("{path} answered {status}")));
    }
    let rows = if key.is_empty() { rows } else { rows.get(key).cloned().unwrap_or(Value::Null) };
    Ok(rows.as_array().cloned().unwrap_or_default())
}

/// The (inside, box) port pairs of every running container the workspace owns, for a wake or a daemon restart.
pub async fn published(engine: &Path, workspace: &str) -> Result<Vec<(u16, u16)>, Error> {
    let mut out = Vec::new();
    for row in listed(engine, "/containers/json", "", workspace).await? {
        if row.get("State").and_then(Value::as_str) != Some("running") {
            continue;
        }
        let Some(id) = row.get("Id").and_then(Value::as_str) else { continue };
        let (status, inspect) = ask(engine, "GET", &format!("/containers/{id}/json"), None).await?;
        if status == 200 {
            out.extend(published_ports(&inspect));
        }
    }
    Ok(out)
}

/// Every container, network and volume the workspace owns, removed from the engine: what a killed workspace leaves
/// on the box is nothing. Answers how many of each went.
pub async fn remove_all(engine: &Path, workspace: &str) -> Result<(usize, usize, usize), Error> {
    let mut counts = (0, 0, 0);
    for row in listed(engine, "/containers/json", "", workspace).await? {
        if let Some(id) = row.get("Id").and_then(Value::as_str) {
            let (status, _) = ask(engine, "DELETE", &format!("/containers/{id}?force=true&v=true"), None).await?;
            if status == 204 || status == 404 {
                counts.0 += 1;
            }
        }
    }
    for row in listed(engine, "/networks", "", workspace).await? {
        if let Some(id) = row.get("Id").and_then(Value::as_str) {
            let (status, _) = ask(engine, "DELETE", &format!("/networks/{id}"), None).await?;
            if status == 204 || status == 404 {
                counts.1 += 1;
            }
        }
    }
    for row in listed(engine, "/volumes", "Volumes", workspace).await? {
        if let Some(name) = row.get("Name").and_then(Value::as_str) {
            let (status, _) = ask(engine, "DELETE", &format!("/volumes/{}?force=true", encoded(name)), None).await?;
            if status == 204 || status == 404 {
                counts.2 += 1;
            }
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_binds(source: &str) -> Result<PathBuf, String> {
        Ok(PathBuf::from(format!("/box/rootfs{source}")))
    }

    #[test]
    fn the_route_table_passes_the_engines_own_routes_and_refuses_the_boxs() {
        assert_eq!(route("HEAD", "/_ping"), Route::Pass);
        assert_eq!(route("GET", "/v1.55/version"), Route::Pass);
        assert_eq!(route("POST", "/v1.55/images/create?fromImage=postgres&tag=16-alpine"), Route::Pass);
        assert_eq!(route("GET", "/v1.55/images/json"), Route::Pass);
        assert_eq!(route("GET", "/v1.55/images/nginx:alpine/json"), Route::Pass);
        assert_eq!(route("POST", "/v1.55/containers/create?name=web"), Route::Create);
        assert_eq!(route("GET", "/v1.55/containers/json?all=1"), Route::List);
        assert_eq!(route("GET", "/v1.55/networks"), Route::List);
        assert_eq!(route("GET", "/v1.55/volumes"), Route::List);
        assert_eq!(route("GET", "/v1.55/events?since=1"), Route::List);
        assert_eq!(route("POST", "/v1.55/networks/create"), Route::Labelled);
        assert_eq!(route("POST", "/v1.55/volumes/create"), Route::Labelled);
        assert_eq!(route("POST", "/v1.55/containers/abc/start"), Route::Container { id: "abc".into(), verb: Some("start".into()) });
        assert_eq!(route("DELETE", "/v1.55/containers/abc?force=1"), Route::Container { id: "abc".into(), verb: None });
        assert_eq!(route("GET", "/v1.55/containers/abc/logs?follow=1"), Route::Container { id: "abc".into(), verb: Some("logs".into()) });
        assert_eq!(route("POST", "/v1.55/containers/abc/attach"), Route::Container { id: "abc".into(), verb: Some("attach".into()) });
        assert_eq!(route("POST", "/v1.55/exec/e1/start"), Route::Exec { id: "e1".into() });
        assert_eq!(route("GET", "/v1.55/networks/n1"), Route::Network { id: "n1".into(), verb: None });
        assert_eq!(route("GET", "/v1.55/volumes/v1"), Route::Volume { name: "v1".into() });
        for path in [
            "/v1.55/info",
            "/v1.55/system/df",
            "/v1.55/swarm",
            "/v1.55/plugins",
            "/v1.55/services",
            "/v1.55/secrets",
            "/v1.55/auth",
            "/nonsense",
        ] {
            assert!(matches!(route("GET", path), Route::Refused(_)), "{path}");
        }
        assert!(matches!(route("POST", "/v1.55/build?t=x"), Route::Refused(s) if s.contains("image builds")));
        assert!(matches!(route("POST", "/v1.55/containers/prune"), Route::Refused(s) if s.contains("everything on this computer")));
    }

    #[test]
    fn a_create_is_labelled_its_ports_move_to_the_loopback_and_its_binds_are_mapped() {
        let mut body = json!({
            "Image": "nginx:alpine",
            "Labels": { "com.docker.compose.project": "demo" },
            "HostConfig": {
                "Binds": ["/root/demo/html:/usr/share/nginx/html:ro", "dbdata:/var/lib/postgresql/data"],
                "Mounts": [{ "Type": "bind", "Source": "/root/demo/conf", "Target": "/etc/nginx/conf.d" }, { "Type": "volume", "Source": "v", "Target": "/v" }],
                "PortBindings": { "80/tcp": [{ "HostIp": "", "HostPort": "18080" }], "443/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "" }] },
                "NetworkMode": "demo_default"
            },
            "NetworkingConfig": { "EndpointsConfig": { "demo_default": {} } }
        });
        let fenced = fence_create(&mut body, "wsp-a", &no_binds).unwrap();
        assert_eq!(fenced.ports, BTreeMap::from([("80/tcp".to_owned(), 18080)]));
        assert_eq!(fenced.networks, vec!["demo_default", "demo_default"]);
        assert!(fenced.containers.is_empty());
        assert_eq!(body["Labels"][LABEL], "wsp-a");
        assert_eq!(body["Labels"][PORTS_LABEL], "80/tcp=18080");
        assert_eq!(body["Labels"]["com.docker.compose.project"], "demo");
        assert_eq!(
            body["HostConfig"]["Binds"],
            json!(["/box/rootfs/root/demo/html:/usr/share/nginx/html:ro", "dbdata:/var/lib/postgresql/data"])
        );
        assert_eq!(body["HostConfig"]["Mounts"][0]["Source"], "/box/rootfs/root/demo/conf");
        assert_eq!(body["HostConfig"]["Mounts"][1]["Source"], "v");
        assert_eq!(
            body["HostConfig"]["PortBindings"],
            json!({ "80/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "" }], "443/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "" }] })
        );
        let mut bare = json!({ "Image": "alpine" });
        assert_eq!(fence_create(&mut bare, "wsp-b", &no_binds).unwrap(), Fenced::default());
        assert_eq!(bare, json!({ "Image": "alpine", "HostConfig": {}, "Labels": { LABEL: "wsp-b" } }));
    }

    #[test]
    fn a_privileged_container_is_refused() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "Privileged": true } });
        assert_eq!(
            fence_create(&mut body, "w", &no_binds).unwrap_err(),
            "a privileged container is root on this computer, so a workspace cannot ask for one"
        );
    }

    #[test]
    fn cap_add_is_refused() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "CapAdd": ["SYS_ADMIN"] } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("CapAdd is refused"));
        let mut empty = json!({ "Image": "alpine", "HostConfig": { "CapAdd": [], "CapDrop": ["NET_RAW"] } });
        assert!(fence_create(&mut empty, "w", &no_binds).is_ok(), "an empty CapAdd and a CapDrop pass");
    }

    #[test]
    fn devices_are_refused() {
        for field in ["Devices", "DeviceRequests", "DeviceCgroupRules"] {
            let mut body = json!({ "Image": "alpine", "HostConfig": { field: [{ "PathOnHost": "/dev/sda" }] } });
            assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("no device of this computer"), "{field}");
        }
    }

    #[test]
    fn security_opt_is_refused() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "SecurityOpt": ["seccomp=unconfined"] } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("SecurityOpt is refused"));
    }

    #[test]
    fn pid_mode_host_is_refused_and_a_containers_is_checked() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "PidMode": "host" } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("PidMode host is refused"));
        let mut shared = json!({ "Image": "alpine", "HostConfig": { "PidMode": "container:other" } });
        assert_eq!(fence_create(&mut shared, "w", &no_binds).unwrap().containers, vec!["other"]);
        let mut odd = json!({ "Image": "alpine", "HostConfig": { "PidMode": "weird" } });
        assert!(fence_create(&mut odd, "w", &no_binds).is_err());
    }

    #[test]
    fn network_mode_host_is_refused_and_a_named_network_is_checked() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "NetworkMode": "host" } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("NetworkMode host is refused"));
        for plain in PLAIN_NETWORKS {
            let mut ok = json!({ "Image": "alpine", "HostConfig": { "NetworkMode": plain } });
            assert!(fence_create(&mut ok, "w", &no_binds).unwrap().networks.is_empty(), "{plain}");
        }
        let mut shared = json!({ "Image": "alpine", "HostConfig": { "NetworkMode": "container:peer" } });
        assert_eq!(fence_create(&mut shared, "w", &no_binds).unwrap().containers, vec!["peer"]);
    }

    #[test]
    fn ipc_mode_host_is_refused() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "IpcMode": "host" } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("IpcMode host is refused"));
        let mut fine = json!({ "Image": "alpine", "HostConfig": { "IpcMode": "shareable" } });
        assert!(fence_create(&mut fine, "w", &no_binds).is_ok());
    }

    #[test]
    fn publish_all_ports_is_refused_and_volumes_from_is_checked() {
        let mut body = json!({ "Image": "alpine", "HostConfig": { "PublishAllPorts": true } });
        assert!(fence_create(&mut body, "w", &no_binds).unwrap_err().contains("PublishAllPorts is refused"));
        let mut from = json!({ "Image": "alpine", "HostConfig": { "VolumesFrom": ["data:ro"] } });
        assert_eq!(fence_create(&mut from, "w", &no_binds).unwrap().containers, vec!["data"]);
    }

    #[test]
    fn a_bind_outside_the_project_folder_is_refused_with_the_mapping_functions_sentence() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("rootfs");
        fs::create_dir_all(rootfs.join("root/demo/html")).unwrap();
        fs::create_dir_all(rootfs.join("root/other")).unwrap();
        fs::create_dir_all(rootfs.join("root/.wsp")).unwrap();
        fs::create_dir_all(rootfs.join("etc")).unwrap();
        let roots = rootfs.join("root/.wsp/roots");
        let map = |source: &str| map_bind(&rootfs, &roots, source);
        assert!(map("/root/demo").unwrap_err().contains("no project folder yet"));
        fs::write(&roots, "/root/demo\n").unwrap();
        assert_eq!(map("/root/demo/html").unwrap(), rootfs.join("root/demo/html").canonicalize().unwrap());
        assert_eq!(map("/root/demo").unwrap(), rootfs.join("root/demo").canonicalize().unwrap());
        let outside = map("/").unwrap_err();
        assert_eq!(outside, "a bind mount's source must sit under a project folder of this workspace (/root/demo), and / does not");
        assert!(map("/root/other").unwrap_err().contains("and /root/other does not"));
        assert!(map("/root/demo/missing").unwrap_err().contains("is not there in the workspace"));
        assert!(map("relative").unwrap_err().contains("absolute path"));
        // A link inside the project folder that points out of the workspace is refused as the box path it reaches.
        std::os::unix::fs::symlink("/", rootfs.join("root/demo/escape")).unwrap();
        assert!(map("/root/demo/escape").unwrap_err().contains("and /root/demo/escape does not"));
        let mut body = json!({ "Image": "alpine", "HostConfig": { "Binds": ["/:/host"] } });
        assert_eq!(fence_create(&mut body, "w", &map).unwrap_err(), outside);
        let mut mount = json!({ "Image": "alpine", "HostConfig": { "Mounts": [{ "Type": "bind", "Source": "/etc", "Target": "/x" }] }});
        assert!(fence_create(&mut mount, "w", &map).unwrap_err().contains("and /etc does not"));
    }

    #[test]
    fn a_privileged_exec_is_refused_and_a_network_or_volume_create_is_labelled() {
        assert!(fence_exec(&json!({ "Cmd": ["sh"], "Privileged": true })).unwrap_err().contains("privileged exec"));
        assert!(fence_exec(&json!({ "Cmd": ["sh"] })).is_ok());
        let mut network = json!({ "Name": "demo_default", "Labels": { "com.docker.compose.network": "default" } });
        label_create(&mut network, "wsp-a").unwrap();
        assert_eq!(network["Labels"], json!({ "com.docker.compose.network": "default", LABEL: "wsp-a" }));
        let mut volume = json!({ "Name": "data", "Labels": null });
        label_create(&mut volume, "wsp-a").unwrap();
        assert_eq!(volume["Labels"][LABEL], "wsp-a");
    }

    #[test]
    fn a_listing_gets_the_label_filter_whatever_filters_it_carried() {
        let decode = |q: &str| -> Value {
            let filters = q.split('&').find_map(|p| p.strip_prefix("filters=")).unwrap();
            serde_json::from_str(&percent_decode_str(filters).decode_utf8().unwrap()).unwrap()
        };
        let plain = filtered_query(None, "wsp-a").unwrap();
        assert_eq!(decode(&plain), json!({ "label": ["wsp.workspace=wsp-a"] }));
        let with_all = filtered_query(Some("all=1&limit=0"), "wsp-a").unwrap();
        assert!(with_all.starts_with("all=1&limit=0&filters="), "{with_all}");
        let compose = filtered_query(
            Some(&format!("all=1&filters={}", utf8_percent_encode(r#"{"label":["com.docker.compose.project=demo"]}"#, NON_ALPHANUMERIC))),
            "wsp-a",
        )
        .unwrap();
        assert_eq!(decode(&compose), json!({ "label": ["com.docker.compose.project=demo", "wsp.workspace=wsp-a"] }));
        let old_form = filtered_query(
            Some(&format!("filters={}", utf8_percent_encode(r#"{"label":{"x=y":true},"status":{"running":true}}"#, NON_ALPHANUMERIC))),
            "w",
        )
        .unwrap();
        assert_eq!(decode(&old_form), json!({ "label": { "x=y": true, "wsp.workspace=w": true }, "status": { "running": true } }));
        // Compose asks for a network by name in the map form; the label joins in that form, since the engine refuses
        // one filters object in two forms.
        let by_name =
            filtered_query(Some(&format!("filters={}", utf8_percent_encode(r#"{"name":{"demo_default":true}}"#, NON_ALPHANUMERIC))), "w")
                .unwrap();
        assert_eq!(decode(&by_name), json!({ "name": { "demo_default": true }, "label": { "wsp.workspace=w": true } }));
        assert!(filtered_query(Some("filters=notjson"), "w").is_err());
    }

    #[test]
    fn the_published_ports_join_what_was_asked_to_what_the_engine_bound() {
        let inspect = json!({
            "Config": { "Labels": { LABEL: "wsp-a", PORTS_LABEL: "80/tcp=18080" } },
            "NetworkSettings": { "Ports": { "80/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "40001" }], "5432/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "40002" }], "9/udp": null } }
        });
        assert_eq!(published_ports(&inspect), vec![(18080, 40001), (40002, 40002)]);
        assert_eq!(published_ports(&json!({})), Vec::<(u16, u16)>::new());
    }

    #[test]
    fn the_engine_socket_follows_the_doctor_and_a_box_without_one_gets_the_sentence() {
        let facts = |engine| Facts { linux: true, cgroup2: true, controllers: vec![], overlay: true, root: true, kvm: false, engine };
        assert_eq!(socket_of(&facts(Engine::None)).unwrap_err(), NO_ENGINE);
        assert_eq!(engine_socket(Engine::Docker), Some(Path::new("/var/run/docker.sock")));
        assert_eq!(engine_socket(Engine::Podman), Some(Path::new("/run/podman/podman.sock")));
        if !Path::new(PODMAN_SOCKET).exists() {
            assert!(socket_of(&facts(Engine::Podman)).unwrap_err().contains("its socket /run/podman/podman.sock is not there"));
        }
    }

    #[test]
    fn heads_are_read_and_rewritten_with_the_connection_told_to_close() {
        let head = parse_request(b"POST /v1.55/containers/create?name=x HTTP/1.1\r\nHost: docker\r\nUser-Agent: Docker-Client\r\nContent-Length: 12\r\nContent-Type: application/json\r\n\r\n").unwrap();
        assert_eq!(
            (head.method.as_str(), head.path.as_str(), head.content_length, head.chunked, head.upgrade),
            ("POST", "/v1.55/containers/create?name=x", Some(12), false, false)
        );
        let sent = String::from_utf8(request_head(&head, "/v1.55/containers/create?name=x", Some(40))).unwrap();
        assert!(sent.starts_with("POST /v1.55/containers/create?name=x HTTP/1.1\r\n"));
        assert!(sent.contains("Content-Length: 40\r\n") && !sent.contains("Content-Length: 12"));
        assert!(sent.contains("User-Agent: Docker-Client\r\n") && sent.ends_with("Connection: close\r\n\r\n"));
        let upgrade = parse_request(
            b"POST /v1.55/exec/e/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 2\r\n\r\n",
        )
        .unwrap();
        assert!(upgrade.upgrade);
        let sent = String::from_utf8(request_head(&upgrade, &upgrade.path, None)).unwrap();
        assert!(sent.contains("Connection: Upgrade\r\n") && sent.contains("Upgrade: tcp\r\n") && !sent.contains("Connection: close"));
        let (status, answer) = response_head(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n").unwrap();
        assert_eq!(status, 200);
        assert_eq!(
            String::from_utf8(answer).unwrap(),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n"
        );
        let (status, raw) = response_head(b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n").unwrap();
        assert_eq!((status, raw.as_slice()), (101, &b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"[..]));
        assert_eq!(dechunk(b"5\r\nhello\r\n1\r\n!\r\n0\r\n\r\n"), b"hello!");
        assert!(parse_request(b"garbage\r\n\r\n").is_err());
    }
}
