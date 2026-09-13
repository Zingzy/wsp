// SPDX-License-Identifier: AGPL-3.0-only
//! The fenced engine socket against a fake engine in this process: a Unix socket that records every request it is
//! handed and answers what the route asks for. One case per allowed route, so what reaches the engine is read off
//! the record, and one per refusal, so nothing reaches it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use wsp_runtime::engine::{self, Fence, Ports, LABEL, PORTS_LABEL};

const WORKSPACE: &str = "wsp-a";

/// What the fake engine saw: method, path, body.
type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

async fn read_request(stream: &mut UnixStream) -> (String, String, Vec<(String, String)>, Vec<u8>) {
    let mut held = Vec::new();
    let mut buf = [0u8; 4096];
    let split = loop {
        if let Some(at) = held.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0, "the request ended before its head did");
        held.extend_from_slice(&buf[..n]);
    };
    let head = String::from_utf8(held[..split].to_vec()).unwrap();
    let mut rest = held[split..].to_vec();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap().split(' ');
    let method = first.next().unwrap().to_owned();
    let path = first.next().unwrap().to_owned();
    let headers: Vec<(String, String)> =
        lines.filter(|l| !l.is_empty()).filter_map(|l| l.split_once(": ").map(|(k, v)| (k.to_ascii_lowercase(), v.to_owned()))).collect();
    let wanted: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    while rest.len() < wanted {
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0);
        rest.extend_from_slice(&buf[..n]);
    }
    (method, path, headers, rest)
}

fn json_response(status: u16, body: &Value) -> Vec<u8> {
    let text = body.to_string();
    format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len()).into_bytes()
}

fn inspect(id: &str, workspace: &str) -> Value {
    json!({
        "Id": id,
        "Config": { "Labels": { LABEL: workspace, PORTS_LABEL: "80/tcp=18080" } },
        "NetworkSettings": { "Ports": { "80/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "40001" }] } }
    })
}

/// The fake engine's answer to one request, by its path: containers, execs, networks and volumes whose id starts
/// with `ours` wear the workspace's label, `theirs` wear another's, anything else is not there.
fn answer(method: &str, path: &str) -> Vec<u8> {
    let bare = path.split('?').next().unwrap();
    let segments: Vec<&str> = bare.trim_start_matches("/v1.55").split('/').filter(|s| !s.is_empty()).collect();
    let owner = |id: &str| {
        if id.starts_with("ours") {
            Some(WORKSPACE)
        } else if id.starts_with("theirs") {
            Some("wsp-other")
        } else {
            None
        }
    };
    match segments.as_slice() {
        ["containers", id, "json"] => match owner(id) {
            Some(w) => json_response(200, &inspect(id, w)),
            None => json_response(404, &json!({ "message": format!("No such container: {id}") })),
        },
        ["exec", id, "json"] => match owner(id.trim_start_matches("exec")) {
            Some(_) => json_response(200, &json!({ "ID": id, "ContainerID": id.trim_start_matches("exec") })),
            None => json_response(404, &json!({ "message": "no such exec" })),
        },
        ["networks", id] if method == "GET" => match owner(id.trim_start_matches("net")) {
            Some(w) => json_response(200, &json!({ "Id": id, "Labels": { LABEL: w } })),
            None => json_response(404, &json!({ "message": "no such network" })),
        },
        ["volumes", name] if method == "GET" => match owner(name.trim_start_matches("vol")) {
            Some(w) => json_response(200, &json!({ "Name": name, "Labels": { LABEL: w } })),
            None => json_response(404, &json!({ "message": "no such volume" })),
        },
        ["containers", _, "start"] | ["containers", _, "stop"] => b"HTTP/1.1 204 No Content\r\n\r\n".to_vec(),
        ["containers", _] if method == "DELETE" => b"HTTP/1.1 204 No Content\r\n\r\n".to_vec(),
        ["containers", _, "logs"] => b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n".to_vec(),
        ["_ping"] => b"HTTP/1.1 200 OK\r\nApi-Version: 1.55\r\nContent-Length: 2\r\n\r\nOK".to_vec(),
        _ => json_response(200, &json!({ "ok": true, "path": bare })),
    }
}

/// The fake engine on a socket under the directory, recording what it is handed.
fn fake_engine(dir: &Path) -> (PathBuf, Seen) {
    let path = dir.join("engine.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let record = Arc::clone(&record);
            tokio::spawn(async move {
                let (method, path, headers, body) = read_request(&mut stream).await;
                record.lock().unwrap().push((method.clone(), path.clone(), String::from_utf8_lossy(&body).into_owned()));
                let upgrade = headers.iter().any(|(k, v)| k == "upgrade" && v == "tcp");
                if upgrade {
                    stream.write_all(b"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n").await.unwrap();
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = stream.read(&mut buf).await {
                        if n == 0 {
                            break;
                        }
                        let echoed = format!("echo:{}", String::from_utf8_lossy(&buf[..n]));
                        stream.write_all(echoed.as_bytes()).await.unwrap();
                    }
                    return;
                }
                stream.write_all(&answer(&method, &path)).await.unwrap();
                let _ = stream.shutdown().await;
            });
        }
    });
    (path, seen)
}

struct Joined(Mutex<Vec<(String, u16, u16)>>);

impl Ports for Joined {
    fn published(&self, workspace: &str, inside: u16, box_port: u16) {
        self.0.lock().unwrap().push((workspace.to_owned(), inside, box_port));
    }
}

struct World {
    socket: PathBuf,
    seen: Seen,
    joined: Arc<Joined>,
    rootfs: PathBuf,
    _dir: tempfile::TempDir,
}

/// The proxy over the fake engine, its rootfs holding one project folder `/root/demo` named in the roots file.
fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let (engine, seen) = fake_engine(dir.path());
    let rootfs = dir.path().join("rootfs");
    std::fs::create_dir_all(rootfs.join("root/demo/html")).unwrap();
    std::fs::create_dir_all(rootfs.join("root/.wsp")).unwrap();
    std::fs::create_dir_all(rootfs.join("etc")).unwrap();
    std::fs::write(rootfs.join("root/.wsp/roots"), "/root/demo\n").unwrap();
    let joined = Arc::new(Joined(Mutex::new(Vec::new())));
    let listener = engine::bind(&dir.path().join("ws")).unwrap();
    let fence = Fence { workspace: WORKSPACE.into(), rootfs: rootfs.clone(), engine, ports: Arc::clone(&joined) as Arc<dyn Ports> };
    tokio::spawn(engine::serve(listener, Arc::new(fence)));
    World { socket: dir.path().join("ws").join(engine::SOCKET_NAME), seen, joined, rootfs, _dir: dir }
}

impl World {
    /// One request through the workspace's socket, as a Docker client sends it: the status, the head and the body.
    async fn call(&self, method: &str, path: &str, body: Option<&Value>) -> (u16, String, Vec<u8>) {
        let mut stream = UnixStream::connect(&self.socket).await.unwrap();
        let text = body.map(Value::to_string).unwrap_or_default();
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: docker\r\nUser-Agent: Docker-Client/29.7.0\r\n");
        if body.is_some() {
            request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", text.len()));
        }
        request.push_str("\r\n");
        request.push_str(&text);
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut all = Vec::new();
        stream.read_to_end(&mut all).await.unwrap();
        let split = all.windows(4).position(|w| w == b"\r\n\r\n").expect("a response head") + 4;
        let head = String::from_utf8(all[..split].to_vec()).unwrap();
        let status: u16 = head.split(' ').nth(1).unwrap().parse().unwrap();
        (status, head, all[split..].to_vec())
    }

    fn reached(&self) -> Vec<(String, String, String)> {
        self.seen.lock().unwrap().clone()
    }

    fn engine_saw(&self, method: &str, path_starts: &str) -> Option<(String, String, String)> {
        self.reached().into_iter().find(|(m, p, _)| m == method && p.starts_with(path_starts))
    }

    fn message(body: &[u8]) -> String {
        serde_json::from_slice::<Value>(body).ok().and_then(|v| v["message"].as_str().map(str::to_owned)).unwrap_or_default()
    }
}

#[tokio::test]
async fn ping_and_version_pass_and_the_answer_closes_the_connection() {
    let w = world();
    let (status, head, body) = w.call("HEAD", "/_ping", None).await;
    assert_eq!((status, body.as_slice()), (200, &b"OK"[..]));
    assert!(head.contains("Api-Version: 1.55") && head.contains("Connection: close"), "{head}");
    let (status, _, body) = w.call("GET", "/v1.55/version", None).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["path"], "/v1.55/version");
    let sent = w.engine_saw("GET", "/v1.55/version").unwrap();
    assert_eq!(sent.1, "/v1.55/version");
}

#[tokio::test]
async fn image_routes_pass_unchanged() {
    let w = world();
    for (method, path) in [
        ("POST", "/v1.55/images/create?fromImage=postgres&tag=16-alpine"),
        ("GET", "/v1.55/images/json"),
        ("GET", "/v1.55/images/nginx:alpine/json"),
        ("DELETE", "/v1.55/images/nginx:alpine"),
    ] {
        let (status, _, _) = w.call(method, path, None).await;
        assert_eq!(status, 200, "{path}");
        assert_eq!(w.engine_saw(method, path).unwrap().1, path);
    }
}

#[tokio::test]
async fn a_container_create_reaches_the_engine_labelled_with_its_ports_on_the_loopback_and_its_binds_mapped() {
    let w = world();
    let body = json!({
        "Image": "nginx:alpine",
        "HostConfig": { "Binds": ["/root/demo/html:/usr/share/nginx/html:ro"], "PortBindings": { "80/tcp": [{ "HostIp": "", "HostPort": "18080" }] }, "NetworkMode": "netours1" },
        "NetworkingConfig": { "EndpointsConfig": { "netours1": {} } }
    });
    let (status, _, _) = w.call("POST", "/v1.55/containers/create?name=web", Some(&body)).await;
    assert_eq!(status, 200);
    let sent = w.engine_saw("POST", "/v1.55/containers/create").unwrap();
    assert_eq!(sent.1, "/v1.55/containers/create?name=web");
    let reached: Value = serde_json::from_str(&sent.2).unwrap();
    assert_eq!(reached["Labels"][LABEL], WORKSPACE);
    assert_eq!(reached["Labels"][PORTS_LABEL], "80/tcp=18080");
    assert_eq!(reached["HostConfig"]["PortBindings"]["80/tcp"], json!([{ "HostIp": "127.0.0.1", "HostPort": "" }]));
    let mapped = w.rootfs.join("root/demo/html").canonicalize().unwrap();
    assert_eq!(reached["HostConfig"]["Binds"], json!([format!("{}:/usr/share/nginx/html:ro", mapped.display())]));
    // The network it joins was checked for the label first.
    assert!(w.engine_saw("GET", "/networks/netours1").is_some());
}

#[tokio::test]
async fn a_create_naming_another_workspaces_network_or_container_is_not_found_and_never_reaches_the_engine() {
    let w = world();
    let (status, _, body) = w
        .call("POST", "/v1.55/containers/create", Some(&json!({ "Image": "alpine", "HostConfig": { "NetworkMode": "nettheirs1" } })))
        .await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such network: nettheirs1"));
    let (status, _, body) = w
        .call("POST", "/v1.55/containers/create", Some(&json!({ "Image": "alpine", "HostConfig": { "PidMode": "container:theirs1" } })))
        .await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such container: theirs1"));
    assert!(w.engine_saw("POST", "/v1.55/containers/create").is_none());
}

#[tokio::test]
async fn every_refused_field_answers_one_sentence_and_nothing_reaches_the_engine() {
    let w = world();
    let cases: [(Value, &str); 9] = [
        (json!({ "Privileged": true }), "a privileged container is root on this computer, so a workspace cannot ask for one"),
        (json!({ "CapAdd": ["SYS_ADMIN"] }), "a workspace's container runs with the engine's default capabilities; CapAdd is refused"),
        (
            json!({ "Devices": [{ "PathOnHost": "/dev/sda" }] }),
            "a workspace's container gets no device of this computer; Devices is refused",
        ),
        (
            json!({ "SecurityOpt": ["seccomp=unconfined"] }),
            "a workspace's container keeps the engine's seccomp and AppArmor defaults; SecurityOpt is refused",
        ),
        (json!({ "PidMode": "host" }), "a workspace's container cannot share this computer's pid namespace; PidMode host is refused"),
        (json!({ "NetworkMode": "host" }), "a workspace's container cannot join this computer's network; NetworkMode host is refused"),
        (json!({ "IpcMode": "host" }), "a workspace's container cannot share this computer's ipc namespace; IpcMode host is refused"),
        (
            json!({ "Binds": ["/:/host"] }),
            "a bind mount's source must sit under a project folder of this workspace (/root/demo), and / does not",
        ),
        (
            json!({ "PublishAllPorts": true }),
            "a workspace publishes ports one by one on this computer's loopback; PublishAllPorts is refused",
        ),
    ];
    for (host_config, sentence) in cases {
        let (status, head, body) =
            w.call("POST", "/v1.55/containers/create", Some(&json!({ "Image": "alpine", "HostConfig": host_config }))).await;
        assert_eq!((status, World::message(&body).as_str()), (403, sentence));
        assert!(head.contains("Content-Type: application/json"), "{head}");
    }
    assert!(w.engine_saw("POST", "/v1.55/containers/create").is_none(), "{:?}", w.reached());
}

#[tokio::test]
async fn listings_reach_the_engine_with_the_workspaces_label_filter() {
    let w = world();
    for (path, prefix) in [
        ("/v1.55/containers/json?all=1", "/v1.55/containers/json?all=1&filters="),
        ("/v1.55/networks", "/v1.55/networks?filters="),
        ("/v1.55/volumes", "/v1.55/volumes?filters="),
        ("/v1.55/events?since=1", "/v1.55/events?since=1&filters="),
    ] {
        let (status, _, _) = w.call("GET", path, None).await;
        assert_eq!(status, 200, "{path}");
        let sent = w.engine_saw("GET", prefix).unwrap_or_else(|| panic!("{path}: {:?}", w.reached()));
        let filters = percent_encoding::percent_decode_str(sent.1.split("filters=").nth(1).unwrap()).decode_utf8().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&filters).unwrap()["label"], json!([format!("{LABEL}={WORKSPACE}")]), "{path}");
    }
    let compose = format!(
        "/v1.55/containers/json?all=1&filters={}",
        percent_encoding::utf8_percent_encode(r#"{"label":["com.docker.compose.project=demo"]}"#, percent_encoding::NON_ALPHANUMERIC)
    );
    w.call("GET", &compose, None).await;
    let sent = w.reached().into_iter().rfind(|(_, p, _)| p.starts_with("/v1.55/containers/json")).unwrap();
    let filters = percent_encoding::percent_decode_str(sent.1.split("filters=").nth(1).unwrap()).decode_utf8().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&filters).unwrap()["label"],
        json!(["com.docker.compose.project=demo", format!("{LABEL}={WORKSPACE}")])
    );
}

#[tokio::test]
async fn a_network_or_volume_create_reaches_the_engine_labelled() {
    let w = world();
    let (status, _, _) = w
        .call(
            "POST",
            "/v1.55/networks/create",
            Some(&json!({ "Name": "demo_default", "Labels": { "com.docker.compose.network": "default" } })),
        )
        .await;
    assert_eq!(status, 200);
    let sent = w.engine_saw("POST", "/v1.55/networks/create").unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&sent.2).unwrap()["Labels"],
        json!({ "com.docker.compose.network": "default", LABEL: WORKSPACE })
    );
    let (status, _, _) = w.call("POST", "/v1.55/volumes/create", Some(&json!({ "Name": "data" }))).await;
    assert_eq!(status, 200);
    let sent = w.engine_saw("POST", "/v1.55/volumes/create").unwrap();
    assert_eq!(serde_json::from_str::<Value>(&sent.2).unwrap()["Labels"][LABEL], WORKSPACE);
}

#[tokio::test]
async fn container_routes_reach_the_engine_for_the_workspaces_own_and_are_not_found_for_the_boxs() {
    let w = world();
    for (method, path) in [
        ("GET", "/v1.55/containers/ours1/json"),
        ("POST", "/v1.55/containers/ours1/stop?t=10"),
        ("GET", "/v1.55/containers/ours1/logs?stdout=1"),
        ("POST", "/v1.55/containers/ours1/wait"),
        ("GET", "/v1.55/containers/ours1/archive?path=/etc"),
        ("DELETE", "/v1.55/containers/ours1?force=1&v=1"),
    ] {
        let (status, _, body) = w.call(method, path, None).await;
        assert!(status == 200 || status == 204, "{path}: {status}");
        assert!(w.engine_saw(method, path).is_some(), "{path} did not reach the engine: {:?}", w.reached());
        if path.contains("logs") {
            assert_eq!(body, b"5\r\nhello\r\n0\r\n\r\n", "the chunked stream is copied as it came");
        }
    }
    // The box's own container, by name: not found, and nothing but the inspect that read its label reached the engine.
    let before = w.reached().len();
    for (method, path) in
        [("GET", "/v1.55/containers/theirs1/json"), ("POST", "/v1.55/containers/theirs1/stop"), ("DELETE", "/v1.55/containers/theirs1")]
    {
        let (status, _, body) = w.call(method, path, None).await;
        assert_eq!((status, World::message(&body).as_str()), (404, "No such container: theirs1"), "{path}");
    }
    let after: Vec<_> = w.reached()[before..].to_vec();
    assert!(after.iter().all(|(m, p, _)| m == "GET" && p == "/containers/theirs1/json"), "{after:?}");
    let (status, _, body) = w.call("GET", "/v1.55/containers/nobody/json", None).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such container: nobody"));
}

#[tokio::test]
async fn a_start_the_engine_took_joins_the_containers_published_ports() {
    let w = world();
    let (status, _, _) = w.call("POST", "/v1.55/containers/ours1/start", None).await;
    assert_eq!(status, 204);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(w.joined.0.lock().unwrap().clone(), vec![(WORKSPACE.to_owned(), 18080, 40001)]);
    let (status, _, _) = w.call("POST", "/v1.55/containers/theirs1/start", None).await;
    assert_eq!(status, 404);
    assert_eq!(w.joined.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_exec_is_fenced_at_its_create_and_its_start_is_copied_raw_after_the_upgrade() {
    let w = world();
    let (status, _, body) = w.call("POST", "/v1.55/containers/ours1/exec", Some(&json!({ "Cmd": ["sh"], "Privileged": true }))).await;
    assert_eq!(
        (status, World::message(&body).as_str()),
        (403, "a privileged exec is root on this computer, so a workspace cannot ask for one")
    );
    assert!(w.engine_saw("POST", "/v1.55/containers/ours1/exec").is_none());
    let (status, _, _) = w.call("POST", "/v1.55/containers/ours1/exec", Some(&json!({ "Cmd": ["sh"], "AttachStdout": true }))).await;
    assert_eq!(status, 200);
    assert!(w.engine_saw("POST", "/v1.55/containers/ours1/exec").is_some());
    let (status, _, body) = w.call("POST", "/v1.55/containers/theirs1/exec", Some(&json!({ "Cmd": ["sh"] }))).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such container: theirs1"));
    let (status, _, _) = w.call("GET", "/v1.55/exec/execours1/json", None).await;
    assert_eq!(status, 200);
    let (status, _, body) = w.call("GET", "/v1.55/exec/exectheirs1/json", None).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such exec instance: exectheirs1"));
    // The hijacked start: the head passes, then bytes flow both ways until the client closes.
    let mut stream = UnixStream::connect(&w.socket).await.unwrap();
    let body = r#"{"Detach":false,"Tty":false}"#;
    stream
        .write_all(format!("POST /v1.55/exec/execours1/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes())
        .await
        .unwrap();
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.unwrap();
    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
    assert!(head.starts_with("HTTP/1.1 101 UPGRADED\r\n"), "{head}");
    assert!(head.contains("Connection: Upgrade") && !head.contains("Connection: close"), "{head}");
    let mut echoed = String::new();
    if let Some(after) = head.split("\r\n\r\n").nth(1) {
        echoed.push_str(after);
    }
    stream.write_all(b"stdin bytes").await.unwrap();
    while !echoed.contains("echo:stdin bytes") {
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0, "the stream ended before the echo: {echoed}");
        echoed.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    let start = w.engine_saw("POST", "/v1.55/exec/execours1/start").unwrap();
    assert_eq!(start.2, body, "the body after the head reached the engine");
}

#[tokio::test]
async fn an_attach_passes_for_the_workspaces_own_container() {
    let w = world();
    let mut stream = UnixStream::connect(&w.socket).await.unwrap();
    stream
        .write_all(b"POST /v1.55/containers/ours1/attach?stream=1&stdout=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
        .await
        .unwrap();
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 101 UPGRADED"));
    assert!(w.engine_saw("POST", "/v1.55/containers/ours1/attach").is_some());
}

#[tokio::test]
async fn network_and_volume_routes_are_the_workspaces_own_alone() {
    let w = world();
    let (status, _, _) = w.call("GET", "/v1.55/networks/netours1", None).await;
    assert_eq!(status, 200);
    let (status, _, _) = w.call("DELETE", "/v1.55/networks/netours1", None).await;
    assert_eq!(status, 200);
    assert!(w.engine_saw("DELETE", "/v1.55/networks/netours1").is_some());
    let (status, _, body) = w.call("DELETE", "/v1.55/networks/nettheirs1", None).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such network: nettheirs1"));
    assert!(w.engine_saw("DELETE", "/v1.55/networks/nettheirs1").is_none());
    // A connect names a container too, and it is checked.
    let (status, _, body) = w.call("POST", "/v1.55/networks/netours1/connect", Some(&json!({ "Container": "theirs1" }))).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such container: theirs1"));
    let (status, _, _) = w.call("POST", "/v1.55/networks/netours1/connect", Some(&json!({ "Container": "ours1" }))).await;
    assert_eq!(status, 200);
    let (status, _, _) = w.call("GET", "/v1.55/volumes/volours1", None).await;
    assert_eq!(status, 200);
    let (status, _, body) = w.call("DELETE", "/v1.55/volumes/voltheirs1", None).await;
    assert_eq!((status, World::message(&body).as_str()), (404, "No such volume: voltheirs1"));
    assert!(w.engine_saw("DELETE", "/v1.55/volumes/voltheirs1").is_none());
}

#[tokio::test]
async fn the_boxs_routes_are_refused_before_the_engine_hears_of_them() {
    let w = world();
    for path in [
        "/v1.55/info",
        "/v1.55/system/df",
        "/v1.55/swarm",
        "/v1.55/plugins",
        "/v1.55/services",
        "/v1.55/nodes",
        "/v1.55/secrets",
        "/v1.55/configs",
        "/v1.55/auth",
        "/v1.55/distribution/nginx/json",
    ] {
        let (status, _, body) = w.call("GET", path, None).await;
        assert_eq!(status, 403, "{path}");
        assert!(World::message(&body).contains("is not served on a workspace's socket"), "{path}: {}", World::message(&body));
    }
    let (status, _, body) = w.call("POST", "/v1.55/build?t=x", None).await;
    assert_eq!(status, 403);
    assert!(World::message(&body).starts_with("image builds are not served"));
    let (status, _, _) = w.call("POST", "/v1.55/containers/prune", None).await;
    assert_eq!(status, 403);
    assert!(w.reached().is_empty(), "{:?}", w.reached());
}

#[tokio::test]
async fn the_removal_takes_every_container_network_and_volume_of_the_workspace_and_the_ports_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, seen) = fake_engine(dir.path());
    // The fake answers a plain listing with an object, which is no array: nothing to remove, and no error.
    assert_eq!(engine::remove_all(&engine, WORKSPACE).await.unwrap(), (0, 0, 0));
    let listed: Vec<String> = seen.lock().unwrap().iter().map(|(_, p, _)| p.clone()).collect();
    assert_eq!(listed.len(), 3);
    for (path, prefix) in listed.iter().zip(["/containers/json?all=1&filters=", "/networks?all=1&filters=", "/volumes?all=1&filters="]) {
        assert!(path.starts_with(prefix), "{path}");
    }
    assert_eq!(engine::published(&engine, WORKSPACE).await.unwrap(), Vec::<(u16, u16)>::new());
    let (status, value) = engine::ask(&engine, "GET", "/containers/ours1/json", None).await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(engine::published_ports(&value), vec![(18080, 40001)]);
}
