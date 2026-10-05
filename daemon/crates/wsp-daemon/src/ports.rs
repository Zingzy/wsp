// SPDX-License-Identifier: AGPL-3.0-only
//! This machine's listening TCP ports, one road per platform: Linux reads /proc/net/tcp and finds each socket's
//! holder through the /proc/[pid]/fd tables (pgrep is not on every guest); macOS asks lsof. Each watching socket is
//! told what opened and what closed against what it was last told. A browser's DevTools debugging port is no server
//! and is dropped here, where every reader of the ports gets them, once it has answered as one. On a computer
//! somebody owns, every workspace there shares this daemon, so a workspace's socket names roots and sees only the
//! listeners they hold: the process groups of its turns and terminals, as the host names them, every process under
//! those, and every process running in the workspace's folder. A watch that names no roots, which is what the host's
//! own watchers ask for, sees the whole machine.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use wsp_frames::{numbers, DaemonEvent, ListeningPort};

use crate::sys_local::host_command;
use crate::{clock, Outbound};

const TCP_LISTEN: &str = "0A";
/// One read per five seconds, each diffed against the last: a listener that opens and closes between two reads sends
/// nothing, and what moved goes out as one batch. A read a second sent 14 events a second to every page on a Mac.
pub(crate) const DEFAULT_INTERVAL: Duration = Duration::from_secs(5);
/// How long a new listener gets to answer the DevTools question, and how much of its answer is read.
const DEVTOOLS_PROBE: Duration = Duration::from_millis(500);
const DEVTOOLS_REPLY_CAP: u64 = 16 * 1024;

/// One reading of what listens now, from whichever road the platform has.
pub(crate) type PortSource = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Vec<ListeningPort>> + Send>> + Send + Sync>;

/// Whether a listening address reaches only this computer: 127.0.0.0/8 or ::1, the IPv4-mapped form of either
/// included. The one rule, over the address bytes in network order; each road parses its own encoding down to them.
fn is_loopback_bytes(bytes: &[u8]) -> bool {
    match bytes.len() {
        4 => bytes[0] == 127,
        16 => {
            if bytes[..10].iter().any(|b| *b != 0) {
                return false;
            }
            if bytes[10] == 0xff && bytes[11] == 0xff {
                return is_loopback_bytes(&bytes[12..]);
            }
            bytes[10..] == [0, 0, 0, 0, 0, 1]
        }
        _ => false,
    }
}

/// The address bytes behind /proc/net/tcp's address column: each 32-bit word is printed little-endian in hex, so
/// 0100007F is 127.0.0.1 and a tcp6 row carries four such words. Empty for a column of any other width.
fn hex_address_bytes(addr: &str) -> Vec<u8> {
    if addr.len() != 8 && addr.len() != 32 || !addr.is_ascii() {
        return Vec::new();
    }
    let mut bytes = Vec::with_capacity(addr.len() / 2);
    for word in addr.as_bytes().chunks(8) {
        for byte in word.chunks(2).rev() {
            match u8::from_str_radix(std::str::from_utf8(byte).unwrap_or("zz"), 16) {
                Ok(b) => bytes.push(b),
                Err(_) => return Vec::new(),
            }
        }
    }
    bytes
}

pub(crate) fn is_loopback_hex(addr: &str) -> bool {
    is_loopback_bytes(&hex_address_bytes(addr))
}

/// The address bytes behind a numeric host as lsof prints it: a dotted quad, an IPv6 address with its brackets
/// already off, or an IPv4-mapped one. Empty for a wildcard and for anything that does not parse.
fn host_address_bytes(host: &str) -> Vec<u8> {
    if host.contains(':') {
        host.parse::<std::net::Ipv6Addr>().map(|a| a.octets().to_vec()).unwrap_or_default()
    } else {
        host.parse::<std::net::Ipv4Addr>().map(|a| a.octets().to_vec()).unwrap_or_default()
    }
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    is_loopback_bytes(&host_address_bytes(host))
}

/// /proc/net/tcp (or tcp6; same layout, wider address) as LISTEN rows. The file carries socket inodes, not pids;
/// the inode-to-pid map built from a /proc/[pid]/fd scan names the owners.
pub(crate) fn parse_proc_net_tcp(text: &str, inode_to_pid: Option<&HashMap<u64, u32>>) -> Vec<ListeningPort> {
    let mut rows = Vec::new();
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 10 || f[3] != TCP_LISTEN {
            continue;
        }
        let (addr, port_hex) = f[1].rsplit_once(':').unwrap_or(("", f[1]));
        let Ok(port) = u16::from_str_radix(port_hex, 16) else { continue };
        let Ok(inode) = f[9].parse::<u64>() else { continue };
        rows.push(ListeningPort {
            port,
            pid: inode_to_pid.and_then(|m| m.get(&inode).copied()),
            inode: Some(inode),
            uid: f[7].parse().unwrap_or(0),
            process: None,
            command: None,
            loopback: is_loopback_hex(addr),
        });
    }
    rows
}

/// Every socket inode a process holds, to the pid holding it. pgrep does not exist in the guests; walking
/// /proc/[pid]/fd is the portable way.
fn scan_socket_inodes(proc_root: &Path) -> HashMap<u64, u32> {
    let mut map = HashMap::new();
    let Ok(dirs) = std::fs::read_dir(proc_root) else { return map };
    for dir in dirs.flatten() {
        let Some(pid) = dir.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(fds) = std::fs::read_dir(dir.path().join("fd")) else { continue };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else { continue };
            let target = target.to_string_lossy();
            if let Some(inode) = target.strip_prefix("socket:[").and_then(|t| t.strip_suffix(']')).and_then(|n| n.parse::<u64>().ok()) {
                map.insert(inode, pid);
            }
        }
    }
    map
}

fn read_comm(proc_root: &Path, pid: u32) -> Option<String> {
    let comm = std::fs::read_to_string(proc_root.join(pid.to_string()).join("comm")).ok()?;
    let comm = comm.trim();
    (!comm.is_empty()).then(|| comm.to_owned())
}

/// The holder's argv joined by spaces, at most PORT_CMDLINE_CAP_BYTES of it; a cut argv ends with an ellipsis.
/// cmdline separates argv with NUL bytes and ends with one.
fn read_cmdline(proc_root: &Path, pid: u32) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(proc_root.join(pid.to_string()).join("cmdline")).ok()?;
    let mut buf = vec![0u8; numbers::PORT_CMDLINE_CAP_BYTES + 1];
    let mut read = 0;
    while read < buf.len() {
        match file.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => return None,
        }
    }
    let kept = String::from_utf8_lossy(&buf[..read.min(numbers::PORT_CMDLINE_CAP_BYTES)]).into_owned();
    let command: Vec<&str> = kept.split('\0').filter(|a| !a.is_empty()).collect();
    if command.is_empty() {
        return None;
    }
    let command = command.join(" ");
    Some(if read > numbers::PORT_CMDLINE_CAP_BYTES { format!("{command}\u{2026}") } else { command })
}

/// The Linux road, as one reading: tcp then tcp6, one row per port (the first wins), each owner named by comm and
/// cmdline where the fd scan found one.
pub(crate) fn proc_snapshot(proc_root: &Path) -> Vec<ListeningPort> {
    let texts = ["tcp", "tcp6"].map(|name| std::fs::read_to_string(proc_root.join("net").join(name)).unwrap_or_default());
    let inode_to_pid = scan_socket_inodes(proc_root);
    let mut rows: Vec<ListeningPort> = Vec::new();
    for text in &texts {
        for row in parse_proc_net_tcp(text, Some(&inode_to_pid)) {
            if !rows.iter().any(|r| r.port == row.port) {
                rows.push(row);
            }
        }
    }
    for row in &mut rows {
        if let Some(pid) = row.pid {
            row.process = read_comm(proc_root, pid);
            row.command = read_cmdline(proc_root, pid);
        }
    }
    rows
}

pub(crate) fn proc_net_tcp_source(proc_root: PathBuf) -> PortSource {
    Arc::new(move || {
        let root = proc_root.clone();
        Box::pin(async move { tokio::task::spawn_blocking(move || proc_snapshot(&root)).await.unwrap_or_default() })
    })
}

/// lsof's field output for the listening TCP sockets this user can see: numeric hosts and ports, untruncated
/// command names, and one field per line. A process set opens with its pid and carries its command and uid; each
/// socket under it opens with its fd and carries its address.
const LSOF_ARGS: [&str; 8] = ["-nP", "-w", "+c", "0", "-F", "pcfnu", "-iTCP", "-sTCP:LISTEN"];

/// lsof field output into LISTEN rows. The fd lines only separate one socket from the next; a row is the process
/// set's pid, command and uid with that socket's address. lsof names neither an argv nor a socket inode.
pub(crate) fn parse_lsof_listeners(text: &str) -> Vec<ListeningPort> {
    let mut rows = Vec::new();
    let (mut pid, mut uid, mut process): (Option<u32>, u32, Option<String>) = (None, 0, None);
    for line in text.lines() {
        let Some(field) = line.chars().next() else { continue };
        let value = &line[field.len_utf8()..];
        match field {
            'p' => {
                pid = value.parse().ok();
                uid = 0;
                process = None;
            }
            'c' => {
                if !value.is_empty() {
                    process = Some(value.to_owned());
                }
            }
            'u' => uid = value.parse().unwrap_or(0),
            'n' => {
                let Some((host, port)) = value.rsplit_once(':') else { continue };
                let Ok(port) = port.parse::<u16>() else { continue };
                let host = host.strip_prefix('[').unwrap_or(host);
                let host = host.strip_suffix(']').unwrap_or(host);
                rows.push(ListeningPort {
                    port,
                    pid,
                    inode: None,
                    uid,
                    process: process.clone(),
                    command: None,
                    loopback: is_loopback_host(host),
                });
            }
            _ => {}
        }
    }
    rows
}

/// The darwin road: /proc does not exist there, so lsof names the listeners. lsof exits non-zero when nothing is
/// listening, and whatever it printed before that is still read; a lsof that cannot run reads as no ports.
pub(crate) async fn lsof_snapshot(program: &Path) -> Vec<ListeningPort> {
    let printed = match tokio::process::Command::new(program).args(LSOF_ARGS).output().await {
        Ok(out) => String::from_utf8_lossy(&out.stdout).into_owned(),
        Err(_) => String::new(),
    };
    let mut rows: Vec<ListeningPort> = Vec::new();
    for row in parse_lsof_listeners(&printed) {
        if !rows.iter().any(|r| r.port == row.port) {
            rows.push(row);
        }
    }
    rows
}

pub(crate) fn lsof_source() -> PortSource {
    Arc::new(|| Box::pin(lsof_snapshot(Path::new("lsof"))))
}

/// A platform with no road here reads empty rather than failing the daemon that asked, so a pane on it shows no
/// ports instead of no daemon.
pub(crate) fn empty_source() -> PortSource {
    Arc::new(|| Box::pin(async { Vec::new() }))
}

/// The road for this daemon: a fake /proc stands in for the whole machine, ports included, when one is given, so a
/// test on darwin drives the Linux road; the platform's own road otherwise.
pub(crate) fn source_for(proc_root: Option<&Path>) -> PortSource {
    match proc_root {
        Some(root) => proc_net_tcp_source(root.to_path_buf()),
        None if cfg!(target_os = "linux") => proc_net_tcp_source(PathBuf::from("/proc")),
        None if cfg!(target_os = "macos") => lsof_source(),
        None => empty_source(),
    }
}

/// Whether a listener is a browser's DevTools debugging port, by what it answers once its holder is one: such a
/// port answers `GET /json/version` with a `Browser` field. A port that refuses, stalls or says anything else is not.
/// Chrome's server closes on an HTTP/1.0 request and holds an HTTP/1.1 one open after its reply, so the ask is 1.1
/// and the read stops at the reply's Content-Length.
async fn is_devtools(port: u16) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let asked = async {
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        socket.write_all(b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await.ok()?;
        let mut reply = Vec::new();
        let mut chunk = [0u8; 4096];
        let body = loop {
            let read = socket.read(&mut chunk).await.ok()?;
            reply.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&reply);
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
                });
                if read == 0 || length.is_some_and(|length| body.len() >= length) {
                    break body.to_owned();
                }
            }
            if read == 0 || reply.len() as u64 >= DEVTOOLS_REPLY_CAP {
                return None;
            }
        };
        let version: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
        Some(version.get("Browser").is_some_and(serde_json::Value::is_string))
    };
    matches!(tokio::time::timeout(DEVTOOLS_PROBE, asked).await, Ok(Some(true)))
}

/// Signal 0 delivers nothing and reports whether the pid exists; EPERM means it does, under another user.
fn pid_alive(pid: u32) -> bool {
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None) {
        Ok(()) => true,
        Err(errno) => errno == nix::errno::Errno::EPERM,
    }
}

/// The processes a DevTools port can belong to, by the name the listener's holder goes by: /proc/<pid>/comm on Linux,
/// cut at 15 bytes, and lsof's whole command name on a Mac, where each app's helpers are named after it. Electron is
/// here because a DevTools port on an Electron app is one to hide too. A listener held by anything else is never
/// asked, a node server a thread's tests start among them.
const BROWSER_NAMES: [&str; 11] = [
    "google chrome",
    "chrome",
    "chromium",
    "chromium-browse",
    "headless_shell",
    "microsoft edge",
    "msedge",
    "brave browser",
    "brave",
    "arc",
    "electron",
];

/// Whether a listener's holder goes by a browser's or Electron's name: one of the names, or one of them and then a
/// word, as "Google Chrome Helper (Renderer)" is. A holder with no name is no browser.
fn browser_held(process: Option<&str>) -> bool {
    let Some(name) = process else { return false };
    let name = name.to_lowercase();
    BROWSER_NAMES.iter().any(|b| name == *b || name.strip_prefix(b).is_some_and(|rest| rest.starts_with(' ')))
}

/// Each listener's answer to the DevTools question, by port and holder; None while the ask is out.
type DevtoolsAnswers = Arc<Mutex<HashMap<(u16, Option<u32>), Option<bool>>>>;

/// How a listener is asked the DevTools question, by its port.
type Asker = Arc<dyn Fn(u16) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// One process's place on the computer: its parent and the process group it is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Lineage {
    pub(crate) pid: u32,
    pub(crate) ppid: u32,
    pub(crate) pgid: u32,
}

/// Every process's lineage, from whichever road the platform has.
pub(crate) type LineageSource = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Vec<Lineage>> + Send>> + Send + Sync>;

/// The Linux road: each /proc/[pid]/stat, read as the processes pane reads it.
fn proc_lineage(proc_root: &Path) -> Vec<Lineage> {
    let Ok(dirs) = std::fs::read_dir(proc_root) else { return Vec::new() };
    dirs.flatten()
        .filter(|d| d.file_name().to_str().is_some_and(|n| n.parse::<u32>().is_ok()))
        .filter_map(|d| std::fs::read_to_string(d.path().join("stat")).ok())
        .filter_map(|text| crate::proc::parse_proc_pid_stat(&text).ok())
        .map(|st| Lineage { pid: st.pid, ppid: st.ppid, pgid: st.pgrp })
        .collect()
}

/// ps's `pid= ppid= pgid=` columns, the darwin road.
fn parse_lineage(text: &str) -> Vec<Lineage> {
    text.lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace().map(|w| w.parse::<u32>().ok());
            Some(Lineage { pid: words.next()??, ppid: words.next()??, pgid: words.next()?? })
        })
        .collect()
}

/// The road for this daemon, as source_for picks the ports': a fake /proc when one is given, the platform's own
/// otherwise. A ps that fails reads as no processes, so a watch that names roots sees nothing rather than everything.
pub(crate) fn lineage_for(proc_root: Option<&Path>) -> LineageSource {
    let root = match proc_root {
        Some(root) => Some(root.to_path_buf()),
        None if cfg!(target_os = "linux") => Some(PathBuf::from("/proc")),
        None => None,
    };
    match root {
        Some(root) => Arc::new(move || {
            let root = root.clone();
            Box::pin(async move { tokio::task::spawn_blocking(move || proc_lineage(&root)).await.unwrap_or_default() })
        }),
        None if cfg!(target_os = "macos") => Arc::new(|| {
            Box::pin(async {
                let read = tokio::task::spawn_blocking(|| host_command("ps", &["-A", "-o", "pid=,ppid=,pgid="]).output()).await;
                match read {
                    Ok(Ok(out)) if out.status.success() => parse_lineage(&String::from_utf8_lossy(&out.stdout)),
                    _ => Vec::new(),
                }
            })
        }),
        None => Arc::new(|| Box::pin(async { Vec::new() })),
    }
}

/// The processes a watch's roots hold: each root, every process in a root's process group, and every process under
/// any of those, a dev server that made a group of its own among them. Init and the kernel are no workspace's, so a
/// root of 0 or 1 holds nothing.
fn members(table: &[Lineage], roots: &[u32]) -> HashSet<u32> {
    let roots: HashSet<u32> = roots.iter().copied().filter(|r| *r > 1).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in table {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    let mut held: HashSet<u32> = table.iter().filter(|p| roots.contains(&p.pid) || roots.contains(&p.pgid)).map(|p| p.pid).collect();
    let mut next: Vec<u32> = held.iter().copied().collect();
    while let Some(parent) = next.pop() {
        for child in children.get(&parent).into_iter().flatten() {
            if held.insert(*child) {
                next.push(*child);
            }
        }
    }
    held
}

/// The folder each of these processes runs in, from whichever road the platform has; a process it cannot read is
/// left out.
pub(crate) type CwdSource = Arc<dyn Fn(Vec<u32>) -> Pin<Box<dyn Future<Output = HashMap<u32, PathBuf>> + Send>> + Send + Sync>;

/// lsof's field output for `-d cwd`: a process set opens with its pid and names its folder on an `n` line.
fn parse_lsof_cwds(text: &str) -> HashMap<u32, PathBuf> {
    let mut cwds = HashMap::new();
    let mut pid = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<u32>().ok();
        } else if let (Some(value), Some(held)) = (line.strip_prefix('n'), pid) {
            cwds.insert(held, PathBuf::from(value));
        }
    }
    cwds
}

/// The road for this daemon, as source_for picks the ports': /proc/[pid]/cwd off a fake /proc when one is given or
/// on Linux, and one lsof for every pid asked about on a Mac.
pub(crate) fn cwd_for(proc_root: Option<&Path>) -> CwdSource {
    let root = match proc_root {
        Some(root) => Some(root.to_path_buf()),
        None if cfg!(target_os = "linux") => Some(PathBuf::from("/proc")),
        None => None,
    };
    match root {
        Some(root) => Arc::new(move |pids: Vec<u32>| {
            let root = root.clone();
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    pids.into_iter()
                        .filter_map(|pid| std::fs::read_link(root.join(pid.to_string()).join("cwd")).ok().map(|cwd| (pid, cwd)))
                        .collect()
                })
                .await
                .unwrap_or_default()
            })
        }),
        None if cfg!(target_os = "macos") => Arc::new(|pids: Vec<u32>| {
            Box::pin(async move {
                let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
                let read =
                    tokio::task::spawn_blocking(move || host_command("lsof", &["-a", "-d", "cwd", "-p", &list, "-Fpn"]).output()).await;
                match read {
                    Ok(Ok(out)) => parse_lsof_cwds(&String::from_utf8_lossy(&out.stdout)),
                    _ => HashMap::new(),
                }
            })
        }),
        None => Arc::new(|_| Box::pin(async { HashMap::new() })),
    }
}

/// Whose listeners one watch sees.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Scope {
    /// Every listener: what a watch that names no roots sees, the host's own watchers among them, and a cloud
    /// machine, which is the workspace's whole.
    Everything,
    /// The listeners of the processes these roots hold, and with a folder, of every process running in it.
    Roots { roots: Vec<u32>, folder: Option<PathBuf> },
}

/// The reads one watch is made of: the listeners and the processes holding them, and the DevTools question put to a
/// browser's listener once.
pub(crate) struct PortWatcher {
    source: PortSource,
    lineage: LineageSource,
    cwd: CwdSource,
    alive: Box<dyn Fn(u32) -> bool + Send + Sync>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    /// Kept while a listener lives, so each is asked once.
    devtools: DevtoolsAnswers,
    ask: Asker,
}

impl PortWatcher {
    pub(crate) fn new(source: PortSource, lineage: LineageSource, cwd: CwdSource) -> PortWatcher {
        PortWatcher::with(source, lineage, cwd, Box::new(pid_alive), Box::new(clock::now_ms))
    }

    pub(crate) fn with(
        source: PortSource,
        lineage: LineageSource,
        cwd: CwdSource,
        alive: Box<dyn Fn(u32) -> bool + Send + Sync>,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> PortWatcher {
        PortWatcher {
            source,
            lineage,
            cwd,
            alive,
            now,
            devtools: Arc::new(Mutex::new(HashMap::new())),
            ask: Arc::new(|port| Box::pin(is_devtools(port))),
        }
    }

    /// One reading for every scope, in their order: what listens among the processes each one holds, with the ports
    /// that answered as a browser's DevTools left out. The processes are read after the listeners, so a listener's
    /// holder is never newer than the table it is looked up in, and a folder is read only for a listener's holder
    /// that no root holds. Only a listener some scope sees is asked, and only
    /// one a browser or Electron holds: a thread's test servers get no request from wsp. A new listener is a server
    /// until its ask comes back, so a slow or silent one opens on the reading that finds it, and a DevTools port
    /// closes on the reading after its answer.
    async fn read(&mut self, scopes: &[Scope]) -> (Vec<ListeningPort>, Vec<Vec<ListeningPort>>) {
        let read = (self.source)().await;
        let rooted = scopes.iter().any(|s| matches!(s, Scope::Roots { .. }));
        let table = if rooted { (self.lineage)().await } else { Vec::new() };
        let held: Vec<Option<HashSet<u32>>> = scopes
            .iter()
            .map(|scope| match scope {
                Scope::Everything => None,
                Scope::Roots { roots, .. } => Some(members(&table, roots)),
            })
            .collect();
        let unheld: HashSet<u32> = scopes
            .iter()
            .zip(&held)
            .filter(|(scope, _)| matches!(scope, Scope::Roots { folder: Some(_), .. }))
            .flat_map(|(_, held)| read.iter().filter_map(|r| r.pid).filter(|pid| !held.as_ref().is_some_and(|h| h.contains(pid))))
            .collect();
        let cwds = if unheld.is_empty() { HashMap::new() } else { (self.cwd)(unheld.into_iter().collect()).await };
        let seen: Vec<Vec<ListeningPort>> = scopes
            .iter()
            .zip(&held)
            .map(|(scope, held)| match (scope, held) {
                (Scope::Roots { folder, .. }, Some(held)) => read
                    .iter()
                    .filter(|r| {
                        r.pid.is_some_and(|pid| {
                            held.contains(&pid) || folder.as_ref().is_some_and(|f| cwds.get(&pid).is_some_and(|cwd| cwd.starts_with(f)))
                        })
                    })
                    .cloned()
                    .collect(),
                _ => read.clone(),
            })
            .collect();
        let mut answers = self.devtools.lock().unwrap_or_else(|e| e.into_inner());
        answers.retain(|(port, pid), _| read.iter().any(|r| r.port == *port && r.pid == *pid));
        for r in seen.iter().flatten() {
            let key = (r.port, r.pid);
            if answers.contains_key(&key) {
                continue;
            }
            if !browser_held(r.process.as_deref()) {
                answers.insert(key, Some(false));
                continue;
            }
            answers.insert(key, None);
            let devtools = Arc::clone(&self.devtools);
            let asked = (self.ask)(key.0);
            tokio::spawn(async move {
                let answer = asked.await;
                if let Some(slot) = devtools.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&key) {
                    *slot = Some(answer);
                }
            });
        }
        let seen = seen
            .into_iter()
            .map(|rows| rows.into_iter().filter(|r| answers.get(&(r.port, r.pid)) != Some(&Some(true))).collect())
            .collect();
        (read, seen)
    }

    /// What a watch was last sent against what it sees now: a close for every port it was told of that is gone or
    /// held by another socket now, then an open for every port it sees that it was not told of in that holder. A
    /// listener that came and went between two reads was never sent and sends nothing. A close for a port that the
    /// machine's own reading still holds says it left the view.
    fn changes(&self, sent: &[ListeningPort], now: &[ListeningPort], listening: &[ListeningPort]) -> Vec<DaemonEvent> {
        let same = |a: &ListeningPort, b: &ListeningPort| a.port == b.port && a.pid == b.pid && a.inode == b.inode;
        let closed = sent
            .iter()
            .filter(|row| !now.iter().any(|n| same(n, row)))
            .map(|row| self.close_event(row, listening.iter().any(|l| same(l, row))));
        // The wire has no null pid: an owner the fd scan could not name is left out, like its comm.
        let opened = now.iter().filter(|row| !sent.iter().any(|k| same(k, row))).map(|row| DaemonEvent::PortOpen {
            port: row.port,
            pid: row.pid,
            process: row.process.clone(),
            loopback: Some(row.loopback),
        });
        closed.chain(opened).collect()
    }

    /// The close names the last row's holder, since /proc no longer has the socket to ask.
    fn close_event(&self, row: &ListeningPort, still_listening: bool) -> DaemonEvent {
        let at = Some(clock::iso_millis((self.now)()));
        match row.pid {
            None => DaemonEvent::PortClose { port: row.port, pid: None, process: None, command: None, exited: None, left: None, at },
            Some(pid) => DaemonEvent::PortClose {
                port: row.port,
                pid: Some(pid),
                process: row.process.clone(),
                command: row.command.clone(),
                exited: Some(!(self.alive)(pid)),
                left: still_listening.then_some(true),
                at,
            },
        }
    }
}

/// What each poll's opens go to beside the watchers: in a daemon, the spotter waiting on a sign-in's listener.
pub(crate) type OnChanges = Arc<dyn Fn(&[DaemonEvent]) + Send + Sync>;

/// How often the watch reads while a sign-in waits on its callback listener: the spotter's window is five seconds,
/// and a listener read on the coalesced cadence could land after it closed.
const HURRIED_INTERVAL: Duration = Duration::from_secs(1);

/// The one watch a daemon runs, read for every socket that asked. It reads only while some socket watches: the
/// first ports.watch starts it, and it stops at the first tick that finds nobody left. Each socket is told what
/// moved against what it was last sent, never against the read before.
pub(crate) struct PortWatch {
    watcher: tokio::sync::Mutex<PortWatcher>,
    interval: Duration,
    watching: Mutex<Watching>,
    hurried_until: Mutex<Option<tokio::time::Instant>>,
    hurry: tokio::sync::Notify,
}

#[derive(Default)]
struct Watching {
    listeners: Vec<Watcher>,
    polling: bool,
}

/// One socket's watch: whose listeners it sees, and what it was last told; None until its first reply.
struct Watcher {
    key: u64,
    out: Outbound,
    scope: Scope,
    sent: Option<Vec<ListeningPort>>,
}

impl PortWatch {
    pub(crate) fn new(source: PortSource, lineage: LineageSource, cwd: CwdSource, interval: Duration) -> PortWatch {
        PortWatch {
            watcher: tokio::sync::Mutex::new(PortWatcher::new(source, lineage, cwd)),
            interval,
            watching: Mutex::new(Watching::default()),
            hurried_until: Mutex::new(None),
            hurry: tokio::sync::Notify::new(),
        }
    }

    fn watching(&self) -> std::sync::MutexGuard<'_, Watching> {
        self.watching.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A socket's watch, or a second one naming its roots again: one read for every watcher under the one lock, so
    /// the reply carries what this socket now holds and not a state a later read has already moved on from. A socket
    /// already watching is told what its new roots moved; one watching for the first time is told nothing and holds
    /// the reply.
    /// Answers the ports the socket holds now, and whether this was its first watch.
    pub(crate) async fn watch(
        self: &Arc<Self>,
        key: u64,
        out: Outbound,
        roots: Option<Vec<u32>>,
        folder: Option<String>,
        on: OnChanges,
    ) -> (Vec<ListeningPort>, bool) {
        // Held as the kernel names it, so a cwd read off /proc or lsof compares with it whatever links led there.
        let folder = folder.map(|f| std::fs::canonicalize(&f).unwrap_or_else(|_| PathBuf::from(f)));
        let scope = match roots {
            Some(roots) => Scope::Roots { roots, folder },
            None => Scope::Everything,
        };
        let mut watcher = self.watcher.lock().await;
        let fresh = {
            let mut watching = self.watching();
            let fresh = match watching.listeners.iter_mut().find(|w| w.key == key) {
                Some(held) => {
                    held.scope = scope;
                    false
                }
                None => {
                    watching.listeners.push(Watcher { key, out, scope, sent: None });
                    true
                }
            };
            if !watching.polling {
                watching.polling = true;
                tokio::spawn(Arc::clone(self).run(Arc::clone(&on)));
            }
            fresh
        };
        let mut seen = self.read_all(&mut watcher, &on).await;
        (seen.remove(&key).unwrap_or_default(), fresh)
    }

    pub(crate) fn unsubscribe(&self, key: u64) {
        self.watching().listeners.retain(|l| l.key != key);
    }

    /// Reads now, and every HURRIED_INTERVAL for the window after.
    pub(crate) fn hurry(&self, window: Duration) {
        *self.hurried_until.lock().unwrap_or_else(|e| e.into_inner()) = Some(tokio::time::Instant::now() + window);
        self.hurry.notify_one();
    }

    fn wait(&self) -> Duration {
        let hurried = self.hurried_until.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|until| until > tokio::time::Instant::now());
        if hurried {
            self.interval.min(HURRIED_INTERVAL)
        } else {
            self.interval
        }
    }

    /// The watcher's lock is taken before the subscribers are looked at, so a watch arriving as the loop stops either
    /// keeps it going or starts the next one.
    async fn run(self: Arc<Self>, on: OnChanges) {
        loop {
            tokio::select! {
                () = tokio::time::sleep(self.wait()) => {}
                () = self.hurry.notified() => {}
            }
            let mut watcher = self.watcher.lock().await;
            {
                let mut watching = self.watching();
                if watching.listeners.is_empty() {
                    watching.polling = false;
                    return;
                }
            }
            self.read_all(&mut watcher, &on).await;
        }
    }

    /// One read for every watcher, each sent what moved against what it was last sent, and the opens among them to
    /// the spotter once each. Answers what each watcher holds now, by its key. Watchers only come under the read
    /// lock the caller holds, so the set read for is the set told; one that went meanwhile is skipped.
    async fn read_all(&self, watcher: &mut PortWatcher, on: &OnChanges) -> HashMap<u64, Vec<ListeningPort>> {
        let scopes: Vec<(u64, Scope)> = self.watching().listeners.iter().map(|w| (w.key, w.scope.clone())).collect();
        let (listening, read) = watcher.read(&scopes.iter().map(|(_, s)| s.clone()).collect::<Vec<_>>()).await;
        let seen: HashMap<u64, Vec<ListeningPort>> = scopes.into_iter().map(|(key, _)| key).zip(read).collect();
        let mut opened: Vec<DaemonEvent> = Vec::new();
        let mut watching = self.watching();
        watching.listeners.retain_mut(|w| {
            let Some(now) = seen.get(&w.key) else { return true };
            let events = w.sent.as_deref().map(|sent| watcher.changes(sent, now, &listening)).unwrap_or_default();
            w.sent = Some(now.clone());
            for event in &events {
                if !w.out.send_text(&crate::frame_text(event)) {
                    return false;
                }
                if let DaemonEvent::PortOpen { port, .. } = event {
                    if !opened.iter().any(|o| matches!(o, DaemonEvent::PortOpen { port: p, .. } if p == port)) {
                        opened.push(event.clone());
                    }
                }
            }
            true
        });
        drop(watching);
        on(&opened);
        seen
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(name)).unwrap()
    }

    fn fixed(rows: Arc<Mutex<Vec<ListeningPort>>>) -> PortSource {
        Arc::new(move || {
            let rows = rows.lock().unwrap().clone();
            Box::pin(async move { rows })
        })
    }

    fn row(port: u16, pid: Option<u32>, inode: u64, uid: u32, loopback: bool) -> ListeningPort {
        ListeningPort { port, pid, inode: Some(inode), uid, process: None, command: None, loopback }
    }

    /// A listener held by a process of this name, as /proc/<pid>/comm or lsof names it.
    fn named(port: u16, pid: u32, inode: u64, process: &str) -> ListeningPort {
        ListeningPort { process: Some(process.to_owned()), ..row(port, Some(pid), inode, 0, true) }
    }

    /// A machine whose processes' folders cannot be read.
    fn no_cwd() -> CwdSource {
        Arc::new(|_| Box::pin(async { HashMap::new() }))
    }

    /// Every pid given as a process leading a group of its own under init.
    fn groups(pids: &[u32]) -> LineageSource {
        let table: Vec<Lineage> = pids.iter().map(|pid| Lineage { pid: *pid, ppid: 1, pgid: *pid }).collect();
        Arc::new(move || {
            let table = table.clone();
            Box::pin(async move { table })
        })
    }

    /// One socket's view over a watcher, read and told what moved as the watch does it for that socket.
    struct View {
        w: PortWatcher,
        scope: Scope,
        sent: Option<Vec<ListeningPort>>,
    }

    impl View {
        async fn poll(&mut self) -> Vec<DaemonEvent> {
            let (listening, mut seen) = self.w.read(std::slice::from_ref(&self.scope)).await;
            let now = seen.remove(0);
            let events = self.sent.as_deref().map(|sent| self.w.changes(sent, &now, &listening)).unwrap_or_default();
            self.sent = Some(now);
            events
        }

        fn current(&self) -> Vec<ListeningPort> {
            self.sent.clone().unwrap_or_default()
        }
    }

    fn view(source: PortSource) -> View {
        View { w: PortWatcher::new(source, groups(&[]), no_cwd()), scope: Scope::Everything, sent: None }
    }

    /// A view whose roots are these pids, each leading its own group.
    fn rooted(source: PortSource, pids: &[u32]) -> View {
        View { w: PortWatcher::new(source, groups(pids), no_cwd()), scope: Scope::Roots { roots: pids.to_vec(), folder: None }, sent: None }
    }

    fn watcher_with(source: PortSource, alive: bool, at: u64) -> View {
        View {
            w: PortWatcher::with(source, groups(&[]), no_cwd(), Box::new(move |_| alive), Box::new(move || at)),
            scope: Scope::Everything,
            sent: None,
        }
    }

    const AT: u64 = 1_788_609_840_000;
    const AT_ISO: &str = "2026-09-05T12:04:00.000Z";

    #[test]
    fn parse_proc_net_tcp_returns_listen_ports_with_pids_resolved_through_the_inode_map() {
        let map = HashMap::from([(45678, 123), (45700, 456)]);
        let rows = parse_proc_net_tcp(&fixture("proc-net-tcp.txt"), Some(&map));
        assert_eq!(rows.iter().map(|r| (r.port, r.pid)).collect::<Vec<_>>(), [(8080, Some(123)), (3000, Some(456))]);
    }

    #[test]
    fn parse_proc_net_tcp_filters_non_listen_rows_and_survives_a_missing_inode_map() {
        let rows = parse_proc_net_tcp(&fixture("proc-net-tcp.txt"), None);
        assert_eq!(rows.iter().map(|r| r.port).collect::<Vec<_>>(), [8080, 3000]);
        assert_eq!((rows[0].pid, rows[0].inode, rows[0].uid), (None, Some(45678), 0));
        assert_eq!((rows[1].pid, rows[1].inode, rows[1].uid), (None, Some(45700), 1000));
    }

    #[tokio::test]
    async fn the_watcher_emits_port_open_and_port_close_on_diffs_between_polls() {
        let snapshot = Arc::new(Mutex::new(vec![row(8080, Some(123), 45678, 0, false)]));
        let mut w = view(fixed(Arc::clone(&snapshot)));
        // The first poll seeds what is already there without events; only changes after it are events.
        assert!(w.poll().await.is_empty());
        assert_eq!(w.current().iter().map(|p| p.port).collect::<Vec<_>>(), [8080]);
        *snapshot.lock().unwrap() = vec![row(8080, Some(123), 45678, 0, false), row(3000, Some(456), 45700, 1000, true)];
        let opened = w.poll().await;
        *snapshot.lock().unwrap() = vec![row(3000, Some(456), 45700, 1000, true)];
        let closed = w.poll().await;
        let steady = w.poll().await;
        assert_eq!(opened, [DaemonEvent::PortOpen { port: 3000, pid: Some(456), process: None, loopback: Some(true) }]);
        assert!(matches!(closed.as_slice(), [DaemonEvent::PortClose { port: 8080, .. }]));
        assert!(steady.is_empty());
        assert_eq!(w.current().iter().map(|p| p.port).collect::<Vec<_>>(), [3000]);
    }

    /// A listener on a free loopback port that answers every request with the body given, and its port.
    /// A listener answering as Chrome's DevTools server does, measured on 2026-09-29: an HTTP/1.0 request is closed
    /// on with nothing said, and a reply to HTTP/1.1 keeps the connection open whatever the request asked.
    async fn answering(body: &'static str) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let read = socket.read(&mut buf).await.unwrap_or(0);
                    if !String::from_utf8_lossy(&buf[..read]).lines().next().is_some_and(|line| line.ends_with("HTTP/1.1")) {
                        return;
                    }
                    let reply =
                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                    let _ = socket.write_all(reply.as_bytes()).await;
                    tokio::time::sleep(Duration::from_secs(5)).await;
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn a_browsers_listener_outside_wsps_own_processes_is_never_asked_nor_listed() {
        // Counted at the asker, since any other wsp on this computer may connect to a test's listener on its own.
        let asked = Arc::new(Mutex::new(Vec::new()));
        let count = Arc::clone(&asked);
        let snapshot = Arc::new(Mutex::new(vec![named(4100, 700, 1, "chrome"), named(4200, 1234, 2, "chrome")]));
        let mut w = rooted(fixed(Arc::clone(&snapshot)), &[1234]);
        w.w.ask = Arc::new(move |port| {
            count.lock().unwrap().push(port);
            Box::pin(async { false })
        });
        assert!(w.poll().await.is_empty());
        assert!(w.poll().await.is_empty());
        assert_eq!(w.current().iter().map(|p| p.port).collect::<Vec<_>>(), [4200]);
        assert_eq!(*asked.lock().unwrap(), [4200], "only wsp's own listener is asked, and once");
    }

    #[tokio::test]
    async fn a_browser_wsps_own_processes_started_still_drops_while_their_plain_server_stays() {
        let devtools = answering(r#"{"Browser":"HeadlessChrome/140.0.7339.16","Protocol-Version":"1.3"}"#).await;
        let server = answering("<!doctype html><title>dev</title>").await;
        let snapshot = Arc::new(Mutex::new(vec![named(devtools, 900, 1, "Google Chrome Helper"), row(server, Some(901), 2, 0, true)]));
        let mut w = rooted(fixed(Arc::clone(&snapshot)), &[900, 901]);
        assert!(w.poll().await.is_empty());
        let dropped = next_change(&mut w).await;
        assert!(matches!(dropped.as_slice(), [DaemonEvent::PortClose { port, .. }] if *port == devtools), "{dropped:?}");
        assert_eq!(w.current().iter().map(|p| p.port).collect::<Vec<_>>(), [server]);
    }

    #[tokio::test]
    async fn a_port_opened_outside_the_workspaces_tree_sends_nothing() {
        let snapshot = Arc::new(Mutex::new(vec![row(4200, Some(1234), 1, 0, true)]));
        let mut w = rooted(fixed(Arc::clone(&snapshot)), &[1234, 1235]);
        assert!(w.poll().await.is_empty());
        snapshot.lock().unwrap().extend([row(4100, Some(700), 2, 0, true), row(4101, None, 3, 0, true)]);
        assert_eq!(w.poll().await, [], "a listener held outside the tree, or by a holder nobody could name, is no change");
        snapshot.lock().unwrap().push(row(4201, Some(1235), 4, 0, true));
        assert_eq!(w.poll().await, [DaemonEvent::PortOpen { port: 4201, pid: Some(1235), process: None, loopback: Some(true) }]);
        assert_eq!(w.current().iter().map(|p| p.port).collect::<Vec<_>>(), [4200, 4201]);
    }

    fn out() -> (crate::Outbound, tokio::sync::mpsc::UnboundedReceiver<crate::Outgoing>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (crate::Outbound(tx), rx)
    }

    /// The frames a watcher has been sent so far, as (type, port).
    fn heard(rx: &mut tokio::sync::mpsc::UnboundedReceiver<crate::Outgoing>) -> Vec<(String, u64)> {
        let mut out = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(frame.text()).unwrap();
            out.push((v["type"].as_str().unwrap().to_owned(), v["port"].as_u64().unwrap()));
        }
        out
    }

    fn counted(rows: Arc<Mutex<Vec<ListeningPort>>>, reads: Arc<std::sync::atomic::AtomicUsize>) -> PortSource {
        Arc::new(move || {
            reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let rows = rows.lock().unwrap().clone();
            Box::pin(async move { rows })
        })
    }

    async fn until(start: tokio::time::Instant, ms: u64) {
        tokio::time::sleep_until(start + Duration::from_millis(ms)).await;
    }

    fn quiet() -> OnChanges {
        Arc::new(|_| {})
    }

    /// A watch over the whole machine, as a cloud machine's is.
    fn whole(source: PortSource) -> Arc<PortWatch> {
        Arc::new(PortWatch::new(source, groups(&[]), no_cwd(), DEFAULT_INTERVAL))
    }

    #[tokio::test(start_paused = true)]
    async fn events_within_five_seconds_arrive_as_one_batch() {
        let snapshot = Arc::new(Mutex::new(Vec::new()));
        let watch = whole(fixed(Arc::clone(&snapshot)));
        let (o, mut rx) = out();
        let start = tokio::time::Instant::now();
        assert_eq!(watch.watch(1, o, None, None, quiet()).await, (vec![], true));
        until(start, 1_000).await;
        snapshot.lock().unwrap().push(row(3000, Some(1), 1, 0, true));
        until(start, 2_000).await;
        snapshot.lock().unwrap().push(row(3001, Some(2), 2, 0, true));
        until(start, 3_000).await;
        snapshot.lock().unwrap().retain(|r| r.port != 3001);
        snapshot.lock().unwrap().push(row(3002, Some(3), 3, 0, true));
        until(start, 4_900).await;
        assert_eq!(heard(&mut rx), [], "nothing goes out before the five seconds are up");
        until(start, 5_100).await;
        assert_eq!(
            heard(&mut rx),
            [("port.open".to_owned(), 3000), ("port.open".to_owned(), 3002)],
            "the opens arrive together, and a listener that came and went inside the window, never sent, sends nothing"
        );
        until(start, 9_900).await;
        assert_eq!(heard(&mut rx), []);
    }

    #[tokio::test(start_paused = true)]
    async fn a_port_the_watcher_was_told_is_open_gets_its_close_however_often_it_reopened_inside_the_window() {
        let snapshot = Arc::new(Mutex::new(vec![row(3000, Some(1), 1, 0, true)]));
        let watch = whole(fixed(Arc::clone(&snapshot)));
        let (o, mut rx) = out();
        let start = tokio::time::Instant::now();
        assert_eq!(watch.watch(1, o, None, None, quiet()).await.0.len(), 1, "the watcher was told 3000 is open");
        until(start, 1_000).await;
        snapshot.lock().unwrap().clear();
        until(start, 2_000).await;
        snapshot.lock().unwrap().push(row(3000, Some(1), 1, 0, true));
        until(start, 3_000).await;
        snapshot.lock().unwrap().clear();
        until(start, 5_100).await;
        assert_eq!(heard(&mut rx), [("port.close".to_owned(), 3000)]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_port_another_holder_took_inside_the_window_closes_for_the_old_one_and_opens_for_the_new() {
        let snapshot = Arc::new(Mutex::new(vec![row(3000, Some(1), 1, 0, true)]));
        let watch = whole(fixed(Arc::clone(&snapshot)));
        let (o, mut rx) = out();
        let start = tokio::time::Instant::now();
        watch.watch(1, o, None, None, quiet()).await;
        until(start, 1_000).await;
        *snapshot.lock().unwrap() = vec![row(3000, Some(2), 2, 0, true)];
        until(start, 5_100).await;
        assert_eq!(heard(&mut rx), [("port.close".to_owned(), 3000), ("port.open".to_owned(), 3000)]);
    }

    #[tokio::test(start_paused = true)]
    async fn each_watcher_is_told_against_what_it_was_sent_and_a_new_watch_is_told_nothing_but_its_reply() {
        let snapshot = Arc::new(Mutex::new(vec![row(3000, Some(1), 1, 0, true)]));
        let watch = whole(fixed(Arc::clone(&snapshot)));
        let (first, mut heard_first) = out();
        let (second, mut heard_second) = out();
        let start = tokio::time::Instant::now();
        watch.watch(1, first, None, None, quiet()).await;
        until(start, 2_000).await;
        // The listener goes and another comes between the first watcher's reply and the second's: the second watch's
        // read tells the first what moved, and the second only what it holds.
        *snapshot.lock().unwrap() = vec![row(3001, Some(1), 2, 0, true)];
        let (ports, fresh) = watch.watch(2, second, None, None, quiet()).await;
        assert_eq!((ports.iter().map(|p| p.port).collect::<Vec<_>>(), fresh), (vec![3001], true));
        assert_eq!(heard(&mut heard_first), [("port.close".to_owned(), 3000), ("port.open".to_owned(), 3001)]);
        assert_eq!(heard(&mut heard_second), []);
        until(start, 5_100).await;
        assert_eq!((heard(&mut heard_first), heard(&mut heard_second)), (vec![], vec![]));
    }

    #[tokio::test(start_paused = true)]
    async fn the_watch_reads_nothing_once_its_last_watcher_has_gone_and_seeds_afresh_for_the_next() {
        let snapshot = Arc::new(Mutex::new(vec![row(3000, Some(1), 1, 0, true)]));
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let watch = Arc::new(PortWatch::new(counted(Arc::clone(&snapshot), Arc::clone(&reads)), groups(&[]), no_cwd(), DEFAULT_INTERVAL));
        let read = || reads.load(std::sync::atomic::Ordering::SeqCst);
        let start = tokio::time::Instant::now();
        let (o, _rx) = out();
        watch.watch(1, o, None, None, quiet()).await;
        until(start, 5_100).await;
        assert_eq!(read(), 2);
        watch.unsubscribe(1);
        until(start, 60_000).await;
        assert_eq!(read(), 2, "nobody watches, so nothing is read");
        snapshot.lock().unwrap().push(row(3001, Some(2), 2, 0, true));
        let (o, mut rx) = out();
        let (ports, fresh) = watch.watch(2, o, None, None, quiet()).await;
        assert_eq!((ports.len(), fresh), (2, true), "the next watch is seeded, not told of what moved while nobody watched");
        until(start, 65_100).await;
        assert_eq!((read(), heard(&mut rx)), (4, vec![]));
    }

    #[tokio::test(start_paused = true)]
    async fn a_hurry_reads_at_once_and_every_second_through_its_window_then_falls_back() {
        let snapshot = Arc::new(Mutex::new(Vec::new()));
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let watch =
            Arc::new(PortWatch::new(counted(Arc::clone(&snapshot), Arc::clone(&reads)), groups(&[]), no_cwd(), Duration::from_secs(5)));
        let read = || reads.load(std::sync::atomic::Ordering::SeqCst);
        let start = tokio::time::Instant::now();
        let (o, mut rx) = out();
        watch.watch(1, o, None, None, quiet()).await;
        until(start, 500).await;
        snapshot.lock().unwrap().push(row(45543, Some(1), 1, 0, true));
        watch.hurry(Duration::from_secs(5));
        until(start, 600).await;
        assert_eq!((read(), heard(&mut rx)), (2, vec![("port.open".to_owned(), 45543)]));
        until(start, 5_550).await;
        assert_eq!(read(), 7, "a read a second through the window");
        until(start, 15_600).await;
        assert_eq!(read(), 9, "then one every five seconds again");
    }

    #[tokio::test(start_paused = true)]
    async fn a_watch_sees_what_its_roots_hold_and_one_that_names_none_sees_the_whole_machine() {
        let snapshot = Arc::new(Mutex::new(vec![
            row(4000, Some(100), 1, 0, true),
            row(4001, Some(201), 2, 0, true),
            row(4002, Some(301), 3, 0, true),
        ]));
        // One host (100) running a turn for each of two workspaces; A's server made a group of its own under its turn.
        let table = vec![
            Lineage { pid: 100, ppid: 1, pgid: 100 },
            Lineage { pid: 200, ppid: 100, pgid: 200 },
            Lineage { pid: 201, ppid: 200, pgid: 201 },
            Lineage { pid: 300, ppid: 100, pgid: 300 },
            Lineage { pid: 301, ppid: 300, pgid: 300 },
        ];
        let lineage: LineageSource = Arc::new(move || {
            let table = table.clone();
            Box::pin(async move { table })
        });
        let watch = Arc::new(PortWatch::new(fixed(snapshot), lineage, no_cwd(), DEFAULT_INTERVAL));
        let ports = |seen: Vec<ListeningPort>| seen.iter().map(|p| p.port).collect::<Vec<_>>();
        assert_eq!(ports(watch.watch(1, out().0, Some(vec![200]), None, quiet()).await.0), [4001]);
        assert_eq!(ports(watch.watch(2, out().0, Some(vec![300]), None, quiet()).await.0), [4002]);
        assert_eq!(
            ports(watch.watch(3, out().0, None, None, quiet()).await.0),
            [4000, 4001, 4002],
            "the host's own watchers see every listener"
        );
        assert_eq!(
            ports(watch.watch(4, out().0, Some(vec![100]), None, quiet()).await.0),
            [4000, 4001, 4002],
            "the host holds every workspace"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_port_that_leaves_a_watch_while_it_still_listens_closes_as_left_and_one_that_stopped_does_not() {
        let snapshot = Arc::new(Mutex::new(vec![row(4202, Some(202), 1, 0, true), row(4203, Some(203), 2, 0, true)]));
        let table = vec![
            Lineage { pid: 200, ppid: 1, pgid: 200 },
            Lineage { pid: 202, ppid: 1, pgid: 200 },
            Lineage { pid: 203, ppid: 1, pgid: 200 },
        ];
        let lineage: LineageSource = Arc::new(move || {
            let table = table.clone();
            Box::pin(async move { table })
        });
        let watch = Arc::new(PortWatch::new(fixed(Arc::clone(&snapshot)), lineage, no_cwd(), DEFAULT_INTERVAL));
        let (o, mut rx) = out();
        watch.watch(1, o.clone(), Some(vec![200]), None, quiet()).await;
        snapshot.lock().unwrap().retain(|r| r.port != 4203);
        // The turn's group stops being a root: 4202 still listens, held by a process that is no longer the workspace's.
        watch.watch(1, o, Some(vec![]), None, quiet()).await;
        let mut closes = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(frame.text()).unwrap();
            closes.push((v["port"].as_u64().unwrap(), v.get("left").cloned()));
        }
        closes.sort_by_key(|(port, _)| *port);
        assert_eq!(closes, [(4202, Some(serde_json::json!(true))), (4203, None)]);
    }

    #[test]
    fn a_root_holds_its_group_and_everything_under_it_and_init_holds_nothing() {
        let table = [
            Lineage { pid: 1, ppid: 0, pgid: 1 },
            Lineage { pid: 2, ppid: 0, pgid: 0 },
            Lineage { pid: 50, ppid: 1, pgid: 50 },
            Lineage { pid: 51, ppid: 50, pgid: 51 },
            Lineage { pid: 52, ppid: 51, pgid: 51 },
            // Reparented to init when the turn's shell went, still in the turn's group.
            Lineage { pid: 53, ppid: 1, pgid: 50 },
            Lineage { pid: 60, ppid: 1, pgid: 60 },
        ];
        let mut held: Vec<u32> = members(&table, &[50]).into_iter().collect();
        held.sort_unstable();
        assert_eq!(held, [50, 51, 52, 53]);
        assert!(members(&table, &[0, 1]).is_empty());
    }

    #[test]
    fn lsof_cwd_fields_read_as_each_pids_folder() {
        let read = parse_lsof_cwds("p401\nfcwd\nn/Users/zingzy/wsp/landing/app\np402\nfcwd\nn/private/tmp\n");
        assert_eq!(read.get(&401), Some(&PathBuf::from("/Users/zingzy/wsp/landing/app")));
        assert_eq!(read.get(&402), Some(&PathBuf::from("/private/tmp")));
        assert_eq!(read.len(), 2);
    }

    #[test]
    fn ps_lineage_columns_read_as_pid_parent_and_group() {
        assert_eq!(
            parse_lineage("  1     0     1\n 50     1    50\nnot a row\n 51    50\n"),
            [Lineage { pid: 1, ppid: 0, pgid: 1 }, Lineage { pid: 50, ppid: 1, pgid: 50 }]
        );
    }

    #[tokio::test]
    async fn only_a_listener_a_browser_or_electron_holds_is_asked_so_a_threads_node_server_hears_nothing() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let count = Arc::clone(&asked);
        // Every one of them under the host's own tree, as a thread's test servers and its screenshot browser are.
        let snapshot = Arc::new(Mutex::new(vec![
            named(4300, 800, 1, "node"),
            named(4301, 801, 2, "vitest"),
            row(4302, Some(802), 3, 0, true),
            named(4400, 803, 4, "Google Chrome Helper"),
            named(4401, 804, 5, "headless_shell"),
            named(4402, 805, 6, "chrome"),
            named(4403, 806, 7, "Electron Helper"),
        ]));
        let mut w = rooted(fixed(snapshot), &[800, 801, 802, 803, 804, 805, 806]);
        w.w.ask = Arc::new(move |port| {
            count.lock().unwrap().push(port);
            Box::pin(async { false })
        });
        assert!(w.poll().await.is_empty());
        assert!(w.poll().await.is_empty());
        assert_eq!(
            *asked.lock().unwrap(),
            [4400, 4401, 4402, 4403],
            "a node server, a nameless holder and anything not a browser are never asked"
        );
        assert_eq!(w.current().len(), 7, "every one of them is still listed as a server");
    }

    #[test]
    fn a_browsers_or_electrons_name_is_one_of_the_list_or_one_of_them_and_then_a_word() {
        for name in [
            "Google Chrome",
            "Google Chrome Helper (Renderer)",
            "Chromium",
            "chromium-browse",
            "headless_shell",
            "chrome",
            "Microsoft Edge Helper",
            "msedge",
            "Brave Browser Helper",
            "Arc",
            "Arc Helper",
            "Electron",
            "Electron Helper",
        ] {
            assert!(browser_held(Some(name)), "{name}");
        }
        for name in ["node", "vitest", "chromedriver", "archiver", "Code Helper", "python3"] {
            assert!(!browser_held(Some(name)), "{name}");
        }
        assert!(!browser_held(None));
    }

    /// A listener that takes the connection and never says a word, as postgres, redis and ssh do to an HTTP ask.
    async fn silent() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        port
    }

    #[tokio::test]
    async fn listeners_that_never_answer_hold_up_no_seed() {
        let mut rows = Vec::new();
        for n in 0..6u32 {
            rows.push(row(silent().await, Some(700 + n), u64::from(n) + 1, 0, true));
        }
        let mut w = view(fixed(Arc::new(Mutex::new(rows))));
        let started = std::time::Instant::now();
        assert!(w.poll().await.is_empty());
        let took = started.elapsed();
        assert_eq!(w.current().len(), 6, "a port that says nothing is still a server");
        assert!(took < DEVTOOLS_PROBE / 2, "six silent ports took {took:?} to seed");
    }

    #[tokio::test]
    async fn a_listener_that_never_answers_http_opens_on_the_poll_that_first_reads_it() {
        let snapshot = Arc::new(Mutex::new(Vec::new()));
        let mut w = view(fixed(Arc::clone(&snapshot)));
        assert!(w.poll().await.is_empty());
        let port = silent().await;
        snapshot.lock().unwrap().push(row(port, Some(800), 1, 0, true));
        let started = std::time::Instant::now();
        let opened = w.poll().await;
        let took = started.elapsed();
        assert_eq!(opened, [DaemonEvent::PortOpen { port, pid: Some(800), process: None, loopback: Some(true) }]);
        assert!(took < DEVTOOLS_PROBE / 2, "the open waited {took:?} on a port that says nothing");
    }

    /// Polls until a reading says something, as the watch's interval would.
    async fn next_change(w: &mut View) -> Vec<DaemonEvent> {
        for _ in 0..40 {
            let events = w.poll().await;
            if !events.is_empty() {
                return events;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Vec::new()
    }

    #[tokio::test]
    async fn a_browsers_devtools_port_is_dropped_once_it_answers_as_one_while_a_plain_listener_stays() {
        let devtools = answering(r#"{"Browser":"HeadlessChrome/140.0.7339.16","Protocol-Version":"1.3","webSocketDebuggerUrl":"ws://127.0.0.1/devtools/browser/x"}"#).await;
        let server = answering("<!doctype html><title>dev</title>").await;
        let later = answering(r#"{"Browser":"Chrome/140.0","Protocol-Version":"1.3"}"#).await;
        let snapshot = Arc::new(Mutex::new(vec![named(devtools, 900, 1, "headless_shell"), row(server, Some(901), 2, 0, true)]));
        let mut w = view(fixed(Arc::clone(&snapshot)));
        assert!(w.poll().await.is_empty());
        let dropped = next_change(&mut w).await;
        assert!(matches!(dropped.as_slice(), [DaemonEvent::PortClose { port, .. }] if *port == devtools), "{dropped:?}");
        assert_eq!(w.current().iter().map(|p| p.port).collect::<Vec<_>>(), [server]);
        snapshot.lock().unwrap().push(named(later, 902, 3, "chrome"));
        assert_eq!(
            w.poll().await,
            [DaemonEvent::PortOpen { port: later, pid: Some(902), process: Some("chrome".to_owned()), loopback: Some(true) }]
        );
        let dropped = next_change(&mut w).await;
        assert!(matches!(dropped.as_slice(), [DaemonEvent::PortClose { port, .. }] if *port == later), "{dropped:?}");
        assert_eq!(w.current().iter().map(|p| p.port).collect::<Vec<_>>(), [server]);
        assert!(next_change(&mut w).await.is_empty(), "a dropped port stays dropped");
    }

    /// A /proc lookalike: net/tcp from the fixture, pid 123 owning inode 45678 with comm "node" and a cmdline, pid
    /// 456 owning inode 45700 with no comm file at all.
    fn fake_proc_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("net")).unwrap();
        std::fs::write(root.path().join("net/tcp"), fixture("proc-net-tcp.txt")).unwrap();
        std::fs::create_dir_all(root.path().join("123/fd")).unwrap();
        symlink("socket:[45678]", root.path().join("123/fd/3")).unwrap();
        std::fs::write(root.path().join("123/comm"), "node\n").unwrap();
        std::fs::write(root.path().join("123/cmdline"), "node\0server.js\0--port\08080\0").unwrap();
        std::fs::create_dir_all(root.path().join("456/fd")).unwrap();
        symlink("socket:[45700]", root.path().join("456/fd/5")).unwrap();
        root
    }

    #[tokio::test]
    async fn the_proc_road_names_the_listener_from_comm_and_its_argv_from_cmdline_leaving_both_unset_when_unreadable() {
        let root = fake_proc_root();
        let rows = proc_net_tcp_source(root.path().to_path_buf())().await;
        assert_eq!(
            rows,
            [
                ListeningPort {
                    port: 8080,
                    pid: Some(123),
                    inode: Some(45678),
                    uid: 0,
                    process: Some("node".into()),
                    command: Some("node server.js --port 8080".into()),
                    loopback: false
                },
                row(3000, Some(456), 45700, 1000, true),
            ]
        );
    }

    #[tokio::test]
    async fn reads_at_most_512_bytes_of_cmdline_and_ends_a_cut_argv_with_an_ellipsis() {
        let root = fake_proc_root();
        std::fs::write(root.path().join("456/cmdline"), format!("node\0-e\0{}\0", "x".repeat(4096))).unwrap();
        let rows = proc_snapshot(root.path());
        assert_eq!(rows[1].command.as_deref(), Some(format!("node -e {}\u{2026}", "x".repeat(504)).as_str()));
        assert_eq!(rows[1].command.as_ref().unwrap().chars().count(), 513);
        assert_eq!(rows[1].process, None);
    }

    #[tokio::test]
    async fn port_open_carries_process_when_the_row_has_one() {
        let root = fake_proc_root();
        let empty = Arc::new(Mutex::new(Vec::new()));
        let mut w = view(fixed(empty));
        assert!(w.poll().await.is_empty());
        w.w.source = proc_net_tcp_source(root.path().to_path_buf());
        assert_eq!(
            w.poll().await,
            [
                DaemonEvent::PortOpen { port: 8080, pid: Some(123), process: Some("node".into()), loopback: Some(false) },
                DaemonEvent::PortOpen { port: 3000, pid: Some(456), process: None, loopback: Some(true) },
            ]
        );
    }

    #[tokio::test]
    async fn across_a_listener_restart_on_one_port_it_emits_close_then_open_whether_or_not_the_new_owner_can_be_read() {
        let root = fake_proc_root();
        let tcp = fixture("proc-net-tcp.txt");
        let restarted_row = tcp.lines().find(|l| l.contains("45678")).unwrap().to_owned();
        let without = tcp.replace(&format!("{restarted_row}\n"), "");
        let unowned = tcp.replace(&restarted_row, &restarted_row.replace("45678", "45999"));
        let mut w = watcher_with(proc_net_tcp_source(root.path().to_path_buf()), false, AT);
        assert!(w.poll().await.is_empty());

        std::fs::write(root.path().join("net/tcp"), &without).unwrap();
        std::fs::remove_dir_all(root.path().join("123")).unwrap();
        let closed = w.poll().await;
        assert_eq!(
            closed,
            [DaemonEvent::PortClose {
                port: 8080,
                pid: Some(123),
                process: Some("node".into()),
                command: Some("node server.js --port 8080".into()),
                exited: Some(true),
                left: None,
                at: Some(AT_ISO.into()),
            }]
        );
        assert_eq!(
            serde_json::to_value(&closed[0]).unwrap(),
            serde_json::json!({ "type": "port.close", "port": 8080, "pid": 123, "process": "node", "command": "node server.js --port 8080", "exited": true, "at": AT_ISO })
        );

        std::fs::write(root.path().join("net/tcp"), &unowned).unwrap();
        let opened = w.poll().await;
        assert_eq!(serde_json::to_value(&opened).unwrap(), serde_json::json!([{ "type": "port.open", "port": 8080, "loopback": false }]));
    }

    async fn close_after(rows: Vec<ListeningPort>, alive: bool) -> Vec<serde_json::Value> {
        let snapshot = Arc::new(Mutex::new(rows));
        let mut w = watcher_with(fixed(Arc::clone(&snapshot)), alive, AT);
        assert!(w.poll().await.is_empty());
        snapshot.lock().unwrap().clear();
        w.poll().await.iter().map(|e| serde_json::to_value(e).unwrap()).collect()
    }

    fn held() -> ListeningPort {
        ListeningPort {
            port: 8412,
            pid: Some(53479),
            inode: Some(9),
            uid: 0,
            process: Some("python3".into()),
            command: Some("python3 -m http.server 8412".into()),
            loopback: false,
        }
    }

    #[tokio::test]
    async fn a_port_seen_with_a_pid_closes_with_its_holder_whether_the_pid_exited_and_the_time() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&asked);
        let snapshot = Arc::new(Mutex::new(vec![held()]));
        let mut w = View {
            w: PortWatcher::with(
                fixed(Arc::clone(&snapshot)),
                groups(&[]),
                no_cwd(),
                Box::new(move |pid| {
                    seen.lock().unwrap().push(pid);
                    false
                }),
                Box::new(|| AT),
            ),
            scope: Scope::Everything,
            sent: None,
        };
        assert!(w.poll().await.is_empty());
        snapshot.lock().unwrap().clear();
        let closed: Vec<serde_json::Value> = w.poll().await.iter().map(|e| serde_json::to_value(e).unwrap()).collect();
        assert_eq!(
            closed,
            [
                serde_json::json!({ "type": "port.close", "port": 8412, "pid": 53479, "process": "python3", "command": "python3 -m http.server 8412", "exited": true, "at": AT_ISO })
            ]
        );
        assert_eq!(*asked.lock().unwrap(), [53479]);
    }

    #[tokio::test]
    async fn a_holder_still_alive_when_its_port_closes_is_said_to_be_running() {
        let closed = close_after(vec![held()], true).await;
        assert_eq!((closed[0]["pid"].as_u64(), closed[0]["exited"].as_bool()), (Some(53479), Some(false)));
    }

    #[tokio::test]
    async fn a_port_whose_owner_was_never_resolved_closes_plain_with_only_the_time() {
        let unowned = ListeningPort { port: 3000, pid: None, inode: Some(10), uid: 0, process: None, command: None, loopback: false };
        let snapshot = Arc::new(Mutex::new(vec![unowned]));
        let mut w = View {
            w: PortWatcher::with(
                fixed(Arc::clone(&snapshot)),
                groups(&[]),
                no_cwd(),
                Box::new(|_| panic!("never asked without a pid")),
                Box::new(|| AT),
            ),
            scope: Scope::Everything,
            sent: None,
        };
        assert!(w.poll().await.is_empty());
        snapshot.lock().unwrap().clear();
        let closed: Vec<serde_json::Value> = w.poll().await.iter().map(|e| serde_json::to_value(e).unwrap()).collect();
        assert_eq!(closed, [serde_json::json!({ "type": "port.close", "port": 3000, "at": AT_ISO })]);
    }

    #[test]
    fn loopback_listeners_in_proc_net_tcp_and_tcp6() {
        for (hex, loopback) in [
            ("0100007F", true),
            ("0200007F", true),
            ("00000000", false),
            ("0101A8C0", false),
            ("00000000000000000000000001000000", true),
            ("0000000000000000FFFF00000100007F", true),
            ("00000000000000000000000000000000", false),
            ("00000000000000000000000002000000", false),
            ("FE800000000000000000000000000001", false),
            ("0100", false),
            ("zz00007F", false),
        ] {
            assert_eq!(is_loopback_hex(hex), loopback, "{hex}");
        }
    }

    #[test]
    fn flags_the_fixture_rows_loopback_as_the_node_daemon_does() {
        let rows6 = parse_proc_net_tcp(&fixture("proc-net-tcp6.txt"), None);
        assert_eq!(rows6.iter().map(|r| (r.port, r.loopback)).collect::<Vec<_>>(), [(8976, true), (7070, false), (3001, true)]);
        let rows = parse_proc_net_tcp(&fixture("proc-net-tcp.txt"), None);
        assert_eq!(rows.iter().map(|r| (r.port, r.loopback)).collect::<Vec<_>>(), [(8080, false), (3000, true)]);
    }

    #[test]
    fn loopback_in_a_text_address_as_lsof_prints_it() {
        for (host, loopback) in [
            ("127.0.0.1", true),
            ("127.0.0.2", true),
            ("::1", true),
            ("::ffff:127.0.0.1", true),
            ("0.0.0.0", false),
            ("192.168.1.1", false),
            ("::", false),
            ("fe80::1", false),
            ("::ffff:192.168.1.1", false),
            ("*", false),
            ("", false),
            ("not-an-address", false),
        ] {
            assert_eq!(is_loopback_host(host), loopback, "{host}");
        }
    }

    fn lsof_row(port: u16, pid: u32, uid: u32, process: &str, loopback: bool) -> ListeningPort {
        ListeningPort { port, pid: Some(pid), inode: None, uid, process: Some(process.into()), command: None, loopback }
    }

    #[test]
    fn parse_lsof_listeners_gives_one_row_per_listening_socket_with_its_process_sets_pid_command_and_uid() {
        assert_eq!(
            parse_lsof_listeners(&fixture("lsof-listen.txt")),
            [
                lsof_row(7000, 712, 501, "ControlCenter", false),
                lsof_row(5000, 712, 501, "ControlCenter", true),
                lsof_row(3000, 1042, 501, "node", true),
                lsof_row(3000, 1042, 501, "node", true),
                lsof_row(49152, 88, 0, "rapportd", false),
            ]
        );
    }

    #[test]
    fn a_line_that_is_not_a_field_and_a_name_with_no_port_are_skipped() {
        assert_eq!(
            parse_lsof_listeners("lsof: WARNING: can't stat()\np9\ncsh\nu0\nf3\nnpipe\nf4\nn127.0.0.1:8080\n"),
            [lsof_row(8080, 9, 0, "sh", true)]
        );
    }

    fn fake_lsof(script: &str) -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lsof");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, path)
    }

    #[tokio::test]
    async fn the_darwin_road_asks_lsof_and_folds_its_rows_to_one_per_port() {
        let (_dir, lsof) = fake_lsof(&format!("#!/bin/sh\ncat <<'OUT'\n{}OUT\n", fixture("lsof-listen.txt")));
        assert_eq!(
            lsof_snapshot(&lsof).await,
            [
                lsof_row(7000, 712, 501, "ControlCenter", false),
                lsof_row(5000, 712, 501, "ControlCenter", true),
                lsof_row(3000, 1042, 501, "node", true),
                lsof_row(49152, 88, 0, "rapportd", false),
            ]
        );
    }

    #[tokio::test]
    async fn lsof_exiting_non_zero_with_nothing_listening_reads_as_no_ports_not_as_a_failed_poll() {
        let (_dir, lsof) = fake_lsof("#!/bin/sh\nexit 1\n");
        assert!(lsof_snapshot(&lsof).await.is_empty());
        assert!(lsof_snapshot(Path::new("/nonexistent/lsof")).await.is_empty());
    }

    #[tokio::test]
    async fn a_platform_with_no_road_reads_empty_rather_than_failing_the_pane() {
        assert!(empty_source()().await.is_empty());
        let root = fake_proc_root();
        assert_eq!(source_for(Some(root.path()))().await.len(), 2);
    }
}
