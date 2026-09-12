// SPDX-License-Identifier: AGPL-3.0-only
//! Every machine op on the link, answered as the Docker backend on a place answers them, so the host's link
//! backend needs no change: the same handles, rows and results, and every refusal as `{ ok: false, error, kind,
//! status }` with `kind: missing` for a workspace nothing here knows. A workspace is a record under the run
//! directory, a container youki made from the store's layers, and its cgroup.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;
use wsp_frames::{
    BackendFacts, BackendPricing, BaseTemplates, Capabilities, DaemonErrorResponse, DaemonSupervisor, ExecResult, Lifecycle,
    LifecycleBudgets, MachineAnswersReply, MachineCounts, MachineErrorKind, MachineExecReply, MachineHandle, MachineHandleReply,
    MachineKind, MachineLinkRequest, MachineListReply, MachineListRow, MachineOp, MachineRoads, MachineSeen, MachineShape,
    MachineShapeReply, MachineSizeOffer, MachineSpec, MachineState, MachineStateReply, PauseMode, PlaceCapacity, PlaceImage, Reply,
    RequestId, SnapshotStoragePricing, WorkspaceSize,
};

use crate::bundle::{self, Config, Init, Layout, Workspace};
use crate::fetch::{self, Client, Reference};
use crate::freeze;
use crate::profile;
use crate::runtime::{self, Runtime, Status};
use crate::store::{self, Store, Swept};
use crate::{answer_machine_op, no_backend_refusal};

/// The id of the offer this computer serves, which the host stamps on every fork made here.
pub const OFFER: &str = "runtime";
/// The image a workspace boots from when nothing names one: the same long term release the goldens build on.
pub const BASE_IMAGE: &str = "ubuntu:24.04";
/// The most of the box one workspace's memory cap may name: half leaves the daemon, the person's own processes
/// and the page cache the rest.
pub const BOX_MEMORY_SHARE: f64 = 0.5;
/// The kernel takes 64 bytes of host name and refuses the boot above it.
pub const HOSTNAME_MAX: usize = 63;
/// Where a sealed image keeps the script that keeps its daemon running; the boot runs it when it is there.
pub const GUEST_SUPERVISOR_PATH: &str = "/root/wsp-daemon/supervise.sh";
/// The environment every exec carries ahead of its command, as every wsp guest exec does.
pub const EXEC_ENV: &str = "export HOME=/root USER=root";
/// Whether the guest's daemon listens, asked from inside in the words a base image can answer in.
pub const DAEMON_LISTENING_CHECK: &str = "(exec 3<>/dev/tcp/127.0.0.1/7070) 2>/dev/null";
/// The label every workspace wears, so a listing is only ours.
pub const WSP_LABEL: &str = "wsp";
const SIZES: [(f64, u64); 2] = [(2.0, 4096), (4.0, 8192)];
const WAKE_ATTEMPTS: u32 = 1;
const DAEMON_ANSWERS_MS: u64 = 30_000;
/// The Docker backend's default exec deadline.
const EXEC_DEFAULT: Duration = Duration::from_millis(20_000);

/// What every workspace boots: the daemon's supervisor once an image carries one, else a process that holds the
/// workspace up so execs can reach it. The same line the Docker backend boots, so a sealed image starts the same.
pub fn boot_cmd() -> Vec<String> {
    vec![
        "/bin/sh".to_owned(),
        "-c".to_owned(),
        format!("if [ -x {GUEST_SUPERVISOR_PATH} ]; then exec {GUEST_SUPERVISOR_PATH}; fi\nexec sleep infinity"),
    ]
}

/// A refusal on the wire: the sentence, and the engine's kind and status where a client branches on them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpError {
    pub message: String,
    pub kind: Option<MachineErrorKind>,
    pub status: Option<u16>,
}

impl OpError {
    fn plain(message: impl Into<String>) -> OpError {
        OpError { message: message.into(), kind: None, status: None }
    }

    fn missing(message: impl Into<String>) -> OpError {
        OpError { message: message.into(), kind: Some(MachineErrorKind::Missing), status: Some(404) }
    }

    fn no_workspace(id: &str) -> OpError {
        OpError::missing(format!("no such workspace: {id}"))
    }
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<runtime::Error> for OpError {
    fn from(e: runtime::Error) -> OpError {
        OpError::plain(e.to_string())
    }
}

impl From<bundle::Error> for OpError {
    fn from(e: bundle::Error) -> OpError {
        OpError::plain(e.to_string())
    }
}

impl From<io::Error> for OpError {
    fn from(e: io::Error) -> OpError {
        OpError::plain(e.to_string())
    }
}

/// A name the store lacks and no registry answers is missing, as the Docker daemon says of an image it has not got.
impl From<store::Error> for OpError {
    fn from(e: store::Error) -> OpError {
        match &e {
            store::Error::Fetch(fetch::Error::Status { status: 404, .. } | fetch::Error::BadName(_) | fetch::Error::Denied { .. }) => {
                OpError::missing(format!("no such image: {e}"))
            }
            _ => OpError::plain(e.to_string()),
        }
    }
}

/// What the box has, read once at open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoxFacts {
    pub cores: u64,
    pub mem_mb: u64,
}

impl BoxFacts {
    fn read() -> BoxFacts {
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get() as u64);
        let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let mem_kb: u64 = meminfo
            .lines()
            .find_map(|line| line.strip_prefix("MemTotal:"))
            .and_then(|rest| rest.trim().trim_end_matches("kB").trim().parse().ok())
            .unwrap_or(0);
        BoxFacts { cores, mem_mb: mem_kb / 1024 }
    }

    /// The most one workspace's cap may name here.
    fn machine_mem_mb(&self) -> u64 {
        (self.mem_mb as f64 * BOX_MEMORY_SHARE).floor() as u64
    }
}

pub struct Ops {
    layout: Layout,
    store: Arc<Store>,
    runtime: Runtime,
    /// One pull at a time: two creates of one image would append to the same partial blob.
    pulls: Mutex<()>,
    facts: BoxFacts,
    swept: Swept,
    stopped: Vec<String>,
}

impl Ops {
    /// Opens the store under the root, sweeps what nothing names, reads the box, and marks every workspace whose
    /// init is gone as stopped: a reboot, or a daemon that was not there when the init died, leaves its record,
    /// its upper directory and youki's state behind, and youki reads any process on the old pid as the container.
    /// `exe` is this binary.
    pub fn open(root: &Path, exe: PathBuf) -> Result<Ops, store::Error> {
        let layout = Layout::new(root);
        let store = Store::open(root)?;
        let swept = store.sweep()?;
        for dir in [layout.run(), layout.state()] {
            fs::create_dir_all(&dir).map_err(|source| store::Error::Io { path: dir.clone(), source })?;
        }
        let mut ops = Ops {
            layout,
            store: Arc::new(store),
            runtime: Runtime::new(root, exe),
            pulls: Mutex::new(()),
            facts: BoxFacts::read(),
            swept,
            stopped: Vec::new(),
        };
        ops.stopped = ops.mark_stopped().map_err(|e| store::Error::Record { path: ops.layout.run(), detail: e.message })?;
        Ok(ops)
    }

    /// Every record whose init is not the process it named any more: its overlay is detached and youki's state
    /// removed, so no read goes through the stale pid; the run directory with its upper stays for the kill, or for
    /// the boot from it once that exists.
    fn mark_stopped(&self) -> Result<Vec<String>, OpError> {
        let mut stopped = Vec::new();
        for record in self.records()? {
            if runtime::alive(&record.init) {
                continue;
            }
            bundle::unmount(&self.layout.rootfs(&record.id))?;
            let state = self.layout.state_of(&record.id);
            if state.exists() {
                fs::remove_dir_all(&state).map_err(|e| OpError::plain(format!("{}: {e}", state.display())))?;
            }
            stopped.push(record.id);
        }
        Ok(stopped)
    }

    /// What the sweep at open removed.
    pub fn swept_at_open(&self) -> &Swept {
        &self.swept
    }

    /// The workspaces found stopped at open, their init gone.
    pub fn stopped_at_open(&self) -> &[String] {
        &self.stopped
    }

    pub fn facts(&self) -> BoxFacts {
        self.facts
    }

    /// One frame in, one reply text out, under the request's id.
    pub async fn answer(&self, id: Option<RequestId>, frame: &Value) -> String {
        let request: MachineLinkRequest = match serde_json::from_value(frame.clone()) {
            Ok(request) => request,
            Err(e) => return text(&DaemonErrorResponse::new(id, e.to_string())),
        };
        match self.serve(request.op).await {
            Ok(body) => text(&Reply::new(id, body)),
            Err(OpError { message, kind, status }) => {
                let mut reply = DaemonErrorResponse::new(id, message);
                reply.kind = kind;
                reply.status = status;
                text(&reply)
            }
        }
    }

    async fn serve(&self, op: MachineOp) -> Result<Value, OpError> {
        match op {
            MachineOp::Backend => {
                self.self_check().await.map_err(OpError::plain)?;
                body(self.backend_facts())
            }
            MachineOp::Capacity => body(self.capacity()?),
            MachineOp::CheckKey => {
                self.self_check().await.map_err(OpError::plain)?;
                body(Empty {})
            }
            MachineOp::Create { spec } => body(MachineHandleReply { machine: self.create(spec).await? }),
            MachineOp::Get { machine_id } => {
                let record = self.record(&machine_id)?;
                let seen = MachineSeen { state: self.state_of(&record), created_at: Some(record.created_at.clone()) };
                body(MachineHandleReply { machine: self.handle(&record, None, Some(seen)) })
            }
            MachineOp::List { labels } => body(MachineListReply { machines: self.list(labels.as_ref())? }),
            MachineOp::Exec { machine_id, cmd, timeout_ms } => {
                let record = self.record(&machine_id)?;
                body(MachineExecReply { result: self.exec(&record.id, &cmd, None, deadline(timeout_ms)).await? })
            }
            MachineOp::Pause { machine_id } => {
                let record = self.record(&machine_id)?;
                let cgroup = self.live_cgroup(&record)?;
                if freeze::frozen(&cgroup)? {
                    return Err(OpError::plain(format!("workspace {} is already paused", record.id)));
                }
                freeze::freeze(cgroup).await?;
                self.runtime.set_status(&record.id, true)?;
                body(Empty {})
            }
            MachineOp::Resume { machine_id } => {
                let record = self.record(&machine_id)?;
                let cgroup = self.live_cgroup(&record)?;
                if !freeze::frozen(&cgroup)? {
                    return Err(OpError::plain(format!("workspace {} is not paused", record.id)));
                }
                freeze::thaw(cgroup).await?;
                self.runtime.set_status(&record.id, false)?;
                body(Empty {})
            }
            MachineOp::Kill { machine_id } => {
                let record = self.record(&machine_id)?;
                self.remove(&record.id, Some(&record.init)).await?;
                body(Empty {})
            }
            MachineOp::State { machine_id } => body(MachineStateReply { state: self.state_of(&self.record(&machine_id)?) }),
            MachineOp::Describe { machine_id } => {
                let record = self.record(&machine_id)?;
                body(MachineShapeReply {
                    shape: MachineShape { cpu: record.cpu, mem_mb: record.mem_mb, disk_gb: None, created_at: Some(record.created_at) },
                })
            }
            MachineOp::Metrics { machine_id } => {
                let record = self.record(&machine_id)?;
                let cgroup = self.live_cgroup(&record)?;
                freeze::memory_current(&cgroup)?;
                freeze::cpu_usage_usec(&cgroup)?;
                body(Empty {})
            }
            MachineOp::DaemonAnswers { machine_id, timeout_ms } => {
                let record = self.record(&machine_id)?;
                let result = self.exec(&record.id, DAEMON_LISTENING_CHECK, None, deadline(timeout_ms)).await?;
                body(MachineAnswersReply { answers: result.exit_code == 0 })
            }
            MachineOp::PutBytes { machine_id, path, upload_id, seq, last, data, timeout_ms } => {
                let record = self.record(&machine_id)?;
                self.put_bytes(&record.id, &path, &upload_id, seq, last, &data, deadline(timeout_ms)).await?;
                body(Empty {})
            }
            MachineOp::Facts { machine_id } => {
                self.record(&machine_id)?;
                Err(OpError::plain(no_backend_refusal("facts")))
            }
            MachineOp::PreviewUrl { machine_id, .. } => {
                self.record(&machine_id)?;
                Err(OpError::plain(no_backend_refusal("previewUrl")))
            }
            MachineOp::DownloadUrl { machine_id, .. } => {
                self.record(&machine_id)?;
                Err(OpError::plain("a workspace serves no signed download URL; its files come out through exec"))
            }
            MachineOp::UploadUrl { machine_id, .. } => {
                self.record(&machine_id)?;
                Err(OpError::plain("a workspace serves no signed upload URL; its files go in through the byte road"))
            }
            MachineOp::Snapshot { .. } => Err(OpError::plain(no_backend_refusal("machine.snapshot"))),
            MachineOp::DeleteSnapshot { .. } => Err(OpError::plain(no_backend_refusal("machine.deleteSnapshot"))),
            MachineOp::ListSnapshots => Err(OpError::plain(no_backend_refusal("machine.listSnapshots"))),
            MachineOp::PromoteSnapshot { .. } => Err(OpError::plain(no_backend_refusal("machine.promoteSnapshot"))),
            MachineOp::GetTemplate { .. } => Err(OpError::plain(no_backend_refusal("machine.getTemplate"))),
            MachineOp::ListTemplates => Err(OpError::plain(no_backend_refusal("machine.listTemplates"))),
            MachineOp::DeleteTemplate { .. } => Err(OpError::plain(no_backend_refusal("machine.deleteTemplate"))),
        }
    }

    /// The flags, prices and budgets this backend declares, as the plan fixes them.
    pub fn backend_facts(&self) -> BackendFacts {
        let sizes = SIZES.iter().map(|&(cpu, mem_mb)| MachineSizeOffer { cpu, mem_mb, rate_usd_per_hour: 0.0 }).collect();
        BackendFacts {
            offer: OFFER.to_owned(),
            capabilities: Capabilities {
                live_clone_forks: false,
                pause_mode: Some(PauseMode::Disk),
                resize: false,
                replaces_machine: true,
                preview_urls: false,
                signed_urls: false,
                containers: false,
                callback_relay: true,
                disk_snapshots: true,
                snapshot_listing: true,
                templates: true,
                sizes,
                kept: false,
            },
            pricing: BackendPricing {
                default_size: WorkspaceSize { cpu: SIZES[0].0, mem_mb: SIZES[0].1 },
                snapshot_storage: SnapshotStoragePricing { free_gb: 0.0, usd_per_gb_month: 0.0, billed_from: String::new() },
                builder_disk_gb: None,
            },
            lifecycle: Some(Lifecycle {
                budgets: LifecycleBudgets { wake_attempts: WAKE_ATTEMPTS, daemon_answers_ms: DAEMON_ANSWERS_MS, resume_asks: None },
            }),
            base_templates: Some(BaseTemplates { sandbox: BASE_IMAGE.to_owned(), desktop: BASE_IMAGE.to_owned() }),
        }
    }

    /// Whether this computer can run a workspace at all: cgroup v2 with the controllers a cap needs, an overlay
    /// mount, and a cgroup of our own. Each refusal is one sentence for the doctor. Off the runtime thread, since
    /// it mounts.
    pub async fn self_check(&self) -> Result<(), String> {
        let root = self.layout.root().to_path_buf();
        tokio::task::spawn_blocking(move || Self::self_check_on(&Layout::new(&root))).await.map_err(|e| e.to_string())?
    }

    fn self_check_on(layout: &Layout) -> Result<(), String> {
        let controllers = fs::read_to_string(Path::new(freeze::CGROUP_ROOT).join("cgroup.controllers")).map_err(|_| {
            "this computer mounts cgroup v1 at /sys/fs/cgroup, and wsp runs workspaces on cgroup v2 alone: boot it with systemd.unified_cgroup_hierarchy=1".to_owned()
        })?;
        for wanted in ["memory", "cpu"] {
            if !controllers.split_whitespace().any(|c| c == wanted) {
                return Err(format!("this computer's cgroup root offers no {wanted} controller, which wsp needs to run workspaces here"));
            }
        }
        let check = layout.check();
        let (lower, upper, work, merged) = (check.join("lower"), check.join("upper"), check.join("work"), check.join("merged"));
        let overlay = (|| -> Result<(), String> {
            for dir in [&lower, &upper, &work, &merged] {
                fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            bundle::mount_rootfs(std::slice::from_ref(&lower), &upper, &work, &merged).map_err(|e| e.to_string())?;
            bundle::unmount(&merged).map_err(|e| e.to_string())
        })();
        let _ = fs::remove_dir_all(&check);
        overlay.map_err(|e| format!("this computer refuses an overlay mount: {e}"))?;
        let cgroup = Path::new(freeze::CGROUP_ROOT).join("wsp").join(format!("check-{}", std::process::id()));
        fs::create_dir_all(&cgroup).map_err(|e| format!("this computer refuses a cgroup under {}/wsp: {e}", freeze::CGROUP_ROOT))?;
        let _ = fs::remove_dir(&cgroup);
        Ok(())
    }

    pub fn capacity(&self) -> Result<PlaceCapacity, OpError> {
        let mut counts = MachineCounts { running: 0, paused: 0 };
        let mut taken_mb = 0;
        for record in self.records()? {
            match self.state_of(&record) {
                MachineState::Gone => continue,
                MachineState::Paused => counts.paused += 1,
                MachineState::Running | MachineState::Starting => counts.running += 1,
            }
            taken_mb += record.mem_mb.unwrap_or(0);
        }
        let machine_mem_mb = self.facts.machine_mem_mb();
        let stat =
            nix::sys::statvfs::statvfs(self.layout.root()).map_err(|e| OpError::plain(format!("{}: {e}", self.layout.root().display())))?;
        let disk_free_bytes = stat.blocks_available() as u64 * stat.fragment_size() as u64;
        let images = self
            .store
            .images()?
            .into_iter()
            .map(|image| PlaceImage { id: image.manifest.to_string(), name: Some(image.name), size_bytes: image.layer_bytes.iter().sum() })
            .collect();
        Ok(PlaceCapacity {
            cores: self.facts.cores,
            mem_mb: self.facts.mem_mb,
            mem_room_mb: machine_mem_mb.saturating_sub(taken_mb),
            machine_mem_mb,
            disk_free_bytes,
            images,
            machines: counts,
        })
    }

    /// The size this box can give, out of the one asked for; what a seal records is what the box built.
    pub fn size_on_box(&self, cpu: Option<f64>, mem_mb: Option<u64>) -> (Option<f64>, Option<u64>) {
        (cpu.map(|c| c.min(self.facts.cores as f64)), mem_mb.map(|m| m.min(self.facts.machine_mem_mb())))
    }

    async fn create(&self, spec: MachineSpec) -> Result<MachineHandle, OpError> {
        let image = spec.from_snapshot.clone().or_else(|| spec.template.clone()).unwrap_or_else(|| BASE_IMAGE.to_owned());
        let id = match &spec.idempotency_key {
            Some(key) => format!("wsp-{}", workspace_word(key)),
            None => format!("wsp-{}", random_hex()),
        };
        let dir = self.layout.workspace(&id);
        // The directory is the claim: a second create under the same key answers the workspace the first one made.
        if let Err(e) = fs::create_dir_all(self.layout.run()).and_then(|()| fs::create_dir(&dir)) {
            if e.kind() != io::ErrorKind::AlreadyExists {
                return Err(OpError::plain(format!("{}: {e}", dir.display())));
            }
            return match bundle::read_record(&self.layout.record(&id))? {
                Some(record) => Ok(self.handle(&record, Some(true), None)),
                None => Err(OpError::plain(format!("workspace {id} is being created"))),
            };
        }
        match self.build(&id, &image, &spec).await {
            Ok(record) => Ok(self.handle(&record, None, None)),
            Err(e) => {
                // A workspace that would not come up is ours and nobody else's: nothing of it stays behind.
                let _ = self.remove(&id, None).await;
                Err(e)
            }
        }
    }

    async fn build(&self, id: &str, image: &str, spec: &MachineSpec) -> Result<Workspace, OpError> {
        let lowers = self.lowers_of(image).await?;
        let (cpu, mem_mb) = self.size_on_box(spec.cpu, spec.mem_mb);
        let hostname: String = id.chars().take(HOSTNAME_MAX).collect();
        for dir in [self.layout.upper(id), self.layout.work(id), self.layout.rootfs(id)] {
            fs::create_dir_all(&dir).map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))?;
        }
        bundle::write_etc(&self.layout.etc(id), &hostname)?;
        bundle::mount_rootfs(&lowers, &self.layout.upper(id), &self.layout.work(id), &self.layout.rootfs(id))?;
        let mut args = vec![profile::INIT_PATH.to_owned(), "runtime".to_owned(), "init".to_owned(), "--".to_owned()];
        args.extend(boot_cmd());
        let envs = spec.envs.clone().unwrap_or_default();
        let cgroup = self.layout.cgroup_name(id);
        let config = Config {
            hostname: &hostname,
            args: &args,
            envs: &envs,
            cpu,
            mem_mb,
            cgroup: &cgroup,
            init: self.runtime.exe(),
            etc: &self.layout.etc(id),
        };
        bundle::write_json(&self.layout.config(id), &bundle::config_json(&config))?;
        let mut labels = BTreeMap::from([(WSP_LABEL.to_owned(), "1".to_owned())]);
        labels.extend(spec.labels.clone().unwrap_or_default());
        self.runtime.create(id).await?;
        let pid = self.runtime.init_pid(id)?.ok_or_else(|| OpError::plain(format!("workspace {id} was created without an init")))?;
        let init = runtime::identity_of(pid)?;
        let record = Workspace { id: id.to_owned(), hostname, image: image.to_owned(), labels, cpu, mem_mb, created_at: now_iso(), init };
        bundle::write_json(&self.layout.record(id), &record)?;
        freeze::forbid_swap(&self.layout.cgroup_dir(id))?;
        self.runtime.start(id).await?;
        Ok(record)
    }

    /// The unpacked layers of the image, pulled into the store first where it lacks them.
    async fn lowers_of(&self, name: &str) -> Result<Vec<PathBuf>, OpError> {
        let _one_at_a_time = self.pulls.lock().await;
        let store = Arc::clone(&self.store);
        let wanted = name.to_owned();
        let image = tokio::task::spawn_blocking(move || -> Result<store::Image, store::Error> {
            if let Some(image) = store.image(&wanted)? {
                return Ok(image);
            }
            let source = Reference::parse(&wanted)?;
            Ok(store.pull(&wanted, &source, &mut Client::new())?.image)
        })
        .await
        .map_err(|e| OpError::plain(e.to_string()))??;
        image
            .chain
            .layers
            .iter()
            .map(|digest| {
                self.store.unpacked(digest).ok_or_else(|| OpError::plain(format!("layer {digest} of {name} is not unpacked in the store")))
            })
            .collect()
    }

    async fn exec(&self, id: &str, cmd: &str, stdin: Option<Vec<u8>>, timeout: Duration) -> Result<ExecResult, OpError> {
        let args = vec!["bash".to_owned(), "-c".to_owned(), format!("{EXEC_ENV}\n{cmd}")];
        let done = self.runtime.exec(id, &args, stdin, timeout).await?;
        Ok(ExecResult { exit_code: done.exit_code, stdout: done.stdout, stderr: done.stderr })
    }

    /// The parts of one upload appended under its id; the last one lands the whole file through an exec that reads
    /// it on stdin, inside the workspace, so a link in the rootfs can never point the write at the box.
    #[allow(clippy::too_many_arguments)]
    async fn put_bytes(
        &self,
        id: &str,
        path: &str,
        upload_id: &str,
        seq: u64,
        last: bool,
        data: &str,
        timeout: Duration,
    ) -> Result<(), OpError> {
        if upload_id.is_empty() || !upload_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
            return Err(OpError::plain(format!("{upload_id} is not an upload id")));
        }
        let part = self.layout.put(upload_id);
        let held = fs::metadata(&part).ok().map(|m| m.len());
        if (seq == 0) != held.is_none() {
            let _ = fs::remove_file(&part);
            return Err(OpError::plain(format!("part {seq} of {upload_id} is out of order; the upload is dropped and starts again")));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| OpError::plain(format!("part {seq} of {upload_id}: {e}")))?;
        if let Some(parent) = part.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::OpenOptions::new().append(true).create(true).open(&part)?;
        io::Write::write_all(&mut file, &bytes)?;
        drop(file);
        if !last {
            return Ok(());
        }
        let whole = fs::read(&part)?;
        let _ = fs::remove_file(&part);
        let script = land_script(path, whole.len());
        let done = self.exec(id, &script, Some(whole), timeout).await?;
        if done.exit_code != 0 {
            return Err(OpError::plain(format!("landing {path} on {id} exited {}: {}", done.exit_code, done.stderr.trim())));
        }
        Ok(())
    }

    /// Kills, deletes, unmounts and removes every trace of the workspace under the root.
    async fn remove(&self, id: &str, init: Option<&Init>) -> Result<(), OpError> {
        self.runtime.kill(id, init).await?;
        bundle::unmount(&self.layout.rootfs(id))?;
        let dir = self.layout.workspace(id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))?;
        }
        Ok(())
    }

    fn handle(&self, record: &Workspace, replayed: Option<bool>, seen: Option<MachineSeen>) -> MachineHandle {
        MachineHandle {
            id: record.id.clone(),
            kind: MachineKind::Sandbox,
            stream_url: None,
            labels: Some(record.labels.clone()),
            seen,
            replayed,
            daemon_supervisor: Some(DaemonSupervisor::Entrypoint),
            roads: MachineRoads { preview_url: false, daemon_answers: true, put_bytes: true, describe: true, facts: false, metrics: true },
        }
    }

    fn record(&self, id: &str) -> Result<Workspace, OpError> {
        bundle::read_record(&self.layout.record(id))?.ok_or_else(|| OpError::no_workspace(id))
    }

    fn records(&self) -> Result<Vec<Workspace>, OpError> {
        let run = self.layout.run();
        let mut out = Vec::new();
        let entries = match fs::read_dir(&run) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(OpError::plain(format!("{}: {e}", run.display()))),
        };
        for entry in entries {
            let entry = entry.map_err(|e| OpError::plain(format!("{}: {e}", run.display())))?;
            if let Some(record) = bundle::read_record(&entry.path().join("workspace.json"))? {
                out.push(record);
            }
        }
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        Ok(out)
    }

    fn list(&self, labels: Option<&BTreeMap<String, String>>) -> Result<Vec<MachineListRow>, OpError> {
        Ok(self
            .records()?
            .into_iter()
            .filter(|record| labels.is_none_or(|wanted| wanted.iter().all(|(k, v)| record.labels.get(k) == Some(v))))
            .map(|record| MachineListRow {
                id: record.id.clone(),
                state: self.state_of(&record),
                size: match (record.cpu, record.mem_mb) {
                    (Some(cpu), Some(mem_mb)) => Some(WorkspaceSize { cpu, mem_mb }),
                    _ => None,
                },
                labels: record.labels,
            })
            .collect())
    }

    /// The workspace's cgroup, while its init is the process the record names; the path is the plain manager's and
    /// never read off a pid.
    fn live_cgroup(&self, record: &Workspace) -> Result<PathBuf, OpError> {
        if !runtime::alive(&record.init) {
            return Err(OpError::plain(format!("workspace {} has no process", record.id)));
        }
        Ok(self.layout.cgroup_dir(&record.id))
    }

    /// created reads starting, a frozen cgroup reads paused, a stopped workspace reads gone. A record whose init
    /// is not the process it named reads gone before youki is asked, since youki reads any process on that pid as
    /// the container.
    pub fn state_of(&self, record: &Workspace) -> MachineState {
        if !runtime::alive(&record.init) {
            return MachineState::Gone;
        }
        match self.runtime.status(&record.id) {
            Ok(Status::Creating | Status::Created) => MachineState::Starting,
            Ok(Status::Paused) => MachineState::Paused,
            Ok(Status::Running) => match freeze::frozen(&self.layout.cgroup_dir(&record.id)) {
                Ok(true) => MachineState::Paused,
                _ => MachineState::Running,
            },
            Ok(Status::Stopped | Status::Gone) | Err(_) => MachineState::Gone,
        }
    }
}

#[derive(Serialize)]
struct Empty {}

fn body<T: Serialize>(value: T) -> Result<Value, OpError> {
    serde_json::to_value(value).map_err(|e| OpError::plain(e.to_string()))
}

fn text(value: &impl Serialize) -> String {
    serde_json::to_string(value).expect("a frame serialises")
}

fn deadline(timeout_ms: Option<u32>) -> Duration {
    timeout_ms.map_or(EXEC_DEFAULT, |ms| Duration::from_millis(u64::from(ms)))
}

/// An idempotency key as a workspace id: lower case letters, digits, dot, underscore and hyphen, as youki takes
/// an id and Docker takes a name, anything else a hyphen, nothing leading with a dot or a hyphen, 128 at most.
pub fn workspace_word(key: &str) -> String {
    let cleaned: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let trimmed = cleaned.trim_start_matches(['.', '-']);
    let word = if trimmed.is_empty() { "snapshot" } else { trimmed };
    word.chars().take(128).collect()
}

fn random_hex() -> String {
    let mut bytes = [0u8; 8];
    let read = fs::File::open("/dev/urandom").and_then(|mut f| io::Read::read_exact(&mut f, &mut bytes));
    if read.is_err() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        bytes.copy_from_slice(&(nanos as u64 ^ u64::from(std::process::id())).to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A word in single quotes for sh.
fn quoted(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// The script that lands stdin at the path: the parent made, the bytes counted before the file moves into place.
pub fn land_script(path: &str, count: usize) -> String {
    let dir =
        Path::new(path).parent().map(|p| p.to_string_lossy().into_owned()).filter(|p| !p.is_empty()).unwrap_or_else(|| "/".to_owned());
    let tmp = format!("{path}.in");
    [
        "set -e".to_owned(),
        "umask 022".to_owned(),
        format!("mkdir -p {}", quoted(&dir)),
        format!("cat > {}", quoted(&tmp)),
        format!("[ \"$(wc -c < {} | tr -d ' ')\" = {count} ] || {{ rm -f {}; echo short >&2; exit 1; }}", quoted(&tmp), quoted(&tmp)),
        format!("mv -f {} {}", quoted(&tmp), quoted(path)),
    ]
    .join("\n")
}

/// The refusal for an op nothing here serves, as the stub before this crate answered every op.
pub fn stub(id: Option<RequestId>, op: &str) -> String {
    text(&answer_machine_op(id, op))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_id_word_is_what_youki_and_docker_both_take() {
        assert_eq!(workspace_word("smoke-default-A1"), "smoke-default-a1");
        assert_eq!(workspace_word("ws:one/two three"), "ws-one-two-three");
        assert_eq!(workspace_word("..--x"), "x");
        assert_eq!(workspace_word("!!!"), "snapshot");
        assert_eq!(workspace_word(&"a".repeat(200)).len(), 128);
    }

    #[test]
    fn the_land_script_quotes_the_path_and_counts_the_bytes() {
        let script = land_script("/root/it's here/x.bin", 13);
        assert!(script.contains("mkdir -p '/root/it'\\''s here'"));
        assert!(script.contains("cat > '/root/it'\\''s here/x.bin.in'"));
        assert!(script.contains("= 13 ]"));
        assert!(script.ends_with("mv -f '/root/it'\\''s here/x.bin.in' '/root/it'\\''s here/x.bin'"));
        assert!(land_script("top", 1).contains("mkdir -p '/'"));
    }

    #[test]
    fn the_box_is_read_off_proc_and_the_size_is_held_to_it() {
        let facts = BoxFacts::read();
        assert!(facts.cores >= 1 && facts.mem_mb > 0);
        assert_eq!(facts.machine_mem_mb(), (facts.mem_mb as f64 * BOX_MEMORY_SHARE).floor() as u64);
    }

    #[test]
    fn the_backend_facts_are_the_plans() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true")).unwrap();
        let facts = ops.backend_facts();
        assert_eq!(facts.offer, "runtime");
        assert_eq!(facts.capabilities.pause_mode, Some(PauseMode::Disk));
        assert!(!facts.capabilities.live_clone_forks && !facts.capabilities.resize && !facts.capabilities.preview_urls);
        assert!(!facts.capabilities.signed_urls && !facts.capabilities.containers && !facts.capabilities.kept);
        assert!(facts.capabilities.replaces_machine && facts.capabilities.callback_relay && facts.capabilities.disk_snapshots);
        assert!(facts.capabilities.snapshot_listing && facts.capabilities.templates);
        assert_eq!(facts.capabilities.sizes.len(), 2);
        assert_eq!(
            (facts.capabilities.sizes[1].cpu, facts.capabilities.sizes[1].mem_mb, facts.capabilities.sizes[1].rate_usd_per_hour),
            (4.0, 8192, 0.0)
        );
        assert_eq!(facts.pricing.default_size, WorkspaceSize { cpu: 2.0, mem_mb: 4096 });
        assert_eq!(
            facts.lifecycle.as_ref().unwrap().budgets,
            LifecycleBudgets { wake_attempts: 1, daemon_answers_ms: 30_000, resume_asks: None }
        );
        assert_eq!(
            facts.base_templates.as_ref().unwrap(),
            &BaseTemplates { sandbox: "ubuntu:24.04".into(), desktop: "ubuntu:24.04".into() }
        );
        let json = serde_json::to_value(&facts).unwrap();
        assert_eq!(json["pricing"]["snapshotStorage"], serde_json::json!({ "freeGb": 0.0, "usdPerGbMonth": 0.0, "billedFrom": "" }));
        assert!(json["pricing"].get("builderDiskGb").is_none());
        let (cpu, mem) = ops.size_on_box(Some(9999.0), Some(u64::MAX));
        assert_eq!((cpu, mem), (Some(ops.facts().cores as f64), Some(ops.facts().machine_mem_mb())));
        assert_eq!(ops.size_on_box(None, Some(1)), (None, Some(1)));
    }

    #[tokio::test]
    async fn an_unknown_workspace_is_missing_on_every_op_that_names_one_and_a_bad_frame_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true")).unwrap();
        for op in [
            "machine.get",
            "machine.exec",
            "machine.pause",
            "machine.resume",
            "machine.kill",
            "machine.state",
            "machine.describe",
            "machine.metrics",
            "machine.daemonAnswers",
            "machine.facts",
        ] {
            let reply: Value = serde_json::from_str(
                &ops.answer(Some(RequestId::from(1)), &serde_json::json!({ "id": 1, "op": op, "machineId": "gone", "cmd": "true" })).await,
            )
            .unwrap();
            assert_eq!(
                reply,
                serde_json::json!({ "id": 1, "ok": false, "error": "no such workspace: gone", "kind": "missing", "status": 404 }),
                "{op}"
            );
        }
        let reply: Value = serde_json::from_str(
            &ops.answer(Some(RequestId::from(2)), &serde_json::json!({ "id": 2, "op": "machine.state", "machineId": 7 })).await,
        )
        .unwrap();
        assert_eq!((reply["ok"].as_bool(), reply.get("kind")), (Some(false), None));
        let listed: Value =
            serde_json::from_str(&ops.answer(Some(RequestId::from(3)), &serde_json::json!({ "id": 3, "op": "machine.list" })).await)
                .unwrap();
        assert_eq!(listed, serde_json::json!({ "id": 3, "ok": true, "machines": [] }));
        let later: Value = serde_json::from_str(
            &ops.answer(Some(RequestId::from(4)), &serde_json::json!({ "id": 4, "op": "machine.listSnapshots" })).await,
        )
        .unwrap();
        assert_eq!(later["error"], "this computer's backend has no machine.listSnapshots");
    }

    #[test]
    fn a_store_error_for_an_image_no_registry_has_reads_missing() {
        let e: OpError = store::Error::Fetch(fetch::Error::Status { status: 404, url: "https://registry-1.docker.io/v2/x".into() }).into();
        assert_eq!((e.kind, e.status), (Some(MachineErrorKind::Missing), Some(404)));
        assert!(e.message.starts_with("no such image: "));
        let e: OpError = store::Error::Fetch(fetch::Error::BadName("sha256:abc".into())).into();
        assert_eq!(e.kind, Some(MachineErrorKind::Missing));
    }
}
