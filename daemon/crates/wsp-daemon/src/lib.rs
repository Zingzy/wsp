// SPDX-License-Identifier: AGPL-3.0-only
//! The daemon server. Every socket, inbound or the link a place opened, passes one door: the auth frame first,
//! checked against the token file as it is at that moment, then the op switch. Nothing is served before the door
//! passes a socket and nothing here binds anything but the address it was told.

mod auth;
mod door;
mod exec;
mod mode;
mod ops;
mod pty;
mod urls;

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::mpsc;
use wsp_frames::{numbers, DaemonEvent, WorkspaceKind};

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
    pub kind: WorkspaceKind,
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
            kind: WorkspaceKind::Cloud,
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
        }
    }
}

/// Every frame the daemon writes is one JSON object; serialising the wire types cannot fail.
pub(crate) fn frame_text(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("a frame serialises")
}

/// The way frames reach one socket from anywhere in the daemon: its serve loop writes what arrives here, in order,
/// so a handler's events and its reply cannot cross.
#[derive(Clone)]
pub(crate) struct Outbound(pub(crate) mpsc::UnboundedSender<String>);

impl Outbound {
    /// False once the socket is gone, which is how a listener learns it may be dropped.
    pub(crate) fn send_text(&self, text: &str) -> bool {
        self.0.send(text.to_owned()).is_ok()
    }

    pub(crate) fn send_event(&self, event: &DaemonEvent) -> bool {
        self.send_text(&frame_text(event))
    }
}

/// One socket's interest in a pty's data, its exit or its mode; the key is what detaches it when the socket closes.
pub(crate) struct Listener {
    pub(crate) key: u64,
    pub(crate) out: Outbound,
}

/// What every socket's handler reads: the options as given, the root the hello announces, the ptys and their mode
/// watcher, and every authed unscoped socket for the events the daemon pushes without being asked.
pub(crate) struct Ctx {
    pub(crate) options: Options,
    pub(crate) root: String,
    pub(crate) auth_deadline: Duration,
    pub(crate) ptys: Mutex<pty::PtyManager>,
    pub(crate) modes: Arc<mode::ModeWatcher>,
    authed: Mutex<HashMap<u64, Outbound>>,
    keys: AtomicU64,
}

impl Ctx {
    pub(crate) fn new(options: Options) -> Ctx {
        let root = resolved_root(options.root.as_deref());
        let auth_deadline = Duration::from_millis(options.auth_deadline_ms.unwrap_or(numbers::AUTH_DEADLINE_MS));
        let proc_root = options.proc_root.clone().unwrap_or_else(|| PathBuf::from("/proc"));
        let interval = options.mode_interval_ms.map_or(mode::DEFAULT_INTERVAL, Duration::from_millis);
        let modes = Arc::new(mode::ModeWatcher::new(mode::linux_mode_probe(&proc_root), interval));
        Ctx {
            options,
            root,
            auth_deadline,
            ptys: Mutex::new(pty::PtyManager::default()),
            modes,
            authed: Mutex::new(HashMap::new()),
            keys: AtomicU64::new(1),
        }
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
    ctx: Arc<Ctx>,
}

impl Daemon {
    /// Binds the address and reads the token file once, so a daemon with no token to check against never starts.
    pub async fn bind(options: Options) -> io::Result<Daemon> {
        if auth::current_token(&options.token_path).is_none() {
            return Err(io::Error::other(wsp_frames::words::NO_TOKEN_AT_START));
        }
        let listener = TcpListener::bind((options.host.as_str(), options.port)).await?;
        Ok(Daemon { listener, ctx: Arc::new(Ctx::new(options)) })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.listener.local_addr().expect("a bound listener has an address")
    }

    /// Accepts forever; each socket gets its own task and its own door.
    pub async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            // As node's ws does: without it a pty's small frames sit behind the peer's delayed ACK, 40 ms measured.
            let _ = stream.set_nodelay(true);
            let ctx = Arc::clone(&self.ctx);
            tokio::spawn(door::serve(stream, ctx));
        }
    }
}

/// The root the hello announces: the --root given, else HOME, made absolute against the working directory and
/// normalised lexically, as node's path.resolve does.
fn resolved_root(root: Option<&Path>) -> String {
    let given = root.map(Path::to_path_buf).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/"));
    let absolute = if given.is_absolute() { given } else { std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(given) };
    let mut out = PathBuf::from("/");
    for part in absolute.components() {
        match part {
            std::path::Component::Normal(p) => out.push(p),
            std::path::Component::ParentDir => {
                out.pop();
            }
            _ => {}
        }
    }
    out.to_string_lossy().into_owned()
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
