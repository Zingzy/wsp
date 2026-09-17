// SPDX-License-Identifier: AGPL-3.0-only
//! Every machine op on the link, answered as the Docker backend on a place answers them, so the host's link
//! backend needs no change: the same handles, rows and results, and every refusal as `{ ok: false, error, kind,
//! status }` with `kind: missing` for a workspace nothing here knows. A workspace is a record under the run
//! directory, a container youki made from this computer's own directories and one copy of a checkout on it, its
//! cgroup, and its network. This computer keeps no image: a create that names a template or a snapshot is
//! refused in one sentence, and nothing here pulls, builds, saves or lists one. Idle means stopped: a pause kills
//! the processes and takes the network down, the workspace's upper directories stay with its copy, and the wake
//! mounts the computer again and boots from them with the same id, address and forwards; a workspace labelled to
//! keep running is frozen instead.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;
use wsp_frames::{
    words, BackendFacts, BackendPricing, Capabilities, CopyWord, DaemonErrorResponse, DaemonSupervisor, ExecResult, Lifecycle,
    LifecycleBudgets, MachineAnswersReply, MachineCounts, MachineErrorKind, MachineExecReply, MachineHandle, MachineHandleReply,
    MachineKind, MachineLinkRequest, MachineListReply, MachineListRow, MachineOp, MachineReachReply, MachineReading, MachineReadingReply,
    MachineRoads, MachineSeen, MachineShape, MachineShapeReply, MachineSizeOffer, MachineSpec, MachineState, MachineStateReply, PauseMode,
    PlaceCapacity, PreviewReach, Reply, RequestId, Share, SnapshotStoragePricing, WorkspaceCopy, WorkspaceSize,
};

use crate::bundle::{self, Config, CopyMade, Init, Layout, Workspace};
use crate::copy;
use crate::engine::{self, Fence, Ports};
use crate::freeze;
use crate::net::{self, Net};
use crate::profile;
use crate::runtime::{self, Runtime, Status};
use crate::size::{size_on_box, BoxFacts, SizeOnBox};
use crate::{answer_machine_op, no_backend_refusal};

/// The id of the offer this computer serves, which the host stamps on every fork made here.
pub const OFFER: &str = "runtime";
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
    runtime: Runtime,
    net: Arc<Net>,
    /// The fenced engine socket's accept loop of every running workspace that asked for one.
    engines: Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>,
    facts: BoxFacts,
    stopped: Vec<String>,
    net_swept: net::Swept,
    unfinished: Unfinished,
}

/// What the open took away of creates that never finished: a copy still being made and a claimed run directory
/// with no record in it are both what a daemon that died in the middle of a create leaves, and neither is a
/// workspace anything can name.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Unfinished {
    pub copies: Vec<String>,
    pub claims: Vec<String>,
}

impl Unfinished {
    pub fn is_empty(&self) -> bool {
        self.copies.is_empty() && self.claims.is_empty()
    }
}

impl Ops {
    /// Opens the root, sweeps the creates that never finished, reads the box, marks every workspace whose init is
    /// gone as stopped (a reboot, or a daemon that was not there when the init died, leaves its record, its upper
    /// directories and youki's state behind, and youki reads any process on the old pid as the container), and
    /// sweeps the network of every workspace that is not running. `exe` is this binary. The forwards of the
    /// workspaces still running come back with `restore`, which wants the runtime the listeners live on.
    pub fn open(root: &Path, exe: PathBuf) -> Result<Ops, OpError> {
        // Where the root was put, before a directory is made under it: every workspace here reads the computer's
        // own system directories through an overlay whose upper sits under this root, so a root inside one of
        // them gives every workspace its own upper, and its neighbours', to read inside the tree it overlays.
        // Refused whole rather than served: a daemon that made its folders and then failed every create left a
        // person reading `ready` and nothing else.
        if let Some(reason) = crate::doctor::root_under_a_lower(root) {
            return Err(OpError::plain(reason));
        }
        let layout = Layout::new(root);
        for dir in [layout.run(), layout.state(), layout.copies()] {
            fs::create_dir_all(&dir).map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))?;
        }
        // The logins directory is made before any sign-in on this computer asks for it, and only this login may
        // read it: what lands under it is the person's own sign-in for every workspace here.
        let logins = layout.logins();
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&logins)
            .map_err(|e| OpError::plain(format!("{}: {e}", logins.display())))?;
        // Before anything reads the run directory as a list of workspaces: what a create that died left is not
        // one, and a copy that was still being made is not a copy.
        let unfinished = sweep_unfinished(&layout)?;
        let runtime = Runtime::new(root, exe);
        let stopped = mark_stopped(&layout)?;
        let running = running_ids(&layout)?;
        let (net, net_swept) = Net::open(Layout::new(root), &running).map_err(|e| OpError::plain(format!("{}: {e}", root.display())))?;
        Ok(Ops {
            layout,
            runtime,
            net: Arc::new(net),
            engines: Mutex::new(BTreeMap::new()),
            facts: BoxFacts::read(),
            stopped,
            net_swept,
            unfinished,
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

    /// The workspaces found stopped at open, their init gone.
    pub fn stopped_at_open(&self) -> &[String] {
        &self.stopped
    }

    /// What the network sweep at open removed.
    pub fn net_swept_at_open(&self) -> &net::Swept {
        &self.net_swept
    }

    /// What the open took away of creates that never finished.
    pub fn unfinished_at_open(&self) -> &Unfinished {
        &self.unfinished
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
                // Every overlay's upper under one directory, so this is the whole of what the workspace has
                // written since it booted, the box's own directories not counted.
                let upper = self.layout.upper(&record.id);
                // Off the runtime thread: a workspace after a build holds hundreds of thousands of files.
                let used_bytes = tokio::task::spawn_blocking(move || copy::tree_bytes(&upper).ok()).await.ok().flatten();
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
                // This computer keeps no image: a workspace here is a copy of the computer itself, so there is
                // nothing to save a machine's disk into, nothing to name and nothing to list.
                disk_snapshots: false,
                images: false,
                snapshots_any_life: false,
                snapshot_listing: false,
                templates: false,
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
            // Nothing boots from a name here, so there is no name to offer for a kind.
            base_templates: None,
            logins: Some(self.layout.logins().to_string_lossy().into_owned()),
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
        // Where the root was put, in the same words the open refuses it with: every workspace here reads the
        // computer's own system directories through an overlay whose upper is under this root, so a root inside
        // one of them gives a workspace its own upper to read. The open makes nothing under such a root, and
        // this is the sentence the host reads when it asks.
        if let Some(reason) = crate::doctor::root_under_a_lower(layout.root()) {
            return Err(reason);
        }
        // And whether this computer's own directories can be a workspace at all: /usr is where every tool a
        // workspace runs comes from, so a root that keeps /bin of its own is named here and not at a create.
        if let Some(reason) = bundle::unmerged_root().map_err(|e| e.to_string())? {
            return Err(reason);
        }
        let check = layout.check();
        let (upper, work, merged) = (check.join("upper"), check.join("work"), check.join("merged"));
        // One of the overlays a workspace is made of, over the box's own directory rather than over an empty
        // one: what a create does, done once here, so a box that refuses it says so at the dial.
        let lower = Path::new(crate::doctor::OVERLAID[0]);
        let overlay = (|| -> Result<(), String> {
            for dir in [&upper, &work, &merged] {
                fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            bundle::mount_overlay(lower, &upper, &work, &merged).map_err(|e| e.to_string())?;
            bundle::unmount(&merged).map_err(|e| e.to_string())
        })();
        let _ = fs::remove_dir_all(&check);
        overlay.map_err(|e| format!("this computer refuses an overlay mount of {}: {e}", lower.display()))?;
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
        Ok(PlaceCapacity {
            cores: self.facts.cores,
            mem_mb: self.facts.mem_mb,
            mem_room_mb: machine_mem_mb.saturating_sub(taken_mb),
            machine_mem_mb,
            cpu_taken: Some(taken_cpu),
            mem_taken_mb: Some(taken_mb),
            disk_free_bytes,
            // No image is kept here, so the room for one more workspace is the memory rule alone.
            images: Vec::new(),
            machines: counts,
        })
    }

    async fn create(&self, spec: MachineSpec) -> Result<MachineHandle, OpError> {
        // A workspace here is made of this computer's own directories, so a name for an image to boot from is
        // not something to fall back from: it is a create meant for another kind of place.
        if spec.template.is_some() || spec.from_snapshot.is_some() {
            return Err(OpError::plain(words::NO_IMAGES_HERE));
        }
        // Read before the claim below, so the answer to a create the first one already made carries the same
        // sentence about the same size rather than going quiet on the second ask.
        let size = size_on_box(&self.facts, spec.cpu, spec.mem_mb);
        // Before the claim and before anything is mounted: a source this daemon does not share out is refused,
        // and a refusal here costs nothing to take back.
        let shares = self.shares_of(&spec)?;
        let id = match &spec.idempotency_key {
            Some(key) => format!("wsp-{}", workspace_word(key)),
            None => format!("wsp-{}", random_word()),
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
        // Before anything is mounted and before youki: a copy of the checkout is the slowest thing a create does
        // and the one thing a person waits on, and a refusal here costs nothing else.
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
        match self.build(&id, &spec, &size, copy.clone(), shares).await {
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

    /// The logins a create asks for, held to one rule: a file under the directory this daemon shares them out of.
    /// A source anywhere else on the box is refused, since a bind mount lands on the workspace's own files and is
    /// the one thing a slip cannot be taken back; so is one that is there and is not a file, which the boot would
    /// otherwise pass over without a word. A source that is not there yet is a login nobody has signed in on this
    /// computer: the boot passes that over and the wake after the sign-in binds it. The wire has already read both
    /// paths as paths; this is what reads where the source is and what it is.
    fn shares_of(&self, spec: &MachineSpec) -> Result<Vec<Share>, OpError> {
        let logins = self.layout.logins();
        let asked = spec.shares.clone().unwrap_or_default();
        for share in &asked {
            // Held to the wire's own rule rather than to a copy of it, as the bind under a rootfs is: a source
            // that walks up out of the logins directory resolves to a path on the box like any other.
            let at = Path::new(&share.source);
            let under = wsp_frames::is_plain_path(&share.source) && at.strip_prefix(&logins).is_ok_and(|rest| rest.iter().next().is_some());
            if !under || (at.exists() && !at.is_file()) {
                return Err(OpError::plain(format!(
                    "a login shared into a workspace is a file under {}, and {} is not one",
                    logins.display(),
                    share.source
                )));
            }
        }
        Ok(asked)
    }

    /// The workspace's own copy of a checkout this computer holds, made the way this disk makes one and timed.
    /// Off the runtime thread: a plain copy of a package tree is minutes of a core, and nothing else this daemon
    /// serves may wait behind it.
    async fn make_copy(&self, id: &str, want: &WorkspaceCopy) -> Result<CopyMade, OpError> {
        // The path the project takes inside, read through the same wall the boot's bind is built with and
        // before a byte is copied or anything is mounted: a refusal here costs nothing to take back.
        bundle::inside(&self.layout.rootfs(id), &want.at)?;
        // Made under a name that says it is not finished and renamed into place by one directory entry once it
        // is: a create that dies in the middle of a copy, which a kernel or a disk can always make happen,
        // leaves something the open sweeps rather than a copy of half a checkout that reads as whole.
        let (from, being_made, to) = (PathBuf::from(&want.from), self.layout.copy_being_made(id), self.layout.copy_of(id));
        let copies = self.layout.copies();
        let started = std::time::Instant::now();
        let made = tokio::task::spawn_blocking(move || -> io::Result<CopyWord> {
            let copier = copy::copier_for(&from, &copies)?;
            let _ = copier.remove(&being_made);
            copier.copy(&from, &being_made)?;
            match fs::rename(&being_made, &to) {
                Ok(()) => Ok(copier.word()),
                Err(e) => {
                    let _ = copier.remove(&being_made);
                    Err(io::Error::new(e.kind(), format!("{}: {e}", to.display())))
                }
            }
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
        spec: &MachineSpec,
        size: &SizeOnBox,
        copy: Option<CopyMade>,
        shares: Vec<Share>,
    ) -> Result<Workspace, OpError> {
        let engine = spec.engine == Some(true);
        if engine {
            engine::socket_of(&crate::doctor::read_facts()).map_err(OpError::plain)?;
        }
        let hostname: String = id.chars().take(HOSTNAME_MAX).collect();
        let mut labels = BTreeMap::from([(WSP_LABEL.to_owned(), "1".to_owned())]);
        labels.extend(spec.labels.clone().unwrap_or_default());
        let record = Workspace {
            id: id.to_owned(),
            hostname,
            labels,
            envs: spec.envs.clone().unwrap_or_default(),
            cpu: Some(size.cpu),
            mem_mb: Some(size.mem_mb),
            created_at: now_iso(),
            init: Init { pid: 0, started: 0, boot_id: String::new() },
            engine,
            copy,
            shares,
        };
        self.boot(record).await
    }

    /// The workspace's processes from its record: the computer's own directories under the workspace's upper
    /// directories, the bundle, youki's create, the network, the start, and the forwards its record names. A
    /// first boot and a wake are the same road; a wake finds the upper directories as the stop left them, with
    /// everything the workspace wrote, over the box's directories as they are now.
    async fn boot(&self, mut record: Workspace) -> Result<Workspace, OpError> {
        let id = record.id.clone();
        bundle::write_etc(&self.layout.etc(&id), &record.hostname, None)?;
        bundle::mount_computer(&self.layout, &id)?;
        // The copy into the rootfs before youki takes it: youki rebinds the rootfs as it pivots, so the project
        // travels inside with it, and the daemon goes on seeing it at the same path out here. A wake binds the
        // copy the stop left on disk, so everything the workspace wrote in the project is still there.
        if let Some(made) = &record.copy {
            bundle::bind_into(&self.layout.copy_of(&id), &bundle::inside(&self.layout.rootfs(&id), &made.at)?)?;
        }
        // The computer's own logins, each mounted at the path its tool reads inside. A file bind needs the file
        // to be there inside, so the runtime makes an empty one where the image carries none; a login this
        // computer does not hold yet is no mount at all, and the wake after the sign-in is what brings it.
        let mut shares = Vec::new();
        for share in &record.shares {
            if !Path::new(&share.source).is_file() {
                continue;
            }
            bundle::empty_file(&bundle::inside(&self.layout.rootfs(&id), &share.target)?)?;
            shares.push(share.clone());
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
            shares: &shares,
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
    /// listeners go, and every mount under the rootfs is detached, deepest first, so a stopped workspace holds
    /// none of the box's directories and the box may upgrade them while it sleeps. The upper directories, the
    /// copy, the record and the network record stay: they are what the wake boots it with.
    async fn stop(&self, record: &Workspace) -> Result<(), OpError> {
        self.stop_engine(&record.id).await;
        self.runtime.kill(&record.id, Some(&record.init)).await?;
        self.net.stop(&record.id).await?;
        bundle::unmount_under(&self.layout.rootfs(&record.id))?;
        Ok(())
    }

    /// A stopped workspace booted again over what it wrote before it stopped.
    async fn wake(&self, record: Workspace) -> Result<Workspace, OpError> {
        if !self.layout.upper(&record.id).is_dir() {
            return Err(OpError::plain(format!("workspace {} has nothing saved to boot from", record.id)));
        }
        self.boot(record).await
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

/// Every claimed run directory and every copy that no record names, taken away. A create claims its run
/// directory first and writes its record last, so a daemon that died anywhere between the two leaves a
/// directory naming no workspace and, where the create had got that far, a copy of a checkout or of part of
/// one. None of it is anything a machine op can reach, and all of it wedges the key it was claimed under until
/// somebody removes it by hand, so the open is where it goes.
///
/// The claims go first, and their mounts with them: a dead create may have left the whole rootfs standing with
/// the copy bound into it, and a copy removed at its source while that bind is up would be deleted through the
/// bind before anything took the mount down.
fn sweep_unfinished(layout: &Layout) -> Result<Unfinished, OpError> {
    let mut swept = Unfinished::default();
    if let Some(entries) = read_dir_or_none(&layout.run())? {
        for entry in entries {
            let id = entry.file_name().to_string_lossy().into_owned();
            if bundle::read_record(&layout.record(&id))?.is_some() {
                continue;
            }
            // Everything under the rootfs first, as the stop and the sweep of a stopped workspace both do: a
            // daemon that died between the mounts and the record left the box's directories standing under
            // there with the copy bound into them, and a remove that walked in would delete the copy's files
            // through that bind and then answer EBUSY on the mount point itself, which refuses the open rather
            // than clearing it.
            bundle::unmount_under(&layout.rootfs(&id))?;
            let path = entry.path();
            fs::remove_dir_all(&path).map_err(|e| OpError::plain(format!("{}: {e}", path.display())))?;
            swept.claims.push(id);
        }
    }
    if let Some(entries) = read_dir_or_none(&layout.copies())? {
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            // A copy belongs to one workspace and to nothing else, so at open a copy whose workspace has no
            // record is a create that died, whether it died before the rename that takes the mark off or
            // after it. Both wedge the same key the same way: the next create under it claims the run
            // directory again and then cannot put its own copy where that one sits.
            if bundle::read_record(&layout.record(&Layout::copy_belongs_to(&name)))?.is_some() {
                continue;
            }
            let path = entry.path();
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                // A probe file a daemon died beside, which is a file and not a copy.
                fs::remove_file(&path).map_err(|e| OpError::plain(format!("{}: {e}", path.display())))?;
                swept.copies.push(name);
                continue;
            }
            // However it was made: a snapshot is a subvolume the kernel takes away, and a tree is a tree.
            if copy::copier_of(CopyWord::Snapshot).remove(&path).is_err() {
                copy::copier_of(CopyWord::Plain).remove(&path).map_err(|e| OpError::plain(format!("{}: {e}", path.display())))?;
            }
            swept.copies.push(name);
        }
    }
    // A directory hands its entries back in whatever order it keeps them, and this is read by a person in a
    // log line and by a test.
    swept.copies.sort();
    swept.claims.sort();
    Ok(swept)
}

/// The entries of a directory, or nothing where there is no such directory.
fn read_dir_or_none(dir: &Path) -> Result<Option<Vec<fs::DirEntry>>, OpError> {
    match fs::read_dir(dir) {
        Ok(entries) => entries.collect::<io::Result<Vec<_>>>().map(Some).map_err(|e| OpError::plain(format!("{}: {e}", dir.display()))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(OpError::plain(format!("{}: {e}", dir.display()))),
    }
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

/// The moment as the wire carries it, ISO 8601 in UTC to the millisecond.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Sixteen hex digits nothing else on the box is writing under, for the id of a workspace no key names.
fn random_word() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 8];
    let read = fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes));
    if read.is_err() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        bytes.copy_from_slice(&(nanos as u64 ^ u64::from(std::process::id())).to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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
    use std::os::unix::fs::PermissionsExt;

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
            shares: &[],
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
        assert!(facts.capabilities.replaces_machine && facts.capabilities.callback_relay);
        // This computer keeps no image, so every flag that would promise one is false and no kind names a
        // template to boot from.
        assert!(!facts.capabilities.images && !facts.capabilities.disk_snapshots);
        assert!(!facts.capabilities.snapshots_any_life && !facts.capabilities.snapshot_listing && !facts.capabilities.templates);
        assert_eq!(facts.base_templates, None);
        assert!(serde_json::to_value(&facts).unwrap()["capabilities"]["images"] == serde_json::json!(false));
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
        // The eight a layer store answered are not ops here at all: nothing of them is in the frame the runtime
        // reads, so the frame itself does not read and the reply names the op it carried. The daemon in front of
        // this never sends one down, since it answers `unknown op` for a name that is not a machine op.
        for op in [
            "machine.snapshot",
            "machine.snapshotJob",
            "machine.deleteSnapshot",
            "machine.listSnapshots",
            "machine.promoteSnapshot",
            "machine.getTemplate",
            "machine.listTemplates",
            "machine.deleteTemplate",
        ] {
            let reply: Value = serde_json::from_str(
                &ops.answer(
                    Some(RequestId::from(4)),
                    &serde_json::json!({ "id": 4, "op": op, "machineId": "gone", "name": "v1", "snapshotId": "sha256:aa", "templateId": "wsp/dev:template", "job": "j" }),
                )
                .await,
            )
            .unwrap();
            assert_eq!((reply["ok"].as_bool(), reply.get("kind")), (Some(false), None), "{op}: {reply}");
            assert!(reply["error"].as_str().unwrap().contains(op), "{op}: {reply}");
        }
    }

    /// What the room for one more workspace is read from here: the memory rule alone, since no image is kept on
    /// this computer and there is nothing to measure a disk against.
    #[test]
    fn the_capacity_names_no_image() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true")).unwrap();
        let capacity = ops.capacity().unwrap();
        assert!(capacity.images.is_empty(), "{:?}", capacity.images);
        assert_eq!(capacity.machines, MachineCounts { running: 0, paused: 0 });
        assert!(capacity.disk_free_bytes > 0);
        // The disk is still read and answered: what the host divides by an image's bytes where a place holds
        // one, and what a person reads either way.
        assert_eq!(capacity.mem_room_mb, ops.facts().machine_mem_mb());
    }

    /// A create meant for a provider, sent to a computer somebody joined: one sentence, and nothing claimed,
    /// copied or mounted for it. The same sentence a road above answers for a saved image here.
    #[tokio::test]
    async fn a_create_that_names_an_image_is_refused_in_one_sentence_and_claims_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true")).unwrap();
        for named in [
            serde_json::json!({ "kind": "sandbox", "template": "ubuntu:24.04" }),
            serde_json::json!({ "kind": "sandbox", "fromSnapshot": "sha256:aa" }),
            serde_json::json!({ "kind": "sandbox", "template": "wsp/dev:template", "idempotencyKey": "k" }),
        ] {
            let reply: Value = serde_json::from_str(
                &ops.answer(Some(RequestId::from(1)), &serde_json::json!({ "id": 1, "op": "machine.create", "spec": named })).await,
            )
            .unwrap();
            assert_eq!(
                reply,
                serde_json::json!({ "id": 1, "ok": false, "error": "this computer keeps no images: a workspace here is a copy of the computer itself" }),
                "{named}"
            );
        }
        assert_eq!(fs::read_dir(Layout::new(dir.path()).run()).unwrap().count(), 0);
        assert_eq!(fs::read_dir(Layout::new(dir.path()).copies()).unwrap().count(), 0);
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

    /// One workspace on disk as a daemon that stopped left it: its record under the run directory, its upper
    /// directory (what a nap boots from), and the chain it mounts.
    ///
    /// No rootfs directory, and that is the whole of what makes this runnable by anyone: the open unmounts the
    /// rootfs of every record whose init is gone, and umount2 resolves the path before it checks the capability,
    /// so a path that is not there answers ENOENT to any login while one that is answers EPERM to a login that is
    /// not root. A mounted rootfs is a thing a boot makes, not a thing a record carries, and none of what this
    /// proves reads it.
    fn left_on_disk(root: &Path, id: &str) {
        let layout = Layout::new(root);
        fs::create_dir_all(layout.upper(id)).unwrap();
        let record = Workspace {
            id: id.to_owned(),
            hostname: id.to_owned(),
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
            shares: Vec::new(),
        };
        fs::write(layout.record(id), serde_json::to_vec(&record).unwrap()).unwrap();
    }

    #[test]
    fn a_daemon_that_comes_up_finds_the_workspaces_it_left_and_what_each_of_them_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        left_on_disk(root, "wsp-one");
        left_on_disk(root, "wsp-two");

        let again = Ops::open(root, PathBuf::from("/bin/true")).unwrap();
        // The records are there and the listing names both, with the size each was created at.
        let listed = again.list(None).unwrap();
        assert_eq!(listed.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["wsp-one", "wsp-two"]);
        assert!(listed.iter().all(|row| row.state == MachineState::Paused && row.size == Some(WorkspaceSize { cpu: 1.0, mem_mb: 1024 })));
        // Nothing of either was swept: a record names them both.
        assert!(again.unfinished_at_open().is_empty(), "{:?}", again.unfinished_at_open());

        // And what each nap is waiting to be woken over is where the record left it.
        for id in ["wsp-one", "wsp-two"] {
            assert!(Layout::new(root).upper(id).is_dir(), "{id} lost what it wrote");
        }
    }

    /// A spec asking for one shared login, with the source spelled as given.
    fn asking_for(source: &Path) -> MachineSpec {
        MachineSpec {
            kind: MachineKind::Sandbox,
            template: None,
            from_snapshot: None,
            cpu: None,
            mem_mb: None,
            disk_gb: None,
            envs: None,
            labels: None,
            on_idle: None,
            idle_timeout_ms: None,
            idempotency_key: None,
            engine: None,
            copy: None,
            shares: Some(vec![Share { source: source.display().to_string(), target: "/root/.codex/auth.json".to_owned() }]),
        }
    }

    #[test]
    fn a_login_shared_into_a_workspace_is_a_file_under_this_daemons_logins_directory_and_nowhere_else() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true")).unwrap();
        let logins = ops.layout.logins();
        // The open made it, and only this login reads what lands under it: the sign-in writes the person's own
        // login there before any workspace asks for it.
        assert!(logins.is_dir());
        assert_eq!(fs::metadata(&logins).unwrap().permissions().mode() & 0o777, 0o700);
        // A login nobody has signed in here yet is taken: the boot passes it over and the wake after the sign-in
        // binds it, which is what lets a workspace be made on a box before its owner has signed anything in.
        let asked = ops.shares_of(&asking_for(&logins.join("codex/auth.json"))).unwrap();
        assert_eq!(asked.iter().map(|s| s.target.as_str()).collect::<Vec<_>>(), ["/root/.codex/auth.json"]);
        // And the file itself once it is there.
        fs::create_dir_all(logins.join("codex")).unwrap();
        fs::write(logins.join("codex/auth.json"), b"{}\n").unwrap();
        assert_eq!(ops.shares_of(&asking_for(&logins.join("codex/auth.json"))).unwrap().len(), 1);
        // Anywhere else on the box, the directory this daemon shares them out of, and a directory under it: each
        // refused in one sentence naming where a shared login does live. A directory is refused rather than
        // passed over, since a boot reading it as no file would skip it without a word.
        for outside in [dir.path().join("root/.ssh/id_ed25519"), logins.clone(), logins.join("codex"), logins.join("../copies/wsp-a")] {
            let refused = ops.shares_of(&asking_for(&outside)).unwrap_err().message;
            assert!(refused.contains(&logins.display().to_string()) && refused.ends_with("is not one"), "{outside:?}: {refused}");
        }
        // And a create that asks for none shares none.
        assert!(ops.shares_of(&MachineSpec { shares: None, ..asking_for(&logins) }).unwrap().is_empty());
        // What this computer says about itself names the same directory, which is what the host fills a create from.
        assert_eq!(ops.backend_facts().logins, Some(logins.display().to_string()));
    }

    #[test]
    fn the_open_sweeps_a_copy_still_being_made_and_a_claim_with_no_workspace_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let layout = Layout::new(root);
        drop(Ops::open(root, PathBuf::from("/bin/true")).unwrap());
        // What a daemon that died in the middle of a create leaves: the claim it took first, and the copy it
        // was writing under the name a copy is made under.
        let half = layout.copy_being_made("wsp-half");
        fs::create_dir_all(half.join("src")).unwrap();
        fs::write(half.join("src/index.js"), b"half of a checkout\n").unwrap();
        fs::create_dir_all(layout.workspace("wsp-half")).unwrap();
        // And what a workspace looks like, which the sweep may not touch: a record, its upper, its copy.
        left_on_disk(root, "wsp-whole");
        fs::create_dir_all(layout.copy_of("wsp-whole")).unwrap();

        // And a copy that finished but whose create died before the record: it lost the mark at the rename,
        // so only the missing record tells it apart from a workspace's own copy.
        let finished = layout.copy_of("wsp-done");
        fs::create_dir_all(finished.join("src")).unwrap();
        fs::write(finished.join("src/index.js"), b"a whole checkout\n").unwrap();
        fs::create_dir_all(layout.workspace("wsp-done")).unwrap();
        // A probe file a daemon died beside is a file rather than a copy, and the open may not trip on it.
        fs::write(layout.copies().join(".clone-probe-4242-0"), b"w").unwrap();

        let again = Ops::open(root, PathBuf::from("/bin/true")).unwrap();
        let swept = again.unfinished_at_open();
        assert_eq!(swept.copies.iter().filter(|name| name.contains("wsp-half")).count(), 1, "{swept:?}");
        assert!(swept.copies.contains(&"wsp-done".to_owned()) && swept.copies.contains(&".clone-probe-4242-0".to_owned()), "{swept:?}");
        assert_eq!(swept.claims, vec!["wsp-done".to_owned(), "wsp-half".to_owned()]);
        assert!(!half.exists() && !layout.workspace("wsp-half").exists());
        assert!(!finished.exists() && !layout.workspace("wsp-done").exists());
        assert!(layout.copy_of("wsp-whole").is_dir() && layout.workspace("wsp-whole").is_dir());
        assert_eq!(again.list(None).unwrap().len(), 1);
        // The key the dead create held is free again: a copy under it is made rather than refused.
        let from = dir.path().join("checkout");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("index.js"), b"module.exports = 1\n").unwrap();
        let want = WorkspaceCopy { from: from.display().to_string(), at: "/Users/zingzy/wsp".to_owned() };
        let made = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(again.make_copy("wsp-done", &want))
            .unwrap();
        assert_eq!(made.at, "/Users/zingzy/wsp");
        assert_eq!(fs::read(layout.copy_of("wsp-done").join("index.js")).unwrap(), b"module.exports = 1\n");
        // And an open of a root nothing died under says nothing; the copy just made has no record yet, so it
        // is swept in its turn, which is what a create that died right there left.
        let third = Ops::open(root, PathBuf::from("/bin/true")).unwrap();
        assert_eq!(third.unfinished_at_open().copies, vec!["wsp-done".to_owned()]);
        let fourth = Ops::open(root, PathBuf::from("/bin/true")).unwrap();
        assert!(fourth.unfinished_at_open().is_empty());
    }

    /// The claim of a create that died with its mounts up: the open takes the mounts down before it takes the
    /// directory, or the remove walks into the copy through the bind and then answers EBUSY on the mount point
    /// and the daemon does not come up at all. Root and the live flag, as the mount cases are.
    #[test]
    fn the_open_unmounts_what_a_dead_create_left_under_a_claim_before_it_takes_the_claim() {
        if std::env::var("WSP_RUNTIME_LIVE").as_deref() != Ok("1") || !nix::unistd::geteuid().is_root() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let layout = Layout::new(root);
        drop(Ops::open(root, PathBuf::from("/bin/true")).unwrap());
        // A copy of a checkout, and the claim of the create that was binding it in when the daemon died.
        let copy = layout.copy_of("wsp-mounted");
        fs::create_dir_all(&copy).unwrap();
        fs::write(copy.join("README.md"), b"the copy\n").unwrap();
        let rootfs = layout.rootfs("wsp-mounted");
        bundle::bind_into(&copy, &bundle::inside(&rootfs, "/Users/zingzy/wsp").unwrap()).unwrap();
        let mounted = || fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&rootfs.display().to_string());
        assert!(mounted());

        let again = Ops::open(root, PathBuf::from("/bin/true")).unwrap();
        assert!(!mounted(), "the open left the bind of a claim it removed");
        assert!(!layout.workspace("wsp-mounted").exists());
        assert!(!copy.exists(), "the copy of a create that never finished stayed");
        assert_eq!(again.unfinished_at_open().claims, vec!["wsp-mounted".to_owned()]);
    }

    /// A copy that fails partway leaves nothing under the name a workspace's copy has, so the next create under
    /// the same key is not handed half a checkout. The walk refuses a named pipe, which is a checkout a person
    /// can make by accident and the cheapest failure to write here.
    #[tokio::test]
    async fn a_copy_that_fails_partway_leaves_no_copy_and_nothing_half_made() {
        let dir = tempfile::tempdir().unwrap();
        let ops = Ops::open(dir.path(), PathBuf::from("/bin/true")).unwrap();
        let from = dir.path().join("checkout");
        fs::create_dir_all(from.join("src")).unwrap();
        fs::write(from.join("src/index.js"), b"module.exports = 1\n").unwrap();
        nix::unistd::mkfifo(&from.join("pipe"), nix::sys::stat::Mode::S_IRUSR).unwrap();
        let want = WorkspaceCopy { from: from.display().to_string(), at: "/Users/zingzy/wsp".to_owned() };
        let refused = ops.make_copy("wsp-x", &want).await.unwrap_err().message;
        assert!(refused.contains("pipe") && refused.contains("is a device"), "{refused}");
        let layout = Layout::new(dir.path());
        assert!(!layout.copy_of("wsp-x").exists(), "a failed copy left a copy");
        assert!(!layout.copy_being_made("wsp-x").exists(), "a failed copy left what it was making");
        let left: Vec<_> = fs::read_dir(layout.copies()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(left.is_empty(), "{left:?}");
    }

    /// A root under one of the five directories every workspace overlays: the open refuses it in the doctor's
    /// own sentence and makes nothing under it, since a workspace there would read its own upper inside the tree
    /// it overlays. No root and no disk needed: the reading is of the path, and the refusal comes before the
    /// first directory.
    #[test]
    fn a_root_under_a_directory_every_workspace_overlays_is_refused_by_the_open_and_nothing_is_made() {
        let under = Path::new("/var/lib/wsp-under-a-lower");
        let refused = match Ops::open(under, PathBuf::from("/bin/true")) {
            Ok(_) => panic!("a root under /var opened"),
            Err(e) => e.message,
        };
        assert_eq!(refused, crate::doctor::root_under_a_lower(under).unwrap());
        assert!(refused.contains("/var/lib/wsp-under-a-lower") && refused.contains("/var"), "{refused}");
        assert!(!under.exists(), "the open made a folder under a root it refused");
        // And the same root a directory deeper, since the reading is of the whole path.
        assert!(Ops::open(Path::new("/etc/wsp/one"), PathBuf::from("/bin/true")).is_err());
        // A root clear of all five opens as ever.
        let dir = tempfile::tempdir().unwrap();
        assert!(Ops::open(dir.path(), PathBuf::from("/bin/true")).is_ok());
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
}
