// SPDX-License-Identifier: AGPL-3.0-only
//! The daemon server. Every socket, inbound or the link a place opened, passes one door: the auth frame first,
//! checked against the token file as it is at that moment, then the op switch. Nothing is served before the door
//! passes a socket and nothing here binds anything but the address it was told.

mod auth;
mod door;
mod fs;
mod git;
mod ops;
mod paths;

use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use wsp_frames::{numbers, WorkspaceKind};

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

/// What every socket's handler reads: the options as given and the root the hello announces.
pub(crate) struct Ctx {
    pub(crate) options: Options,
    pub(crate) root: String,
    pub(crate) auth_deadline: Duration,
}

impl Ctx {
    pub(crate) fn new(options: Options) -> Ctx {
        let root = resolved_root(options.root.as_deref());
        let auth_deadline = Duration::from_millis(options.auth_deadline_ms.unwrap_or(numbers::AUTH_DEADLINE_MS));
        Ctx { options, root, auth_deadline }
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
            let ctx = Arc::clone(&self.ctx);
            tokio::spawn(door::serve(stream, ctx));
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
