// SPDX-License-Identifier: AGPL-3.0-only
//! youki's library, driven two ways. Create and exec clone a new process, and libcontainer clones with a raw
//! clone3 that skips the bookkeeping a threaded libc needs, so each runs in a fresh process of this same binary
//! (`runtime create`, `runtime exec`) that the daemon spawns and waits for; that process also carries the exec's
//! stdio, which a tenant inherits. Start, kill, delete and the status are reads and writes on the state directory
//! and the cgroup and run in this process. The tenant notify sockets youki leaves behind are removed after each
//! exec.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use libcontainer::container::builder::ContainerBuilder;
use libcontainer::container::{Container, ContainerStatus, State};
use libcontainer::network::link::LinkClient;
use libcontainer::network::wrapper::create_network_client;
use libcontainer::syscall::syscall::SyscallType;
use nix::sched::{setns, CloneFlags};
use nix::sys::signal::{kill, killpg, Signal};
use nix::sys::wait::{waitpid, WaitStatus};
use nix::unistd::Pid;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use wsp_frames::numbers;

use crate::bundle::{Init, Layout};

/// The exit code a helper answers for a failure of its own, apart from the command it ran; its stderr says why,
/// behind `HELPER_PREFIX`.
pub const HELPER_FAILED: i32 = 125;
const HELPER_PREFIX: &str = "wsp-runtime: ";
/// How much longer than an exec's own deadline the daemon waits for its helper before killing the group.
const HELPER_MARGIN: Duration = Duration::from_secs(5);
const CREATE_TIMEOUT: Duration = Duration::from_secs(60);
/// A tenant notify socket older than this belongs to no exec still starting.
const STALE_NOTIFY: Duration = Duration::from_secs(30);
const TENANT_NOTIFY: &str = "tenant-notify-";
/// How long killed processes get to leave their cgroup before the kill is called failed.
const KILL_PATIENCE: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub enum Error {
    /// youki refused, in its own words.
    Container(String),
    /// A helper process ended without doing its work.
    Helper {
        verb: &'static str,
        detail: String,
    },
    Io {
        path: PathBuf,
        source: io::Error,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Container(detail) => write!(f, "{detail}"),
            Error::Helper { verb, detail } => write!(f, "runtime {verb}: {detail}"),
            Error::Io { path, source } => write!(f, "{}: {source}", path.display()),
        }
    }
}

impl std::error::Error for Error {}

/// The error and every source under it, joined, since youki's top line alone rarely says what failed.
fn described(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(inner) = source {
        let line = inner.to_string();
        if !text.contains(&line) {
            text.push_str(": ");
            text.push_str(&line);
        }
        source = inner.source();
    }
    text
}

fn container(e: impl std::error::Error) -> Error {
    Error::Container(described(&e))
}

fn io_at(path: &Path) -> impl FnOnce(io::Error) -> Error + '_ {
    move |source| Error::Io { path: path.to_owned(), source }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Creating,
    Created,
    Running,
    Paused,
    Stopped,
    /// No state directory: nothing was created, or it was deleted.
    Gone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exec {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub struct Runtime {
    layout: Layout,
    exe: PathBuf,
}

impl Runtime {
    /// `exe` is this binary, which the helpers run and the workspaces boot as their init.
    pub fn new(root: &Path, exe: PathBuf) -> Runtime {
        Runtime { layout: Layout::new(root), exe }
    }

    pub fn exe(&self) -> &Path {
        &self.exe
    }

    /// youki's create for the bundle under the run directory, in a helper process; the container is created and
    /// waits for start.
    pub async fn create(&self, id: &str) -> Result<(), Error> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(["runtime", "create", "--root"]).arg(self.layout.root()).args(["--id", id]).stdin(Stdio::null()).kill_on_drop(true);
        let output = match tokio::time::timeout(CREATE_TIMEOUT, cmd.output()).await {
            Err(_) => return Err(Error::Helper { verb: "create", detail: format!("did not finish in {} s", CREATE_TIMEOUT.as_secs()) }),
            Ok(Err(e)) => return Err(Error::Helper { verb: "create", detail: e.to_string() }),
            Ok(Ok(output)) => output,
        };
        if output.status.success() {
            return Ok(());
        }
        let said = String::from_utf8_lossy(&output.stderr);
        Err(Error::Helper { verb: "create", detail: said.trim().strip_prefix(HELPER_PREFIX).unwrap_or(said.trim()).to_owned() })
    }

    pub async fn start(&self, id: &str) -> Result<(), Error> {
        let dir = self.layout.state_of(id);
        tokio::task::spawn_blocking(move || Container::load(dir).map_err(container)?.start().map_err(container)).await.map_err(joined)?
    }

    /// A command inside the workspace as a tenant, through a helper: both streams captured under the output cap,
    /// the exit code as the command's, 124 once the deadline passed.
    pub async fn exec(&self, id: &str, args: &[String], stdin: Option<Vec<u8>>, timeout: Duration) -> Result<Exec, Error> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(["runtime", "exec", "--root"])
            .arg(self.layout.root())
            .args(["--id", id, "--timeout-ms", &timeout.as_millis().to_string(), "--"])
            .args(args);
        cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Its own group, so the daemon's own deadline reaches the helper and whatever it left in the group.
        cmd.process_group(0).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| Error::Helper { verb: "exec", detail: e.to_string() })?;
        let pid = child.id();
        let mut feed = child.stdin.take();
        let out = child.stdout.take();
        let err = child.stderr.take();
        let stdout = Mutex::new(Vec::new());
        let stderr = Mutex::new(Vec::new());
        let run = async {
            let write = async {
                if let (Some(pipe), Some(bytes)) = (feed.as_mut(), stdin) {
                    let _ = pipe.write_all(&bytes).await;
                }
                drop(feed);
            };
            let ((), (), (), status) = tokio::join!(write, read_into(out, &stdout), read_into(err, &stderr), child.wait());
            status
        };
        let status = match tokio::time::timeout(timeout + HELPER_MARGIN, run).await {
            Ok(status) => status.map_err(|e| Error::Helper { verb: "exec", detail: e.to_string() })?.code(),
            Err(_) => {
                if let Some(group) = pid.and_then(|p| i32::try_from(p).ok()) {
                    let _ = killpg(Pid::from_raw(group), Signal::SIGKILL);
                }
                let _ = child.start_kill();
                None
            }
        };
        let stdout = String::from_utf8_lossy(&stdout.into_inner().unwrap_or_else(|e| e.into_inner())).into_owned();
        let stderr = String::from_utf8_lossy(&stderr.into_inner().unwrap_or_else(|e| e.into_inner())).into_owned();
        if status == Some(HELPER_FAILED) {
            if let Some(detail) = stderr.trim().strip_prefix(HELPER_PREFIX) {
                return Err(Error::Helper { verb: "exec", detail: detail.to_owned() });
            }
        }
        Ok(Exec { exit_code: status.unwrap_or(numbers::EXEC_DEADLINE_EXIT), stdout, stderr })
    }

    /// SIGKILL to every process in the cgroup, then youki's delete once they have left and the init is reaped: the
    /// cgroup and the state directory go. `init` is the record's; a workspace whose init is not that process any
    /// more has nothing of ours running, so nothing is killed and the delete takes the rest. None is a workspace
    /// still being created, whose init is the one youki just made.
    pub async fn kill(&self, id: &str, init: Option<&Init>) -> Result<(), Error> {
        let dir = self.layout.state_of(id);
        let cgroup = self.layout.cgroup_dir(id);
        let init = init.cloned();
        tokio::task::spawn_blocking(move || {
            // No state of youki's: a create that never got that far, or one whose init the open found gone. The
            // cgroup is empty then, and ours to remove.
            if !dir.join("state.json").is_file() {
                let _ = fs::remove_dir_all(&dir);
                if cgroup.exists() {
                    crate::freeze::wait_unpopulated(&cgroup, KILL_PATIENCE).map_err(io_at(&cgroup))?;
                    fs::remove_dir(&cgroup).map_err(io_at(&cgroup))?;
                }
                return Ok(());
            }
            let pid = State::load(&dir).map_err(container)?.pid;
            let ours = init.as_ref().is_none_or(alive);
            // A load that fails is an init that left between two reads of /proc: nothing is left to kill, and the
            // delete below takes the rest, as it does for a stopped or half-created container.
            if ours {
                if let Ok(mut c) = Container::load(dir.clone()) {
                    match c.kill(sigkill(), true) {
                        Ok(()) | Err(libcontainer::error::LibcontainerError::IncorrectStatus(_)) => {}
                        Err(e) if c.status() == ContainerStatus::Stopped => {
                            let _ = e;
                        }
                        Err(e) => return Err(container(e)),
                    }
                }
            }
            // youki's delete reads the init's /proc entry and waits well under a second for the cgroup to empty; a
            // wait for the processes to leave and for the init to be reaped first, so the delete finds a stopped
            // container and an empty cgroup.
            crate::freeze::wait_unpopulated(&cgroup, KILL_PATIENCE).map_err(io_at(&cgroup))?;
            if let (true, Some(pid)) = (ours, pid) {
                wait_reaped(pid, KILL_PATIENCE)?;
            }
            let deleted = Container::load(dir.clone()).map_err(container).and_then(|mut c| c.delete(true).map_err(container));
            if let Err(e) = deleted {
                if cgroup.exists() {
                    return Err(e);
                }
                // A cgroup the kernel already dropped (the box rebooted) fails youki's delete; the directory is ours.
                if dir.exists() {
                    fs::remove_dir_all(&dir).map_err(io_at(&dir))?;
                }
            }
            Ok(())
        })
        .await
        .map_err(joined)?
    }

    /// youki's status for the workspace, refreshed against /proc; Gone where it has no state directory.
    pub fn status(&self, id: &str) -> Result<Status, Error> {
        let dir = self.layout.state_of(id);
        if !dir.join("state.json").is_file() {
            return Ok(Status::Gone);
        }
        let c = Container::load(dir).map_err(container)?;
        Ok(match c.status() {
            ContainerStatus::Creating => Status::Creating,
            ContainerStatus::Created => Status::Created,
            ContainerStatus::Running => Status::Running,
            ContainerStatus::Paused => Status::Paused,
            ContainerStatus::Stopped => Status::Stopped,
        })
    }

    /// The init process's pid, while the container has one.
    pub fn init_pid(&self, id: &str) -> Result<Option<i32>, Error> {
        let dir = self.layout.state_of(id);
        if !dir.join("state.json").is_file() {
            return Ok(None);
        }
        Ok(Container::load(dir).map_err(container)?.pid().map(|pid| pid.as_raw()))
    }

    /// youki's status word written to its state file, so its own reads agree with the freezer.
    pub fn set_status(&self, id: &str, paused: bool) -> Result<(), Error> {
        let mut c = Container::load(self.layout.state_of(id)).map_err(container)?;
        c.set_status(if paused { ContainerStatus::Paused } else { ContainerStatus::Running }).save().map_err(container)
    }
}

/// The identity of a live process: its pid with its start time and the box's boot id, which is what tells the
/// init a record names apart from a process the kernel handed the same pid to later, or after a reboot.
pub fn identity_of(pid: i32) -> io::Result<Init> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    Ok(Init { pid, started: start_ticks(&stat)?, boot_id: boot_id()? })
}

/// Whether the process the record names is still that process.
pub fn alive(init: &Init) -> bool {
    identity_of(init.pid).is_ok_and(|now| now == *init)
}

/// Field 22 of a stat line: the fields after the command name, which the parentheses close, start at the state.
fn start_ticks(stat: &str) -> io::Result<u64> {
    let after_comm = stat.rsplit_once(')').map(|(_, rest)| rest).ok_or_else(|| io::Error::other("a stat line without a command name"))?;
    after_comm
        .split_whitespace()
        .nth(19)
        .and_then(|field| field.parse().ok())
        .ok_or_else(|| io::Error::other("a stat line without a start time"))
}

fn boot_id() -> io::Result<String> {
    Ok(fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_owned())
}

/// Waits until the process's /proc entry is gone: exited and reaped by whoever holds it.
fn wait_reaped(pid: i32, patience: Duration) -> Result<(), Error> {
    let entry = PathBuf::from(format!("/proc/{pid}"));
    let started = std::time::Instant::now();
    while entry.exists() {
        if started.elapsed() > patience {
            return Err(Error::Container(format!("process {pid} is still there {} s after its kill", patience.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}

/// SIGKILL as youki's own signal type, which wraps another nix than this crate's.
fn sigkill() -> libcontainer::signal::Signal {
    libcontainer::signal::Signal::try_from(Signal::SIGKILL as i32).expect("SIGKILL is a signal")
}

fn joined(e: tokio::task::JoinError) -> Error {
    Error::Helper { verb: "blocking", detail: e.to_string() }
}

/// One reader per stream, into a buffer capped at the protocol's exec output cap.
async fn read_into<R: AsyncRead + Unpin>(pipe: Option<R>, out: &Mutex<Vec<u8>>) {
    let Some(mut pipe) = pipe else { return };
    let mut buf = vec![0u8; 16 * 1024];
    while let Ok(n) = pipe.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let mut held = out.lock().unwrap_or_else(|e| e.into_inner());
        let room = numbers::EXEC_OUTPUT_MAX.saturating_sub(held.len());
        held.extend_from_slice(&buf[..n.min(room)]);
    }
}

/// In the helper process: youki's create for the bundle, detached, on the plain cgroup manager; then the
/// workspace's loopback is brought up, which a fresh network namespace leaves down.
pub fn helper_create(root: &Path, id: &str) -> Result<(), Error> {
    let layout = Layout::new(root);
    let state = layout.state();
    fs::create_dir_all(&state).map_err(io_at(&state))?;
    // The init's stdio is its own, never this process's pipes: an init holding them would keep the daemon waiting
    // for the helper's output after the helper exited.
    let null = fs::File::open("/dev/null").map_err(io_at(Path::new("/dev/null")))?;
    let log_path = layout.boot_log(id);
    let log = fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(io_at(&log_path))?;
    let log_err = log.try_clone().map_err(io_at(&log_path))?;
    let c = ContainerBuilder::new(id.to_owned(), SyscallType::default())
        .with_root_path(&state)
        .map_err(container)?
        .validate_id()
        .map_err(container)?
        .with_stdin(null)
        .with_stdout(log)
        .with_stderr(log_err)
        .as_init(layout.workspace(id))
        .with_systemd(false)
        .with_detach(true)
        .build()
        .map_err(container)?;
    let pid = c.pid().ok_or_else(|| Error::Container("youki created the container without a pid".into()))?;
    loopback_up(Pid::from_raw(pid.as_raw()))
}

fn loopback_up(pid: Pid) -> Result<(), Error> {
    let ns_path = PathBuf::from(format!("/proc/{pid}/ns/net"));
    let ns = fs::File::open(&ns_path).map_err(io_at(&ns_path))?;
    setns(ns, CloneFlags::CLONE_NEWNET).map_err(|e| Error::Io { path: ns_path.clone(), source: io::Error::from(e) })?;
    let mut links = LinkClient::new(create_network_client()).map_err(container)?;
    let lo = links.get_by_name("lo").map_err(container)?;
    links.set_up(lo.header.index).map_err(container)
}

/// In the helper process: the command as a tenant of the workspace, its stdio inherited from this process, waited
/// for; past the deadline its group is killed and the answer is 124. Answers the exit code to exit with.
pub fn helper_exec(root: &Path, id: &str, args: Vec<String>, timeout: Duration) -> Result<i32, Error> {
    let layout = Layout::new(root);
    let tenant = ContainerBuilder::new(id.to_owned(), SyscallType::default())
        .with_root_path(layout.state())
        .map_err(container)?
        .as_tenant()
        .with_container_args(args)
        .with_detach(false)
        .build()
        .map_err(container)?;
    let pid = Pid::from_raw(tenant.as_raw());
    let deadline = std::thread::spawn(move || {
        std::thread::sleep(timeout);
        // The tenant is its own session, so its group is what its children share.
        let _ = killpg(pid, Signal::SIGKILL);
        let _ = kill(pid, Signal::SIGKILL);
    });
    let code = loop {
        match waitpid(pid, None) {
            Ok(WaitStatus::Exited(_, code)) => break code,
            Ok(WaitStatus::Signaled(_, signal, _)) => {
                break if deadline.is_finished() { numbers::EXEC_DEADLINE_EXIT } else { 128 + signal as i32 };
            }
            Ok(_) | Err(nix::Error::EINTR) => continue,
            Err(e) => return Err(Error::Container(format!("waiting for the tenant: {e}"))),
        }
    };
    remove_stale_notify_sockets(&layout.state_of(id));
    Ok(code)
}

/// youki leaves each tenant's notify socket in the state directory; the ones older than any exec still starting go.
fn remove_stale_notify_sockets(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(TENANT_NOTIFY) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > STALE_NOTIFY);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// What a helper's failure prints before it exits `HELPER_FAILED`.
pub fn helper_failure_line(e: &Error) -> String {
    format!("{HELPER_PREFIX}{e}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_with_no_state_directory_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(dir.path(), PathBuf::from("/bin/true"));
        assert_eq!(runtime.status("wsp-none").unwrap(), Status::Gone);
        assert_eq!(runtime.init_pid("wsp-none").unwrap(), None);
    }

    #[test]
    fn a_process_is_known_by_its_pid_start_time_and_boot_and_a_stat_line_is_read_past_the_command_name() {
        assert_eq!(
            start_ticks("7 (sleep) S 1 7 7 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 424242 8000 200 18446744073709551615").unwrap(),
            424242
        );
        assert_eq!(start_ticks("8 (a (weird) name) S 1 8 8 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 99 8000 200 1").unwrap(), 99);
        assert!(start_ticks("no parentheses here").is_err());
        let own = identity_of(std::process::id() as i32).unwrap();
        assert!(alive(&own));
        assert!(!alive(&Init { started: own.started + 1, ..own.clone() }));
        assert!(!alive(&Init { boot_id: "another boot".into(), ..own.clone() }));
        assert!(!alive(&Init { pid: 4_194_303, ..own }));
    }

    #[test]
    fn stale_notify_sockets_go_and_fresh_ones_stay() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("tenant-notify-old");
        let fresh = dir.path().join("tenant-notify-fresh");
        let other = dir.path().join("state.json");
        for p in [&old, &fresh, &other] {
            fs::write(p, "").unwrap();
        }
        let long_ago = SystemTime::now() - Duration::from_secs(120);
        fs::File::open(&old).unwrap().set_modified(long_ago).unwrap();
        fs::File::open(&other).unwrap().set_modified(long_ago).unwrap();
        remove_stale_notify_sockets(dir.path());
        assert!(!old.exists() && fresh.exists() && other.exists());
    }

    #[test]
    fn a_helper_failure_line_carries_the_prefix_the_daemon_reads() {
        let line = helper_failure_line(&Error::Container("no such container".into()));
        assert_eq!(line, "wsp-runtime: no such container");
        assert_eq!(line.strip_prefix(HELPER_PREFIX), Some("no such container"));
    }
}
