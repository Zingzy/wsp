// SPDX-License-Identifier: AGPL-3.0-only
//! The machine ops against the kernel, through this binary as the helper and the init: root and cgroup v2, so
//! gated WSP_RUNTIME_LIVE=1. The root is one directory under /tmp per checkout; every workspace a case makes is
//! killed at its end, and its mount and its cgroup are checked gone. Nothing here touches a workspace it did not
//! make. The cases are the Docker backend's, the fake engine replaced by the kernel, then the network's: the box
//! reaches a workspace at a published port, a workspace reaches its box, a registry and nothing of its
//! neighbours; then this computer's own: a workspace made of the box's directories, the project it was given as
//! a copy, and the pause that stops it and the wake that boots it over what it wrote.
#![cfg(target_os = "linux")]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{Mutex, MutexGuard};
use wsp_frames::RequestId;
use wsp_runtime::net::{self, Network, Route};
use wsp_runtime::nft;
use wsp_runtime::ops::Ops;

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
    /// Opens the ops on the fixed root and kills whatever an earlier case left under the live label, every one
    /// of them named after this checkout.
    async fn open() -> World {
        let turn = ONE_AT_A_TIME.lock().await;
        let ops = Ops::open(&root(), bin()).unwrap();
        let world = World { ops, made: Vec::new(), _turn: turn };
        world.ops.restore().await.unwrap();
        let rows = world.ok("machine.list", json!({ "labels": { "wsp-owner": live_owner() } })).await;
        for row in rows["machines"].as_array().unwrap() {
            world.ask("machine.kill", json!({ "machineId": row["id"] })).await;
        }
        world
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
        self.created(spec).await["id"].as_str().unwrap().to_owned()
    }

    /// The whole handle the create answered with, for the cases that read what it says beside the id.
    async fn created(&mut self, spec: Value) -> Value {
        let reply = self.ok("machine.create", json!({ "spec": spec })).await;
        let machine = reply["machine"].clone();
        self.made.push(machine["id"].as_str().unwrap().to_owned());
        machine
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

/// The spec every case here creates from: no image name at all, since this computer keeps none and a workspace
/// is made of the computer's own directories.
fn spec(extra: Value) -> Value {
    let mut spec = json!({ "kind": "sandbox", "labels": { "wsp-owner": live_owner() } });
    for (k, v) in extra.as_object().unwrap() {
        spec[k] = v.clone();
    }
    spec
}

#[tokio::test]
async fn builds_the_container_from_the_spec_limits_labels_envs_and_the_boot_command() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let started = Instant::now();
    // Two cores of a box that keeps one, so this reads the box rather than a number: a runner with two cores gives
    // one and the assertions below follow it.
    let cores = w.ok("machine.capacity", json!({})).await["cores"].as_f64().unwrap();
    let given_cpu = 2.0f64.min((cores - 1.0).max(1.0));
    let id = w.create(spec(json!({ "cpu": 2, "memMb": 1024, "envs": { "WSP_TOKEN": "t" }, "idempotencyKey": format!("live-665-build-{}", checkout_key()) }))).await;
    let ready = started.elapsed();
    eprintln!("create to ready: {} ms", ready.as_millis());
    assert_eq!(id, format!("wsp-live-665-build-{}", checkout_key()));
    assert_eq!(w.state(&id).await, "running");
    let (code, out, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.swap.max; echo $WSP_TOKEN; hostname; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done").await;
    assert_eq!(code, 0);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], "1073741824", "{out}");
    assert_eq!(lines[1], format!("{} 100000", (given_cpu * 100_000.0) as i64), "{out}");
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
    let cores = capacity["cores"].as_f64().unwrap();
    let made = w.created(spec(json!({ "cpu": 512, "memMb": 9_000_000 }))).await;
    let id = made["id"].as_str().unwrap().to_owned();
    // The box keeps a core and a gigabyte of its own, and the answer says what it gave instead.
    let shape = w.ok("machine.describe", json!({ "machineId": id })).await["shape"].clone();
    assert_eq!(shape["cpu"].as_f64(), Some((cores - 1.0).max(1.0)));
    assert_eq!(shape["memMb"], capacity["machineMemMb"]);
    let notice = made["notice"].as_str().unwrap_or_default().to_owned();
    assert!(notice.contains("cpu clamped to") && notice.contains("memory clamped to"), "{notice}");
    let (_, out, _) = w.exec(&id, "cat /sys/fs/cgroup/memory.max").await;
    assert_eq!(out.trim(), (capacity["machineMemMb"].as_u64().unwrap() * 1024 * 1024).to_string());
    // The room the doctor reads counts this fork at the size the box gave it, beside whatever else is here.
    let after = w.ok("machine.capacity", json!({})).await;
    let taken_cpu = after["cpuTaken"].as_f64().unwrap() - capacity["cpuTaken"].as_f64().unwrap();
    let taken_mem = after["memTakenMb"].as_u64().unwrap() - capacity["memTakenMb"].as_u64().unwrap();
    assert_eq!(taken_cpu, (cores - 1.0).max(1.0));
    assert_eq!(taken_mem, capacity["machineMemMb"].as_u64().unwrap());
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
async fn an_exec_runs_behind_the_workspaces_seccomp_filter_with_the_inits_capabilities() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    const FENCE_LINES: &str = "grep -E '^(Seccomp|Seccomp_filters|CapBnd|CapEff|CapPrm|CapInh|CapAmb):'";
    let (code, out, err) = w.exec(&id, &format!("{FENCE_LINES} /proc/1/status; echo --; {FENCE_LINES} /proc/$$/status")).await;
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    let (init, shell) = out.split_once("--\n").unwrap();
    eprintln!("the init's status:\n{init}the exec'd shell's status:\n{shell}");
    assert!(shell.contains("Seccomp:\t2\n"), "the exec'd shell runs unfenced: {shell}");
    assert!(shell.contains("Seccomp_filters:\t1\n"), "{shell}");
    assert!(!shell.contains("CapEff:\t000001ffffffffff\n"), "the exec'd shell kept the box's capabilities: {shell}");
    assert_eq!(shell, init, "an exec'd process runs as the init does");
    w.close().await;
}

#[tokio::test]
async fn an_exec_against_a_filter_with_a_notify_action_is_refused_and_the_workspace_still_answers() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    // The bundle's config.json is what every exec reads its filter from; a rule with the notify action is added to
    // it while the workspace runs, and the original is put back before the next exec.
    let config = root().join("run").join(&id).join("config.json");
    let kept = fs::read_to_string(&config).unwrap();
    let mut bundle: Value = serde_json::from_str(&kept).unwrap();
    bundle["linux"]["seccomp"]["syscalls"].as_array_mut().unwrap().push(json!({ "names": ["getcwd"], "action": "SCMP_ACT_NOTIFY" }));
    fs::write(&config, bundle.to_string()).unwrap();
    let refused = w.ask("machine.exec", json!({ "machineId": id, "cmd": "echo unfenced", "timeoutMs": 10_000 })).await;
    fs::write(&config, &kept).unwrap();
    assert_eq!(
        refused,
        json!({ "id": 1, "ok": false, "error": "runtime exec: the workspace's seccomp filter has a rule whose action is notify, and an exec serves no listener for it, so the command did not run" })
    );
    let (code, out, _) = w.exec(&id, "echo fenced; grep Seccomp: /proc/$$/status").await;
    assert_eq!((code, out.as_str()), (0, "fenced\nSeccomp:\t2\n"));
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
async fn a_reading_of_a_workspace_is_what_its_cgroup_its_record_and_its_network_say() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let capacity = w.ok("machine.capacity", json!({})).await;
    let id = w.create(spec(json!({ "cpu": 1, "memMb": 1024 }))).await;
    // Something for the cgroup to have counted: a second of a core, and a process that stays.
    w.exec(&id, "nohup sleep 300 > /dev/null 2>&1 & timeout 1 sh -c 'while :; do :; done'; true").await;
    let reading = w.ok("machine.metrics", json!({ "machineId": id })).await["reading"].clone();
    assert_eq!(reading["state"], "running");
    // One core is under the clamp on any box that runs workspaces at all, which keeps one for itself.
    assert_eq!(reading["cpu"].as_f64(), Some(1.0));
    assert_eq!(reading["memMb"], 1024.min(capacity["machineMemMb"].as_u64().unwrap()));
    let mem = reading["memBytes"].as_u64().unwrap();
    assert!(mem > 0 && mem <= reading["memMb"].as_u64().unwrap() * 1024 * 1024, "{reading}");
    // The busy second is a second of processor time, give or take the scheduler.
    assert!(reading["cpuUsageUsec"].as_u64().unwrap() > 500_000, "{reading}");
    assert!(reading["uptimeMs"].as_u64().unwrap() > 0, "{reading}");
    // The init, the sleep, and whatever the shell left behind it.
    assert!(reading["procs"].as_u64().unwrap() >= 2, "{reading}");
    assert_eq!(reading["address"], w.network(&id).address.to_string());
    assert_eq!(reading["cgroup"], format!("{CGROUPS}/{id}"));
    assert_eq!(reading["upper"], root().join("run").join(&id).join("upper").to_string_lossy().as_ref());
    // A workspace that is stopped keeps its sizes and its paths and has no live figures to give.
    w.ok("machine.pause", json!({ "machineId": id })).await;
    let napping = w.ok("machine.metrics", json!({ "machineId": id })).await["reading"].clone();
    assert_eq!(napping["state"], "paused");
    assert_eq!(napping["memMb"], reading["memMb"]);
    assert_eq!(napping["cgroup"], reading["cgroup"]);
    for figure in ["memBytes", "cpuUsageUsec", "uptimeMs", "procs"] {
        assert!(napping.get(figure).is_none(), "{figure} in {napping}");
    }
    w.ok("machine.resume", json!({ "machineId": id })).await;
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
    // This computer keeps no image: no flag promises one and no kind names one to boot from.
    assert_eq!(facts["capabilities"]["images"], false);
    assert_eq!(facts["capabilities"]["diskSnapshots"], false);
    assert_eq!(facts["capabilities"]["templates"], false);
    assert!(facts.get("baseTemplates").is_none(), "{facts}");
    let capacity = w.ok("machine.capacity", json!({})).await;
    assert!(capacity["cores"].as_u64().unwrap() >= 1);
    assert!(capacity["diskFreeBytes"].as_u64().unwrap() > 0);
    assert_eq!(capacity["images"].as_array().unwrap().len(), 0);
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

/// The sha256 of what the byte road was handed, to read against what the file inside holds.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A file of the box's landed in the workspace through the byte road, in parts, and made executable.
async fn put_file(w: &World, id: &str, from: &Path, to: &str) {
    let bytes = fs::read(from).unwrap();
    let part_size = 4 * 1024 * 1024;
    let parts = bytes.chunks(part_size).collect::<Vec<_>>();
    let upload = format!("u{}", to.bytes().map(u64::from).sum::<u64>());
    for (seq, part) in parts.iter().enumerate() {
        w.ok(
            "machine.putBytes",
            json!({ "machineId": id, "path": to, "uploadId": upload, "seq": seq, "last": seq + 1 == parts.len(), "data": base64_of(part), "timeoutMs": 120_000 }),
        )
        .await;
    }
    let (code, _, err) = w.exec(id, &format!("chmod +x '{to}'")).await;
    assert_eq!((code, err.as_str()), (0, ""));
}

/// The box's own docker client and its compose plugin, where the box has them.
fn box_docker() -> Option<(PathBuf, PathBuf)> {
    let docker = ["/usr/bin/docker", "/usr/local/bin/docker"].into_iter().map(PathBuf::from).find(|p| p.exists())?;
    let compose = [
        "/usr/libexec/docker/cli-plugins/docker-compose",
        "/usr/lib/docker/cli-plugins/docker-compose",
        "/usr/local/lib/docker/cli-plugins/docker-compose",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.exists())?;
    Some((docker, compose))
}

/// The box's own docker client: the exit code, stdout and stderr, apart, since a pull's progress lands on stderr
/// around the one line stdout carries.
fn on_box(args: &[&str]) -> (i32, String, String) {
    let out = std::process::Command::new("docker").args(args).output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

/// The id `docker run -d` prints: the one line of stdout that is a 64 hex digit id, whatever else the run said.
fn container_id(stdout: &str) -> Option<String> {
    stdout.lines().map(str::trim).find(|l| l.len() == 64 && l.bytes().all(|b| b.is_ascii_hexdigit())).map(str::to_owned)
}

/// A container of the box's own, outside any workspace, removed when the case ends however it ends.
struct OutsideContainer {
    name: String,
}

impl Drop for OutsideContainer {
    fn drop(&mut self) {
        on_box(&["rm", "-f", &self.name]);
    }
}

#[test]
fn the_container_id_is_read_off_stdout_whatever_a_pull_printed_around_it() {
    let id = "08f2f4299c2a612c6f95ae0f5586eb975e67849e25e057837d309b451db61629";
    assert_eq!(container_id(&format!("{id}\n")), Some(id.to_owned()));
    assert_eq!(
        container_id(&format!("Unable to find image 'alpine:latest' locally\n{id}\nStatus: Downloaded newer image\n")),
        Some(id.to_owned())
    );
    assert_eq!(container_id("Status: Downloaded newer image for alpine:latest\n"), None);
    assert_eq!(container_id(""), None);
}

fn show(title: &str, code: i64, out: &str, err: &str) {
    eprintln!("== {title} (exit {code})\n{}{}", out, if err.is_empty() { String::new() } else { format!("[stderr] {err}") });
}

#[tokio::test]
async fn a_workspace_with_an_engine_runs_a_projects_compose_and_sees_its_own_containers_alone() {
    if !live() {
        return;
    }
    let Ok(_engine) = wsp_runtime::engine::socket_of(&wsp_runtime::doctor::read_facts()) else {
        eprintln!("this box has no container engine with a socket; the engine case is skipped");
        return;
    };
    let Some((docker, compose)) = box_docker() else {
        eprintln!("this box has no docker client with a compose plugin to land inside; the engine case is skipped");
        return;
    };
    let mut w = World::open().await;
    let key = checkout_key();
    // A container of the box's own, outside any workspace: the one the workspace must not see. Removed when the case
    // ends, a panic included.
    let outside = format!("wsp-live-outside-{key}");
    on_box(&["rm", "-f", &outside]);
    let _outside_guard = OutsideContainer { name: outside.clone() };
    let (code, started, said) = on_box(&["run", "-d", "--name", &outside, "alpine", "sleep", "600"]);
    assert_eq!(code, 0, "{started}{said}");
    if !said.is_empty() {
        eprintln!("== the box pulled the image first:\n{said}");
    }
    let outside_id = container_id(&started).unwrap_or_else(|| panic!("no container id on stdout: {started:?}"));
    let id = w.create(spec(json!({ "engine": true, "idempotencyKey": format!("live-665-engine-{key}") }))).await;
    put_file(&w, &id, &docker, "/usr/local/bin/docker").await;
    put_file(&w, &id, &compose, "/root/.docker/cli-plugins/docker-compose").await;
    let (code, out, err) = w.exec(&id, "ls -la /var/run/docker.sock /run/wsp; readlink -f /var/run/docker.sock").await;
    show("the socket inside the workspace made with --engine", code, &out, &err);
    assert_eq!(code, 0);
    let compose_file = "services:\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_PASSWORD: wsp\n  web:\n    image: nginx:alpine\n    ports:\n      - \"18080:80\"\n    volumes:\n      - ./html:/usr/share/nginx/html:ro\n    depends_on: [db]\n";
    let (code, _, err) = w
        .exec(
            &id,
            &format!(
                "mkdir -p /root/demo/html /root/.wsp && echo hello-from-workspace > /root/demo/html/index.html && printf '%s' '{compose_file}' > /root/demo/compose.yaml && echo /root/demo > /root/.wsp/roots && docker version --format 'client {{{{.Client.Version}}}} server {{{{.Server.Version}}}}'"
            ),
        )
        .await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    let started = Instant::now();
    let (code, out, err) = w.exec(&id, "cd /root/demo && docker compose -p wspdemo up -d 2>&1").await;
    show("docker compose up -d, from inside", code, &out, &err);
    eprintln!("compose up took {} ms", started.elapsed().as_millis());
    assert_eq!(code, 0);
    let (code, out, err) =
        w.exec(&id, "docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}'; echo; docker ps -a --format '{{.Names}}  {{.Status}}'").await;
    show("docker ps, then docker ps -a, from inside", code, &out, &err);
    assert_eq!(code, 0);
    assert!(out.contains("wspdemo-db-1") && out.contains("wspdemo-web-1"), "{out}");
    assert!(!out.contains(&outside), "the box's own container shows inside: {out}");
    let (_, on_the_box, _) = on_box(&["ps", "--format", "{{.Names}}  {{.Ports}}"]);
    eprintln!("== docker ps, on the box\n{on_the_box}");
    assert!(on_the_box.contains(&outside) && on_the_box.contains("wspdemo-web-1"), "{on_the_box}");
    assert!(on_the_box.contains("127.0.0.1:"), "the published port sits on the box's loopback: {on_the_box}");
    let (code, out, err) = w.exec(&id, "docker run --rm -v /:/host alpine ls /host 2>&1").await;
    show("docker run -v /:/host, from inside", code, &out, &err);
    assert_ne!(code, 0);
    assert!(out.contains("a bind mount's source must sit under a project folder of this workspace (/root/demo), and / does not"), "{out}");
    let (code, out, err) =
        w.exec(&id, "exec 3<>/dev/tcp/127.0.0.1/18080; printf 'GET / HTTP/1.0\\r\\nHost: x\\r\\n\\r\\n' >&3; timeout 5 cat <&3").await;
    show("GET 127.0.0.1:18080 from inside (the published port)", code, &out, &err);
    assert!(out.contains("hello-from-workspace"), "{out}");
    let (code, out, err) = w
        .exec(&id, &format!("docker inspect --type container --format '{{{{.Name}}}}' {outside_id} 2>&1; docker stop {outside} 2>&1"))
        .await;
    show("the box's own container, named from inside", code, &out, &err);
    assert!(out.contains(&format!("No such container: {outside_id}")), "{out}");
    let (_, still, _) = on_box(&["inspect", "--format", "{{.State.Status}}", &outside]);
    assert_eq!(still.trim(), "running", "the box's container was touched from inside");
    let (code, out, err) = w.exec(&id, "docker run -d --name wsp-live-left alpine sleep 600 2>&1").await;
    show("a container left running when the workspace goes", code, &out, &err);
    assert_eq!(code, 0);
    // Cost: one docker ps through the fence against one straight at the engine, from the box, twenty each. Off the
    // runtime thread, since the fence is served on it and the client waits on the fence.
    let socket = root().join("run").join(&id).join("engine").join("docker.sock");
    let time = |args: Vec<String>| {
        tokio::task::spawn_blocking(move || {
            let words: Vec<&str> = args.iter().map(String::as_str).collect();
            let started = Instant::now();
            for _ in 0..20 {
                assert_eq!(on_box(&words).0, 0, "{words:?}");
            }
            started.elapsed().as_millis() / 20
        })
    };
    let fenced = time(vec!["-H".into(), format!("unix://{}", socket.display()), "ps".into(), "-q".into()]).await.unwrap();
    let straight = time(vec!["ps".into(), "-q".into()]).await.unwrap();
    eprintln!("== cost: docker ps through the fence {fenced} ms, straight at the engine {straight} ms (mean of 20, from the box)");
    let status = fs::read_to_string("/proc/self/status").unwrap();
    eprintln!("== this process VmRSS with the proxy and forwards up: {}", status.lines().find(|l| l.starts_with("VmRSS")).unwrap_or(""));
    let (code, out, err) = w.exec(&id, "cd /root/demo && docker compose -p wspdemo down -v 2>&1").await;
    show("docker compose down -v, from inside", code, &out, &err);
    assert_eq!(code, 0);
    // A workspace made without the engine: no socket, and the client says so.
    let plain = w.create(spec(json!({ "idempotencyKey": format!("live-665-noengine-{key}") }))).await;
    put_file(&w, &plain, &docker, "/usr/local/bin/docker").await;
    let (code, out, err) = w.exec(&plain, "ls -la /var/run/docker.sock /run/wsp 2>&1; docker ps 2>&1").await;
    show("a workspace made without --engine: the socket and docker ps", code, &out, &err);
    assert_ne!(code, 0);
    assert!(out.contains("unix:///var/run/docker.sock") && out.contains("no such file or directory"), "{out}");
    assert!(!root().join("run").join(&plain).join("engine").exists());
    w.close().await;
    let (_, left, _) = on_box(&["ps", "-a", "--filter", &format!("label={}={id}", wsp_runtime::engine::LABEL), "--format", "{{.Names}}"]);
    let (_, networks, _) =
        on_box(&["network", "ls", "--filter", &format!("label={}={id}", wsp_runtime::engine::LABEL), "--format", "{{.Name}}"]);
    eprintln!("== after the kill, on the box: containers [{}] networks [{}]", left.trim(), networks.trim());
    assert_eq!((left.trim(), networks.trim()), ("", ""), "the killed workspace left containers on the engine");
    assert!(!socket.exists(), "the socket stays after the kill");
    let (_, outside_still, _) = on_box(&["inspect", "--format", "{{.State.Status}}", &outside]);
    assert_eq!(outside_still.trim(), "running", "the box's own container went with the workspace");
}

/// A checkout on the box, as a project a person keeps there: a file, a folder, a symlink, a mode and a pair of
/// hard links, which is what a package tree is made of.
fn checkout(at: &Path) {
    fs::create_dir_all(at.join("src")).unwrap();
    fs::write(at.join("README.md"), b"the checkout\n").unwrap();
    fs::write(at.join("src/index.js"), b"module.exports = 1\n").unwrap();
    fs::hard_link(at.join("src/index.js"), at.join("src/again.js")).unwrap();
    std::os::unix::fs::symlink("index.js", at.join("src/link.js")).unwrap();
    fs::set_permissions(at.join("README.md"), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
}

/// A workspace of this computer and nothing else: no image named, no project handed in. What it holds is what
/// the box holds, read through an overlay of its own; what the box keeps to itself is an empty directory inside.
#[tokio::test]
async fn a_workspace_is_the_computer_it_runs_on_with_a_wsp_folder_of_its_own() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let id = w.create(spec(json!({}))).await;
    // The box's own tools and the box's own /etc, through the overlays; the box's /root, through the bind. The
    // wsp folder under that home is the workspace's own, bound over the box's, so what the computer's own daemon
    // keeps there is not a name a workspace can read.
    let (code, out, err) = w
        .exec(
            &id,
            "command -v sh; command -v git || echo no-git-on-this-box; head -1 /etc/os-release; ls -A /root/.wsp; find /var/lib/docker /var/lib/containerd -mindepth 1 | wc -l",
        )
        .await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    eprintln!("== what a workspace of this computer reads: {out}");
    let inside: Vec<&str> = out.lines().collect();
    let on_the_box = fs::read_to_string("/etc/os-release").unwrap().lines().next().unwrap().to_owned();
    assert!(inside.contains(&on_the_box.as_str()), "the box's /etc/os-release did not come in: {out}");
    for name in fs::read_dir("/root/.wsp").into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()) {
        assert!(!inside.contains(&name.as_str()), "the daemon's own {name} is readable inside: {out}");
    }
    assert_eq!(inside.last(), Some(&"0"), "the engine's own folders are not empty inside: {out}");
    // What the box keeps out of a workspace: the daemon's own root, where every other workspace's copy lives,
    // and the box's own engine socket, since /run is the workspace's own directory and not the box's.
    let (code, out, _) = w.exec(&id, &format!("ls -A / | tr '\n' ' '; echo; test -e {} && echo root-inside || echo root-outside; test -e /run/docker.sock && echo socket-inside || echo socket-outside", root().display())).await;
    assert_eq!(code, 0);
    assert!(out.contains("root-outside") && out.contains("socket-outside"), "{out}");
    eprintln!("== what a workspace of this computer holds at its top level: {}", out.lines().next().unwrap_or(""));
    // /root is the person's own home on this computer, shared by every workspace on it: what the box holds there
    // is what a workspace reads, and what a workspace writes there the box has.
    let mark = format!("/root/.wsp-live-{}", checkout_key());
    let (code, _, err) = w.exec(&id, &format!("echo from-inside > {mark}")).await;
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(fs::read_to_string(&mark).unwrap(), "from-inside\n", "the box's /root is not the workspace's own");
    fs::remove_file(&mark).unwrap();
    // The daemon's own folder inside is the workspace's own, not the computer's: two workspaces each write a
    // token at the path the daemon reads by default, each reads its own back, and the computer's own token file
    // is the same bytes after as before. The box's names were read as invisible inside above, which is what
    // makes this write safe to make.
    let token = wsp_frames::numbers::DEFAULT_TOKEN_PATH;
    let box_token = fs::read(token).ok();
    let second = w.create(spec(json!({}))).await;
    for (workspace, word) in [(&id, "first"), (&second, "second")] {
        let (code, _, err) = w.exec(workspace, &format!("printf '%s' token-of-the-{word} > {token}")).await;
        assert_eq!((code, err.as_str()), (0, ""), "{err}");
    }
    for (workspace, word) in [(&id, "first"), (&second, "second")] {
        let (code, out, _) = w.exec(workspace, &format!("cat {token}")).await;
        assert_eq!((code, out.as_str()), (0, format!("token-of-the-{word}").as_str()), "a workspace read another's token");
        assert_eq!(
            fs::read(root().join("run").join(workspace).join("wsp-home/daemon-token")).unwrap(),
            format!("token-of-the-{word}").into_bytes()
        );
    }
    assert_eq!(fs::read(token).ok(), box_token, "a workspace's write reached the computer's own daemon token");
    // A package installed inside is the workspace's alone: the overlay's upper takes it and the box has nothing.
    let (code, out, err) =
        w.exec(&id, "mkdir -p /usr/local/lib/wsp-probe && echo mine > /usr/local/lib/wsp-probe/x && cat /usr/local/lib/wsp-probe/x").await;
    assert_eq!((code, out.as_str(), err.as_str()), (0, "mine\n", ""));
    assert!(!Path::new("/usr/local/lib/wsp-probe").exists(), "a workspace's write reached the box's /usr");
    assert!(root().join("run").join(&id).join("upper/usr/local/lib/wsp-probe/x").is_file(), "the write is not in the workspace's upper");
    // The mounts a workspace holds are under its rootfs and nowhere else, and the nap takes every one of them.
    let rootfs = format!("{}/run/{id}/rootfs", root().display());
    let under = |table: &str| table.lines().filter(|line| line.contains(&rootfs)).count();
    assert!(under(&fs::read_to_string("/proc/self/mountinfo").unwrap()) >= 9, "the overlays and the binds are not all there");
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    assert_eq!(under(&fs::read_to_string("/proc/self/mountinfo").unwrap()), 0, "the nap left a mount of the box's directories");
    // And the wake mounts the computer again over what the workspace wrote, its own wsp folder included.
    w.ok("machine.resume", json!({ "machineId": &id })).await;
    let (code, out, _) = w.exec(&id, &format!("cat /usr/local/lib/wsp-probe/x; cat {token}; head -1 /etc/os-release")).await;
    assert_eq!(code, 0);
    assert!(out.starts_with("mine\ntoken-of-the-first"), "{out}");
    w.close().await;
}

/// A create meant for a provider, sent here: one sentence, and nothing of a workspace left behind. The eight ops
/// a layer store answered are not ops at all any more, so the frame itself is refused and names itself.
#[tokio::test]
async fn a_create_that_names_an_image_is_refused_and_the_snapshot_ops_are_gone() {
    if !live() {
        return;
    }
    let w = World::open().await;
    let key = checkout_key();
    let refused = w
        .ask(
            "machine.create",
            json!({ "spec": spec(json!({ "template": "ubuntu:24.04", "idempotencyKey": format!("live-image-{key}") })) }),
        )
        .await;
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"], wsp_frames::words::NO_IMAGES_HERE, "{refused}");
    assert!(!root().join("run").join(format!("wsp-live-image-{key}")).exists(), "the refused create claimed a folder");
    for (op, fields) in [
        ("machine.snapshot", json!({ "machineId": "wsp-x", "name": "v1", "life": { "firstLife": true } })),
        ("machine.listSnapshots", json!({})),
        ("machine.listTemplates", json!({})),
        ("machine.promoteSnapshot", json!({ "snapshotId": "sha256:aa", "name": "v1" })),
    ] {
        let reply = w.ask(op, fields).await;
        assert_eq!(reply["ok"], false, "{op}: {reply}");
        assert!(reply["error"].as_str().unwrap().contains(op), "{op}: {reply}");
    }
}

#[tokio::test]
async fn a_workspace_made_with_a_project_holds_a_copy_of_the_checkout_at_its_own_path() {
    if !live() {
        return;
    }
    let mut w = World::open().await;
    let key = checkout_key();
    let from = root().join("projects").join(format!("live-copy-{key}"));
    let _ = fs::remove_dir_all(&from);
    checkout(&from);
    let at = "/Users/zingzy/wsp";
    let started = Instant::now();
    let made = w
        .created(spec(json!({
            "copy": { "from": from.display().to_string(), "at": at },
            "idempotencyKey": format!("live-copy-made-{key}"),
        })))
        .await;
    let id = made["id"].as_str().unwrap().to_owned();
    eprintln!("create with a copy to ready: {} ms", started.elapsed().as_millis());
    // The project is inside at the path it has on the computer, with the checkout's own bytes and its mode.
    let (code, out, err) = w.exec(&id, &format!("cat {at}/README.md; stat -c %a {at}/README.md; readlink {at}/src/link.js")).await;
    assert_eq!((code, err.as_str()), (0, ""), "{err}");
    assert_eq!(out.lines().collect::<Vec<_>>(), ["the checkout", "600", "index.js"], "{out}");
    // The two names of one file are one file in the copy too, which is what keeps a package tree's bytes down.
    let (code, out, _) = w.exec(&id, &format!("stat -c %i {at}/src/index.js {at}/src/again.js")).await;
    assert_eq!(code, 0);
    let inodes: Vec<&str> = out.lines().collect();
    assert_eq!(inodes.len(), 2);
    assert_eq!(inodes[0], inodes[1], "the hard linked pair became two files: {out}");
    // A write inside stays inside: the checkout on the box is not the workspace's to change.
    let (code, _, err) = w.exec(&id, &format!("echo written-inside >> {at}/README.md")).await;
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(fs::read_to_string(from.join("README.md")).unwrap(), "the checkout\n");
    // And the checkout moving on does not reach a copy already made.
    fs::write(from.join("README.md"), "moved\n").unwrap();
    let (_, out, _) = w.exec(&id, &format!("cat {at}/README.md")).await;
    assert_eq!(out, "the checkout\nwritten-inside\n", "{out}");
    // The record carries how the copy was made and how long it took, and the copy is under the root's own folder.
    let record: Value = serde_json::from_slice(&fs::read(root().join("run").join(&id).join("workspace.json")).unwrap()).unwrap();
    let copy = &record["copy"];
    eprintln!("== the copy as the record carries it: {copy}");
    assert_eq!((copy["from"].as_str(), copy["at"].as_str()), (Some(from.display().to_string().as_str()), Some(at)));
    assert!(["reflink", "snapshot", "plain"].contains(&copy["made"].as_str().unwrap()), "{copy}");
    assert!(copy["ms"].as_u64().is_some(), "{copy}");
    assert!(root().join("copies").join(&id).is_dir());
    // What a boot leaves at /run and /tmp is not what a nap keeps: the project's copy comes back with the line
    // the workspace wrote in it, and the pid file a process inside left at /run is gone, as it is on any boot.
    let (code, _, err) = w.exec(&id, "echo 4242 > /run/inside.pid; echo scratch > /tmp/inside.tmp").await;
    assert_eq!((code, err.as_str()), (0, ""));
    // A nap keeps the copy and the file the workspace wrote in it, and the wake binds it back at the same path.
    w.ok("machine.pause", json!({ "machineId": &id })).await;
    assert!(root().join("copies").join(&id).is_dir(), "the nap took the copy");
    assert!(!fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&format!("/run/{id}/rootfs")), "the nap left a mount");
    w.ok("machine.resume", json!({ "machineId": &id })).await;
    let (code, out, _) = w.exec(&id, &format!("cat {at}/README.md")).await;
    assert_eq!((code, out.as_str()), (0, "the checkout\nwritten-inside\n"));
    let (code, out, _) = w.exec(&id, "find /run /tmp -mindepth 1 | wc -l").await;
    assert_eq!((code, out.trim()), (0, "0"), "the wake carried the last boot's /run or /tmp");
    // The kill takes the copy with the workspace, and leaves the checkout on the box where it was.
    w.ok("machine.kill", json!({ "machineId": &id })).await;
    assert!(!root().join("copies").join(&id).exists(), "the copy stayed after the kill");
    assert!(from.join("README.md").exists(), "the kill took the checkout");
    let _ = fs::remove_dir_all(&from);
    w.close().await;
}

#[tokio::test]
async fn a_create_whose_project_is_not_there_is_refused_by_name_and_leaves_nothing() {
    if !live() {
        return;
    }
    let w = World::open().await;
    let key = checkout_key();
    let gone = root().join("projects").join(format!("live-copy-no-such-{key}"));
    let id = format!("wsp-live-copy-missing-{key}");
    let reply = w
        .ask(
            "machine.create",
            json!({ "spec": spec(json!({
                "copy": { "from": gone.display().to_string(), "at": "/Users/zingzy/wsp" },
                "idempotencyKey": format!("live-copy-missing-{key}"),
            })) }),
        )
        .await;
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(reply["error"].as_str().unwrap().contains(&gone.display().to_string()), "{reply}");
    // Nothing of a workspace that never came up: no run directory, no copy, no cgroup.
    assert!(!root().join("run").join(&id).exists() && !root().join("copies").join(&id).exists());
    assert!(!Path::new(CGROUPS).join(&id).exists());
}

/// A throwaway volume of its own filesystem, made as a file and mounted on a loop device, so a box whose root
/// shares no blocks can still be asked what it does when a disk shares them. Unmounted and removed when the case
/// ends, a panic included.
struct Volume {
    image: PathBuf,
    at: PathBuf,
}

impl Drop for Volume {
    fn drop(&mut self) {
        let _ = std::process::Command::new("umount").arg(&self.at).status();
        let _ = fs::remove_dir_all(&self.at);
        let _ = fs::remove_file(&self.image);
    }
}

/// `mkfs` run over a sparse file of `gb` gigabytes and mounted, or nothing where this box has no such mkfs.
fn volume(word: &str, mkfs: &[&str], gb: u64) -> Option<Volume> {
    let key = checkout_key();
    let volume = Volume {
        image: PathBuf::from(format!("/tmp/wsp-copy-{word}-{key}.img")),
        at: PathBuf::from(format!("/tmp/wsp-copy-{word}-{key}")),
    };
    let _ = std::process::Command::new("umount").arg(&volume.at).status();
    let _ = fs::remove_file(&volume.image);
    fs::create_dir_all(&volume.at).unwrap();
    let file = fs::File::create(&volume.image).unwrap();
    file.set_len(gb * 1024 * 1024 * 1024).unwrap();
    drop(file);
    let made = std::process::Command::new(mkfs[0]).args(&mkfs[1..]).arg(&volume.image).output();
    match made {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            eprintln!("this box will not make a {word}: {}", String::from_utf8_lossy(&out.stderr).trim());
            return None;
        }
        Err(e) => {
            eprintln!("this box has no {}: {e}", mkfs[0]);
            return None;
        }
    }
    let mounted = std::process::Command::new("mount").args(["-o", "loop"]).arg(&volume.image).arg(&volume.at).output().ok()?;
    if !mounted.status.success() {
        eprintln!("this box will not mount a {word} on a loop device: {}", String::from_utf8_lossy(&mounted.stderr).trim());
        return None;
    }
    Some(volume)
}

/// What the volume this path sits on holds right now.
fn used_bytes(at: &Path) -> u64 {
    let name = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(at.as_os_str())).unwrap();
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: the name is a nul-terminated path and the struct is the one the call fills.
    assert_eq!(unsafe { libc::statvfs(name.as_ptr(), &mut stat) }, 0, "{}", at.display());
    (stat.f_blocks - stat.f_bfree) * u64::from(stat.f_frsize as u32)
}

/// Whether this run is root, which the loop volumes and their mounts need.
fn root_here() -> bool {
    // SAFETY: geteuid reads this process and touches nothing.
    unsafe { libc::geteuid() == 0 }
}

/// A checkout of `mb` megabytes in files of a megabyte each, with the odds and ends a real one carries.
fn big_checkout(at: &Path, mb: u64) {
    fs::create_dir_all(at.join("node_modules")).unwrap();
    let megabyte = vec![7u8; 1024 * 1024];
    for i in 0..mb {
        fs::write(at.join("node_modules").join(format!("pkg-{i}.js")), &megabyte).unwrap();
    }
    fs::write(at.join("README.md"), b"the checkout\n").unwrap();
    fs::hard_link(at.join("node_modules/pkg-0.js"), at.join("node_modules/linked.js")).unwrap();
    std::os::unix::fs::symlink("pkg-0.js", at.join("node_modules/link.js")).unwrap();
    fs::set_permissions(at.join("README.md"), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    xattr::set(at.join("README.md"), "user.wsp", b"kept").unwrap();
}

#[tokio::test]
async fn a_disk_that_shares_blocks_copies_a_two_hundred_megabyte_checkout_for_its_metadata_alone() {
    if !live() || !root_here() {
        return;
    }
    let Some(volume) = volume("xfs", &["mkfs.xfs", "-q", "-m", "reflink=1"], 2) else { return };
    let (from, copies) = (volume.at.join("projects/checkout"), volume.at.join("copies"));
    big_checkout(&from, 200);
    fs::create_dir_all(&copies).unwrap();
    let copier = wsp_runtime::copy::copier_for(&from, &copies).unwrap();
    assert_eq!(copier.word(), wsp_frames::CopyWord::Reflink, "a reflink xfs did not pick the reflink copy");
    let before = used_bytes(&volume.at);
    let started = Instant::now();
    copier.copy(&from, &copies.join("wsp-a")).unwrap();
    let took = started.elapsed();
    let grew = used_bytes(&volume.at).saturating_sub(before);
    eprintln!("== a 200 MB checkout copied by reflink in {} ms, and the volume grew by {grew} bytes", took.as_millis());
    assert!(grew < 1024 * 1024, "the copy cost {grew} bytes, which is a copy of the bytes rather than of the metadata");
    let to = copies.join("wsp-a");
    // What the checkout is made of came across.
    assert_eq!(fs::read(to.join("README.md")).unwrap(), b"the checkout\n");
    assert_eq!(fs::symlink_metadata(to.join("README.md")).unwrap().mode() & 0o7777, 0o600);
    assert_eq!(xattr::get(to.join("README.md"), "user.wsp").unwrap().as_deref(), Some(&b"kept"[..]));
    assert_eq!(fs::read_link(to.join("node_modules/link.js")).unwrap(), Path::new("pkg-0.js"));
    let (first, second) =
        (fs::metadata(to.join("node_modules/pkg-0.js")).unwrap(), fs::metadata(to.join("node_modules/linked.js")).unwrap());
    assert_eq!((first.ino(), first.nlink()), (second.ino(), 2), "the hard linked pair became two files");
    // Each tree is its own from the moment the clone is taken, whichever side is written.
    fs::write(to.join("README.md"), b"written in the copy\n").unwrap();
    assert_eq!(fs::read(from.join("README.md")).unwrap(), b"the checkout\n");
    fs::write(from.join("node_modules/pkg-1.js"), b"the checkout moved on\n").unwrap();
    assert_eq!(fs::metadata(to.join("node_modules/pkg-1.js")).unwrap().len(), 1024 * 1024);
    copier.remove(&to).unwrap();
    assert!(!to.exists());
}

#[tokio::test]
async fn a_btrfs_subvolume_is_snapshotted_rather_than_walked_at_all() {
    if !live() || !root_here() {
        return;
    }
    let Some(volume) = volume("btrfs", &["mkfs.btrfs", "-q", "-f"], 2) else { return };
    let (from, copies) = (volume.at.join("checkout"), volume.at.join("copies"));
    let made = std::process::Command::new("btrfs").args(["subvolume", "create"]).arg(&from).output();
    match made {
        Ok(out) if out.status.success() => {}
        _ => {
            eprintln!("this box has no btrfs command to make a subvolume with; the snapshot case is skipped");
            return;
        }
    }
    big_checkout(&from, 50);
    fs::create_dir_all(&copies).unwrap();
    let copier = wsp_runtime::copy::copier_for(&from, &copies).unwrap();
    assert_eq!(copier.word(), wsp_frames::CopyWord::Snapshot, "a subvolume did not pick the snapshot");
    let to = copies.join("wsp-a");
    let started = Instant::now();
    copier.copy(&from, &to).unwrap();
    let took = started.elapsed();
    eprintln!("== a 50 MB subvolume snapshotted in {} ms", took.as_millis());
    assert!(took < Duration::from_millis(100), "the snapshot took {} ms, which is a walk rather than a snapshot", took.as_millis());
    assert_eq!(fs::read(to.join("README.md")).unwrap(), b"the checkout\n");
    fs::write(to.join("README.md"), b"written in the copy\n").unwrap();
    assert_eq!(fs::read(from.join("README.md")).unwrap(), b"the checkout\n");
    copier.remove(&to).unwrap();
    assert!(!to.exists(), "the snapshot's own directory stayed after the remove");
}
