// SPDX-License-Identifier: AGPL-3.0-only
//! The ssh server an editor reaches a workspace through: the image's own OpenSSH, started on the machine's
//! loopback on the first ask with a config, a host key and an authorized_keys file of this daemon's own, and never
//! the machine's own `/root/.ssh`, which a fork on a box has covered empty. It runs in the foreground in a cgroup of
//! its own, so every session and every server an editor leaves behind is one set of processes: once the last session
//! into it has been closed for the idle window, that cgroup is killed whole, and the next ask starts it again.
//! Nothing else in the daemon spells an sshd flag.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use wsp_frames::{words, DaemonErrorCode, SshStartReply};

use crate::paths::OpError;

/// The programs and folders the server is made of, each where Ubuntu puts it unless a case names another.
#[derive(Debug, Clone)]
pub struct Programs {
    pub sshd: PathBuf,
    pub keygen: PathBuf,
    /// The privilege separation folder sshd refuses to start without.
    pub privsep: PathBuf,
    /// Where this machine's own server keeps its files; beside the daemon's token when unset.
    pub dir: Option<PathBuf>,
    /// Where a cgroup of the server's own is made on this machine.
    pub cgroup_root: PathBuf,
}

impl Default for Programs {
    fn default() -> Programs {
        Programs {
            sshd: PathBuf::from("/usr/sbin/sshd"),
            keygen: PathBuf::from("/usr/bin/ssh-keygen"),
            privsep: PathBuf::from("/run/sshd"),
            dir: None,
            cgroup_root: PathBuf::from("/sys/fs/cgroup"),
        }
    }
}

/// The name of the cgroup the server runs in, under the machine's or the workspace's own.
const CGROUP: &str = "wsp-ssh";
/// How long a server gets to start listening.
const START_WAIT: Duration = Duration::from_secs(5);

/// The config, written whole since sshd takes the first occurrence of a keyword. `UsePAM yes` because sshd reads
/// root as locked without it wherever root has no password (the Boat image) or no shadow entry at all (every fork
/// on a box), measured on both; TCP forwarding stays on because VS Code reaches its server through a local forward.
pub(crate) const CONFIG: &str = "PidFile none
UsePAM yes
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
AllowAgentForwarding no
X11Forwarding no
AllowTcpForwarding yes
PermitTunnel no
PrintMotd no
PrintLastLog no
LogLevel ERROR
Subsystem sftp /usr/lib/openssh/sftp-server
";

/// One ed25519 public key line, `ssh-ed25519 <base64> [comment]`, and nothing that could carry a second line or
/// an option into authorized_keys.
pub(crate) fn key_line(key: &str) -> Result<String, OpError> {
    let refused = || OpError::coded(DaemonErrorCode::BadRequest, words::SSH_KEY_SHAPE.to_owned());
    let key = key.trim();
    if key.contains(['\n', '\r', '\0']) {
        return Err(refused());
    }
    let mut parts = key.split_whitespace();
    let (Some("ssh-ed25519"), Some(body)) = (parts.next(), parts.next()) else { return Err(refused()) };
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=');
    if body.len() < 40 || !body.chars().all(plain) {
        return Err(refused());
    }
    let comment: Vec<&str> = parts.collect();
    let printable = |w: &&str| w.chars().all(|c| c.is_ascii_graphic());
    if !comment.iter().all(printable) {
        return Err(refused());
    }
    Ok(if comment.is_empty() { format!("ssh-ed25519 {body}") } else { format!("ssh-ed25519 {body} {}", comment.join(" ")) })
}

/// The machine a server is for: this one, or one workspace this computer runs.
pub(crate) enum Machine<'a> {
    Here,
    #[cfg(target_os = "linux")]
    Inside {
        ops: &'a Arc<wsp_runtime::ops::Ops>,
        id: &'a str,
    },
    #[cfg(not(target_os = "linux"))]
    #[allow(dead_code)]
    Never(std::marker::PhantomData<&'a ()>),
}

impl Machine<'_> {
    fn key(&self) -> String {
        match self {
            Machine::Here => String::new(),
            #[cfg(target_os = "linux")]
            Machine::Inside { id, .. } => (*id).to_owned(),
            #[cfg(not(target_os = "linux"))]
            Machine::Never(_) => String::new(),
        }
    }
}

/// What ends a server and everything it started.
enum Stop {
    /// The cgroup it runs in: killed whole, sessions and the servers they left behind with it.
    Cgroup(PathBuf),
    /// Where no cgroup of its own could be made: its own process group on this machine, or its pid inside.
    Pid(i32),
}

struct Running {
    port: u16,
    host_key: String,
    stop: Stop,
    /// Sessions into it open right now, off the tunnels dialled to its port.
    sessions: usize,
    /// Moves every time a session opens, so an idle timer armed before it knows it is stale.
    turn: u64,
}

/// Every server this daemon started, one per machine.
pub(crate) struct Servers {
    programs: Programs,
    idle: Duration,
    token_dir: PathBuf,
    running: Mutex<HashMap<String, Running>>,
    /// One start at a time, so two editors connecting at once meet one server.
    starting: tokio::sync::Mutex<()>,
}

/// A session into a server, held for as long as its tunnel stands.
pub(crate) struct Session {
    servers: Arc<Servers>,
    key: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        let turn = {
            let mut running = self.servers.lock();
            let Some(held) = running.get_mut(&self.key) else { return };
            held.sessions = held.sessions.saturating_sub(1);
            if held.sessions > 0 {
                return;
            }
            held.turn
        };
        let servers = Arc::clone(&self.servers);
        let key = self.key.clone();
        tokio::spawn(async move {
            tokio::time::sleep(servers.idle).await;
            servers.stop_if_idle(&key, turn).await;
        });
    }
}

impl Servers {
    pub(crate) fn new(programs: Programs, idle: Duration, token_path: &Path) -> Servers {
        let token_dir = token_path.parent().map_or_else(|| PathBuf::from("."), Path::to_path_buf);
        Servers { programs, idle, token_dir, running: Mutex::new(HashMap::new()), starting: tokio::sync::Mutex::new(()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Running>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A tunnel to that port of that machine is a session into its server; nothing for any other port.
    pub(crate) fn session(self: &Arc<Self>, key: &str, port: u16) -> Option<Session> {
        let mut running = self.lock();
        let held = running.get_mut(key).filter(|held| held.port == port)?;
        held.sessions += 1;
        held.turn += 1;
        Some(Session { servers: Arc::clone(self), key: key.to_owned() })
    }

    /// The server of that machine, started if none answers, with the key given as the whole of who it lets in.
    pub(crate) async fn start(self: &Arc<Self>, machine: Machine<'_>, key: &str) -> Result<SshStartReply, OpError> {
        let key_line = key_line(key)?;
        let _one = self.starting.lock().await;
        let at = self.files(&machine)?;
        let authorized = format!("{key_line}\n");
        let held = self.lock().get(&machine.key()).map(|held| (held.port, held.host_key.clone()));
        if let Some((port, host_key)) = held {
            if dial(&machine, port).await.is_ok() {
                self.put_files(&machine, &at, authorized.as_bytes()).await?;
                return Ok(SshStartReply { port, host_key });
            }
            // A server that no longer answers is one to put back, whatever ended it.
            let gone = self.lock().remove(&machine.key());
            if let Some(gone) = gone {
                end(gone.stop).await;
            }
        }
        if !self.has_sshd(&machine).await? {
            return Err(OpError::plain(words::NO_SSHD));
        }
        // A server this daemon holds none of, still in the machine's cgroup, is one an older daemon started and was
        // ended before it could end: it goes before another is started beside it.
        if let Some(left) = self.cgroup_of(&machine).filter(|cgroup| cgroup.exists()) {
            let _ = tokio::task::spawn_blocking(move || kill_cgroup(&left)).await;
        }
        self.put_files(&machine, &at, authorized.as_bytes()).await?;
        self.prepare(&machine, &at).await?;
        let host_key =
            self.host_key(&machine, &at).await?.ok_or_else(|| OpError::plain("reading the ssh server's host key: none was made"))?;
        let port = free_port(&machine).await?;
        let inside = |name: &str| at.dir.join(name).to_string_lossy().into_owned();
        let argv = vec![
            self.program(&machine, &self.programs.sshd, "/usr/sbin/sshd"),
            "-D".to_owned(),
            "-e".to_owned(),
            "-f".to_owned(),
            inside("sshd_config"),
            "-h".to_owned(),
            inside("host_ed25519"),
            "-o".to_owned(),
            format!("AuthorizedKeysFile={}", inside("authorized_keys")),
            "-o".to_owned(),
            format!("ListenAddress=127.0.0.1:{port}"),
        ];
        let (pid, said) = spawn(&machine, &argv).await?;
        let stop = self.contain(&machine, pid);
        let deadline = Instant::now() + START_WAIT;
        loop {
            if dial(&machine, port).await.is_ok() {
                break;
            }
            if Instant::now() >= deadline || !alive_on(&machine, pid) {
                end(stop).await;
                let last = said.lock().unwrap_or_else(|e| e.into_inner()).clone();
                return Err(OpError::plain(format!(
                    "the ssh server did not start: {}",
                    if last.is_empty() { "it said nothing" } else { &last }
                )));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.lock().insert(machine.key(), Running { port, host_key: host_key.clone(), stop, sessions: 0, turn: 0 });
        // Started and nobody in yet: an editor that never connects leaves nothing running past the idle window.
        let servers = Arc::clone(self);
        let key = machine.key();
        tokio::spawn(async move {
            tokio::time::sleep(servers.idle).await;
            servers.stop_if_idle(&key, 0).await;
        });
        Ok(SshStartReply { port, host_key })
    }

    /// Ends the server of that machine if nobody has opened a session into it since the timer was armed.
    async fn stop_if_idle(&self, key: &str, turn: u64) {
        let gone = {
            let mut running = self.lock();
            match running.get(key) {
                Some(held) if held.sessions == 0 && held.turn == turn => running.remove(key),
                _ => None,
            }
        };
        if let Some(gone) = gone {
            end(gone.stop).await;
        }
    }

    /// The folder the files are in as the server reads them: this machine's own, made private here, or the
    /// workspace's, which only the runtime's doors below write.
    fn files(&self, machine: &Machine<'_>) -> Result<Files, OpError> {
        match machine {
            Machine::Here => {
                let dir = self.programs.dir.clone().unwrap_or_else(|| self.token_dir.join("ssh"));
                make_private_dir(&dir)?;
                Ok(Files { dir })
            }
            #[cfg(target_os = "linux")]
            Machine::Inside { .. } => Ok(Files { dir: PathBuf::from(wsp_runtime::bundle::SSH_DIR_INSIDE) }),
            #[cfg(not(target_os = "linux"))]
            Machine::Never(_) => Err(OpError::plain(words::NO_SSHD)),
        }
    }

    /// Whether the machine has an sshd to start: this one's own configured path, or the image's, asked inside.
    async fn has_sshd(&self, machine: &Machine<'_>) -> Result<bool, OpError> {
        match machine {
            Machine::Here => Ok(self.programs.sshd.exists()),
            #[cfg(target_os = "linux")]
            Machine::Inside { ops, id } => {
                let asked =
                    ops.exec_in(id, "test -x /usr/sbin/sshd", None, Duration::from_secs(20)).await.map_err(crate::ops::from_runtime)?;
                Ok(asked.exit_code == 0)
            }
            #[cfg(not(target_os = "linux"))]
            Machine::Never(_) => Ok(false),
        }
    }

    /// The key it lets in and its config. Inside a workspace these go through the runtime, which follows no link
    /// the workspace planted: its root could otherwise point them at this computer's own files. That call runs off
    /// the async threads, since what it opens is the workspace's to make.
    async fn put_files(&self, machine: &Machine<'_>, at: &Files, authorized: &[u8]) -> Result<(), OpError> {
        match machine {
            Machine::Here => {
                write_private(&at.dir.join("authorized_keys"), authorized)?;
                write_private(&at.dir.join("sshd_config"), CONFIG.as_bytes())
            }
            #[cfg(target_os = "linux")]
            Machine::Inside { ops, id } => {
                let (ops, id, authorized) = (Arc::clone(ops), (*id).to_owned(), authorized.to_vec());
                tokio::task::spawn_blocking(move || ops.write_ssh_files_in(&id, &authorized, CONFIG.as_bytes()))
                    .await
                    .map_err(|e| OpError::plain(format!("writing the ssh server's files: {e}")))?
                    .map_err(crate::ops::from_runtime)
            }
            #[cfg(not(target_os = "linux"))]
            Machine::Never(_) => Err(OpError::plain(words::NO_SSHD)),
        }
    }

    /// The public half of its host key, by the same road; nothing where none is made yet.
    async fn host_key(&self, machine: &Machine<'_>, at: &Files) -> Result<Option<String>, OpError> {
        match machine {
            Machine::Here => match std::fs::read_to_string(at.dir.join("host_ed25519.pub")) {
                Ok(text) => Ok(Some(text.trim().to_owned())),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(OpError::plain(format!("reading the ssh server's host key: {e}"))),
            },
            #[cfg(target_os = "linux")]
            Machine::Inside { ops, id } => {
                let (ops, id) = (Arc::clone(ops), (*id).to_owned());
                tokio::task::spawn_blocking(move || ops.ssh_host_key_in(&id))
                    .await
                    .map_err(|e| OpError::plain(format!("reading the ssh server's host key: {e}")))?
                    .map_err(crate::ops::from_runtime)
            }
            #[cfg(not(target_os = "linux"))]
            Machine::Never(_) => Ok(None),
        }
    }

    /// The program as the machine runs it: this machine's own configured path, or the image's inside a workspace.
    fn program(&self, machine: &Machine<'_>, here: &Path, inside: &str) -> String {
        match machine {
            Machine::Here => here.to_string_lossy().into_owned(),
            #[cfg(target_os = "linux")]
            Machine::Inside { .. } => inside.to_owned(),
            #[cfg(not(target_os = "linux"))]
            Machine::Never(_) => inside.to_owned(),
        }
    }

    /// The host key made once, and the privilege separation folder sshd wants, on the machine itself.
    async fn prepare(&self, machine: &Machine<'_>, at: &Files) -> Result<(), OpError> {
        let key_there = self.host_key(machine, at).await?.is_some();
        match machine {
            Machine::Here => {
                let _ = std::fs::create_dir_all(&self.programs.privsep);
                if !key_there {
                    let key = at.dir.join("host_ed25519");
                    let made = tokio::process::Command::new(&self.programs.keygen)
                        .args(["-q", "-t", "ed25519", "-N", "", "-C", "wsp", "-f"])
                        .arg(&key)
                        .stdin(std::process::Stdio::null())
                        .output()
                        .await
                        .map_err(|e| OpError::plain(format!("making the ssh server's host key: {e}")))?;
                    if !made.status.success() {
                        return Err(OpError::plain(format!(
                            "making the ssh server's host key: {}",
                            String::from_utf8_lossy(&made.stderr).trim()
                        )));
                    }
                }
                Ok(())
            }
            #[cfg(target_os = "linux")]
            Machine::Inside { ops, id } => {
                let key = at.dir.join("host_ed25519");
                // Inside the workspace's own namespaces, where its links resolve against its own root. A private half
                // left without its public one goes first, since ssh-keygen stops to ask before writing over it.
                let make = if key_there {
                    String::new()
                } else {
                    format!("\nrm -f '{0}' '{0}.pub'\n/usr/bin/ssh-keygen -q -t ed25519 -N '' -C wsp -f '{0}'", key.display())
                };
                let done = ops
                    .exec_in(id, &format!("mkdir -p /run/sshd{make}"), None, Duration::from_secs(20))
                    .await
                    .map_err(crate::ops::from_runtime)?;
                if done.exit_code != 0 {
                    return Err(OpError::plain(format!("making the ssh server's host key: {}", done.stderr.trim())));
                }
                Ok(())
            }
            #[cfg(not(target_os = "linux"))]
            Machine::Never(_) => Ok(()),
        }
    }

    /// The cgroup a server of that machine runs in, where the machine has one to put it under.
    fn cgroup_of(&self, machine: &Machine<'_>) -> Option<PathBuf> {
        let base = match machine {
            Machine::Here => Ok(self.programs.cgroup_root.clone()),
            #[cfg(target_os = "linux")]
            Machine::Inside { ops, id } => ops.cgroup_of_running(id).map_err(|_| ()),
            #[cfg(not(target_os = "linux"))]
            Machine::Never(_) => Err(()),
        };
        base.ok().map(|base| base.join(CGROUP))
    }

    /// Every server this daemon started, ended with all they started: what a daemon does on its way out, since the
    /// one that follows it knows none of them and would start a second beside each.
    pub(crate) async fn end_all(&self) {
        let held: Vec<Running> = self.lock().drain().map(|(_, r)| r).collect();
        for r in held {
            end(r.stop).await;
        }
    }

    /// Puts the server in a cgroup of its own under the machine's or the workspace's, so what its sessions leave
    /// behind is ended with it; its own pid where no such cgroup can be made.
    fn contain(&self, machine: &Machine<'_>, pid: i32) -> Stop {
        let Some(cgroup) = self.cgroup_of(machine) else { return Stop::Pid(pid) };
        let moved = std::fs::create_dir_all(&cgroup).and_then(|()| std::fs::write(cgroup.join("cgroup.procs"), pid.to_string()));
        match moved {
            Ok(()) => Stop::Cgroup(cgroup),
            Err(_) => Stop::Pid(pid),
        }
    }
}

struct Files {
    dir: PathBuf,
}

fn make_private_dir(dir: &Path) -> Result<(), OpError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).map_err(|e| OpError::plain(format!("making {}: {e}", dir.display())))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| OpError::plain(format!("{}: {e}", dir.display())))
}

/// A file only its owner reads, written beside itself and renamed over, so sshd never reads half of one.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), OpError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let next = path.with_extension("next");
    let wrote = (|| -> io::Result<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&next)?;
        file.write_all(bytes)?;
        std::fs::rename(&next, path)
    })();
    wrote.map_err(|e| OpError::plain(format!("writing {}: {e}", path.display())))
}

async fn free_port(machine: &Machine<'_>) -> Result<u16, OpError> {
    match machine {
        Machine::Here => {
            let bound = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| OpError::plain(format!("finding a free port: {e}")))?;
            bound.local_addr().map(|a| a.port()).map_err(|e| OpError::plain(format!("finding a free port: {e}")))
        }
        #[cfg(target_os = "linux")]
        Machine::Inside { ops, id } => ops.free_port_in(id).await.map_err(crate::ops::from_runtime),
        #[cfg(not(target_os = "linux"))]
        Machine::Never(_) => Err(OpError::plain(words::NO_SSHD)),
    }
}

async fn dial(machine: &Machine<'_>, port: u16) -> io::Result<TcpStream> {
    match machine {
        Machine::Here => TcpStream::connect(("127.0.0.1", port)).await,
        #[cfg(target_os = "linux")]
        Machine::Inside { ops, id } => ops.dial_in(id, port).await.map_err(|e| io::Error::other(e.message)),
        #[cfg(not(target_os = "linux"))]
        Machine::Never(_) => Err(io::Error::other("no such machine")),
    }
}

/// The server started in the foreground, and what it last said on stderr, kept for a start that fails.
async fn spawn(machine: &Machine<'_>, argv: &[String]) -> Result<(i32, Arc<Mutex<String>>), OpError> {
    let said = Arc::new(Mutex::new(String::new()));
    let (mut child, pid) = match machine {
        Machine::Here => {
            let mut cmd = tokio::process::Command::new(&argv[0]);
            cmd.args(&argv[1..])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped());
            // Its own group, which is what ends it where no cgroup can be made.
            cmd.process_group(0);
            let child = cmd.spawn().map_err(|e| OpError::plain(format!("starting the ssh server: {e}")))?;
            let pid = child.id().and_then(|p| i32::try_from(p).ok()).ok_or_else(|| OpError::plain("the ssh server ended as it started"))?;
            (child, pid)
        }
        #[cfg(target_os = "linux")]
        Machine::Inside { ops, id } => {
            let spawned = ops.spawn_in(id, argv).await.map_err(crate::ops::from_runtime)?;
            let pid = i32::try_from(spawned.pid).map_err(|_| OpError::plain("the ssh server's pid does not fit"))?;
            (spawned.helper, pid)
        }
        #[cfg(not(target_os = "linux"))]
        Machine::Never(_) => return Err(OpError::plain(words::NO_SSHD)),
    };
    let lines = Arc::clone(&said);
    let err = child.stderr.take();
    tokio::spawn(async move {
        if let Some(mut err) = err {
            let mut buf = vec![0u8; 4096];
            while let Ok(n) = err.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buf[..n]);
                if let Some(line) = text.lines().map(str::trim).rfind(|l| !l.is_empty()) {
                    *lines.lock().unwrap_or_else(|e| e.into_inner()) = line.to_owned();
                }
            }
        }
        // Reaped here whenever it ends, so nothing is left a zombie of this daemon's.
        let _ = child.wait().await;
    });
    Ok((pid, said))
}

fn alive_on(machine: &Machine<'_>, pid: i32) -> bool {
    let _ = machine;
    std::path::Path::new(&format!("/proc/{pid}")).exists() || nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

/// Kills the server and everything under it, and waits for the cgroup to empty before taking it away.
async fn end(stop: Stop) {
    match stop {
        Stop::Cgroup(cgroup) => {
            let _ = tokio::task::spawn_blocking(move || kill_cgroup(&cgroup)).await;
        }
        Stop::Pid(pid) => {
            use nix::sys::signal::{kill, killpg, Signal};
            use nix::unistd::Pid;
            if killpg(Pid::from_raw(pid), Signal::SIGKILL).is_err() {
                let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
            }
        }
    }
}

/// cgroup.kill where the kernel has it, and SIGKILL to every pid the cgroup lists besides, until none of them is
/// alive or a second passes; then the cgroup itself goes.
fn kill_cgroup(cgroup: &Path) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    let listed = || -> Vec<i32> {
        std::fs::read_to_string(cgroup.join("cgroup.procs"))
            .map(|t| t.lines().filter_map(|l| l.trim().parse().ok()).collect())
            .unwrap_or_default()
    };
    let deadline = Instant::now() + Duration::from_secs(1);
    let _ = std::fs::write(cgroup.join("cgroup.kill"), "1");
    loop {
        let alive: Vec<i32> = listed().into_iter().filter(|pid| kill(Pid::from_raw(*pid), None).is_ok()).collect();
        if alive.is_empty() || Instant::now() >= deadline {
            break;
        }
        for pid in alive {
            let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = std::fs::remove_dir(cgroup);
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMdk8rPQwJx5kMq0bD8xg1d0i7wYcU6r3Jc4oYy4S2Qm you@mac";

    #[test]
    fn a_key_is_one_ed25519_line_and_nothing_that_could_smuggle_another() {
        assert_eq!(key_line(KEY).unwrap(), KEY);
        assert_eq!(key_line(&format!("  {KEY}\n")).unwrap(), KEY);
        let refused = |k: &str| key_line(k).unwrap_err();
        for bad in [
            "",
            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 you@mac",
            &format!("{KEY}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMdk8rPQwJx5kMq0bD8xg1d0i7wYcU6r3Jc4oYy4S2Qm other"),
            "command=\"sh\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMdk8rPQwJx5kMq0bD8xg1d0i7wYcU6r3Jc4oYy4S2Qm",
            "ssh-ed25519 short",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMdk8rPQwJx5kMq0bD8xg1d0i7wYcU6r3Jc4oYy4S2Q\"m",
        ] {
            let err = refused(bad);
            assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::BadRequest), words::SSH_KEY_SHAPE), "{bad}");
        }
    }

    #[test]
    fn the_config_logs_in_through_pam_and_lets_in_nothing_but_a_key() {
        let lines: Vec<&str> = CONFIG.lines().collect();
        for wanted in [
            "UsePAM yes",
            "PasswordAuthentication no",
            "KbdInteractiveAuthentication no",
            "AllowAgentForwarding no",
            "X11Forwarding no",
            "PermitTunnel no",
            "PidFile none",
        ] {
            assert!(lines.contains(&wanted), "{wanted}");
        }
        // Written whole: sshd takes a keyword's first occurrence, so no keyword appears twice.
        let mut seen = std::collections::HashSet::new();
        for line in &lines {
            assert!(seen.insert(line.split_whitespace().next().unwrap()), "{line}");
        }
    }

    /// A stand-in sshd: it records its argv and listens where ListenAddress says until it is killed; a stand-in
    /// ssh-keygen writes the two halves of a host key.
    pub(crate) fn stand_ins(dir: &Path) -> Programs {
        use std::os::unix::fs::PermissionsExt;
        let sshd = dir.join("sshd");
        std::fs::write(
            &sshd,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}/argv'\nfor a in \"$@\"; do case \"$a\" in ListenAddress=*) port=${{a##*:}};; esac; done\nexec python3 -c 'import socket,sys,time\ns=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((\"127.0.0.1\", int(sys.argv[1]))); s.listen(8)\nwhile True: c,_=s.accept(); c.sendall(b\"SSH-2.0-stand-in\\r\\n\")' \"$port\"\n",
                dir.display()
            ),
        )
        .unwrap();
        let keygen = dir.join("ssh-keygen");
        std::fs::write(
            &keygen,
            "#!/bin/sh\nfor a in \"$@\"; do f=\"$a\"; done\nprintf 'private\\n' > \"$f\"\nprintf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyHostKeyHostKeyHostKeyHostKeyHostKey1 wsp\\n' > \"$f.pub\"\n",
        )
        .unwrap();
        for p in [&sshd, &keygen] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        Programs { sshd, keygen, privsep: dir.join("privsep"), dir: Some(dir.join("files")), cgroup_root: dir.join("cgroup") }
    }

    fn servers(dir: &Path, idle: Duration) -> Arc<Servers> {
        Arc::new(Servers::new(stand_ins(dir), idle, &dir.join("token")))
    }

    #[tokio::test]
    async fn the_first_ask_starts_the_server_on_a_free_loopback_port_with_the_files_of_its_own_and_the_second_starts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let s = servers(dir.path(), Duration::from_secs(60));
        let first = s.start(Machine::Here, KEY).await.unwrap();
        assert!(first.port >= 1024);
        assert_eq!(first.host_key, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyHostKeyHostKeyHostKeyHostKeyHostKey1 wsp");
        let files = dir.path().join("files");
        assert_eq!(std::fs::read_to_string(files.join("authorized_keys")).unwrap(), format!("{KEY}\n"));
        assert_eq!(std::fs::read_to_string(files.join("sshd_config")).unwrap(), CONFIG);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&files).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(files.join("authorized_keys")).unwrap().permissions().mode() & 0o777, 0o600);
        let argv = std::fs::read_to_string(dir.path().join("argv")).unwrap();
        let argv: Vec<&str> = argv.lines().collect();
        assert_eq!(argv[..2], ["-D", "-e"]);
        assert!(argv.contains(&format!("ListenAddress=127.0.0.1:{}", first.port).as_str()), "{argv:?}");
        assert!(argv.contains(&format!("AuthorizedKeysFile={}", files.join("authorized_keys").display()).as_str()), "{argv:?}");
        // The server stands in a cgroup of its own, which is what ends it and what its sessions leave behind.
        let procs = std::fs::read_to_string(dir.path().join("cgroup/wsp-ssh/cgroup.procs")).unwrap();
        assert!(!procs.trim().is_empty());
        std::fs::remove_file(dir.path().join("argv")).unwrap();
        let second = s.start(Machine::Here, KEY).await.unwrap();
        assert_eq!(second, first);
        assert!(!dir.path().join("argv").exists(), "a second ask started a second server");
        end_all(&s).await;
    }

    #[tokio::test]
    async fn a_machine_with_no_sshd_is_refused_in_one_sentence_and_a_bad_key_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let mut programs = stand_ins(dir.path());
        programs.sshd = dir.path().join("nowhere/sshd");
        let s = Arc::new(Servers::new(programs, Duration::from_secs(60), &dir.path().join("token")));
        assert_eq!(s.start(Machine::Here, KEY).await.unwrap_err().message, words::NO_SSHD);
        let bad = servers(tempfile::tempdir().unwrap().path(), Duration::from_secs(60));
        assert_eq!(bad.start(Machine::Here, "ssh-rsa AAAA").await.unwrap_err().code, Some(DaemonErrorCode::BadRequest));
    }

    #[tokio::test]
    async fn the_server_is_ended_once_its_last_session_has_been_closed_for_the_idle_window_and_not_while_one_stands() {
        let dir = tempfile::tempdir().unwrap();
        let s = servers(dir.path(), Duration::from_millis(300));
        let started = s.start(Machine::Here, KEY).await.unwrap();
        assert!(s.session("", started.port + 1).is_none(), "a tunnel to another port is no session");
        let one = s.session("", started.port).unwrap();
        let two = s.session("", started.port).unwrap();
        drop(one);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(TcpStream::connect(("127.0.0.1", started.port)).await.is_ok(), "ended while a session stood");
        drop(two);
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert!(TcpStream::connect(("127.0.0.1", started.port)).await.is_err(), "still up past the idle window");
        assert!(s.lock().is_empty());
        // The next ask starts it again.
        let again = s.start(Machine::Here, KEY).await.unwrap();
        assert!(TcpStream::connect(("127.0.0.1", again.port)).await.is_ok());
        end_all(&s).await;
    }

    async fn end_all(s: &Arc<Servers>) {
        s.end_all().await;
    }

    /// A process standing in for what a server this daemon never started left in the machine's cgroup: an older
    /// daemon's, ended by an update or a crash before it could end its own.
    fn left_behind(cgroup_root: &Path) -> std::process::Child {
        let child = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        let cgroup = cgroup_root.join(CGROUP);
        std::fs::create_dir_all(&cgroup).unwrap();
        std::fs::write(cgroup.join("cgroup.procs"), format!("{}\n", child.id())).unwrap();
        child
    }

    fn gone(child: &mut std::process::Child) -> bool {
        for _ in 0..40 {
            if child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[tokio::test]
    async fn a_server_an_older_daemon_left_in_the_machines_cgroup_is_ended_before_one_is_started() {
        let dir = tempfile::tempdir().unwrap();
        let s = servers(dir.path(), Duration::from_secs(60));
        let mut old = left_behind(&dir.path().join("cgroup"));
        let started = s.start(Machine::Here, KEY).await.unwrap();
        assert!(gone(&mut old), "the old server still runs beside the new one");
        assert!(TcpStream::connect(("127.0.0.1", started.port)).await.is_ok());
        end_all(&s).await;
    }

    #[tokio::test]
    async fn ending_them_all_leaves_no_server_listening_and_none_held() {
        let dir = tempfile::tempdir().unwrap();
        let s = servers(dir.path(), Duration::from_secs(60));
        let started = s.start(Machine::Here, KEY).await.unwrap();
        s.end_all().await;
        assert!(s.lock().is_empty());
        let mut refused = false;
        for _ in 0..40 {
            if TcpStream::connect(("127.0.0.1", started.port)).await.is_err() {
                refused = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(refused, "still listening after every server was ended");
    }
}
