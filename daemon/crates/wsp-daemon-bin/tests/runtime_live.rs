// SPDX-License-Identifier: AGPL-3.0-only
//! The machine ops against the kernel, through this binary as the helper and the init: root, cgroup v2 and a
//! registry, so gated WSP_RUNTIME_LIVE=1. The root is one directory under /tmp per checkout, so the base image is
//! pulled once per checkout; every workspace a case makes is killed at its end, and its mount and its cgroup are
//! checked gone. Nothing here touches a workspace it did not make. The cases are the Docker backend's, the fake
//! engine replaced by the kernel.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde_json::{json, Value};
use wsp_frames::RequestId;
use wsp_runtime::ops::Ops;

const CGROUPS: &str = "/sys/fs/cgroup/wsp";

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

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
    _turn: std::sync::MutexGuard<'static, ()>,
}

impl World {
    /// Opens the ops on the fixed root and kills whatever an earlier case left under the live label.
    async fn open() -> World {
        let turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        // The binary under test, or the one WSP_RUNTIME_BIN names, so the release build's numbers can be read here.
        let bin = std::env::var("WSP_RUNTIME_BIN").map_or_else(|_| PathBuf::from(env!("CARGO_BIN_EXE_wsp-daemon")), PathBuf::from);
        let ops = Ops::open(&root(), bin).unwrap();
        let world = World { ops, made: Vec::new(), _turn: turn };
        let rows = world.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
        for row in rows["machines"].as_array().unwrap() {
            world.ask("machine.kill", json!({ "machineId": row["id"] })).await;
        }
        world
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
        json!({ "previewUrl": false, "daemonAnswers": true, "putBytes": true, "describe": true, "facts": false, "metrics": true })
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
    let id = w.create(spec(json!({ "memMb": 512 }))).await;
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
    // A workspace whose init died is gone: a stopped container reads gone until a saved layer can boot it again.
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
    assert_eq!(w.state(&id).await, "gone");
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
    assert_eq!(w.state(&id).await, "gone", "a live process on the old pid is not the workspace");
    let paused = w.ask("machine.pause", json!({ "machineId": id })).await;
    assert_eq!(paused["ok"], false, "{paused}");
    assert!(paused["error"].as_str().unwrap().contains("has no process"), "{paused}");
    let metrics = w.ask("machine.metrics", json!({ "machineId": id })).await;
    assert_eq!(metrics["ok"], false, "{metrics}");
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
