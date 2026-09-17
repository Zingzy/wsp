// SPDX-License-Identifier: AGPL-3.0-only
//! Every machine op on the link, answered as the Docker backend on a place answers them, so the host's link
//! backend needs no change: the same handles, rows and results, and every refusal as `{ ok: false, error, kind,
//! status }` with `kind: missing` for a workspace nothing here knows. A workspace is a record under the run
//! directory, a container youki made from the store's layers, its cgroup, and its network. Idle means stopped: a
//! pause kills the processes and takes the network down, its upper directory stays as the saved layer, and the
//! wake boots from it with the same id, address and forwards; a workspace labelled to keep running is frozen
//! instead. A snapshot commits the upper directory to the store under a name, and a template is a name over a
//! snapshot's chain; a fork boots from either as from an image.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;
use wsp_frames::{
    BackendFacts, BackendPricing, BaseTemplates, Capabilities, CopyWord, DaemonErrorResponse, DaemonSupervisor, ExecResult, Lifecycle,
    LifecycleBudgets, MachineAnswersReply, MachineCounts, MachineErrorKind, MachineExecReply, MachineHandle, MachineHandleReply,
    MachineKind, MachineLinkRequest, MachineListReply, MachineListRow, MachineOp, MachinePromoteReply, MachineReachReply, MachineReading,
    MachineReadingReply, MachineRoads, MachineSeen, MachineShape, MachineShapeReply, MachineSizeOffer, MachineSnapshotJobReply,
    MachineSnapshotReply, MachineSnapshotsReply, MachineSpec, MachineState, MachineStateReply, MachineTemplateReply, MachineTemplatesReply,
    PauseMode, PlaceCapacity, PlaceImage, PreviewReach, Reply, RequestId, SnapshotJobState, SnapshotRow, SnapshotStoragePricing,
    TemplateRow, TemplateStatus, WorkspaceCopy, WorkspaceSize,
};

use crate::bundle::{self, Config, CopyMade, Init, Layout, Workspace};
use crate::copy;
use crate::engine::{self, Fence, Ports};
use crate::fetch::{self, Client, Digest, Reference};
use crate::freeze;
use crate::net::{self, Net};
use crate::profile;
use crate::runtime::{self, Runtime, Status};
use crate::size::{size_on_box, BoxFacts, SizeOnBox};
use crate::snapshot;
use crate::store::{self, Chain, Snapshot, Store, Swept};
use crate::{answer_machine_op, no_backend_refusal};

/// The id of the offer this computer serves, which the host stamps on every fork made here.
pub const OFFER: &str = "runtime";
/// The image a workspace boots from when nothing names one: the same long term release the goldens build on.
pub const BASE_IMAGE: &str = "ubuntu:24.04";
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
/// The label and its value on a workspace that must keep what its processes hold: a pause freezes it instead of
/// stopping it, which is what a pinned port or a service inside asks for.
pub const IDLE_LABEL: &str = "wsp.idle";
pub const IDLE_FREEZE: &str = "freeze";
/// The repository a promoted snapshot's template id sits in, as the Docker backend tags one: `wsp/<name>:template`.
pub const TEMPLATE_REPO: &str = "wsp";
pub const TEMPLATE_TAG: &str = "template";
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

impl std::error::Error for OpError {}

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

impl From<net::Error> for OpError {
    fn from(e: net::Error) -> OpError {
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

/// The handle a create answers with, carrying what the create has to say about what it gave.
fn noticed(mut handle: MachineHandle, notice: Option<String>) -> MachineHandle {
    handle.notice = notice;
    handle
}

/// Everything one create has to say, as one sentence a person reads: the size the box gave where it gave
/// another, the copy's minutes where it wrote every byte, nothing where there is nothing to say.
fn notices<const N: usize>(said: [Option<String>; N]) -> Option<String> {
    let all: Vec<String> = said.into_iter().flatten().collect();
    (!all.is_empty()).then(|| all.join("; "))
}

/// How long a plain copy took and why it took it, in the words a person can act on: the root's own filesystem,
/// which is the thing that decides whether a copy shares blocks. A box that will not say what it is on says the
/// time alone.
pub fn plain_copy_line(root: &Path, filesystem: Option<&str>, ms: u64) -> String {
    let seconds = (ms as f64 / 1000.0).round().max(1.0) as u64;
    let why = match filesystem {
        Some(kind) => format!("{} is on {kind}, which shares no blocks between copies", root.display()),
        None => format!("{} shares no blocks between copies", root.display()),
    };
    format!("copied plainly in {seconds} s: {why}")
}

pub struct Ops {
    layout: Layout,
    store: Arc<Store>,
    runtime: Runtime,
    net: Arc<Net>,
    /// The fenced engine socket's accept loop of every running workspace that asked for one.
    engines: Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>,
    /// One pull, commit or sweep at a time, and a create from the resolve of its chain to the record that holds
    /// it: two pulls of one image would append to the same partial blob, and a sweep between a resolve and the
    /// record would take a layer the boot is about to mount. Shared with the snapshot jobs, which outlive the frame
    /// that started them.
    pulls: Arc<Mutex<()>>,
    /// Every snapshot job this daemon started, by the name its reply carried, running or finished: the host asks
    /// after a job until it reads done or failed, and a finished job costs a few words to keep.
    jobs: std::sync::Mutex<BTreeMap<String, Arc<SnapshotJob>>>,
    facts: BoxFacts,
    swept: Swept,
    stopped: Vec<String>,
    net_swept: net::Swept,
}

impl Ops {
    /// Opens the store under the root, sweeps what nothing names, reads the box, marks every workspace whose init
    /// is gone as stopped (a reboot, or a daemon that was not there when the init died, leaves its record, its upper
    /// directory and youki's state behind, and youki reads any process on the old pid as the container), and sweeps
    /// the network of every workspace that is not running. `exe` is this binary. The forwards of the workspaces
    /// still running come back with `restore`, which wants the runtime the listeners live on.
    pub fn open(root: &Path, exe: PathBuf) -> Result<Ops, store::Error> {
        let layout = Layout::new(root);
        let store = Store::open(root)?;
        for dir in [layout.run(), layout.state()] {
            fs::create_dir_all(&dir).map_err(|source| store::Error::Io { path: dir.clone(), source })?;
        }
        let held = held_chains(&layout).map_err(|e| store::Error::Record { path: layout.run(), detail: e.message })?;
        let swept = store.sweep(&held)?;
        let runtime = Runtime::new(root, exe);
        let stopped = mark_stopped(&layout).map_err(|e| store::Error::Record { path: layout.run(), detail: e.message })?;
        let running = running_ids(&layout).map_err(|e| store::Error::Record { path: layout.run(), detail: e.message })?;
        let (net, net_swept) = Net::open(Layout::new(root), &running)
            .map_err(|e| store::Error::Io { path: root.to_path_buf(), source: io::Error::other(e.to_string()) })?;
        Ok(Ops {
            layout,
            store: Arc::new(store),
            runtime,
            net: Arc::new(net),
            engines: Mutex::new(BTreeMap::new()),
            pulls: Arc::new(Mutex::new(())),
            jobs: std::sync::Mutex::new(BTreeMap::new()),
            facts: BoxFacts::read(),
            swept,
            stopped,
            net_swept,
        })
    }

    /// The published ports of every running workspace, listening again where their records say, and the engine
    /// socket of every running workspace that asked for one served again, its containers' ports joined. An engine
    /// that left the box since leaves that workspace's socket unserved and the rest untouched.
    pub async fn restore(&self) -> Result<(), OpError> {
        let running = running_ids(&self.layout)?;
        self.net.restore(&running).await?;
        for record in self.records()? {
            if record.engine && running.contains(&record.id) && self.serve_engine(&record.id).await.is_ok() {
                self.join_ports(&record).await;
            }
        }
        Ok(())
    }

    /// The workspace's socket bound in its directory and its accept loop started over the box's engine; one already
    /// served is replaced.
    async fn serve_engine(&self, id: &str) -> Result<(), OpError> {
        let socket = engine::socket_of(&crate::doctor::read_facts()).map_err(OpError::plain)?;
        let listener = engine::bind(&self.layout.engine(id))?;
        let fence = Fence {
            workspace: id.to_owned(),
            rootfs: self.layout.rootfs(id),
            engine: socket,
            ports: Arc::new(Inward { net: Arc::clone(&self.net), root: self.layout.root().to_path_buf() }),
        };
        let task = tokio::spawn(engine::serve(listener, Arc::new(fence)));
        if let Some(old) = self.engines.lock().await.insert(id.to_owned(), task) {
            old.abort();
        }
        Ok(())
    }

    /// The published ports of the workspace's running containers joined to its loopback, as after a wake or a
    /// daemon restart; a container whose port cannot be joined is left for the next start to try again.
    async fn join_ports(&self, record: &Workspace) {
        let Ok(socket) = engine::socket_of(&crate::doctor::read_facts()) else { return };
        let Ok(pairs) = engine::published(&socket, &record.id).await else { return };
        for (inside, box_port) in pairs {
            let _ = self.net.forward_inward(&record.id, record.init.pid, inside, box_port).await;
        }
    }

    /// The accept loop ended and the socket file gone; the directory stays with the bundle.
    async fn stop_engine(&self, id: &str) {
        if let Some(task) = self.engines.lock().await.remove(id) {
            task.abort();
        }
        let _ = fs::remove_file(self.layout.engine(id).join(engine::SOCKET_NAME));
    }

    /// What the sweep at open removed.
    pub fn swept_at_open(&self) -> &Swept {
        &self.swept
    }

    /// The workspaces found stopped at open, their init gone.
    pub fn stopped_at_open(&self) -> &[String] {
        &self.stopped
    }

    /// What the network sweep at open removed.
    pub fn net_swept_at_open(&self) -> &net::Swept {
        &self.net_swept
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
                let record = self.running(&machine_id)?;
                body(MachineExecReply { result: self.exec(&record.id, &cmd, None, deadline(timeout_ms)).await? })
            }
            MachineOp::Pause { machine_id } => {
                let record = self.record(&machine_id)?;
                if !runtime::alive(&record.init) {
                    return Err(OpError::plain(format!("workspace {} is already paused", record.id)));
                }
                let cgroup = self.layout.cgroup_dir(&record.id);
                if freeze::frozen(&cgroup)? {
                    return Err(OpError::plain(format!("workspace {} is already paused", record.id)));
                }
                if record.labels.get(IDLE_LABEL).is_some_and(|v| v == IDLE_FREEZE) {
                    freeze::freeze(cgroup).await?;
                    self.runtime.set_status(&record.id, true)?;
                } else {
                    self.stop(&record).await?;
                }
                body(Empty {})
            }
            MachineOp::Resume { machine_id } => {
                let record = self.record(&machine_id)?;
                if !runtime::alive(&record.init) {
                    self.wake(record).await?;
                    return body(Empty {});
                }
                let cgroup = self.layout.cgroup_dir(&record.id);
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
                let upper = self.layout.upper(&record.id);
                // Off the runtime thread: a workspace after a build holds hundreds of thousands of files.
                let used_bytes = tokio::task::spawn_blocking(move || store::tree_bytes(&upper).ok()).await.ok().flatten();
                body(MachineShapeReply {
                    shape: MachineShape {
                        cpu: record.cpu,
                        mem_mb: record.mem_mb,
                        disk_gb: None,
                        created_at: Some(record.created_at),
                        used_bytes,
                    },
                })
            }
            MachineOp::Metrics { machine_id } => body(MachineReadingReply { reading: self.reading(&self.record(&machine_id)?) }),
            MachineOp::DaemonAnswers { machine_id, timeout_ms } => {
                let record = self.running(&machine_id)?;
                let result = self.exec(&record.id, DAEMON_LISTENING_CHECK, None, deadline(timeout_ms)).await?;
                body(MachineAnswersReply { answers: result.exit_code == 0 })
            }
            MachineOp::PutBytes { machine_id, path, upload_id, seq, last, data, timeout_ms } => {
                let record = self.running(&machine_id)?;
                self.put_bytes(&record.id, &path, &upload_id, seq, last, &data, deadline(timeout_ms)).await?;
                body(Empty {})
            }
            MachineOp::Facts { machine_id } => {
                self.record(&machine_id)?;
                Err(OpError::plain(no_backend_refusal("facts")))
            }
            MachineOp::PreviewUrl { machine_id, port } => {
                let record = self.record(&machine_id)?;
                let box_port = self.net.publish(&record.id, port.get()).await?;
                body(MachineReachReply {
                    reach: PreviewReach {
                        url: format!("http://127.0.0.1:{box_port}"),
                        token: String::new(),
                        expires_at: PreviewReach::NEVER,
                    },
                })
            }
            MachineOp::DownloadUrl { machine_id, .. } => {
                self.record(&machine_id)?;
                Err(OpError::plain("a workspace serves no signed download URL; its files come out through exec"))
            }
            MachineOp::UploadUrl { machine_id, .. } => {
                self.record(&machine_id)?;
                Err(OpError::plain("a workspace serves no signed upload URL; its files go in through the byte road"))
            }
            // The disk is the same copy whatever the workspace has done since it booted, so the life it is handed
            // changes nothing here, as it changes nothing for the Docker backend.
            MachineOp::Snapshot { machine_id, name, life: _ } => {
                let record = self.record(&machine_id)?;
                body(MachineSnapshotReply { job: self.start_snapshot(record, name) })
            }
            MachineOp::SnapshotJob { job } => body(self.snapshot_job(&job)?),
            MachineOp::DeleteSnapshot { snapshot_id } => {
                let id = Digest::parse(&snapshot_id).map_err(|_| OpError::missing(format!("no such snapshot: {snapshot_id}")))?;
                if !self.remove_and_sweep(move |store| store.remove_snapshot(&id)).await? {
                    return Err(OpError::missing(format!("no such snapshot: {snapshot_id}")));
                }
                body(Empty {})
            }
            MachineOp::ListSnapshots => {
                let snapshots = self.store.snapshots()?.into_iter().map(|s| self.snapshot_row(s)).collect::<Result<_, _>>()?;
                body(MachineSnapshotsReply { snapshots })
            }
            MachineOp::PromoteSnapshot { snapshot_id, name } => {
                let id = Digest::parse(&snapshot_id).map_err(|_| OpError::missing(format!("no such snapshot: {snapshot_id}")))?;
                let snapshot = self.store.snapshot(&id)?.ok_or_else(|| OpError::missing(format!("no such snapshot: {snapshot_id}")))?;
                let template_id = template_id(&name);
                self.store.record_template(&template_id, &name, &snapshot)?;
                body(MachinePromoteReply { template_id })
            }
            MachineOp::GetTemplate { template_id } => {
                let template =
                    self.store.template(&template_id)?.ok_or_else(|| OpError::missing(format!("no such template: {template_id}")))?;
                body(MachineTemplateReply { template: template_row(&template) })
            }
            MachineOp::ListTemplates => {
                body(MachineTemplatesReply { templates: self.store.templates()?.iter().map(template_row).collect() })
            }
            MachineOp::DeleteTemplate { template_id } => {
                let id = template_id.clone();
                if !self.remove_and_sweep(move |store| store.remove_template(&id)).await? {
                    return Err(OpError::missing(format!("no such template: {template_id}")));
                }
                body(Empty {})
            }
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
                replaces_machine: true,
                preview_urls: false,
                signed_urls: false,
                callback_relay: true,
                disk_snapshots: true,
                snapshots_any_life: true,
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
    /// mount, a cgroup of our own, and the kernel's nftables and veth for its network. Each refusal is one
    /// sentence for the doctor. Off the runtime thread, since it mounts and speaks netlink.
    pub async fn self_check(&self) -> Result<(), String> {
        let root = self.layout.root().to_path_buf();
        tokio::task::spawn_blocking(move || Self::self_check_on(&Layout::new(&root))).await.map_err(|e| e.to_string())?
    }

    fn self_check_on(layout: &Layout) -> Result<(), String> {
        // The read-only facts the doctor reads for the report, in one place, then the live proof below: a mount and
        // a cgroup this can make, which the read alone cannot promise. The two answer in the same words because
        // they are the same words.
        if let Some(reason) = crate::doctor::assess(&crate::doctor::read_facts()).blocked {
            return Err(reason);
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
        net::check()
    }

    pub fn capacity(&self) -> Result<PlaceCapacity, OpError> {
        let mut counts = MachineCounts { running: 0, paused: 0 };
        let (mut taken_mb, mut taken_cpu) = (0, 0.0);
        // A frozen workspace keeps every byte it holds and every core it was given and counts at its cap; a
        // stopped one holds nothing.
        for record in self.records()? {
            match self.state_of(&record) {
                MachineState::Gone => continue,
                MachineState::Paused => counts.paused += 1,
                MachineState::Running | MachineState::Starting => counts.running += 1,
            }
            if runtime::alive(&record.init) {
                taken_mb += record.mem_mb.unwrap_or(0);
                taken_cpu += record.cpu.unwrap_or(0.0);
            }
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
            cpu_taken: Some(taken_cpu),
            mem_taken_mb: Some(taken_mb),
            disk_free_bytes,
            images,
            machines: counts,
        })
    }

    async fn create(&self, spec: MachineSpec) -> Result<MachineHandle, OpError> {
        let image = spec.from_snapshot.clone().or_else(|| spec.template.clone()).unwrap_or_else(|| BASE_IMAGE.to_owned());
        // Read before the claim below, so the answer to a create the first one already made carries the same
        // sentence about the same size rather than going quiet on the second ask.
        let size = size_on_box(&self.facts, spec.cpu, spec.mem_mb);
        let id = match &spec.idempotency_key {
            Some(key) => format!("wsp-{}", workspace_word(key)),
            None => format!("wsp-{}", store::random_word()),
        };
        let dir = self.layout.workspace(&id);
        // The directory is the claim: a second create under the same key answers the workspace the first one made.
        if let Err(e) = fs::create_dir_all(self.layout.run()).and_then(|()| fs::create_dir(&dir)) {
            if e.kind() != io::ErrorKind::AlreadyExists {
                return Err(OpError::plain(format!("{}: {e}", dir.display())));
            }
            return match bundle::read_record(&self.layout.record(&id))? {
                Some(record) => Ok(noticed(self.handle(&record, Some(true), None), size.clamped)),
                None => Err(OpError::plain(format!("workspace {id} is being created"))),
            };
        }
        // Before the store and before youki: a copy of the checkout is the slowest thing a create does and the
        // one thing a person waits on, and a refusal here costs nothing else.
        let copy = match &spec.copy {
            Some(want) => match self.make_copy(&id, want).await {
                Ok(made) => Some(made),
                Err(e) => {
                    let _ = fs::remove_dir_all(&dir);
                    return Err(e);
                }
            },
            None => None,
        };
        let notice = notices([size.clamped.clone(), copy.as_ref().and_then(|made| self.plain_copy_notice(made))]);
        match self.build(&id, &image, &spec, &size, copy.clone()).await {
            Ok(record) => Ok(noticed(self.handle(&record, None, None), notice)),
            Err(e) => {
                // A workspace that would not come up is ours and nobody else's: nothing of it stays behind, the
                // copy it was given included, which the record does not carry yet where the boot failed early.
                let _ = self.remove(&id, None).await;
                if let Some(made) = &copy {
                    let _ = copy::copier_of(made.made).remove(&self.layout.copy_of(&id));
                }
                Err(e)
            }
        }
    }

    /// The workspace's own copy of a checkout this computer holds, made the way this disk makes one and timed.
    /// Off the runtime thread: a plain copy of a package tree is minutes of a core, and nothing else this daemon
    /// serves may wait behind it.
    async fn make_copy(&self, id: &str, want: &WorkspaceCopy) -> Result<CopyMade, OpError> {
        // The path the project takes inside, read through the same wall the boot's bind is built with and
        // before a byte is copied or anything is mounted: a refusal here costs nothing to take back.
        bundle::inside(&self.layout.rootfs(id), &want.at)?;
        let (from, to, copies) = (PathBuf::from(&want.from), self.layout.copy_of(id), self.layout.copies());
        let started = std::time::Instant::now();
        let made = tokio::task::spawn_blocking(move || -> io::Result<CopyWord> {
            let copier = copy::copier_for(&from, &copies)?;
            copier.copy(&from, &to)?;
            Ok(copier.word())
        })
        .await
        .map_err(|e| OpError::plain(e.to_string()))??;
        Ok(CopyMade { from: want.from.clone(), at: want.at.clone(), made, ms: started.elapsed().as_millis() as u64 })
    }

    /// What a create says where the copy cost every byte of the checkout; a reflink and a snapshot say nothing,
    /// since the place's row already carries the word and neither took a minute.
    fn plain_copy_notice(&self, made: &CopyMade) -> Option<String> {
        (made.made == CopyWord::Plain)
            .then(|| plain_copy_line(self.layout.root(), bundle::filesystem_at(self.layout.root()).as_deref(), made.ms))
    }

    async fn build(
        &self,
        id: &str,
        image: &str,
        spec: &MachineSpec,
        size: &SizeOnBox,
        copy: Option<CopyMade>,
    ) -> Result<Workspace, OpError> {
        // Held until the record is on disk, which is what makes the sweep keep the chain: a delete of the snapshot
        // or template the fork boots from waits here instead of taking the layer from under the mount.
        let _one_at_a_time = self.pulls.lock().await;
        let engine = spec.engine == Some(true);
        if engine {
            engine::socket_of(&crate::doctor::read_facts()).map_err(OpError::plain)?;
        }
        let chain = self.resolve_chain(image).await?;
        let hostname: String = id.chars().take(HOSTNAME_MAX).collect();
        let mut labels = BTreeMap::from([(WSP_LABEL.to_owned(), "1".to_owned())]);
        labels.extend(spec.labels.clone().unwrap_or_default());
        let record = Workspace {
            id: id.to_owned(),
            hostname,
            image: image.to_owned(),
            chain,
            labels,
            envs: spec.envs.clone().unwrap_or_default(),
            cpu: Some(size.cpu),
            mem_mb: Some(size.mem_mb),
            created_at: store::now_iso(),
            init: Init { pid: 0, started: 0, boot_id: String::new() },
            engine,
            copy,
        };
        self.boot(record).await
    }

    /// The workspace's processes from its record: the overlay over its chain and its own upper directory, the
    /// bundle, youki's create, the network, the start, and the forwards its record names. A first boot and a wake
    /// are the same road; a wake finds the upper directory as the stop left it, with everything the workspace wrote.
    async fn boot(&self, mut record: Workspace) -> Result<Workspace, OpError> {
        let id = record.id.clone();
        let lowers = self.lowers_of(&record.chain, &record.image)?;
        for dir in [self.layout.upper(&id), self.layout.work(&id), self.layout.rootfs(&id)] {
            fs::create_dir_all(&dir).map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))?;
        }
        bundle::write_etc(&self.layout.etc(&id), &record.hostname, None)?;
        bundle::mount_rootfs(&lowers, &self.layout.upper(&id), &self.layout.work(&id), &self.layout.rootfs(&id))?;
        // The copy into the rootfs before youki takes it: youki rebinds the rootfs as it pivots, so the project
        // travels inside with it, and the daemon goes on seeing it at the same path out here. A wake binds the
        // copy the stop left on disk, so everything the workspace wrote in the project is still there.
        if let Some(made) = &record.copy {
            bundle::bind_into(&self.layout.copy_of(&id), &bundle::inside(&self.layout.rootfs(&id), &made.at)?)?;
        }
        let engine_dir = record.engine.then(|| self.layout.engine(&id));
        if let Some(dir) = &engine_dir {
            fs::create_dir_all(dir).map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))?;
            engine::link_client_path(&self.layout.rootfs(&id))?;
        }
        let mut args = vec![profile::INIT_PATH.to_owned(), "runtime".to_owned(), "init".to_owned(), "--".to_owned()];
        args.extend(boot_cmd());
        let cgroup = self.layout.cgroup_name(&id);
        let config = Config {
            hostname: &record.hostname,
            args: &args,
            envs: &record.envs,
            cpu: record.cpu,
            mem_mb: record.mem_mb,
            cgroup: &cgroup,
            init: self.runtime.exe(),
            etc: &self.layout.etc(&id),
            engine: engine_dir.as_deref(),
        };
        bundle::write_json(&self.layout.config(&id), &bundle::config_json(&config))?;
        self.runtime.create(&id).await?;
        let pid = self.runtime.init_pid(&id)?.ok_or_else(|| OpError::plain(format!("workspace {id} was created without an init")))?;
        record.init = runtime::identity_of(pid)?;
        bundle::write_json(&self.layout.record(&id), &record)?;
        let network = self.net.up(&id, pid).await?;
        // The same inode the container has bound, so the line lands inside.
        bundle::write_etc(&self.layout.etc(&id), &record.hostname, Some(network.gateway))?;
        freeze::forbid_swap(&self.layout.cgroup_dir(&id))?;
        if record.engine {
            self.serve_engine(&id).await?;
        }
        self.runtime.start(&id).await?;
        self.net.restore(std::slice::from_ref(&id)).await?;
        if record.engine {
            self.join_ports(&record).await;
        }
        Ok(record)
    }

    /// Idle means stopped: the processes are killed, youki's state and the cgroup go, the network's link and
    /// listeners go, the overlay is detached. The upper directory, the record and the network record stay: they are
    /// the saved layer and what the wake boots it with.
    async fn stop(&self, record: &Workspace) -> Result<(), OpError> {
        self.stop_engine(&record.id).await;
        self.runtime.kill(&record.id, Some(&record.init)).await?;
        self.net.stop(&record.id).await?;
        bundle::unmount_under(&self.layout.rootfs(&record.id))?;
        Ok(())
    }

    /// A stopped workspace booted again from its upper directory.
    async fn wake(&self, record: Workspace) -> Result<Workspace, OpError> {
        if !self.layout.upper(&record.id).is_dir() {
            return Err(OpError::plain(format!("workspace {} has no saved layer to boot from", record.id)));
        }
        self.boot(record).await
    }

    /// The chain a name resolves to: an image, a template or a snapshot the store holds, else an image pulled into
    /// the store under that name. Under the store lock, which the caller holds.
    async fn resolve_chain(&self, name: &str) -> Result<Chain, OpError> {
        let store = Arc::clone(&self.store);
        let wanted = name.to_owned();
        tokio::task::spawn_blocking(move || -> Result<Chain, store::Error> {
            if let Some(chain) = store.chain_of(&wanted)? {
                return Ok(chain);
            }
            let source = Reference::parse(&wanted)?;
            Ok(store.pull(&wanted, &source, &mut Client::new())?.image.chain)
        })
        .await
        .map_err(|e| OpError::plain(e.to_string()))?
        .map_err(OpError::from)
    }

    /// The unpacked layers of a chain, as the overlay takes them.
    fn lowers_of(&self, chain: &Chain, name: &str) -> Result<Vec<PathBuf>, OpError> {
        chain
            .layers
            .iter()
            .map(|digest| {
                self.store.unpacked(digest).ok_or_else(|| OpError::plain(format!("layer {digest} of {name} is not unpacked in the store")))
            })
            .collect()
    }

    /// The snapshot as a job: named at once, run on a task of its own, read back through `snapshot_job`. A layer
    /// of a built workspace takes minutes to write on a small box, longer than any one frame over a link may wait.
    fn start_snapshot(&self, record: Workspace, name: String) -> String {
        let id = store::random_word();
        let job = Arc::new(SnapshotJob::default());
        self.jobs.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), Arc::clone(&job));
        let pulls = Arc::clone(&self.pulls);
        let store = Arc::clone(&self.store);
        let layout = Layout::new(self.layout.root());
        tokio::spawn(async move {
            let outcome = commit_snapshot(pulls, store, &layout, record, name, &job).await;
            *job.state.lock().unwrap_or_else(|e| e.into_inner()) = match outcome {
                Ok(snapshot) => JobState::Done(snapshot),
                Err(e) => JobState::Failed(e.message),
            };
        });
        id
    }

    /// One reading of a snapshot job; a job that failed is the refusal it failed with, every time it is asked.
    fn snapshot_job(&self, id: &str) -> Result<MachineSnapshotJobReply, OpError> {
        let job = self
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| OpError::missing(format!("no such snapshot job: {id}")))?;
        // The state first: a job read done after its bytes were read would hand back a count short of the layer.
        let state = job.state.lock().unwrap_or_else(|e| e.into_inner());
        let bytes = job.written.load(Ordering::Relaxed);
        let total = job.total.get().copied();
        match &*state {
            JobState::Running => Ok(MachineSnapshotJobReply { state: SnapshotJobState::Running, bytes, total, snapshot_id: None }),
            JobState::Done(snapshot) => {
                Ok(MachineSnapshotJobReply { state: SnapshotJobState::Done, bytes, total, snapshot_id: Some(snapshot.id.to_string()) })
            }
            JobState::Failed(message) => Err(OpError::plain(message.clone())),
        }
    }

    /// A record dropped and the store swept of what no record names and no workspace holds, both under the store
    /// lock so a create resolving that record has finished, or has not begun, when it goes; the sweep runs off the
    /// runtime thread and never beside a pull or a commit. Answers whether the record was there.
    async fn remove_and_sweep(&self, remove: impl FnOnce(&Store) -> Result<bool, store::Error> + Send + 'static) -> Result<bool, OpError> {
        let _one_at_a_time = self.pulls.lock().await;
        let store = Arc::clone(&self.store);
        let held = held_chains(&self.layout)?;
        tokio::task::spawn_blocking(move || -> Result<bool, store::Error> {
            if !remove(&store)? {
                return Ok(false);
            }
            store.sweep(&held)?;
            Ok(true)
        })
        .await
        .map_err(|e| OpError::plain(e.to_string()))?
        .map_err(OpError::from)
    }

    /// The row a snapshot lists as: its own layer's bytes, and the snapshot it was taken under when it was one.
    fn snapshot_row(&self, snapshot: Snapshot) -> Result<SnapshotRow, OpError> {
        let parent = match Digest::parse(&snapshot.from) {
            Ok(id) => self.store.snapshot(&id)?.map(|_| snapshot.from.clone()),
            Err(_) => None,
        };
        Ok(SnapshotRow {
            id: snapshot.id.to_string(),
            name: Some(snapshot.name),
            size_bytes: snapshot.layer_bytes,
            created_at: Some(snapshot.created_at),
            parent: Some(parent),
        })
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

    /// Kills, deletes, takes the network down, unmounts and removes every trace of the workspace under the root,
    /// and every container, network and volume it made on the engine, before its rootfs those containers may bind
    /// goes. An engine that does not answer leaves them, and the workspace goes all the same.
    async fn remove(&self, id: &str, init: Option<&Init>) -> Result<(), OpError> {
        self.stop_engine(id).await;
        let record = bundle::read_record(&self.layout.record(id))?;
        if record.as_ref().is_some_and(|record| record.engine) {
            if let Ok(socket) = engine::socket_of(&crate::doctor::read_facts()) {
                let _ = engine::remove_all(&socket, id).await;
            }
        }
        self.runtime.kill(id, init).await?;
        self.net.down(id).await?;
        bundle::unmount_under(&self.layout.rootfs(id))?;
        // After the unmount, and the way it was made: a snapshot is a subvolume the kernel takes away, a copied
        // tree is a tree. The copy is the workspace's own, so it goes with it.
        if let Some(made) = record.and_then(|record| record.copy) {
            copy::copier_of(made.made).remove(&self.layout.copy_of(id))?;
        }
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
            notice: None,
            roads: MachineRoads { preview_url: true, daemon_answers: true, put_bytes: true, describe: true, facts: false, metrics: true },
        }
    }

    /// One workspace as this computer reads it now: the sizes its cgroup was written with, what it holds of them
    /// this moment, and where its processes, its files and its address are. Every live figure is read where the
    /// kernel keeps it and dropped where it cannot be had, since a workspace may stop between the listing and this
    /// and a reading that refused for it would take the whole row with it; the sizes and the paths always answer.
    fn reading(&self, record: &Workspace) -> MachineReading {
        let cgroup = self.layout.cgroup_dir(&record.id);
        let live = runtime::alive(&record.init);
        MachineReading {
            state: self.state_of(record),
            cpu: record.cpu,
            mem_mb: record.mem_mb,
            mem_bytes: live.then(|| freeze::memory_current(&cgroup).ok()).flatten(),
            cpu_usage_usec: live.then(|| freeze::cpu_usage_usec(&cgroup).ok()).flatten(),
            uptime_ms: live.then(|| runtime::uptime_ms(&record.init).ok()).flatten(),
            procs: live.then(|| freeze::pids_in(&cgroup).ok()).flatten(),
            address: self.net.record(&record.id).ok().flatten().map(|network| network.address.to_string()),
            cgroup: cgroup.display().to_string(),
            upper: self.layout.upper(&record.id).display().to_string(),
        }
    }

    fn record(&self, id: &str) -> Result<Workspace, OpError> {
        bundle::read_record(&self.layout.record(id))?.ok_or_else(|| OpError::no_workspace(id))
    }

    /// The record of a workspace whose init is the process it named; a stopped one has nothing to exec into.
    fn running(&self, id: &str) -> Result<Workspace, OpError> {
        let record = self.record(id)?;
        if !runtime::alive(&record.init) {
            return Err(OpError::plain(format!("workspace {} is stopped", record.id)));
        }
        Ok(record)
    }

    fn records(&self) -> Result<Vec<Workspace>, OpError> {
        records_under(&self.layout)
    }
}

/// A snapshot in flight or finished: the layer's bytes written so far, the upper directory's bytes once counted,
/// and how it ended.
#[derive(Default)]
struct SnapshotJob {
    written: AtomicU64,
    total: OnceLock<u64>,
    state: std::sync::Mutex<JobState>,
}

#[derive(Default)]
enum JobState {
    #[default]
    Running,
    Done(Snapshot),
    Failed(String),
}

/// The upper directory committed to the store as a layer under the name, over the chain the workspace booted from,
/// under the store lock as every commit is. A running workspace is held still by the freezer only while its size
/// is counted and its layer is read into the blob, and thawed however that read ends; it runs again while the blob
/// unpacks and the record is written. One already frozen or stopped is read as it is. A freeze that does not settle
/// is undone by the freezer itself, so nothing here is left frozen behind a failure.
async fn commit_snapshot(
    pulls: Arc<Mutex<()>>,
    store: Arc<Store>,
    layout: &Layout,
    record: Workspace,
    name: String,
    job: &Arc<SnapshotJob>,
) -> Result<Snapshot, OpError> {
    let _one_at_a_time = pulls.lock().await;
    let cgroup = layout.cgroup_dir(&record.id);
    let hold = runtime::alive(&record.init) && !freeze::frozen(&cgroup)?;
    if hold {
        freeze::freeze(cgroup.clone()).await?;
    }
    let upper = layout.upper(&record.id);
    let progress = Arc::clone(job);
    let reading = Arc::clone(&store);
    let committed = tokio::task::spawn_blocking(move || {
        let total = store::tree_bytes(&upper).map_err(|source| store::Error::Io { path: upper.clone(), source })?;
        let _ = progress.total.set(total);
        reading.commit_blob(|out| snapshot::write_layer(&upper, out, &progress.written))
    })
    .await
    .map_err(|e| OpError::plain(e.to_string()));
    if hold {
        freeze::thaw(cgroup).await?;
    }
    let committed = committed??;
    tokio::task::spawn_blocking(move || store.record_snapshot(&name, &record.id, &record.image, &record.chain, &committed))
        .await
        .map_err(|e| OpError::plain(e.to_string()))?
        .map_err(OpError::from)
}

/// The join of a container's published port to the workspace's loopback, made off the proxy's own task once the
/// engine has taken the start; a workspace whose init is gone gets none.
struct Inward {
    net: Arc<Net>,
    root: PathBuf,
}

impl Ports for Inward {
    fn published(&self, workspace: &str, inside: u16, box_port: u16) {
        let Ok(Some(record)) = bundle::read_record(&Layout::new(&self.root).record(workspace)) else { return };
        if !runtime::alive(&record.init) {
            return;
        }
        let net = Arc::clone(&self.net);
        let id = workspace.to_owned();
        let pid = record.init.pid;
        tokio::spawn(async move {
            let _ = net.forward_inward(&id, pid, inside, box_port).await;
        });
    }
}

fn records_under(layout: &Layout) -> Result<Vec<Workspace>, OpError> {
    {
        let run = layout.run();
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
}

/// Every record whose init is not the process it named any more and whose stop nobody asked for: its overlay is
/// detached and youki's state removed, so no read goes through the stale pid; the run directory with its upper
/// stays, and the wake boots from it. A workspace stopped on purpose left no state behind and is not named.
fn mark_stopped(layout: &Layout) -> Result<Vec<String>, OpError> {
    let mut stopped = Vec::new();
    for record in records_under(layout)? {
        if runtime::alive(&record.init) {
            continue;
        }
        bundle::unmount_under(&layout.rootfs(&record.id))?;
        let state = layout.state_of(&record.id);
        if state.exists() {
            fs::remove_dir_all(&state).map_err(|e| OpError::plain(format!("{}: {e}", state.display())))?;
            stopped.push(record.id);
        }
    }
    Ok(stopped)
}

/// The chains every workspace under the root booted from, running or stopped: the sweep keeps their layers.
fn held_chains(layout: &Layout) -> Result<Vec<Chain>, OpError> {
    Ok(records_under(layout)?.into_iter().map(|record| record.chain).collect())
}

/// The workspaces whose init is still the process their record names: created, running or frozen.
fn running_ids(layout: &Layout) -> Result<Vec<String>, OpError> {
    Ok(records_under(layout)?.into_iter().filter(|record| runtime::alive(&record.init)).map(|record| record.id).collect())
}

impl Ops {
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

    /// created reads starting, a frozen cgroup reads paused, and a stopped workspace reads paused too: under a
    /// disk pause a stop is a nap, as the Docker backend reads an exited container, and its upper directory is
    /// what the wake boots. A record whose init is not the process it named is stopped before youki is asked,
    /// since youki reads any process on that pid as the container; one whose upper directory is gone too is gone.
    /// A live init whose youki state reads stopped, is missing or does not load is a workspace this daemon can
    /// neither nap nor wake, and reads gone rather than a nap the resume could not do.
    pub fn state_of(&self, record: &Workspace) -> MachineState {
        if !runtime::alive(&record.init) {
            return if self.layout.upper(&record.id).is_dir() { MachineState::Paused } else { MachineState::Gone };
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

/// A template's id from the name it was promoted under, as the Docker backend tags one.
pub fn template_id(name: &str) -> String {
    format!("{TEMPLATE_REPO}/{}:{TEMPLATE_TAG}", workspace_word(name))
}

/// A promoted snapshot is durable the moment its record exists, so its template reads ready at once.
fn template_row(template: &store::Template) -> TemplateRow {
    TemplateRow {
        id: template.id.clone(),
        name: template.name.clone(),
        status: TemplateStatus::Ready,
        error: None,
        created_at: Some(template.created_at.clone()),
    }
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
    use crate::size::LEAST_MEM_MB;

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

    /// The box the size rule is read against here, as the size module's own tests read it: two cores and four
    /// gigabytes, the shape of the box a fork took whole.
    fn small_box() -> BoxFacts {
        BoxFacts { cores: 2, mem_mb: 4096 }
    }

    #[test]
    fn the_clamped_size_is_what_the_cgroup_is_written_with() {
        let given = size_on_box(&small_box(), Some(2.0), Some(4096));
        let spec = bundle::config_json(&Config {
            hostname: "wsp-x",
            args: &["/bin/true".to_owned()],
            envs: &BTreeMap::new(),
            cpu: Some(given.cpu),
            mem_mb: Some(given.mem_mb),
            cgroup: "/wsp/wsp-x",
            init: Path::new("/bin/true"),
            etc: Path::new("/tmp"),
            engine: None,
        });
        // One core of every period, and half of the box's four gigabytes.
        assert_eq!(spec["linux"]["resources"]["cpu"], serde_json::json!({ "quota": 100_000, "period": 100_000 }));
        assert_eq!(spec["linux"]["resources"]["memory"], serde_json::json!({ "limit": 2_147_483_648u64 }));
    }

    #[test]
    fn the_backend_facts_are_the_plans() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true")).unwrap();
        let facts = ops.backend_facts();
        assert_eq!(facts.offer, "runtime");
        assert_eq!(facts.capabilities.pause_mode, Some(PauseMode::Disk));
        assert!(!facts.capabilities.live_clone_forks && !facts.capabilities.preview_urls);
        assert!(!facts.capabilities.signed_urls && !facts.capabilities.kept);
        assert!(facts.capabilities.replaces_machine && facts.capabilities.callback_relay && facts.capabilities.disk_snapshots);
        assert!(facts.capabilities.snapshots_any_life && facts.capabilities.snapshot_listing && facts.capabilities.templates);
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
        let given = size_on_box(&ops.facts(), Some(9999.0), Some(u64::MAX));
        assert_eq!((given.cpu, given.mem_mb), (ops.facts().machine_cpu(), ops.facts().machine_mem_mb()));
        assert!(given.clamped.is_some());
        let room = size_on_box(&ops.facts(), Some(1.0), Some(LEAST_MEM_MB));
        assert_eq!((room.cpu, room.mem_mb, room.clamped), (1.0, LEAST_MEM_MB, None));
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
            "machine.previewUrl",
        ] {
            let reply: Value = serde_json::from_str(
                &ops.answer(
                    Some(RequestId::from(1)),
                    &serde_json::json!({ "id": 1, "op": op, "machineId": "gone", "cmd": "true", "port": 7070 }),
                )
                .await,
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
        let none: Value = serde_json::from_str(
            &ops.answer(Some(RequestId::from(4)), &serde_json::json!({ "id": 4, "op": "machine.listSnapshots" })).await,
        )
        .unwrap();
        assert_eq!(none, serde_json::json!({ "id": 4, "ok": true, "snapshots": [] }));
        let none: Value = serde_json::from_str(
            &ops.answer(Some(RequestId::from(5)), &serde_json::json!({ "id": 5, "op": "machine.listTemplates" })).await,
        )
        .unwrap();
        assert_eq!(none, serde_json::json!({ "id": 5, "ok": true, "templates": [] }));
        for (op, field, word) in [
            ("machine.deleteSnapshot", "snapshotId", "snapshot"),
            ("machine.promoteSnapshot", "snapshotId", "snapshot"),
            ("machine.getTemplate", "templateId", "template"),
            ("machine.deleteTemplate", "templateId", "template"),
            ("machine.snapshotJob", "job", "snapshot job"),
        ] {
            let reply: Value = serde_json::from_str(
                &ops.answer(Some(RequestId::from(6)), &serde_json::json!({ "id": 6, "op": op, field: "nothing", "name": "x" })).await,
            )
            .unwrap();
            assert_eq!(
                reply,
                serde_json::json!({ "id": 6, "ok": false, "error": format!("no such {word}: nothing"), "kind": "missing", "status": 404 }),
                "{op}"
            );
        }
    }

    #[tokio::test]
    async fn a_snapshot_job_that_failed_is_its_refusal_on_every_ask_and_a_running_one_reads_its_count() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true")).unwrap();
        let failed = Arc::new(SnapshotJob::default());
        *failed.state.lock().unwrap() =
            JobState::Failed("/var/lib/wsp/layers/blobs/sha256/commit-x.partial: No space left on device".into());
        let running = Arc::new(SnapshotJob::default());
        running.written.store(1_520_442_115, Ordering::Relaxed);
        let _ = running.total.set(5_284_823_040);
        ops.jobs.lock().unwrap().insert("failed".into(), failed);
        ops.jobs.lock().unwrap().insert("running".into(), running);
        for _ in 0..2 {
            let reply: Value = serde_json::from_str(
                &ops.answer(Some(RequestId::from(8)), &serde_json::json!({ "id": 8, "op": "machine.snapshotJob", "job": "failed" })).await,
            )
            .unwrap();
            assert_eq!(
                reply,
                serde_json::json!({ "id": 8, "ok": false, "error": "/var/lib/wsp/layers/blobs/sha256/commit-x.partial: No space left on device" })
            );
        }
        let reply: Value = serde_json::from_str(
            &ops.answer(Some(RequestId::from(9)), &serde_json::json!({ "id": 9, "op": "machine.snapshotJob", "job": "running" })).await,
        )
        .unwrap();
        assert_eq!(
            reply,
            serde_json::json!({ "id": 9, "ok": true, "state": "running", "bytes": 1_520_442_115u64, "total": 5_284_823_040u64 })
        );
    }

    #[test]
    fn what_a_create_says_is_the_size_it_gave_and_the_minutes_a_plain_copy_took() {
        assert_eq!(notices([None, None]), None);
        assert_eq!(notices([Some("cpu clamped to 1".to_owned()), None]), Some("cpu clamped to 1".to_owned()));
        assert_eq!(
            notices([Some("cpu clamped to 1".to_owned()), Some("copied plainly in 38 s".to_owned())]),
            Some("cpu clamped to 1; copied plainly in 38 s".to_owned())
        );
        // The filesystem is what decides whether a copy shares blocks, so the sentence names it and the root.
        assert_eq!(
            plain_copy_line(Path::new("/wsp"), Some("ext4"), 38_400),
            "copied plainly in 38 s: /wsp is on ext4, which shares no blocks between copies"
        );
        // A box that will not say what it is on still says how long it took, and a copy under a second is a
        // second rather than none.
        assert_eq!(plain_copy_line(Path::new("/wsp"), None, 120), "copied plainly in 1 s: /wsp shares no blocks between copies");
    }

    #[test]
    fn a_template_id_is_the_docker_backends_tag_over_the_name() {
        assert_eq!(template_id("dev"), "wsp/dev:template");
        assert_eq!(template_id("My Golden/v2"), "wsp/my-golden-v2:template");
    }

    /// One workspace on disk as a daemon that stopped left it: its record under the run directory, its upper
    /// directory (what a nap boots from), and the chain it mounts.
    ///
    /// No rootfs directory, and that is the whole of what makes this runnable by anyone: the open unmounts the
    /// rootfs of every record whose init is gone, and umount2 resolves the path before it checks the capability,
    /// so a path that is not there answers ENOENT to any login while one that is answers EPERM to a login that is
    /// not root. A mounted rootfs is a thing a boot makes, not a thing a record carries, and none of what this
    /// proves reads it.
    fn left_on_disk(root: &Path, id: &str, chain: &Chain) {
        let layout = Layout::new(root);
        fs::create_dir_all(layout.upper(id)).unwrap();
        let record = Workspace {
            id: id.to_owned(),
            hostname: id.to_owned(),
            image: "ubuntu:24.04".to_owned(),
            chain: chain.clone(),
            labels: BTreeMap::from([(WSP_LABEL.to_owned(), "1".to_owned())]),
            envs: BTreeMap::new(),
            cpu: Some(1.0),
            mem_mb: Some(1024),
            created_at: "1970-01-01T00:00:00.000Z".to_owned(),
            // A pid nothing holds: the daemon came up after the box did, so the workspace reads stopped, which
            // under a disk pause is a nap its upper directory is waiting to be woken from.
            init: Init { pid: i32::MAX, started: 0, boot_id: String::new() },
            engine: false,
            copy: None,
        };
        fs::write(layout.record(id), serde_json::to_vec(&record).unwrap()).unwrap();
    }

    /// A layer unpacked in the store, as a pull left it; the tree is the form a fork mounts.
    fn unpacked_layer(root: &Path, bytes: &[u8]) -> Digest {
        let digest = Digest::of(bytes);
        let tree = root.join("layers").join("unpacked").join(digest.hex());
        fs::create_dir_all(&tree).unwrap();
        fs::write(tree.join("marker"), bytes).unwrap();
        digest
    }

    #[test]
    fn a_daemon_that_comes_up_finds_the_workspaces_it_left_and_keeps_the_layers_their_forks_mount() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // The store is opened once so its directories are there before anything is written into them.
        drop(Ops::open(root, PathBuf::from("/bin/true")).unwrap());
        let config = unpacked_layer(root, b"config of the image these forked from");
        let layer = unpacked_layer(root, b"the layer they mount");
        let orphan = unpacked_layer(root, b"a layer no record names");
        let chain = Chain { config: config.clone(), layers: vec![layer.clone()] };
        left_on_disk(root, "wsp-one", &chain);
        left_on_disk(root, "wsp-two", &chain);

        let again = Ops::open(root, PathBuf::from("/bin/true")).unwrap();
        // The records are there and the listing names both, with the size each was created at.
        let listed = again.list(None).unwrap();
        assert_eq!(listed.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["wsp-one", "wsp-two"]);
        assert!(listed.iter().all(|row| row.state == MachineState::Paused && row.size == Some(WorkspaceSize { cpu: 1.0, mem_mb: 1024 })));

        // The layers both forks mount are still unpacked under the store, so a wake has something to mount; the
        // one no record names is what the sweep at the open took.
        for digest in [&config, &layer] {
            assert!(again.store.unpacked(digest).is_some(), "{} went with the sweep", digest.hex());
        }
        assert_eq!(again.swept_at_open().unpacked, vec![orphan.clone()]);
        assert!(!root.join("layers").join("unpacked").join(orphan.hex()).exists());

        // And the upper directory each nap is waiting to be woken from is where the record left it.
        for id in ["wsp-one", "wsp-two"] {
            assert!(Layout::new(root).upper(id).is_dir(), "{id} lost its upper directory");
        }
    }

    #[test]
    fn a_record_that_does_not_read_refuses_the_open_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("run").join("wsp-broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("workspace.json"), "{ not json").unwrap();
        let refused = match Ops::open(dir.path(), PathBuf::from("/bin/true")) {
            Ok(_) => panic!("a record that does not read opened"),
            Err(e) => e.to_string(),
        };
        assert!(refused.contains("wsp-broken"), "{refused}");
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
