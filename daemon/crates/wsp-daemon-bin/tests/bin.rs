// SPDX-License-Identifier: AGPL-3.0-only
//! The binary as a process: the flags, the listening line, the port file, the ready line, and a wrong flag.

use std::io::Write;
use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const BIN: &str = env!("CARGO_BIN_EXE_wsp-daemon");

#[tokio::test]
async fn binds_prints_the_listening_line_writes_the_port_file_and_serves_the_door() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    std::fs::File::create(&token).unwrap().write_all(b"bin-token\n").unwrap();
    let port_file = dir.path().join("daemon.port");
    let mut child = Command::new(BIN)
        .args(["--host", "127.0.0.1", "--port", "0", "--token-path"])
        .arg(&token)
        .arg("--port-file")
        .arg(&port_file)
        .arg("--root")
        .arg(dir.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line()).await.unwrap().unwrap().unwrap();
    let port: u16 = line.strip_prefix("wsp-daemon listening on 127.0.0.1:").expect("the listening line").parse().unwrap();
    assert_eq!(std::fs::read_to_string(&port_file).unwrap(), format!("{port}\n"));
    // Not root, or no Linux /proc: the two score lines come first and say so, then the ready line.
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    let ready = loop {
        let line = tokio::time::timeout(Duration::from_secs(5), stderr.next_line()).await.unwrap().unwrap().unwrap();
        if line.starts_with("oom_score_adj not set: ") || line.starts_with("priority not set: ") {
            continue;
        }
        break line;
    };
    assert!(ready.starts_with("ready in ") && ready.ends_with(" ms"), "{ready}");

    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/")).await.unwrap();
    ws.send(Message::text(json!({ "id": 1, "op": "auth", "token": "bin-token" }).to_string())).await.unwrap();
    let mut frames = Vec::new();
    for _ in 0..2 {
        if let Message::Text(t) = ws.next().await.unwrap().unwrap() {
            frames.push(serde_json::from_str::<Value>(&t).unwrap());
        }
    }
    assert_eq!(frames[0], json!({ "id": 1, "ok": true }));
    assert_eq!(frames[1]["type"], "daemon.hello");
    assert_eq!(frames[1]["root"], dir.path().to_str().unwrap());
    ws.send(Message::text(json!({ "id": 2, "op": "ping" }).to_string())).await.unwrap();
    if let Message::Text(t) = ws.next().await.unwrap().unwrap() {
        assert_eq!(serde_json::from_str::<Value>(&t).unwrap(), json!({ "id": 2, "ok": true }));
    }
    child.kill().await.unwrap();
}

#[tokio::test]
async fn a_wrong_flag_prints_the_usage_line_and_exits_2() {
    let out = Command::new(BIN).arg("--wat").output().await.unwrap();
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("--wat"), "{stderr}");
    assert!(stderr.contains("usage: wsp-daemon [--host <addr>] [--port <n>] [--token-path <file>] [--root <dir>]"), "{stderr}");
    let out = Command::new(BIN).args(["--port", "abc"]).output().await.unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--port"));
}

#[tokio::test]
async fn runtime_ask_names_its_root_on_purpose_or_not_at_all() {
    // A frame that is not JSON, so nothing past the flags could run whatever the root: the refusal is the flag's.
    let out = Command::new(BIN).args(["runtime", "ask", "not a frame"]).output().await.unwrap();
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("--root"), "{stderr}");
}

#[tokio::test]
async fn refuses_to_start_without_a_token_file_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    // Spawned and bounded rather than awaited outright: a daemon that wrongly started would run for good.
    let child = Command::new(BIN)
        .args(["--host", "127.0.0.1", "--port", "0", "--token-path"])
        .arg(dir.path().join("missing"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output()).await.expect("the binary exits at once").unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("wsp-daemon failed to start: daemon refuses to start without an auth token"), "{stderr}");
    assert!(out.stdout.is_empty());
}

/// A daemon spawned with a fake stty first on its PATH and a fake /proc: the mode probe reads both, so a test
/// can flip what the slave says without a real terminal changing state.
struct FakeModes {
    dir: tempfile::TempDir,
    child: tokio::process::Child,
    port: u16,
}

impl FakeModes {
    async fn start() -> FakeModes {
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("token");
        std::fs::write(&token, "modes-token\n").unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(dir.path().join("modes"), "icanon echo\n").unwrap();
        let script = format!("#!/bin/sh\necho run >> {d}/count\ncat {d}/modes\n", d = dir.path().display());
        let stty = bin.join("stty");
        std::fs::write(&stty, script).unwrap();
        std::fs::set_permissions(&stty, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let mut child = Command::new(BIN)
            .args(["--host", "127.0.0.1", "--port", "0", "--mode-interval-ms", "50", "--token-path"])
            .arg(&token)
            .arg("--proc-root")
            .arg(dir.path().join("proc"))
            .arg("--root")
            .arg(dir.path())
            .env("PATH", path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line()).await.unwrap().unwrap().unwrap();
        let port: u16 = line.strip_prefix("wsp-daemon listening on 127.0.0.1:").expect("the listening line").parse().unwrap();
        FakeModes { dir, child, port }
    }

    /// The fake tree for one shell pid: its stdin a tty, its stat naming a foreground group, that group's comm.
    fn tree(&self, pid: u64, tpgid: u64, comm: &str) {
        let proc_root = self.dir.path().join("proc");
        let me = proc_root.join(pid.to_string());
        std::fs::create_dir_all(me.join("fd")).unwrap();
        std::os::unix::fs::symlink("/dev/pts/9", me.join("fd/0")).unwrap();
        std::fs::write(me.join("stat"), format!("{pid} (bash) S 1 {pid} {pid} 34816 {tpgid} 4194304 0 0 0 0")).unwrap();
        std::fs::create_dir_all(proc_root.join(tpgid.to_string())).unwrap();
        self.comm(tpgid, comm);
    }

    fn comm(&self, tpgid: u64, comm: &str) {
        std::fs::write(self.dir.path().join("proc").join(tpgid.to_string()).join("comm"), format!("{comm}\n")).unwrap();
    }

    fn modes(&self, text: &str) {
        std::fs::write(self.dir.path().join("modes"), format!("{text}\n")).unwrap();
    }

    fn probes(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("count")).map(|s| s.lines().count()).unwrap_or(0)
    }
}

struct Peer {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    frames: Vec<Value>,
    next: u64,
}

impl Peer {
    async fn connect(port: u16) -> Peer {
        let (ws, _) = connect_async(format!("ws://127.0.0.1:{port}/")).await.unwrap();
        let mut peer = Peer { ws, frames: Vec::new(), next: 1 };
        assert_eq!(peer.request("auth", json!({ "token": "modes-token" })).await["ok"], true);
        peer
    }

    async fn request(&mut self, op: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let mut frame = json!({ "id": id, "op": op });
        for (k, v) in params.as_object().unwrap() {
            frame[k] = v.clone();
        }
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await.expect("answered in time").unwrap().unwrap() {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    let done = v["id"] == json!(id);
                    self.frames.push(v);
                    if done {
                        return self.frames.last().unwrap().clone();
                    }
                }
                _ => continue,
            }
        }
    }

    /// Reads until an event of the type arrives that the test accepts, or the wait runs out.
    async fn wait_event(&mut self, ty: &str, within: Duration, accept: impl Fn(&Value) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        if self.events(ty).iter().any(&accept) {
            return true;
        }
        while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(&t).unwrap();
                let hit = v["type"] == ty && accept(&v);
                self.frames.push(v);
                if hit {
                    return true;
                }
            }
        }
        false
    }

    async fn listen(&mut self, for_: Duration) {
        let deadline = tokio::time::Instant::now() + for_;
        while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            self.frames.push(serde_json::from_str(&t).unwrap());
        }
    }

    fn events(&self, ty: &str) -> Vec<Value> {
        self.frames.iter().filter(|f| f["type"] == ty).cloned().collect()
    }
}

fn mode(pty_id: &str, mode: &str, echo: bool, foreground: &str) -> Value {
    json!({ "type": "pty.mode", "ptyId": pty_id, "mode": mode, "echo": echo, "foreground": foreground })
}

#[tokio::test]
async fn pushes_pty_mode_on_attach_and_again_when_the_probed_state_changes() {
    let mut d = FakeModes::start().await;
    let mut c = Peer::connect(d.port).await;
    let created = c.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    let pid = created["pid"].as_u64().unwrap();
    d.tree(pid, 4567, "bash");
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c.wait_event("pty.mode", Duration::from_secs(5), |_| true).await, "{:?}", c.frames);
    assert_eq!(c.events("pty.mode"), [mode(&pty_id, "line", true, "bash")]);

    // One change at a time: the slave's modes first, then the foreground process.
    d.modes("-icanon -echo");
    assert!(c.wait_event("pty.mode", Duration::from_secs(5), |e| e["mode"] == "raw").await, "{:?}", c.frames);
    assert_eq!(c.events("pty.mode").len(), 2);
    assert_eq!(c.events("pty.mode")[1], mode(&pty_id, "raw", false, "bash"));
    d.comm(4567, "vim");
    assert!(c.wait_event("pty.mode", Duration::from_secs(5), |e| e["foreground"] == "vim").await, "{:?}", c.frames);
    c.listen(Duration::from_millis(200)).await;
    assert_eq!(c.events("pty.mode").len(), 3);
    assert_eq!(c.events("pty.mode")[2], mode(&pty_id, "raw", false, "vim"));
    d.child.kill().await.unwrap();
}

#[tokio::test]
async fn stops_probing_once_the_pty_exits_even_with_the_client_still_attached() {
    let mut d = FakeModes::start().await;
    let mut c = Peer::connect(d.port).await;
    let created = c.request("pty.create", json!({ "shell": "bash" })).await;
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    d.tree(created["pid"].as_u64().unwrap(), 4567, "bash");
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert!(c.wait_event("pty.mode", Duration::from_secs(5), |_| true).await, "{:?}", c.frames);
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "exit\n" })).await["ok"], true);
    assert!(c.wait_event("pty.exit", Duration::from_secs(3), |_| true).await, "{:?}", c.frames);
    // A probe already running when the exit came finishes; the count settles over a few intervals and then holds.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let at_exit = d.probes();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(d.probes(), at_exit);

    // A late attach to the dead pty must not restart the loop either.
    let mut c2 = Peer::connect(d.port).await;
    assert_eq!(c2.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    c2.listen(Duration::from_millis(300)).await;
    assert_eq!(d.probes(), at_exit);
    assert_eq!(c2.events("pty.exit").len(), 1, "{:?}", c2.frames);
    d.child.kill().await.unwrap();
}

/// A daemon spawned plain, its process a thing the test can count threads and fds of.
async fn plain_daemon(env_without: Option<&str>) -> (tempfile::TempDir, tokio::process::Child, u16) {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    std::fs::write(&token, "modes-token\n").unwrap();
    let mut command = Command::new(BIN);
    command.args(["--host", "127.0.0.1", "--port", "0", "--token-path"]).arg(&token).arg("--root").arg(dir.path());
    if let Some(name) = env_without {
        command.env_remove(name);
    }
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line()).await.unwrap().unwrap().unwrap();
    let port: u16 = line.strip_prefix("wsp-daemon listening on 127.0.0.1:").expect("the listening line").parse().unwrap();
    (dir, child, port)
}

fn count(pid: u32, what: &str) -> usize {
    std::fs::read_dir(format!("/proc/{pid}/{what}")).unwrap().count()
}

fn thread_names(pid: u32) -> Vec<String> {
    std::fs::read_dir(format!("/proc/{pid}/task"))
        .unwrap()
        .filter_map(|t| std::fs::read_to_string(t.unwrap().path().join("comm")).ok())
        .map(|n| n.trim().to_owned())
        .collect()
}

#[tokio::test]
async fn an_exited_pty_holds_its_scrollback_and_no_thread_or_fd_until_it_is_killed() {
    let (_dir, mut child, port) = plain_daemon(None).await;
    let pid = child.id().unwrap();
    let mut c = Peer::connect(port).await;
    let (threads, fds) = (count(pid, "task"), count(pid, "fd"));
    let mut ids = Vec::new();
    for _ in 0..10 {
        let created = c.request("pty.create", json!({ "shell": "bash" })).await;
        ids.push(created["ptyId"].as_str().unwrap().to_owned());
    }
    assert!(count(pid, "task") >= threads + 30, "each live pty has its three threads");
    assert!(thread_names(pid).iter().any(|n| n.starts_with("pty-w-")));
    for id in &ids {
        assert_eq!(c.request("pty.write", json!({ "ptyId": id, "data": "exit\n" })).await["ok"], true);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let listed = c.request("pty.list", json!({})).await;
        let entries = listed["ptys"].as_array().unwrap();
        if entries.len() == 10 && entries.iter().all(|p| p["exited"] == true) {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "every shell exits: {listed}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // The threads end with the exit; a moment for the last of them to be gone from /proc.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(count(pid, "task"), threads, "threads after ten exits: {:?}", thread_names(pid));
    assert_eq!(count(pid, "fd"), fds, "fds after ten exits");
    assert!(!thread_names(pid).iter().any(|n| n.starts_with("pty-")));
    // The scrollback is still there for a late attach; the ten entries stay listed until pty.kill.
    assert_eq!(c.request("pty.attach", json!({ "ptyId": ids[0] })).await["ok"], true);
    assert!(c.events("pty.data").iter().any(|e| e["data"].as_str().unwrap_or("").contains("exit")));
    assert_eq!(c.events("pty.exit").len(), 1);
    let r = c.request("pty.resize", json!({ "ptyId": ids[0], "cols": 100, "rows": 30 })).await;
    assert_eq!((r["ok"].as_bool(), r["error"].as_str()), (Some(false), Some(format!("{} has exited", ids[0]).as_str())));
    child.kill().await.unwrap();
}

#[tokio::test]
async fn a_shell_it_spawns_sees_home_and_user_even_when_the_daemon_has_none() {
    let (_dir, mut child, port) = plain_daemon(Some("HOME")).await;
    let row = std::process::Command::new("sh").args(["-c", "getent passwd \"$(id -u)\""]).output().unwrap();
    let row = String::from_utf8_lossy(&row.stdout);
    let fields: Vec<&str> = row.trim().split(':').collect();
    let (user, home) = (fields[0], fields[5]);
    let mut c = Peer::connect(port).await;
    let created = c.request("pty.create", json!({ "shell": "bash", "cwd": "/" })).await;
    assert_eq!(created["ok"], true, "{created}");
    let pty_id = created["ptyId"].as_str().unwrap().to_owned();
    assert_eq!(c.request("pty.attach", json!({ "ptyId": pty_id })).await["ok"], true);
    assert_eq!(c.request("pty.write", json!({ "ptyId": pty_id, "data": "echo HOME=$HOME USER=$USER\n" })).await["ok"], true);
    let want = format!("HOME={home} USER={user}\r");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !c.events("pty.data").iter().map(|e| e["data"].as_str().unwrap_or("")).collect::<String>().contains(&want) {
        assert!(tokio::time::Instant::now() < deadline, "{:?}", c.events("pty.data"));
        c.listen(Duration::from_millis(100)).await;
    }
    child.kill().await.unwrap();
}
