// SPDX-License-Identifier: AGPL-3.0-only
//! The machine ops against the kernel, through this binary as the helper and the init: root, cgroup v2 and a
//! registry, so gated WSP_RUNTIME_LIVE=1. The root is one directory under /tmp per checkout, so the base image is
//! pulled once per checkout; every workspace a case makes is killed at its end, and its mount and its cgroup are
//! checked gone. Nothing here touches a workspace it did not make. The cases are the Docker backend's, the fake
//! engine replaced by the kernel, then the network's: the box reaches a workspace at a published port, a
//! workspace reaches its box, a registry and nothing of its neighbours; then the store's: snapshots, forks from
//! them, templates, and the pause that stops a workspace and the wake that boots its saved layer.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{Mutex, MutexGuard};
use wsp_frames::RequestId;
use wsp_runtime::fetch::Digest;
use wsp_runtime::net::{self, Network, Route};
use wsp_runtime::nft;
use wsp_runtime::ops::Ops;
use wsp_runtime::store::Store;

const CGROUPS: &str = "/sys/fs/cgroup/wsp";

static ONE_AT_A_TIME: Mutex<()> = Mutex::const_new(());

/// A short word for this checkout, off the path of the crate: the root and the owner label carry it, so two
/// builders on one box never share a root or a label.
fn checkout_key() -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in env!("CARGO_MANIFEST_DIR").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")[..8].to_owned()
}

fn root() -> PathBuf {
    PathBuf::from(format!("/tmp/wsp-runtime-live-{}", checkout_key()))
}

fn live_owner() -> String {
    format!("live-665-{}", checkout_key())
}

fn live() -> bool {
    std::env::var("WSP_RUNTIME_LIVE").as_deref() == Ok("1")
}

struct World {
    ops: Ops,
    made: Vec<String>,
    _turn: MutexGuard<'static, ()>,
}

/// The binary under test, or the one WSP_RUNTIME_BIN names, so the release build's numbers can be read here.
fn bin() -> PathBuf {
    std::env::var("WSP_RUNTIME_BIN").map_or_else(|_| PathBuf::from(env!("CARGO_BIN_EXE_wsp-daemon")), PathBuf::from)
}

/// What every workspace here runs to answer a line on its port 7070, from every address it has: the base image
/// carries perl and nothing else that listens.
const ANSWER_ON_7070: &str = "nohup perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => \"0.0.0.0\", LocalPort => 7070, Listen => 5, ReuseAddr => 1) or die $!; while ($c = $s->accept) { print $c \"hello from inside\\n\"; close $c }' > /dev/null 2> /tmp/listen.err & sleep 0.5; cat /tmp/listen.err";

impl World {
    /// Opens the ops on the fixed root and kills whatever an earlier case left under the live label: its
    /// workspaces, its snapshots and its templates, all named after this checkout.
    async fn open() -> World {
        let turn = ONE_AT_A_TIME.lock().await;
        let ops = Ops::open(&root(), bin()).unwrap();
        let world = World { ops, made: Vec::new(), _turn: turn };
        world.ops.restore().await.unwrap();
        let rows = world.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
        for row in rows["machines"].as_array().unwrap() {
            world.ask("machine.kill", json!({ "machineId": row["id"] })).await;
        }
        let templates = world.ok("machine.listTemplates", json!({})).await;
        for row in templates["templates"].as_array().unwrap() {
            if row["name"].as_str().unwrap().starts_with(&live_owner()) {
                world.ok("machine.deleteTemplate", json!({ "templateId": row["id"] })).await;
            }
        }
        let snapshots = world.ok("machine.listSnapshots", json!({})).await;
        for row in snapshots["snapshots"].as_array().unwrap() {
            if row["name"].as_str().unwrap().starts_with(&live_owner()) {
                world.ok("machine.deleteSnapshot", json!({ "snapshotId": row["id"] })).await;
            }
        }
        world
    }

    /// A snapshot of the workspace under a name of this checkout's; answers its id.
    async fn snapshot(&self, id: &str, name: &str, first_life: bool) -> String {
        let reply = self
            .ok(
                "machine.snapshot",
                json!({ "machineId": id, "name": format!("{}-{name}", live_owner()), "life": { "firstLife": first_life } }),
            )
            .await;
        reply["snapshotId"].as_str().unwrap().to_owned()
    }

    /// The listing's row for one snapshot.
    async fn snapshot_row(&self, snapshot_id: &str) -> Value {
        let rows = self.ok("machine.listSnapshots", json!({})).await;
        rows["snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == snapshot_id)
            .cloned()
            .unwrap_or_else(|| panic!("{snapshot_id} is not listed: {rows}"))
    }

    /// The same root opened again, as a daemon that restarted opens it: nothing killed, the forwards restored.
    async fn reopen(&mut self) {
        let fresh = Ops::open(&root(), bin()).unwrap();
        drop(std::mem::replace(&mut self.ops, fresh));
        // The old listeners' tasks end at the next turn of this runtime; a daemon that died holds no port.
        tokio::task::yield_now().await;
        self.ops.restore().await.unwrap();
    }

    fn network(&self, id: &str) -> Network {
        serde_json::from_slice(&fs::read(root().join("run").join(id).join("net.json")).unwrap()).unwrap()
    }

    /// The port on the box's loopback that machine.previewUrl answers for the workspace's port.
    async fn publish(&self, id: &str, port: u16) -> u16 {
        let reply = self.ok("machine.previewUrl", json!({ "machineId": id, "port": port })).await;
        let url = reply["reach"]["url"].as_str().unwrap();
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        assert_eq!(reply["reach"]["token"], "");
        assert_eq!(reply["reach"]["expiresAt"], 9_007_199_254_740_991u64);
        url.rsplit(':').next().unwrap().parse().unwrap()
    }

    /// The workspace answers on 7070 from inside, checked from the box at its own address.
    async fn listen_inside(&self, id: &str) -> Ipv4Addr {
        let (code, _, err) = self.exec(id, ANSWER_ON_7070).await;
        assert_eq!((code, err.as_str()), (0, ""));
        let address = self.network(id).address;
        assert_eq!(read_line(SocketAddrV4::new(address, 7070)).await.unwrap(), "hello from inside");
        address
    }

    async fn ask(&self, op: &str, fields: Value) -> Value {
        let mut frame = json!({ "id": 1, "op": op });
        for (k, v) in fields.as_object().unwrap() {
            frame[k] = v.clone();
        }
        serde_json::from_str(&self.ops.answer(Some(RequestId::from(1)), &frame).await).unwrap()
    }

    async fn ok(&self, op: &str, fields: Value) -> Value {
        let reply = self.ask(op, fields).await;
        assert_eq!(reply["ok"], true, "{op}: {reply}");
        reply
    }

    async fn create(&mut self, spec: Value) -> String {
        let reply = self.ok("machine.create", json!({ "spec": spec })).await;
        let id = reply["machine"]["id"].as_str().unwrap().to_owned();
        self.made.push(id.clone());
        id
    }

    async fn exec(&self, id: &str, cmd: &str) -> (i64, String, String) {
        let reply = self.ok("machine.exec", json!({ "machineId": id, "cmd": cmd, "timeoutMs": 60_000 })).await;
        let r = &reply["result"];
        (r["exitCode"].as_i64().unwrap(), r["stdout"].as_str().unwrap().to_owned(), r["stderr"].as_str().unwrap().to_owned())
    }

    async fn state(&self, id: &str) -> String {
        self.ok("machine.state", json!({ "machineId": id })).await["state"].as_str().unwrap().to_owned()
    }

    /// Kills what this case made and checks the box carries nothing of it.
    async fn close(mut self) {
        for id in std::mem::take(&mut self.made) {
            let reply = self.ask("machine.kill", json!({ "machineId": &id })).await;
            assert!(reply["ok"] == true || reply["kind"] == "missing", "kill {id}: {reply}");
            assert!(!Path::new(CGROUPS).join(&id).exists(), "cgroup of {id} stays");
            assert!(!root().join("run").join(&id).exists(), "run dir of {id} stays");
            let mounts = fs::read_to_string("/proc/self/mountinfo").unwrap();
            assert!(!mounts.contains(&format!("/run/{id}/rootfs")), "the rootfs of {id} is still mounted");
        }
    }
}

/// A case that panics before its close still kills what it made, so a red run leaves no mount and no cgroup on the
/// box; the kills run on a thread of their own, since a runtime cannot be started inside the test's.
impl Drop for World {
    fn drop(&mut self) {
        let ids = std::mem::take(&mut self.made);
        if ids.is_empty() {
            return;
        }
        let ops = &self.ops;
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                runtime.block_on(async {
                    for id in ids {
                        let _ = ops.answer(Some(RequestId::from(1)), &json!({ "id": 1, "op": "machine.kill", "machineId": id })).await;
                    }
                });
            });
        });
    }
}

fn spec(extra: Value) -> Value {
    let mut spec = json!({ "kind": "sandbox", "template": "ubuntu:24.04", "labels": { "wsp-owner": live_owner() } });
    for (k, v) in extra.as_object().unwrap() {
        spec[k] = v.clone();
    }
    spec
}

#[tokio::test]
async fn builds_the_container_from_the_spec_image_limits_labels_envs_and_the_boot_command() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let started = Instant::now();
    let id = w.create(spec(json!({ "cpu": 2, "memMb": 1024, "envs": { "WSP_TOKEN": "t" }, "idempotencyKey": format!("live-665-build-{}", checkout_key()) }))).await;
    let ready = started.elapsed();
    eprintln!("create to ready: {} ms", ready.as_millis());
    assert_eq!(id, format!("wsp-live-665-build-{}", checkout_key()));
    assert_eq!(w.state(&id).await, "running");
    let (code, out, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.swap.max; echo $WSP_TOKEN; hostname; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done").await;
    assert_eq!(code, 0);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], "1073741824", "{out}");
    assert_eq!(lines[1], "200000 100000", "{out}");
    assert_eq!(lines[2], "0", "{out}");
    assert_eq!(lines[3], "t");
    assert_eq!(lines[4], format!("wsp-live-665-build-{}", checkout_key()));
    assert!(out.contains("exec sleep infinity"), "the boot command runs: {out}");
    assert!(out.contains("/sbin/wsp-init runtime init"), "the init runs first: {out}");
    // The same key again answers the workspace that exists, replayed.
    let again =
        w.ok("machine.create", json!({ "spec": spec(json!({ "idempotencyKey": format!("live-665-build-{}", checkout_key()) })) })).await;
    assert_eq!(again["machine"]["id"], id);
    assert_eq!(again["machine"]["replayed"], true);
    assert_eq!(
        again["machine"]["roads"],
        json!({ "previewUrl": true, "daemonAnswers": true, "putBytes": true, "describe": true, "facts": false, "metrics": true })
    );
    let got = w.ok("machine.get", json!({ "machineId": id })).await;
    assert_eq!(got["machine"]["labels"], json!({ "wsp": "1", "wsp-owner": live_owner() }));
    assert_eq!(got["machine"]["seen"]["state"], "running");
    assert_eq!(got["machine"]["daemonSupervisor"], "entrypoint");
    w.close().await;
}

#[tokio::test]
async fn holds_a_machines_size_to_what_the_box_has() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let capacity = w.ok("machine.capacity", json!({})).await;
    let id = w.create(spec(json!({ "cpu": 512, "memMb": 9_000_000 }))).await;
    let shape = w.ok("machine.describe", json!({ "machineId": id })).await["shape"].clone();
    assert_eq!(shape["cpu"].as_f64(), capacity["cores"].as_f64());
    assert_eq!(shape["memMb"], capacity["machineMemMb"]);
    let (_, out, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.max").await;
    assert_eq!(out.trim(), (capacity["machineMemMb"].as_u64().unwrap() * 1024 * 1024).to_string());
    w.close().await;
}

#[tokio::test]
async fn answers_exec_with_stdout_stderr_and_the_exit_code() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, out, err) = w.exec(&id, "echo out; echo err >&2; echo $HOME $USER; exit 7").await;
    assert_eq!((code, out.as_str(), err.as_str()), (7, "out\n/root root\n", "err\n"));
    let started = Instant::now();
    let rounds = 20;
    for _ in 0..rounds {
        w.exec(&id, "true").await;
    }
    eprintln!("exec round trip: {} ms", started.elapsed().as_millis() / rounds);
    let (code, _, _) = w.exec(&id, "sleep 5").await;
    assert_eq!(code, 0);
    let cut = w.ok("machine.exec", json!({ "machineId": id, "cmd": "sleep 30; echo late", "timeoutMs": 300 })).await;
    assert_eq!(cut["result"]["exitCode"], 124);
    assert_eq!(cut["result"]["stdout"], "");
    w.close().await;
}

#[tokio::test]
async fn pauses_and_resumes_with_the_freezer() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    // The label that says the workspace must keep what its processes hold: a pause freezes it instead of stopping it.
    let id = w.create(spec(json!({ "memMb": 512, "labels": { "wsp-owner": live_owner(), "wsp.idle": "freeze" } }))).await;
    w.ok("machine.pause", json!({ "machineId": id })).await;
    let events = fs::read_to_string(Path::new(CGROUPS).join(&id).join("cgroup.events")).unwrap();
    let state_file = fs::read_to_string(root().join("state").join(&id).join("state.json")).unwrap();
    assert_eq!(w.state(&id).await, "paused", "events: {events} state.json: {state_file}");
    assert!(events.contains("frozen 1"), "{events}");
    let held = fs::read_to_string(Path::new(CGROUPS).join(&id).join("memory.current")).unwrap();
    eprintln!("frozen workspace memory.current: {} bytes", held.trim());
    let capacity = w.ok("machine.capacity", json!({})).await;
    assert_eq!(capacity["machines"]["paused"], 1);
    let listed = w.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
    let row = listed["machines"].as_array().unwrap().iter().find(|m| m["id"] == id).unwrap();
    assert_eq!(row["state"], "paused");
    w.ok("machine.resume", json!({ "machineId": id })).await;
    assert_eq!(w.state(&id).await, "running");
    let events = fs::read_to_string(Path::new(CGROUPS).join(&id).join("cgroup.events")).unwrap();
    assert!(events.contains("frozen 0"), "{events}");
    let (code, out, _) = w.exec(&id, "echo awake").await;
    assert_eq!((code, out.as_str()), (0, "awake\n"));
    w.close().await;
}

#[tokio::test]
async fn kills_by_the_id_it_was_given_and_maps_every_state() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    assert_eq!(w.state(&id).await, "running");
    w.ok("machine.pause", json!({ "machineId": id })).await;
    assert_eq!(w.state(&id).await, "paused");
    w.ok("machine.resume", json!({ "machineId": id })).await;
    // A workspace that was stopped and booted again runs its init as before; one that is killed is missing.
    let (_, out, _) = w.exec(&id, "cat /proc/1/cmdline | tr '\\0' ' '").await;
    assert!(out.contains("wsp-init"), "{out}");
    w.ok("machine.kill", json!({ "machineId": id })).await;
    let gone = w.ask("machine.state", json!({ "machineId": id })).await;
    assert_eq!((gone["ok"].as_bool(), gone["kind"].as_str(), gone["status"].as_u64()), (Some(false), Some("missing"), Some(404)));
    assert!(!Path::new(CGROUPS).join(&id).exists());
    assert!(!root().join("run").join(&id).exists());
    assert!(!root().join("state").join(&id).exists());
    w.made.clear();
    let lost = w.ask("machine.get", json!({ "machineId": "wsp-nobody" })).await;
    assert_eq!(lost, json!({ "id": 1, "ok": false, "error": "no such workspace: wsp-nobody", "kind": "missing", "status": 404 }));
    w.close().await;
}

#[tokio::test]
async fn lists_by_our_labels_and_answers_the_size_the_listing_carries() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({ "cpu": 2, "memMb": 1024, "labels": { "wsp-owner": live_owner(), "row": "yes" } }))).await;
    let other = w.create(spec(json!({ "labels": { "wsp-owner": live_owner(), "row": "no" } }))).await;
    let rows = w.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner(), "row": "yes" } })).await;
    assert_eq!(
        rows["machines"],
        json!([{ "id": id, "state": "running", "labels": { "wsp": "1", "wsp-owner": live_owner(), "row": "yes" }, "size": { "cpu": 2.0, "memMb": 1024 } }])
    );
    let all = w.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
    assert_eq!(all["machines"].as_array().unwrap().len(), 2);
    assert!(all["machines"].as_array().unwrap().iter().any(|m| m["id"] == other && m.get("size").is_none()));
    w.close().await;
}

#[tokio::test]
async fn puts_bytes_where_they_belong_and_serves_no_signed_url() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let half = bytes.len() / 2;
    let b64 = |part: &[u8]| base64_of(part);
    w.ok("machine.putBytes", json!({ "machineId": id, "path": "/root/wsp daemon/bundle.tgz", "uploadId": "u665", "seq": 0, "last": false, "data": b64(&bytes[..half]) })).await;
    w.ok("machine.putBytes", json!({ "machineId": id, "path": "/root/wsp daemon/bundle.tgz", "uploadId": "u665", "seq": 1, "last": true, "data": b64(&bytes[half..]) })).await;
    let (code, out, _) = w.exec(&id, "sha256sum '/root/wsp daemon/bundle.tgz'; stat -c %s '/root/wsp daemon/bundle.tgz'").await;
    assert_eq!(code, 0);
    assert!(out.starts_with(&sha256_hex(&bytes)), "{out}");
    assert!(out.trim().ends_with("300000"));
    assert!(!root().join("put").join("u665").exists());
    let wrong = w
        .ask("machine.putBytes", json!({ "machineId": id, "path": "/root/x", "uploadId": "u666", "seq": 3, "last": true, "data": "AAAA" }))
        .await;
    assert!(wrong["error"].as_str().unwrap().contains("out of order"));
    let down = w.ask("machine.downloadUrl", json!({ "machineId": id, "path": "/root/x" })).await;
    assert!(down["error"].as_str().unwrap().contains("no signed download URL"), "{down}");
    let up = w.ask("machine.uploadUrl", json!({ "machineId": id, "path": "/root/x" })).await;
    assert!(up["error"].as_str().unwrap().contains("no signed upload URL"), "{up}");
    w.close().await;
}

#[tokio::test]
async fn asks_the_guest_itself_whether_the_daemon_is_listening_and_says_it_is_the_entrypoint() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    assert_eq!(w.ok("machine.daemonAnswers", json!({ "machineId": id, "timeoutMs": 5000 })).await["answers"], false);
    // A listener on the guest's own loopback: the base image carries perl, and nothing else that listens.
    let (code, _, err) = w.exec(&id, "nohup perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => \"127.0.0.1\", LocalPort => 7070, Listen => 5, ReuseAddr => 1) or die $!; sleep 60' > /dev/null 2> /tmp/listen.err & sleep 0.5; cat /tmp/listen.err").await;
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(w.ok("machine.daemonAnswers", json!({ "machineId": id, "timeoutMs": 5000 })).await["answers"], true);
    let got = w.ok("machine.get", json!({ "machineId": id })).await;
    assert_eq!(got["machine"]["daemonSupervisor"], "entrypoint");
    let facts = w.ask("machine.facts", json!({ "machineId": id })).await;
    assert_eq!(facts["error"], "this computer's backend has no facts");
    w.ok("machine.metrics", json!({ "machineId": id })).await;
    w.close().await;
}

#[tokio::test]
async fn describes_the_workspace_from_its_record() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({ "cpu": 1, "memMb": 768 }))).await;
    let shape = w.ok("machine.describe", json!({ "machineId": id })).await["shape"].clone();
    assert_eq!((shape["cpu"].as_f64(), shape["memMb"].as_u64()), (Some(1.0), Some(768)));
    let created = shape["createdAt"].as_str().unwrap();
    assert!(created.ends_with('Z') && created.contains('T'), "{created}");
    w.close().await;
}

#[tokio::test]
async fn a_memory_cap_holds_seven_hundred_megabytes_touched_under_five_hundred_twelve_exit_137() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({ "memMb": 512 }))).await;
    let (code, _, _) = w.exec(&id, "perl -e '$x = \"x\" x (700 * 1024 * 1024); print length($x)'").await;
    assert_eq!(code, 137);
    assert_eq!(w.state(&id).await, "running", "the hog is the kill, never the workspace's init");
    let (_, peak, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events").await;
    eprintln!("after the cap: {peak}");
    assert!(peak.contains("oom_kill 1"), "{peak}");
    let (code, out, _) = w.exec(&id, "echo alive").await;
    assert_eq!((code, out.as_str()), (0, "alive\n"));
    w.close().await;
}

#[tokio::test]
async fn a_world_dropped_without_its_close_leaves_nothing_on_the_box() {
    if !live() {
        return;
    }
    let id = {
        let mut w = World::open().await;
        let id = w.create(spec(json!({}))).await;
        assert!(Path::new(CGROUPS).join(&id).exists());
        id
    };
    assert!(!Path::new(CGROUPS).join(&id).exists(), "cgroup of {id} stays after the drop");
    assert!(!root().join("run").join(&id).exists());
    assert!(!fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!("/run/{id}/rootfs")));
}

/// The init's pid is only the init while the process behind it is the one the record named: after the init died
/// with no daemon there to delete it, the kernel hands that pid to whatever comes next.
#[tokio::test]
async fn a_pid_the_kernel_reused_after_the_init_died_is_not_the_workspace() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let record: Value = serde_json::from_str(&fs::read_to_string(root().join("run").join(&id).join("workspace.json")).unwrap()).unwrap();
    let pid = record["init"]["pid"].as_i64().unwrap();
    assert!(std::process::Command::new("kill").args(["-9", &pid.to_string()]).status().unwrap().success());
    let gone_by = Instant::now() + std::time::Duration::from_secs(10);
    while Path::new(&format!("/proc/{pid}")).exists() {
        assert!(Instant::now() < gone_by, "init {pid} still there");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(w.state(&id).await, "paused", "a dead init is a stopped workspace, and stopped reads paused");
    // Now a process of this test's own lands on the dead init's pid, through the kernel's next-pid knob.
    let mut landed = None;
    for _ in 0..300 {
        fs::write("/proc/sys/kernel/ns_last_pid", (pid - 1).to_string()).unwrap();
        let child = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        if i64::from(child.id()) == pid {
            landed = Some(child);
            break;
        }
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
    }
    let mut squatter = landed.expect("a process of ours on the old pid");
    let own_cgroup = fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
    // The daemon that never restarted reads the record's init, not whatever the pid names now.
    assert_eq!(w.state(&id).await, "paused", "a live process on the old pid is not the workspace");
    let paused = w.ask("machine.pause", json!({ "machineId": id })).await;
    assert_eq!(paused["ok"], false, "{paused}");
    assert!(paused["error"].as_str().unwrap().contains("is already paused"), "{paused}");
    let metrics = w.ask("machine.metrics", json!({ "machineId": id })).await;
    assert_eq!(metrics["ok"], false, "{metrics}");
    assert!(metrics["error"].as_str().unwrap().contains("is stopped"), "{metrics}");
    // A fresh open of the same root finds the workspace stopped by the same reading, takes its mount and youki's
    // state, and says which.
    let again = Ops::open(&root(), PathBuf::from(env!("CARGO_BIN_EXE_wsp-daemon"))).unwrap();
    assert!(again.stopped_at_open().contains(&id), "{:?}", again.stopped_at_open());
    assert!(!root().join("state").join(&id).exists());
    drop(again);
    w.ok("machine.kill", json!({ "machineId": id })).await;
    w.made.clear();
    // Our process is untouched: alive, in its own cgroup, not frozen.
    assert!(squatter.try_wait().unwrap().is_none(), "the kill took the process on the reused pid");
    assert_eq!(fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap(), own_cgroup);
    let own_events = Path::new("/sys/fs/cgroup").join(own_cgroup.trim().trim_start_matches("0::/")).join("cgroup.events");
    assert!(fs::read_to_string(&own_events).map(|e| e.contains("frozen 0")).unwrap_or(true), "{}", own_events.display());
    let _ = squatter.kill();
    let _ = squatter.wait();
    assert!(!root().join("run").join(&id).exists());
    assert!(!Path::new(CGROUPS).join(&id).exists(), "cgroup of {id} stays");
    w.close().await;
}

#[tokio::test]
async fn the_backend_and_the_self_check_answer_on_this_box() {
    if !live() {
        return;
    }
    let w = World::open().await;
    assert_eq!(w.ok("machine.checkKey", json!({})).await, json!({ "id": 1, "ok": true }));
    let facts = w.ok("machine.backend", json!({})).await;
    assert_eq!(facts["offer"], "runtime");
    assert_eq!(facts["capabilities"]["pauseMode"], "disk");
    assert_eq!(facts["baseTemplates"]["sandbox"], "ubuntu:24.04");
    let capacity = w.ok("machine.capacity", json!({})).await;
    assert!(capacity["cores"].as_u64().unwrap() >= 1);
    assert!(capacity["diskFreeBytes"].as_u64().unwrap() > 0);
    assert!(capacity["images"].as_array().unwrap().iter().any(|i| i["name"] == "ubuntu:24.04"));
    w.close().await;
}

#[tokio::test]
async fn answers_the_daemon_road_at_the_published_port_on_the_boxs_loopback() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    w.listen_inside(&id).await;
    let started = Instant::now();
    let port = w.publish(&id, 7070).await;
    eprintln!("publish: {} ms", started.elapsed().as_millis());
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    assert_eq!(w.publish(&id, 7070).await, port, "the same port every time");
    assert_eq!(w.network(&id).forwards, [(7070, port)].into());
    let got = w.ok("machine.get", json!({ "machineId": id })).await;
    assert_eq!(got["machine"]["roads"]["previewUrl"], true);
    // A port nothing inside listens on is published all the same: the dial inside is refused, so the connection on
    // the box closes without a byte.
    let idle = w.publish(&id, 7071).await;
    assert_ne!(idle, port);
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, idle)).await.unwrap(), "");
    w.close().await;
}

#[tokio::test]
async fn the_address_a_turn_inside_dials_the_box_at_resolves_and_connects() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let network = w.network(&id);
    let (_, hosts, _) = w.exec(&id, "getent hosts host.wsp.internal; cat /etc/resolv.conf").await;
    assert!(hosts.starts_with(&format!("{} ", network.gateway)), "{hosts}");
    assert!(hosts.contains("host.wsp.internal\n"), "{hosts}");
    assert!(!hosts.contains("nameserver 127."), "the box's stub is not handed in: {hosts}");
    let on_gateway = TcpListener::bind(SocketAddrV4::new(network.gateway, 0)).unwrap();
    let port = on_gateway.local_addr().unwrap().port();
    let heard = std::thread::spawn(move || accept_line(&on_gateway));
    let (code, _, err) = w.exec(&id, &format!("exec 3<>/dev/tcp/host.wsp.internal/{port} && echo hi from $(hostname) >&3")).await;
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(heard.join().unwrap().unwrap(), format!("hi from {id}"));
    // The box's other addresses stay behind its firewall: the same listener on every address is not reached there.
    let everywhere = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    let other = everywhere.local_addr().unwrap().port();
    let (code, _, _) = w.exec(&id, &format!("timeout 3 bash -c 'exec 3<>/dev/tcp/{}/{other}'", box_address())).await;
    assert_ne!(code, 0, "the box's address {} answered a workspace", box_address());
    w.close().await;
}

#[tokio::test]
async fn outbound_reaches_a_registry_the_tests_own_and_then_the_real_one() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let network = w.network(&id);
    let registry = TcpListener::bind(SocketAddrV4::new(network.gateway, 0)).unwrap();
    let port = registry.local_addr().unwrap().port();
    let challenge = format!(
        "HTTP/1.1 401 Unauthorized\r\nWww-Authenticate: Bearer realm=\"http://host.wsp.internal:{port}/token\",service=\"wsp\"\r\nContent-Length: 0\r\n\r\n"
    );
    let asked = std::thread::spawn(move || answer_once(&registry, &challenge));
    let get = |host: &str, port: u16| {
        format!("exec 3<>/dev/tcp/{host}/{port} && printf 'GET /v2/ HTTP/1.0\\r\\nHost: {host}\\r\\n\\r\\n' >&3 && head -c 400 <&3 | tr -d '\\r'")
    };
    let (code, out, err) = w.exec(&id, &get("host.wsp.internal", port)).await;
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    assert!(out.starts_with("HTTP/1.1 401 Unauthorized\n"), "{out}");
    assert!(out.contains("Www-Authenticate: Bearer realm="), "{out}");
    assert_eq!(asked.join().unwrap().unwrap(), "GET /v2/ HTTP/1.0");
    // The real one, once: Docker Hub over plain http answers a redirect to its https door, and that answer coming
    // back is the round trip through the resolvers handed in and the NAT.
    let (code, out, err) = w.exec(&id, &format!("getent hosts registry-1.docker.io | head -1; {}", get("registry-1.docker.io", 80))).await;
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    let mut lines = out.lines();
    assert!(lines.next().unwrap().contains("registry-1.docker.io"), "{out}");
    assert!(lines.next().unwrap().starts_with("HTTP/1.1 301"), "{out}");
    w.close().await;
}

#[tokio::test]
async fn two_workspaces_cannot_reach_each_other() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let a = w.create(spec(json!({ "idempotencyKey": format!("live-665-apart-a-{}", checkout_key()) }))).await;
    let b = w.create(spec(json!({ "idempotencyKey": format!("live-665-apart-b-{}", checkout_key()) }))).await;
    let address_a = w.listen_inside(&a).await;
    let address_b = w.network(&b).address;
    assert_ne!(address_a, address_b);
    assert_ne!(w.network(&a).link, w.network(&b).link);
    // b reaches its own box, so a silence toward a is the rule and not a dead network.
    let (code, _, _) =
        w.exec(&b, "exec 3<>/dev/tcp/host.wsp.internal/22 && read -t 5 banner <&3 && case $banner in SSH-*) exit 0;; esac; exit 9").await;
    assert_eq!(code, 0);
    let (code, out, err) = w.exec(&b, &format!("timeout 3 bash -c 'exec 3<>/dev/tcp/{address_a}/7070 && head -1 <&3'")).await;
    assert_ne!(code, 0, "workspace b reached a: {out}{err}");
    assert_eq!(out, "");
    w.close().await;
}

#[tokio::test]
async fn delete_leaves_no_interface_no_rule_and_no_listener() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    w.listen_inside(&id).await;
    let port = w.publish(&id, 7070).await;
    let network = w.network(&id);
    assert!(Path::new("/sys/class/net").join(&network.link).exists());
    assert!(net::rules_present().unwrap());
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    w.ok("machine.kill", json!({ "machineId": id })).await;
    w.made.clear();
    assert!(!Path::new("/sys/class/net").join(&network.link).exists(), "{} stays", network.link);
    assert!(!Route::open().unwrap().links().unwrap().iter().any(|l| l.name.starts_with("wsp-")), "a workspace link stays");
    assert!(!net::rules_present().unwrap(), "the rules stay after the last workspace");
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap_err().kind(), std::io::ErrorKind::ConnectionRefused);
    assert!(!root().join("run").join(&id).exists());
    w.close().await;
}

#[tokio::test]
async fn a_daemon_restart_keeps_a_running_workspaces_network_and_its_forward() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    w.listen_inside(&id).await;
    let port = w.publish(&id, 7070).await;
    let network = w.network(&id);
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    w.reopen().await;
    assert_eq!(w.state(&id).await, "running");
    assert_eq!(w.network(&id), network, "the record is untouched");
    assert!(Path::new("/sys/class/net").join(&network.link).exists(), "the sweep took a running workspace's link");
    assert!(net::rules_present().unwrap());
    assert_eq!(
        read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(),
        "hello from inside",
        "the forward is back on its port"
    );
    assert_eq!(w.publish(&id, 7070).await, port);
    let (code, _, _) = w.exec(&id, "exec 3<>/dev/tcp/host.wsp.internal/22").await;
    assert_eq!(code, 0);
    w.close().await;
}

#[tokio::test]
async fn the_sweep_at_start_takes_the_network_of_a_workspace_that_is_gone() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let port = w.publish(&id, 7070).await;
    let network = w.network(&id);
    // A pair the daemon made and lost before its workspace came up, its alias naming a workspace dir under this root.
    let mut route = Route::open().unwrap();
    route.add_veth("wsp-9000", "wspx-peer", None).unwrap();
    let orphan = route.index_of("wsp-9000").unwrap();
    route.set_alias(orphan, &root().join("run").join("wsp-nobody").display().to_string()).unwrap();
    // The workspace's init killed behind the daemon's back: its namespace and its pair go with it, its record stays.
    let state: Value = serde_json::from_slice(&fs::read(root().join("state").join(&id).join("state.json")).unwrap()).unwrap();
    let init = state["pid"].as_i64().unwrap();
    assert!(std::process::Command::new("kill").args(["-9", &init.to_string()]).status().unwrap().success());
    wait_until(|| !Path::new("/sys/class/net").join(&network.link).exists(), Duration::from_secs(5));
    w.reopen().await;
    assert_eq!(w.ops.net_swept_at_open(), &net::Swept { links: vec!["wsp-9000".into()], rules: true });
    assert!(!Path::new("/sys/class/net/wsp-9000").exists() && !Path::new("/sys/class/net/wspx-peer").exists());
    assert!(!net::rules_present().unwrap(), "the rules stay with no workspace running");
    assert_eq!(
        read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap_err().kind(),
        std::io::ErrorKind::ConnectionRefused,
        "a dead workspace's forward came back"
    );
    assert_eq!(w.state(&id).await, "paused");
    w.close().await;
}

/// The metadata service every cloud answers its instance's own facts at.
const METADATA: Ipv4Addr = Ipv4Addr::new(169, 254, 169, 254);
/// A plain GET from inside with bash alone: the status line comes back, or nothing inside three seconds.
fn get_from_inside(host: &str, port: u16, path: &str) -> String {
    format!("timeout 3 bash -c 'exec 3<>/dev/tcp/{host}/{port} && printf \"GET {path} HTTP/1.0\\r\\nHost: {host}\\r\\n\\r\\n\" >&3 && head -1 <&3'")
}

/// The init's pid of a workspace, off youki's state file, which is where its network namespace is reached.
fn init_pid(id: &str) -> i32 {
    let state: Value = serde_json::from_slice(&fs::read(root().join("state").join(id).join("state.json")).unwrap()).unwrap();
    state["pid"].as_i64().unwrap() as i32
}

/// A firewall shaped like firewalld's: an inet table whose input and forward chains carry policy accept and end in
/// `reject with icmpx admin-prohibited`, with one accept before it sparing everything that is not a workspace's, so
/// the box stays reachable while the test runs. Goes when dropped.
struct LabFirewall;

const LAB_FIREWALL: &str = "wsplabfw";

impl LabFirewall {
    fn build() -> LabFirewall {
        let chain = |name, hook| nft::BaseChain {
            family: nft::NFPROTO_INET,
            table: LAB_FIREWALL,
            name,
            kind: "filter",
            hook,
            priority: 10,
            policy: nft::NF_ACCEPT,
        };
        let mut msgs = vec![
            nft::new_table(nft::NFPROTO_INET, LAB_FIREWALL),
            nft::new_chain(&chain("filter_INPUT", nft::NF_INET_LOCAL_IN)),
            nft::new_chain(&chain("filter_FORWARD", nft::NF_INET_FORWARD)),
        ];
        for name in ["filter_INPUT", "filter_FORWARD"] {
            let mut spare: Vec<nft::Expr> = nft::iifname_not_starts(net::LINK_PREFIX).into();
            spare.push(nft::verdict(nft::NF_ACCEPT));
            msgs.push(nft::new_rule(nft::NFPROTO_INET, LAB_FIREWALL, name, &spare, "lab: not a workspace's", false));
            msgs.push(nft::new_rule(nft::NFPROTO_INET, LAB_FIREWALL, name, &[nft::reject()], "lab: the final reject", false));
        }
        nft::Conn::open().unwrap().batch(&msgs, "building the lab firewall").unwrap();
        LabFirewall
    }

    /// The comments of the chain's rules, head first.
    fn comments(&self, chain: &str) -> Vec<String> {
        nft::Conn::open()
            .unwrap()
            .rules(nft::NFPROTO_INET, LAB_FIREWALL, chain)
            .unwrap()
            .into_iter()
            .map(|r| r.comment.unwrap_or_default())
            .collect()
    }
}

impl Drop for LabFirewall {
    fn drop(&mut self) {
        let _ =
            nft::Conn::open().and_then(|mut c| c.batch(&[nft::del_table(nft::NFPROTO_INET, LAB_FIREWALL)], "removing the lab firewall"));
    }
}

#[tokio::test]
async fn a_workspace_cannot_reach_the_boxs_cloud_metadata() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let box_reaches = TcpStream::connect_timeout(&SocketAddrV4::new(METADATA, 80).into(), Duration::from_secs(2)).is_ok();
    eprintln!("the box itself reaches {METADATA}:80: {box_reaches}");
    let (code, out, err) = w.exec(&id, &get_from_inside(&METADATA.to_string(), 80, "/hetzner/v1/metadata/hostname")).await;
    assert_ne!(code, 0, "the metadata service answered a workspace: {out}{err}");
    assert_eq!(out, "");
    w.close().await;
}

#[tokio::test]
async fn a_workspace_forwards_through_the_default_route_alone() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let a = w.create(spec(json!({}))).await;
    let b = w.create(spec(json!({}))).await;
    // A second road into b, its box end named outside the workspace prefix, as a LAN or a tunnel interface is.
    let ns = fs::File::open(format!("/proc/{}/ns/net", init_pid(&b))).unwrap();
    let mut route = Route::open().unwrap();
    route.add_veth("wsplab0", "lab0", Some(ns.as_raw_fd())).unwrap();
    let lab = route.index_of("wsplab0").unwrap();
    route.add_address(lab, Ipv4Addr::new(192, 0, 2, 1), 24).unwrap();
    route.set_up(lab).unwrap();
    net::inside(ns, |r| {
        let lab0 = r.index_of("lab0")?;
        r.add_address(lab0, Ipv4Addr::new(192, 0, 2, 2), 24)?;
        r.set_up(lab0)
    })
    .unwrap();
    w.listen_inside(&b).await;
    let behind_lab = SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 2), 7070);
    assert_eq!(read_line(behind_lab).await.unwrap(), "hello from inside", "the box reaches b down the lab road");
    let (code, out, err) =
        w.exec(&a, &format!("timeout 3 bash -c 'exec 3<>/dev/tcp/{}/{} && head -1 <&3'", behind_lab.ip(), behind_lab.port())).await;
    assert_ne!(code, 0, "workspace a reached the lab road: {out}{err}");
    assert_eq!(out, "");
    let (code, out, _) = w.exec(&a, &get_from_inside("registry-1.docker.io", 80, "/v2/")).await;
    assert_eq!(code, 0, "the world through the default route stays open: {out}");
    assert!(out.starts_with("HTTP/1.1 301"), "{out}");
    assert_eq!(fs::read_to_string(format!("/proc/sys/net/ipv4/conf/{}/forwarding", w.network(&a).link)).unwrap().trim(), "1");
    route.delete_named("wsplab0").unwrap();
    w.close().await;
}

#[tokio::test]
async fn a_firewall_that_ends_its_chains_in_a_reject_gets_the_accepts_at_its_head() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let lab = LabFirewall::build();
    let id = w.create(spec(json!({}))).await;
    let forward = lab.comments("filter_FORWARD");
    let input = lab.comments("filter_INPUT");
    assert_eq!(&forward[..2], [net::RULE_COMMENT, net::RULE_COMMENT], "{forward:?}");
    assert_eq!(forward[2..], ["lab: not a workspace's", "lab: the final reject"], "{forward:?}");
    assert_eq!(input, [net::RULE_COMMENT, "lab: not a workspace's", "lab: the final reject"], "{input:?}");
    let (code, out, err) = w.exec(&id, &get_from_inside("registry-1.docker.io", 80, "/v2/")).await;
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    assert!(out.starts_with("HTTP/1.1 301"), "{out}");
    let (code, _, _) =
        w.exec(&id, "exec 3<>/dev/tcp/host.wsp.internal/22 && read -t 5 banner <&3 && case $banner in SSH-*) exit 0;; esac; exit 9").await;
    assert_eq!(code, 0);
    w.close().await;
    assert_eq!(
        lab.comments("filter_FORWARD"),
        ["lab: not a workspace's", "lab: the final reject"],
        "the accepts go with the last workspace"
    );
    assert_eq!(lab.comments("filter_INPUT"), ["lab: not a workspace's", "lab: the final reject"]);
    drop(lab);
    assert!(!nft::Conn::open().unwrap().tables().unwrap().contains(&(nft::NFPROTO_INET, LAB_FIREWALL.to_owned())));
}

#[tokio::test]
async fn a_link_alias_longer_than_the_kernel_takes_is_refused_by_name() {
    if !live() {
        return;
    }
    let mut route = Route::open().unwrap();
    let lo = route.index_of("lo").unwrap();
    let refused = route.set_alias(lo, &"a".repeat(300)).unwrap_err();
    assert!(refused.to_string().ends_with("is 300 bytes, and a link alias holds 255"), "{refused}");
}

/// What a workspace does to its disk before it is committed: a file of its own, a file of the image's deleted, a
/// directory of the image's emptied and refilled, which overlayfs marks opaque, and a hard link whose first name is
/// as long as a package tree's.
const CHANGE_THE_DISK: &str = "echo taken > /root/marker && rm /usr/bin/passwd && rm -rf /home && mkdir /home && touch /home/only && d=/opt/.pnpm/$(printf 'a%.0s' $(seq 60))/node_modules/$(printf 'b%.0s' $(seq 60)) && mkdir -p $d && echo linked > $d/index.js && ln $d/index.js /opt/linked.js";
/// What a fork of that reads back: the marker, no passwd, and /home holding only what the upper put there.
const READ_THE_DISK: &str = "cat /root/marker; test -e /usr/bin/passwd && echo passwd-stays || echo passwd-gone; ls /home";

#[tokio::test]
async fn commits_a_snapshot_under_the_name_and_answers_the_id() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, _, err) = w.exec(&id, CHANGE_THE_DISK).await;
    assert_eq!((code, err.as_str()), (0, ""));
    let started = Instant::now();
    let snapshot_id = w.snapshot(&id, "v1", true).await;
    eprintln!("snapshot: {} ms", started.elapsed().as_millis());
    let digest = Digest::parse(&snapshot_id).unwrap_or_else(|e| panic!("{snapshot_id}: {e}"));
    assert_eq!(w.state(&id).await, "running", "the workspace runs on after the commit");
    let store = Store::open(&root()).unwrap();
    let record = store.snapshot(&digest).unwrap().expect("the store holds the snapshot");
    assert_eq!(record.name, format!("{}-v1", live_owner()));
    assert_eq!(record.workspace, id);
    assert_eq!(record.chain.layers.last(), Some(&record.layer), "the saved layer tops the chain");
    assert!(store.has_blob(&record.layer), "the layer's blob is in the store");
    let unpacked = store.unpacked(&record.layer).expect("the layer is unpacked beside its blob");
    // The whiteouts as the store reads them: a character device for the deleted file, the opaque mark on /home.
    let passwd = fs::symlink_metadata(unpacked.join("usr/bin/passwd")).unwrap();
    assert!(passwd.file_type().is_char_device() && passwd.rdev() == 0, "the deleted file is a whiteout in the layer");
    assert_eq!(xattr::get(unpacked.join("home"), "trusted.overlay.opaque").unwrap().as_deref(), Some(&b"y"[..]));
    assert_eq!(fs::read_to_string(unpacked.join("root/marker")).unwrap(), "taken\n");
    // The hard link's long first name and its second name are one inode in the layer, as they were in the upper.
    let first = unpacked.join("opt/.pnpm").join("a".repeat(60)).join("node_modules").join("b".repeat(60)).join("index.js");
    assert_eq!(fs::metadata(&first).unwrap().ino(), fs::metadata(unpacked.join("opt/linked.js")).unwrap().ino(), "{}", first.display());
    let row = w.snapshot_row(&snapshot_id).await;
    assert_eq!(row["name"], format!("{}-v1", live_owner()));
    assert_eq!(row["sizeBytes"].as_u64(), Some(record.layer_bytes));
    assert_eq!(row["parent"], Value::Null, "a snapshot off an image is a root");
    assert!(row["createdAt"].as_str().unwrap().ends_with('Z'));
    w.ok("machine.deleteSnapshot", json!({ "snapshotId": snapshot_id })).await;
    w.close().await;
}

#[tokio::test]
async fn boots_a_fork_from_a_snapshot_and_the_whiteout_of_a_deleted_file_holds() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, _, _) = w.exec(&id, CHANGE_THE_DISK).await;
    assert_eq!(code, 0);
    let snapshot_id = w.snapshot(&id, "v1", true).await;
    let started = Instant::now();
    let fork = w.create(spec(json!({ "fromSnapshot": snapshot_id, "template": Value::Null }))).await;
    eprintln!("fork from a snapshot to ready: {} ms", started.elapsed().as_millis());
    assert_ne!(fork, id);
    let (code, out, err) = w.exec(&fork, READ_THE_DISK).await;
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    assert_eq!(out, "taken\npasswd-gone\nonly\n", "the marker is there, the deleted file stays deleted, /home holds the upper's alone");
    // The original is untouched by the fork's life.
    let (_, out, _) = w.exec(&fork, "echo fork > /root/marker").await;
    assert_eq!(out, "");
    let (_, out, _) = w.exec(&id, "cat /root/marker").await;
    assert_eq!(out, "taken\n");
    // A snapshot of the fork is chained under the first, and its bytes are its own.
    let second = w.snapshot(&fork, "v2", true).await;
    let row = w.snapshot_row(&second).await;
    assert_eq!(row["parent"], snapshot_id, "the fork's snapshot names the one it booted from");
    w.ok("machine.deleteSnapshot", json!({ "snapshotId": second })).await;
    w.ok("machine.deleteSnapshot", json!({ "snapshotId": snapshot_id })).await;
    w.close().await;
}

#[tokio::test]
async fn a_commit_after_a_thaw_takes_the_life_it_is_handed() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({ "labels": { "wsp-owner": live_owner(), "wsp.idle": "freeze" } }))).await;
    w.ok("machine.pause", json!({ "machineId": id })).await;
    assert!(fs::read_to_string(Path::new(CGROUPS).join(&id).join("cgroup.events")).unwrap().contains("frozen 1"));
    w.ok("machine.resume", json!({ "machineId": id })).await;
    assert!(fs::read_to_string(Path::new(CGROUPS).join(&id).join("cgroup.events")).unwrap().contains("frozen 0"));
    let (code, _, _) = w.exec(&id, "echo second life > /root/after-thaw").await;
    assert_eq!(code, 0);
    // The runtime hands a thawed workspace firstLife false; the disk is the same copy, so the commit takes it.
    let snapshot_id = w.snapshot(&id, "thawed", false).await;
    assert!(Digest::parse(&snapshot_id).is_ok(), "{snapshot_id}");
    assert_eq!(w.state(&id).await, "running");
    let fork = w.create(spec(json!({ "fromSnapshot": snapshot_id, "template": Value::Null }))).await;
    let (_, out, _) = w.exec(&fork, "cat /root/after-thaw").await;
    assert_eq!(out, "second life\n");
    w.ok("machine.deleteSnapshot", json!({ "snapshotId": snapshot_id })).await;
    w.close().await;
}

#[tokio::test]
async fn promotes_by_naming_the_chain() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, _, _) = w.exec(&id, CHANGE_THE_DISK).await;
    assert_eq!(code, 0);
    let snapshot_id = w.snapshot(&id, "v1", true).await;
    let name = format!("{}-dev", live_owner());
    let promoted = w.ok("machine.promoteSnapshot", json!({ "snapshotId": snapshot_id, "name": name })).await;
    let template_id = promoted["templateId"].as_str().unwrap().to_owned();
    assert_eq!(template_id, format!("wsp/{name}:template"));
    let got = w.ok("machine.getTemplate", json!({ "templateId": template_id })).await;
    assert_eq!(got["template"]["id"], template_id);
    assert_eq!(got["template"]["name"], name);
    assert_eq!(got["template"]["status"], "ready");
    assert!(got["template"]["createdAt"].as_str().unwrap().ends_with('Z'));
    let listed = w.ok("machine.listTemplates", json!({})).await;
    assert!(listed["templates"].as_array().unwrap().iter().any(|t| t["id"] == template_id), "{listed}");
    let store = Store::open(&root()).unwrap();
    let template = store.template(&template_id).unwrap().expect("the store holds the template");
    let snapshot = store.snapshot(&Digest::parse(&snapshot_id).unwrap()).unwrap().unwrap();
    assert_eq!(template.chain, snapshot.chain, "a template is the snapshot's chain under a name");
    // A fork boots from the template as from an image, and outlives the snapshot and the template it came from.
    let fork = w.create(spec(json!({ "template": template_id }))).await;
    let (_, out, _) = w.exec(&fork, READ_THE_DISK).await;
    assert_eq!(out, "taken\npasswd-gone\nonly\n");
    w.ok("machine.deleteSnapshot", json!({ "snapshotId": snapshot_id })).await;
    assert!(store.has_blob(&snapshot.layer), "the template still names the layer");
    w.ok("machine.deleteTemplate", json!({ "templateId": template_id })).await;
    let lost = w.ask("machine.getTemplate", json!({ "templateId": template_id })).await;
    assert_eq!((lost["kind"].as_str(), lost["status"].as_u64()), (Some("missing"), Some(404)), "{lost}");
    assert!(store.has_blob(&snapshot.layer), "the fork still holds the layer");
    let (_, out, _) = w.exec(&fork, "cat /root/marker").await;
    assert_eq!(out, "taken\n");
    w.close().await;
}

#[tokio::test]
async fn lists_snapshots_with_their_own_bytes() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, _, _) = w.exec(&id, "head -c 1048576 /dev/urandom > /root/big").await;
    assert_eq!(code, 0);
    let big = w.snapshot(&id, "big", true).await;
    let fork = w.create(spec(json!({ "fromSnapshot": big, "template": Value::Null }))).await;
    let (code, _, _) = w.exec(&fork, "echo small > /root/small").await;
    assert_eq!(code, 0);
    let small = w.snapshot(&fork, "small", true).await;
    let big_row = w.snapshot_row(&big).await;
    let small_row = w.snapshot_row(&small).await;
    let (big_bytes, small_bytes) = (big_row["sizeBytes"].as_u64().unwrap(), small_row["sizeBytes"].as_u64().unwrap());
    eprintln!("snapshot bytes: big {big_bytes}, small {small_bytes}");
    assert!(big_bytes > 1_000_000, "a megabyte of noise does not fold: {big_bytes}");
    assert!(small_bytes < 10_000, "the fork's snapshot carries its own change alone: {small_bytes}");
    assert_eq!(small_row["parent"], big);
    let rows = w.ok("machine.listSnapshots", json!({})).await;
    let names: Vec<&str> = rows["snapshots"].as_array().unwrap().iter().filter_map(|r| r["name"].as_str()).collect();
    let mine: Vec<&&str> = names.iter().filter(|n| n.starts_with(&live_owner())).collect();
    assert_eq!(mine.len(), 2, "{names:?}");
    w.ok("machine.deleteSnapshot", json!({ "snapshotId": small })).await;
    w.ok("machine.deleteSnapshot", json!({ "snapshotId": big })).await;
    w.close().await;
}

#[tokio::test]
async fn delete_drops_the_reference_and_the_sweep_removes_the_layer() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, _, _) = w.exec(&id, "echo taken > /root/marker").await;
    assert_eq!(code, 0);
    let snapshot_id = w.snapshot(&id, "v1", true).await;
    let store = Store::open(&root()).unwrap();
    let layer = store.snapshot(&Digest::parse(&snapshot_id).unwrap()).unwrap().unwrap().layer;
    assert_eq!(store.references(&layer).unwrap(), 1);
    let fork = w.create(spec(json!({ "fromSnapshot": snapshot_id, "template": Value::Null }))).await;
    let du_before = fs::metadata(root().join("layers/blobs/sha256").join(layer.hex())).unwrap().len();
    // The delete drops the snapshot's reference; the fork's record still holds the chain, so the layer stays.
    w.ok("machine.deleteSnapshot", json!({ "snapshotId": snapshot_id })).await;
    assert_eq!(store.references(&layer).unwrap(), 0, "no record names the layer");
    assert!(store.has_blob(&layer) && store.unpacked(&layer).is_some(), "a fork still mounts the layer");
    let (_, out, _) = w.exec(&fork, "cat /root/marker").await;
    assert_eq!(out, "taken\n");
    let again = w.ask("machine.deleteSnapshot", json!({ "snapshotId": snapshot_id })).await;
    assert_eq!((again["kind"].as_str(), again["status"].as_u64()), (Some("missing"), Some(404)), "{again}");
    // With the fork gone nothing holds the layer, and the next sweep, at the daemon's start, takes it.
    w.ok("machine.kill", json!({ "machineId": fork })).await;
    w.made.retain(|m| m != &fork);
    assert!(store.has_blob(&layer), "the kill itself sweeps nothing");
    w.reopen().await;
    let swept = w.ops.swept_at_open();
    assert!(swept.blobs.contains(&layer), "{swept:?}");
    assert!(swept.unpacked.contains(&layer), "{swept:?}");
    assert!(swept.bytes >= du_before, "{} bytes swept, the blob was {du_before}", swept.bytes);
    assert!(!store.has_blob(&layer) && store.unpacked(&layer).is_none());
    w.close().await;
}

/// A fork's create resolves its snapshot, then mounts the chain and writes the record that makes the sweep keep
/// it; a delete of that snapshot in flight at the same time must not take the layer between the two. The two
/// frames run on this one runtime together, the create polled first: the delete gets the store the moment the
/// create lets go of it, which is after the record is on disk, so its sweep finds the layer held.
#[tokio::test]
async fn a_sweep_in_flight_beside_a_fork_takes_nothing_the_fork_mounts() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let (code, _, _) = w.exec(&id, "echo taken > /root/marker").await;
    assert_eq!(code, 0);
    let snapshot_id = w.snapshot(&id, "raced", true).await;
    let store = Store::open(&root()).unwrap();
    let layer = store.snapshot(&Digest::parse(&snapshot_id).unwrap()).unwrap().unwrap().layer;
    let fork_spec = spec(json!({ "fromSnapshot": snapshot_id, "template": Value::Null }));
    let (created, deleted) = tokio::join!(
        w.ask("machine.create", json!({ "spec": fork_spec })),
        w.ask("machine.deleteSnapshot", json!({ "snapshotId": snapshot_id })),
    );
    assert_eq!(created["ok"], true, "{created}");
    let fork = created["machine"]["id"].as_str().unwrap().to_owned();
    w.made.push(fork.clone());
    assert_eq!(deleted["ok"], true, "{deleted}");
    assert!(store.snapshot(&Digest::parse(&snapshot_id).unwrap()).unwrap().is_none(), "the snapshot's record went");
    assert!(store.has_blob(&layer) && store.unpacked(&layer).is_some(), "the fork's record holds the layer through the sweep");
    let (code, out, err) = w.exec(&fork, "cat /root/marker").await;
    assert_eq!((code, out.as_str()), (0, "taken\n"), "the fork mounts the layer whole: {err}");
    w.close().await;
}

/// youki reads any process on the init's pid as the container, and a state file that does not read is a workspace
/// this daemon can neither nap nor wake: it reads gone, not a nap the resume would refuse, and the kill still takes
/// it whole, since a workspace that cannot be killed would stay on the box for good.
#[tokio::test]
async fn a_live_init_whose_state_does_not_read_is_gone_not_a_nap_and_still_dies() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    let init = init_pid(&id);
    let state = root().join("state").join(&id).join("state.json");
    fs::write(&state, b"{ not youki's").unwrap();
    assert_eq!(w.state(&id).await, "gone");
    let listed = w.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
    assert!(listed["machines"].as_array().unwrap().iter().any(|m| m["id"] == id && m["state"] == "gone"), "{listed}");
    w.ok("machine.kill", json!({ "machineId": id })).await;
    w.made.clear();
    assert!(!Path::new(&format!("/proc/{init}")).exists(), "the init is gone");
    assert!(!Path::new(CGROUPS).join(&id).exists(), "the cgroup is gone");
    assert!(!root().join("state").join(&id).exists(), "youki's state is gone");
    assert!(!root().join("run").join(&id).exists(), "the run directory is gone");
    w.close().await;
}

#[tokio::test]
async fn pause_then_resume_boots_the_saved_layer_with_the_same_address_and_forward_under_200_ms() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({ "memMb": 512 }))).await;
    // A second workspace beside it, to be stopped and woken first: its block is then not the lowest free one.
    let other = w.create(spec(json!({}))).await;
    let other_address = w.network(&other).address;
    let address = w.listen_inside(&id).await;
    assert_ne!(other_address, address);
    let port = w.publish(&id, 7070).await;
    let network = w.network(&id);
    let (code, _, _) = w.exec(&id, "echo kept > /root/saved").await;
    assert_eq!(code, 0);
    let record: Value = serde_json::from_str(&fs::read_to_string(root().join("run").join(&id).join("workspace.json")).unwrap()).unwrap();
    let init = record["init"]["pid"].as_i64().unwrap();
    let room_before = w.ok("machine.capacity", json!({})).await["memRoomMb"].as_u64().unwrap();

    w.ok("machine.pause", json!({ "machineId": id })).await;
    assert_eq!(w.state(&id).await, "paused");
    // Stopped, not frozen: no process, no cgroup, no link, no listener, no mount; the upper and the records stay.
    assert!(!Path::new(&format!("/proc/{init}")).exists(), "the init is gone");
    assert!(!Path::new(CGROUPS).join(&id).exists(), "the cgroup is gone");
    assert!(!Path::new("/sys/class/net").join(&network.link).exists(), "the link is gone");
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap_err().kind(), std::io::ErrorKind::ConnectionRefused);
    assert!(!fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!("/run/{id}/rootfs")), "the overlay is detached");
    assert!(root().join("run").join(&id).join("upper/root/saved").is_file(), "the upper directory is the saved layer");
    assert_eq!(w.network(&id).forwards, network.forwards, "the network record keeps the forwards");
    let capacity = w.ok("machine.capacity", json!({})).await;
    assert_eq!(capacity["machines"]["paused"], 1);
    assert_eq!(capacity["memRoomMb"].as_u64().unwrap(), room_before + 512, "a stopped workspace holds no memory");
    let stopped = w.ask("machine.exec", json!({ "machineId": id, "cmd": "true" })).await;
    assert!(stopped["error"].as_str().unwrap().contains("is stopped"), "{stopped}");
    let twice = w.ask("machine.pause", json!({ "machineId": id })).await;
    assert!(twice["error"].as_str().unwrap().contains("is already paused"), "{twice}");
    let listed = w.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
    assert!(listed["machines"].as_array().unwrap().iter().any(|m| m["id"] == id && m["state"] == "paused"), "{listed}");
    // The second workspace, stopped and woken while the first's block is the lowest free one, gets its own back.
    w.ok("machine.pause", json!({ "machineId": other })).await;
    w.ok("machine.resume", json!({ "machineId": other })).await;
    assert_eq!(w.network(&other).address, other_address, "the second workspace keeps its own block");
    let (_, out, _) = w.exec(&other, "hostname -I").await;
    assert_eq!(out.trim(), other_address.to_string());

    let started = Instant::now();
    w.ok("machine.resume", json!({ "machineId": id })).await;
    let wake = started.elapsed();
    eprintln!("wake from the saved layer: {} ms", wake.as_millis());
    assert_eq!(w.state(&id).await, "running");
    assert!(wake < Duration::from_millis(200), "the wake took {} ms", wake.as_millis());
    let woken = w.network(&id);
    assert_eq!((woken.address, woken.link, woken.gateway), (address, network.link.clone(), network.gateway), "the same address");
    assert_eq!(woken.forwards, network.forwards, "the same forward");
    let (code, out, _) = w.exec(&id, "cat /root/saved; hostname").await;
    assert_eq!((code, out.as_str()), (0, format!("kept\n{id}\n").as_str()));
    // The processes are gone with the stop, so the listener inside is started again; the box port is the same one.
    assert_eq!(w.listen_inside(&id).await, address);
    assert_eq!(read_line(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await.unwrap(), "hello from inside");
    assert_eq!(w.publish(&id, 7070).await, port);
    let (_, out, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.max").await;
    assert_eq!(out.trim(), "536870912", "the cap comes back with the boot");
    // A second nap and wake, since the first is not special.
    w.ok("machine.pause", json!({ "machineId": id })).await;
    assert_eq!(w.state(&id).await, "paused");
    let started = Instant::now();
    w.ok("machine.resume", json!({ "machineId": id })).await;
    eprintln!("second wake: {} ms", started.elapsed().as_millis());
    assert_eq!(w.state(&id).await, "running");
    assert_eq!(w.network(&id).address, address);
    w.close().await;
}

/// The image build's own road over the seam, which is the road `wsp image build <place>` drives on a joined
/// computer: a workspace forked from the base runs the recipe as execs, the vault's sign-ins land on it, a
/// snapshot commits the result as a layer under a name, a template names its chain, and a fork from that image
/// runs the recipe's tool and reads the vault. The vault is inside the built layer and nowhere in the store's
/// metadata: the records name digests and times, never a secret's bytes.
#[tokio::test]
async fn an_image_built_by_running_a_recipe_holds_the_vault_in_its_layer_and_not_in_the_stores_metadata() {
    if !live() {
        return;
    }
    const TOKEN: &str = "SIGN-IN-TOKEN-665e-secret";
    let mut w = World::open().await;
    // The builder from the base chain, as prepareBuilder forks one.
    let builder = w.create(spec(json!({}))).await;
    // The recipe as execs: a tool the image carries, and the vault handed in the way the image build hands it
    // today, a file written inside the workspace, not an env on the record.
    let (code, _, err) = w
        .exec(
            &builder,
            "install -D -m 0755 /dev/stdin /usr/local/bin/recipe-tool <<'TOOL'\n#!/bin/sh\necho recipe-tool-ran\nTOOL\nmkdir -p /root/.wsp && printf %s 'SIGN-IN-TOKEN-665e-secret' > /root/.wsp/vault",
        )
        .await;
    assert_eq!((code, err.as_str()), (0, ""), "the recipe steps run");
    // The seal: commit the upper directory as a layer under a name, then name its chain a template a fork boots
    // from, as sealGolden snapshots and promoteSnapshot names.
    let snapshot_id = w.snapshot(&builder, "built", true).await;
    let promoted = w.ok("machine.promoteSnapshot", json!({ "snapshotId": snapshot_id, "name": format!("{}-image", live_owner()) })).await;
    let template_id = promoted["templateId"].as_str().unwrap().to_owned();
    // A fork from the built image runs the recipe's tool and reads the vault, as a workspace made from a copy does.
    let fork = w.create(spec(json!({ "template": template_id }))).await;
    let (code, out, _) = w.exec(&fork, "recipe-tool; cat /root/.wsp/vault").await;
    assert_eq!((code, out.as_str()), (0, &format!("recipe-tool-ran\n{TOKEN}")[..]), "the fork runs the tool and holds the vault");
    // The vault's bytes are in the layer, which the fork just read, and in none of the store's metadata records.
    for dir in ["snapshots", "templates", "images"] {
        let at = root().join("layers").join(dir);
        if let Ok(entries) = fs::read_dir(&at) {
            for entry in entries {
                let path = entry.unwrap().path();
                if path.extension().is_some_and(|e| e == "json") {
                    let text = fs::read_to_string(&path).unwrap();
                    assert!(!text.contains(TOKEN), "the store's {dir} record {} holds the vault: {text}", path.display());
                }
            }
        }
    }
    w.ok("machine.deleteTemplate", json!({ "templateId": template_id })).await;
    w.ask("machine.deleteSnapshot", json!({ "snapshotId": snapshot_id })).await;
    w.close().await;
}

/// One line read off a fresh connection to the address, inside two seconds, off the runtime thread: the forwards
/// under test are tasks of this very runtime and need it free to answer.
async fn read_line(addr: SocketAddrV4) -> std::io::Result<String> {
    tokio::task::spawn_blocking(move || {
        let stream = TcpStream::connect_timeout(&addr.into(), Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line)?;
        Ok(line.trim_end().to_owned())
    })
    .await
    .unwrap()
}

/// One connection accepted and its first line read, inside ten seconds.
fn accept_line(listener: &TcpListener) -> std::io::Result<String> {
    listener.set_nonblocking(false)?;
    let (stream, _) = listener.accept()?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    Ok(line.trim_end().to_owned())
}

/// One connection answered with the response once the request's headers have all arrived; answers the request's
/// first line. bash writes a request line by line, so a read that stops at the first segment and a close with the
/// rest unread would answer with a reset.
fn answer_once(listener: &TcpListener, response: &str) -> std::io::Result<String> {
    let (mut stream, _) = listener.accept()?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut request = Vec::new();
    let mut buf = [0u8; 1024];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        request.extend_from_slice(&buf[..n]);
    }
    let first = String::from_utf8_lossy(&request).lines().next().unwrap_or_default().to_owned();
    stream.write_all(response.as_bytes())?;
    Ok(first)
}

/// The address the box talks to the world from, off a UDP socket's own view; nothing is sent.
fn box_address() -> Ipv4Addr {
    let socket = UdpSocket::bind("0.0.0.0:0").unwrap();
    socket.connect("1.1.1.1:53").unwrap();
    match socket.local_addr().unwrap().ip() {
        std::net::IpAddr::V4(v4) => v4,
        other => panic!("{other} is no IPv4 address"),
    }
}

fn wait_until(done: impl Fn() -> bool, patience: Duration) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < patience, "not done in {} s", patience.as_secs());
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn base64_of(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let mut n = [0u8; 3];
        n[..chunk.len()].copy_from_slice(chunk);
        let v = (u32::from(n[0]) << 16) | (u32::from(n[1]) << 8) | u32::from(n[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((v >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = wsp_runtime::fetch::Digest::of(bytes);
    digest.hex().to_owned()
}
