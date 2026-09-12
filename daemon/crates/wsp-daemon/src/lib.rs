// SPDX-License-Identifier: AGPL-3.0-only
//! The daemon server. Every socket, inbound or the link a place opened, passes one door: the auth frame first,
//! checked against the token file as it is at that moment, then the op switch. Nothing is served before the door
//! passes a socket and nothing here binds anything but the address it was told.

mod auth;
mod awake;
mod clock;
mod door;
mod exec;
mod fs;
mod git;
mod inbox;
mod link;
mod manifest;
mod mode;
mod ops;
mod paths;
mod place;
mod ports;
mod proc;
mod proc_local;
mod pty;
mod readings;
mod relay;
mod sys;
mod sys_local;
mod tunnel;
mod urls;

pub use link::place_backoff_ms;

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::{TcpListener, UnixListener};
use tokio::sync::mpsc;
use wsp_frames::{numbers, DaemonEvent};

use crate::paths::OpError;

/// What a daemon is started with: one field per flag the binary takes, so the harness and the deploy scripts spell
/// one thing. Fields the door does not read yet are held for the modules that will.
#[derive(Debug, Clone)]
pub struct Options {
    pub host: String,
    pub port: u16,
    /// The token file, read at every auth frame so the host can rotate it while the daemon runs.
    pub token_path: PathBuf,
    /// The directory every fs and git path resolves inside; HOME when absent.
    pub root: Option<PathBuf>,
    pub roots_path: Option<PathBuf>,
    /// Which kind of machine this daemon serves, which picks the modules its readings come from. A word rather than
    /// the enum: a kind the registry lacks is refused at the watch, in the words the pane prints, not at start.
    pub kind: String,
    pub work_folder: Option<PathBuf>,
    pub inbox_dir: Option<PathBuf>,
    pub inbox_quiet_ms: Option<u64>,
    pub inbox_poll_ms: Option<u64>,
    pub manifest_path: Option<PathBuf>,
    pub run_dir: Option<PathBuf>,
    pub log_dir: Option<PathBuf>,
    pub open_socket_path: Option<PathBuf>,
    pub proc_root: Option<PathBuf>,
    pub passwd_path: Option<PathBuf>,
    pub ports_interval_ms: Option<u64>,
    pub sys_interval_ms: Option<u64>,
    pub proc_interval_ms: Option<u64>,
    pub mode_interval_ms: Option<u64>,
    pub auth_deadline_ms: Option<u64>,
    pub place_file: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub wsp_argv: Vec<String>,
    pub agents: Vec<String>,
    pub link_connect_ms: Option<u64>,
    pub link_quiet_ms: Option<u64>,
    pub link_refused_retry_ms: Option<u64>,
    pub link_backoff_ms: Option<u64>,
    /// Where a place's daemon keeps the layers and the workspaces it runs.
    pub runtime_root: Option<PathBuf>,
}

impl Options {
    /// The in-guest shape: 0.0.0.0:7070, the guest token file, a cloud machine.
    pub fn new(token_path: impl Into<PathBuf>) -> Options {
        Options {
            host: numbers::DEFAULT_HOST.to_owned(),
            port: numbers::DEFAULT_PORT,
            token_path: token_path.into(),
            root: None,
            roots_path: None,
            kind: "cloud".to_owned(),
            work_folder: None,
            inbox_dir: None,
            inbox_quiet_ms: None,
            inbox_poll_ms: None,
            manifest_path: None,
            run_dir: None,
            log_dir: None,
            open_socket_path: None,
            proc_root: None,
            passwd_path: None,
            ports_interval_ms: None,
            sys_interval_ms: None,
            proc_interval_ms: None,
            mode_interval_ms: None,
            auth_deadline_ms: None,
            place_file: None,
            home: None,
            wsp_argv: Vec::new(),
            agents: Vec::new(),
            link_connect_ms: None,
            link_quiet_ms: None,
            link_refused_retry_ms: None,
            link_backoff_ms: None,
            runtime_root: None,
        }
    }
}

/// Every frame the daemon writes is one JSON object; serialising the wire types cannot fail.
pub(crate) fn frame_text(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("a frame serialises")
}

/// One item on a socket's outbound channel: a frame to write, or the leave's reply, after which the loop stops.
pub(crate) enum Outgoing {
    Text(String),
    Leave(String),
}

impl Outgoing {
    #[cfg(test)]
    pub(crate) fn text(&self) -> &str {
        match self {
            Outgoing::Text(t) | Outgoing::Leave(t) => t,
        }
    }
}

/// The way frames reach one socket from anywhere in the daemon: its serve loop writes what arrives here, in order,
/// so a handler's events and its reply cannot cross.
#[derive(Clone)]
pub(crate) struct Outbound(pub(crate) mpsc::UnboundedSender<Outgoing>);

impl Outbound {
    /// False once the socket is gone, which is how a listener learns it may be dropped.
    pub(crate) fn send_text(&self, text: &str) -> bool {
        self.0.send(Outgoing::Text(text.to_owned())).is_ok()
    }

    pub(crate) fn send(&self, out: Outgoing) -> bool {
        self.0.send(out).is_ok()
    }

    pub(crate) fn send_event(&self, event: &DaemonEvent) -> bool {
        self.send_text(&frame_text(event))
    }
}

/// One line of the daemon's log, as the binary prints it on stderr and the suite reads it.
pub type Log = Box<dyn Fn(&str) + Send + Sync>;
/// The same log where more than one holder writes to it: the samplers log their start and stop.
pub(crate) type SharedLog = Arc<dyn Fn(&str) + Send + Sync>;

/// One socket's interest in a pty's data, its exit or its mode; the key is what detaches it when the socket closes.
pub(crate) struct Listener {
    pub(crate) key: u64,
    pub(crate) out: Outbound,
}

/// How often the two samplers read the machine when no flag says otherwise, as the node daemon's do.
const SAMPLER_INTERVAL_MS: u64 = 2000;

/// What every socket's handler reads: the options as given, the root the hello announces, the ptys and their mode
/// watcher, and every authed unscoped socket for the events the daemon pushes without being asked.
pub(crate) struct Ctx {
    pub(crate) options: Options,
    pub(crate) root: String,
    pub(crate) auth_deadline: Duration,
    pub(crate) ptys: Mutex<pty::PtyManager>,
    pub(crate) modes: Arc<mode::ModeWatcher>,
    pub(crate) manifest: Mutex<manifest::ProcessManifest>,
    pub(crate) spotter: Mutex<relay::CallbackSpotter>,
    pub(crate) ports: ports::PortWatch,
    pub(crate) inbox: inbox::InboxWatch,
    /// Where the daemon's lines go: stderr in the binary, a test's own list otherwise.
    log: SharedLog,
    /// The two samplers, built on the first watch so a daemon nobody asks reads nothing; one each for the daemon.
    sys: Mutex<Option<Arc<sys::SysSampler>>>,
    procs: Mutex<Option<Arc<proc::ProcSampler>>>,
    /// Told once a leave has been answered, which is what ends the daemon.
    pub(crate) stop: tokio::sync::Notify,
    /// The workspaces a place's daemon runs and answers the machine ops on its link with; none where no place file
    /// turned the link on or the runtime root could not be opened.
    #[cfg(target_os = "linux")]
    pub(crate) runtime: Option<Arc<wsp_runtime::ops::Ops>>,
    authed: Mutex<HashMap<u64, Outbound>>,
    keys: AtomicU64,
}

impl Ctx {
    /// Reads the manifest file once; a manifest that is there but cannot be read refuses the start, as it does for
    /// the node daemon.
    pub(crate) fn new(options: Options, log: Log) -> io::Result<Ctx> {
        let root = resolved_root(options.root.as_deref());
        let auth_deadline = Duration::from_millis(options.auth_deadline_ms.unwrap_or(numbers::AUTH_DEADLINE_MS));
        let proc_root = options.proc_root.clone().unwrap_or_else(|| PathBuf::from("/proc"));
        let interval = options.mode_interval_ms.map_or(mode::DEFAULT_INTERVAL, Duration::from_millis);
        let modes = Arc::new(mode::ModeWatcher::new(mode::linux_mode_probe(&proc_root), interval));
        let manifest_path = options.manifest_path.clone().unwrap_or_else(|| PathBuf::from(numbers::DEFAULT_MANIFEST_PATH));
        let manifest = manifest::ProcessManifest::load(Some(manifest_path), options.run_dir.as_deref(), options.log_dir.as_deref())?;
        let interval = options.ports_interval_ms.map_or(ports::DEFAULT_INTERVAL, Duration::from_millis);
        let ports = ports::PortWatch::new(ports::source_for(options.proc_root.as_deref()), interval);
        #[cfg(target_os = "linux")]
        let runtime = open_runtime(&options, &log);
        Ok(Ctx {
            options,
            root,
            auth_deadline,
            ptys: Mutex::new(pty::PtyManager::default()),
            modes,
            manifest: Mutex::new(manifest),
            spotter: Mutex::new(relay::CallbackSpotter::new()),
            ports,
            inbox: inbox::InboxWatch::default(),
            log: Arc::from(log),
            sys: Mutex::new(None),
            procs: Mutex::new(None),
            stop: tokio::sync::Notify::new(),
            #[cfg(target_os = "linux")]
            runtime,
            authed: Mutex::new(HashMap::new()),
            keys: AtomicU64::new(1),
        })
    }

    pub(crate) fn log(&self, line: &str) {
        (self.log)(line);
    }

    /// What this machine's own two modules are built from; the kind picks which modules those are.
    fn readings_options(&self) -> readings::ReadingsOptions {
        readings::ReadingsOptions {
            root: PathBuf::from(&self.root),
            work_folder: self.options.work_folder.clone().unwrap_or_else(|| PathBuf::from(&self.root)),
            proc_root: self.options.proc_root.clone().unwrap_or_else(|| PathBuf::from("/proc")),
            passwd_path: self.options.passwd_path.clone().unwrap_or_else(|| PathBuf::from("/etc/passwd")),
            platform: std::env::consts::OS,
        }
    }

    /// The load sampler, or the refusal for a kind that reads neither of its readings.
    pub(crate) fn sys_sampler(&self) -> Result<Arc<sys::SysSampler>, OpError> {
        let mut held = self.sys.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sampler) = held.as_ref() {
            return Ok(Arc::clone(sampler));
        }
        let kind = readings::readings_for(&self.options.kind, std::env::consts::OS)?;
        let interval = Duration::from_millis(self.options.sys_interval_ms.unwrap_or(SAMPLER_INTERVAL_MS));
        let sampler = sys::SysSampler::new((kind.metrics)(&self.readings_options()), interval, Arc::clone(&self.log));
        *held = Some(Arc::clone(&sampler));
        Ok(sampler)
    }

    /// The processes sampler, or the same refusal.
    pub(crate) fn proc_sampler(self: &Arc<Self>) -> Result<Arc<proc::ProcSampler>, OpError> {
        let mut held = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sampler) = held.as_ref() {
            return Ok(Arc::clone(sampler));
        }
        let kind = readings::readings_for(&self.options.kind, std::env::consts::OS)?;
        // An exited pty's pid can be reused by a stranger; only live shells carry the label. Weak, since the sampler
        // lives inside the context it reads.
        let ctx = Arc::downgrade(self);
        let ptys: proc::PtyPids = Arc::new(move || {
            ctx.upgrade().map_or_else(Vec::new, |ctx| {
                ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).list().into_iter().filter(|p| !p.exited).map(|p| (p.pid, p.id)).collect()
            })
        });
        let opts = proc::ProcSamplerOptions {
            self_pid: std::process::id(),
            ptys,
            interval: Duration::from_millis(self.options.proc_interval_ms.unwrap_or(SAMPLER_INTERVAL_MS)),
            now: Arc::new(sys::now_ms),
            log: Arc::clone(&self.log),
        };
        let sampler = proc::ProcSampler::new((kind.processes)(&self.readings_options()), opts);
        *held = Some(Arc::clone(&sampler));
        Ok(sampler)
    }

    /// A number no other socket or listener in this daemon has.
    pub(crate) fn next_key(&self) -> u64 {
        self.keys.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) fn add_authed(&self, key: u64, out: Outbound) {
        self.authed.lock().unwrap_or_else(|e| e.into_inner()).insert(key, out);
    }

    pub(crate) fn remove_authed(&self, key: u64) {
        self.authed.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
    }

    /// Pushed to every authed unscoped socket, not to subscribers: the host's link reconnects through the edge and
    /// would lose a subscription with it. A port-scoped socket is there to tunnel one port and hears none of it.
    pub(crate) fn broadcast(&self, event: &DaemonEvent) {
        let text = frame_text(event);
        self.authed.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, out| out.send_text(&text));
    }
}

/// A bound daemon: the listener is open and the address is known, nothing is accepted until run.
pub struct Daemon {
    listener: TcpListener,
    open_socket: Option<UnixListener>,
    ctx: Arc<Ctx>,
}

impl Daemon {
    /// Binds the address and reads the token file once, so a daemon with no token to check against never starts;
    /// binds the open socket too when one is named, so a shim that cannot be heard is a start that failed. Lines go
    /// to stderr.
    pub async fn bind(options: Options) -> io::Result<Daemon> {
        Daemon::bind_with(options, Box::new(|line| eprintln!("{line}"))).await
    }

    /// The same, with the log going where the caller says.
    pub async fn bind_with(options: Options, log: Log) -> io::Result<Daemon> {
        if auth::current_token(&options.token_path).is_none() {
            return Err(io::Error::other(wsp_frames::words::NO_TOKEN_AT_START));
        }
        let listener = TcpListener::bind((options.host.as_str(), options.port)).await?;
        let open_socket = match &options.open_socket_path {
            Some(path) => Some(relay::listen_open_socket(path)?),
            None => None,
        };
        Ok(Daemon { listener, open_socket, ctx: Arc::new(Ctx::new(options, log)?) })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.listener.local_addr().expect("a bound listener has an address")
    }

    /// Accepts until a leave answered on the link ends the daemon; each socket gets its own task and its own door.
    /// A place file turns the outbound link on beside the listener, with the awake hold that reads the same file.
    pub async fn run(self) -> io::Result<()> {
        if let Some(file) = self.ctx.options.place_file.clone() {
            let port = self.local_addr().port();
            tokio::spawn(link::run(Arc::clone(&self.ctx), port));
            tokio::spawn(awake::hold_while_joined(Arc::clone(&self.ctx), file));
        }
        if let Some(open_socket) = self.open_socket {
            tokio::spawn(relay::serve_open_socket(open_socket, Arc::clone(&self.ctx)));
        }
        loop {
            let accepted = tokio::select! {
                accepted = self.listener.accept() => accepted,
                _ = self.ctx.stop.notified() => return Ok(()),
            };
            let (stream, _) = accepted?;
            // As node's ws does: without it a pty's small frames sit behind the peer's delayed ACK, 40 ms measured.
            let _ = stream.set_nodelay(true);
            let ctx = Arc::clone(&self.ctx);
            tokio::spawn(door::serve(stream, ctx));
        }
    }
}

/// The workspace runtime a place's daemon serves on its link, under the runtime root. A daemon that is not a place
/// serves none; a root this process cannot open leaves the link answering that no backend is here, and says why once.
#[cfg(target_os = "linux")]
fn open_runtime(options: &Options, log: &Log) -> Option<Arc<wsp_runtime::ops::Ops>> {
    options.place_file.as_ref()?;
    let root = options.runtime_root.clone().unwrap_or_else(|| PathBuf::from(wsp_runtime::DEFAULT_ROOT));
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => {
            log(&format!("workspace runtime not served: this binary's own path is unknown: {e}"));
            return None;
        }
    };
    match wsp_runtime::ops::Ops::open(&root, exe) {
        Ok(ops) => {
            let swept = ops.swept_at_open();
            if swept.bytes > 0 {
                log(&format!(
                    "layer store swept: {} blobs, {} unpacked layers, {} bytes",
                    swept.blobs.len(),
                    swept.unpacked.len(),
                    swept.bytes
                ));
            }
            for id in ops.stopped_at_open() {
                log(&format!("workspace {id} found stopped at start: its init is gone"));
            }
            Some(Arc::new(ops))
        }
        Err(e) => {
            log(&format!("workspace runtime not served: {}: {e}", root.display()));
            None
        }
    }
}

/// The root the hello announces: the --root given, else HOME, made absolute and normalised as node's path.resolve
/// does.
fn resolved_root(root: Option<&Path>) -> String {
    let given = root.map(Path::to_path_buf).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/"));
    paths::absolute(&given).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_root_is_absolute_and_normalised() {
        assert_eq!(resolved_root(Some(Path::new("/srv/work/../work/./here"))), "/srv/work/here");
        assert_eq!(resolved_root(Some(Path::new("/a/b/../../../c"))), "/c");
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(resolved_root(Some(Path::new("sub"))), cwd.join("sub").to_string_lossy());
    }
}
