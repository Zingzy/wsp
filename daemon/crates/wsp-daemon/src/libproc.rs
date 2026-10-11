// SPDX-License-Identifier: AGPL-3.0-only
//! A Mac's processes, read straight out of the kernel through libproc: the same calls Activity Monitor and lsof make,
//! with nothing spawned. Every call answers for the person's own processes without root; another account's process
//! answers its parent and group and nothing more, and a pid that exited between the listing and the read answers
//! none.

use std::ffi::CStr;
use std::path::PathBuf;
use std::sync::OnceLock;

use libc::{c_int, c_void};

/// Who a process is and where it stands: what PROC_PIDTASKALLINFO's BSD half carries.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Identity {
    pub(crate) pid: u32,
    pub(crate) ppid: u32,
    pub(crate) pgid: u32,
    /// The effective user, which a listener's row names, and the real one, which ps -U selects by.
    pub(crate) uid: u32,
    pub(crate) ruid: u32,
    /// The accounting name, at most 16 bytes: what ps prints as ucomm.
    pub(crate) comm: String,
    /// The longer name a process is shown by, up to 32 bytes, the accounting name where it has none: what lsof prints.
    pub(crate) name: String,
    /// The one-letter state ps prints, from the process's status and whether any of its threads is on a core.
    pub(crate) state: char,
    pub(crate) started_ms: i64,
}

/// What a process has spent: the memory Activity Monitor shows, which is its physical footprint and not its resident
/// set (a seventh of the footprint for the host, measured), and its cpu time since it started.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Usage {
    pub(crate) footprint: u64,
    pub(crate) cpu_seconds: f64,
}

/// Every pid on the computer, whoever runs it.
pub(crate) fn pids() -> Vec<u32> {
    // The count moves between the sizing call and the read, so the buffer holds a margin and a full one is read again.
    let mut room = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) }.max(0) as usize + 64;
    loop {
        let mut buf = vec![0 as c_int; room];
        let bytes = (room * size_of::<c_int>()) as c_int;
        let n = unsafe { libc::proc_listallpids(buf.as_mut_ptr().cast(), bytes) };
        if n <= 0 {
            return Vec::new();
        }
        let n = n as usize;
        if n < room {
            buf.truncate(n);
            return buf.into_iter().filter(|p| *p > 0).map(|p| p as u32).collect();
        }
        room *= 2;
    }
}

/// Reads one PROC_PIDINFO flavor into a value of its type, or nothing for a pid that is gone or out of reach.
fn pidinfo<T>(pid: u32, flavor: c_int) -> Option<T> {
    let mut value = std::mem::MaybeUninit::<T>::zeroed();
    let size = size_of::<T>() as c_int;
    let n = unsafe { libc::proc_pidinfo(pid as c_int, flavor, 0, value.as_mut_ptr().cast(), size) };
    (n == size).then(|| unsafe { value.assume_init() })
}

fn text(chars: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = chars.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// ps's letter for a process: a zombie or a stopped one by its status, a new one as idle, and otherwise running when
/// one of its threads is, sleeping when none is. ps splits sleeping at twenty seconds into S and I; this road has no
/// such clock and calls both S, the letter /proc gives a sleeping process on a guest.
fn state_of(status: u32, running: i32) -> char {
    match status {
        libc::SZOMB => 'Z',
        libc::SSTOP => 'T',
        libc::SIDL => 'I',
        _ if running > 0 => 'R',
        _ => 'S',
    }
}

fn identity_of(bsd: &libc::proc_bsdinfo, running: i32) -> Identity {
    let comm = text(&bsd.pbi_comm);
    let name = text(&bsd.pbi_name);
    Identity {
        pid: bsd.pbi_pid,
        ppid: bsd.pbi_ppid,
        pgid: bsd.pbi_pgid,
        uid: bsd.pbi_uid,
        ruid: bsd.pbi_ruid,
        name: if name.is_empty() { comm.clone() } else { name },
        comm,
        state: state_of(bsd.pbi_status, running),
        started_ms: (bsd.pbi_start_tvsec * 1000 + bsd.pbi_start_tvusec / 1000) as i64,
    }
}

/// One of the person's own processes, with its running threads counted out of the task half of the same call. None
/// for another account's, a setuid program the person started among them, which ps would list under their name.
pub(crate) fn identity(pid: u32) -> Option<Identity> {
    pidinfo::<libc::proc_taskallinfo>(pid, libc::PROC_PIDTASKALLINFO).map(|all| identity_of(&all.pbsd, all.ptinfo.pti_numrunning))
}

/// Any process's parent and group, whoever runs it: the short BSD info is the one flavor another account's process
/// answers.
pub(crate) fn lineage(pid: u32) -> Option<(u32, u32)> {
    pidinfo::<libc::proc_bsdshortinfo>(pid, libc::PROC_PIDT_SHORTBSDINFO).map(|short| (short.pbsi_ppid, short.pbsi_pgid))
}

/// Mach time units to nanoseconds, off the kernel's own timebase frequency: one to one on Intel, 125/3 on Apple
/// silicon. mach_timebase_info is not that under Rosetta, where it answers one to one while the kernel still counts a
/// process's time in its own units, and an Intel build on Apple silicon read every process at a forty-second of its
/// cpu.
fn ns_per_tick() -> f64 {
    static RATIO: OnceLock<f64> = OnceLock::new();
    *RATIO.get_or_init(|| {
        let mut hz: u64 = 0;
        let mut len = size_of::<u64>();
        let rc = unsafe { libc::sysctlbyname(c"hw.tbfrequency".as_ptr(), (&mut hz as *mut u64).cast(), &mut len, std::ptr::null_mut(), 0) };
        if rc != 0 || hz == 0 {
            1.0
        } else {
            1e9 / hz as f64
        }
    })
}

/// One process's footprint and cpu time, from proc_pid_rusage, where the cpu times are in mach time units.
pub(crate) fn usage(pid: u32) -> Option<Usage> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    let rc = unsafe { libc::proc_pid_rusage(pid as c_int, libc::RUSAGE_INFO_V4, info.as_mut_ptr().cast()) };
    if rc != 0 {
        return None;
    }
    let info = unsafe { info.assume_init() };
    let ticks = info.ri_user_time.saturating_add(info.ri_system_time);
    Some(Usage { footprint: info.ri_phys_footprint, cpu_seconds: ticks as f64 * ns_per_tick() / 1e9 })
}

/// The kernel's cap on a process's argument area, which KERN_PROCARGS2 needs room for.
fn arg_max() -> usize {
    static MAX: OnceLock<usize> = OnceLock::new();
    *MAX.get_or_init(|| {
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        let mut max: c_int = 0;
        let mut len = size_of::<c_int>();
        let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&mut max as *mut c_int).cast(), &mut len, std::ptr::null_mut(), 0) };
        if rc == 0 && max > 0 {
            max as usize
        } else {
            1 << 20
        }
    })
}

/// A process's argv joined by spaces, at most `cap` bytes of it, as ps prints its args column. KERN_PROCARGS2 lays out
/// argc, the executable's path, padding, then argv and the environment, each NUL-terminated; only argv is read. None
/// for a process out of reach or with no argv, a kernel task's or a zombie's.
pub(crate) fn argv(pid: u32, cap: usize) -> Option<String> {
    let mut buf = vec![0u8; arg_max()];
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as c_int];
    let mut len = buf.len();
    let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast::<c_void>(), &mut len, std::ptr::null_mut(), 0) };
    if rc != 0 || len < size_of::<c_int>() {
        return None;
    }
    argv_of(&buf[..len], cap)
}

fn argv_of(area: &[u8], cap: usize) -> Option<String> {
    let argc = c_int::from_ne_bytes(area.get(..size_of::<c_int>())?.try_into().ok()?);
    let mut rest = &area[size_of::<c_int>()..];
    let path_end = rest.iter().position(|b| *b == 0)?;
    rest = &rest[path_end..];
    let start = rest.iter().position(|b| *b != 0)?;
    rest = &rest[start..];
    let mut args: Vec<&[u8]> = Vec::new();
    for arg in rest.split(|b| *b == 0).take(argc.max(0) as usize) {
        args.push(arg);
    }
    if args.is_empty() {
        return None;
    }
    let joined = args.join(&b' ');
    Some(String::from_utf8_lossy(&joined[..joined.len().min(cap)]).into_owned())
}

/// The folder a process runs in, for the person's own processes.
pub(crate) fn cwd(pid: u32) -> Option<PathBuf> {
    let info = pidinfo::<libc::proc_vnodepathinfo>(pid, libc::PROC_PIDVNODEPATHINFO)?;
    let chars: &[libc::c_char] = info.pvi_cdir.vip_path.as_flattened();
    let path = unsafe { CStr::from_ptr(chars.as_ptr()) };
    let path = path.to_string_lossy();
    (!path.is_empty()).then(|| PathBuf::from(path.into_owned()))
}

/// `struct socket_fdinfo` from sys/proc_info.h, read as bytes at the offsets below. Its size and the offsets were
/// measured with the SDK's own header and are the same on arm64 and x86_64.
const SOCKET_FDINFO_SIZE: usize = 792;
#[repr(C, align(8))]
struct SocketFdInfo([u8; SOCKET_FDINFO_SIZE]);
/// Where `socket_info` starts, after `proc_fileinfo`.
const PSI: usize = 24;
const SOI_FAMILY: usize = PSI + 160;
const SOI_KIND: usize = PSI + 232;
/// The protocol union; a TCP socket's is `tcp_sockinfo`, which opens with `in_sockinfo`.
const SOI_PROTO: usize = PSI + 240;
const INSI_LPORT: usize = SOI_PROTO + 4;
const INSI_VFLAG: usize = SOI_PROTO + 24;
const INSI_LADDR: usize = SOI_PROTO + 48;
const TCPSI_STATE: usize = SOI_PROTO + 80;
const PROC_PIDFDSOCKETINFO: c_int = 3;
const SOCKINFO_TCP: i32 = 2;
const TSI_S_LISTEN: i32 = 1;
const INI_IPV6: u8 = 0x2;

impl SocketFdInfo {
    fn i32_at(&self, at: usize) -> i32 {
        i32::from_ne_bytes(self.0[at..at + 4].try_into().unwrap_or_default())
    }
}

/// One listening TCP socket: its port and the address bytes it is bound to, in network order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Listener {
    pub(crate) port: u16,
    pub(crate) address: Vec<u8>,
}

/// The TCP sockets a process listens on, from its fd table: each socket fd asked for its socket info, as lsof does.
/// Empty for a process out of reach.
pub(crate) fn listeners(pid: u32) -> Vec<Listener> {
    let fd_size = size_of::<libc::proc_fdinfo>();
    let need = unsafe { libc::proc_pidinfo(pid as c_int, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if need <= 0 {
        return Vec::new();
    }
    // Room for fds opened between the sizing call and the read.
    let mut fds = vec![libc::proc_fdinfo { proc_fd: 0, proc_fdtype: 0 }; need as usize / fd_size + 16];
    let bytes = (fds.len() * fd_size) as c_int;
    let n = unsafe { libc::proc_pidinfo(pid as c_int, libc::PROC_PIDLISTFDS, 0, fds.as_mut_ptr().cast(), bytes) };
    if n <= 0 {
        return Vec::new();
    }
    fds.truncate(n as usize / fd_size);
    let mut found = Vec::new();
    for fd in fds.iter().filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32) {
        let mut info = SocketFdInfo([0; SOCKET_FDINFO_SIZE]);
        let n = unsafe {
            libc::proc_pidfdinfo(pid as c_int, fd.proc_fd, PROC_PIDFDSOCKETINFO, info.0.as_mut_ptr().cast(), SOCKET_FDINFO_SIZE as c_int)
        };
        if n as usize != SOCKET_FDINFO_SIZE {
            continue;
        }
        let family = info.i32_at(SOI_FAMILY);
        if (family != libc::AF_INET && family != libc::AF_INET6)
            || info.i32_at(SOI_KIND) != SOCKINFO_TCP
            || info.i32_at(TCPSI_STATE) != TSI_S_LISTEN
        {
            continue;
        }
        // The port is in network order in the low half of an int.
        let port = u16::from_be((info.i32_at(INSI_LPORT) as u32 & 0xffff) as u16);
        let laddr = &info.0[INSI_LADDR..INSI_LADDR + 16];
        // An IPv6 socket that accepts IPv4 too carries both flags; lsof reads the IPv6 address for it, and the IPv4
        // one, the last four bytes of the in4in6 form, only for a socket with no IPv6 in it.
        let v6 = family == libc::AF_INET6 && info.0[INSI_VFLAG] & INI_IPV6 != 0;
        let address = if v6 { laddr.to_vec() } else { laddr[12..].to_vec() };
        found.push(Listener { port, address });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::process::Stdio;

    #[test]
    fn reads_this_process_by_its_own_pid_its_parent_its_group_and_when_it_started() {
        let me = std::process::id();
        assert!(pids().contains(&me));
        let id = identity(me).unwrap();
        assert_eq!(id.pid, me);
        assert_eq!(id.ppid, std::os::unix::process::parent_id());
        assert_eq!(id.pgid, nix::unistd::getpgrp().as_raw() as u32);
        assert_eq!((id.uid, id.ruid), (nix::unistd::geteuid().as_raw(), nix::unistd::getuid().as_raw()));
        // This test runs, so at least its own thread is on a core.
        assert_eq!(id.state, 'R');
        let now = crate::sys::now_ms();
        assert!(id.started_ms <= now && id.started_ms > now - 3_600_000, "{}", id.started_ms);
        assert_eq!(lineage(me), Some((id.ppid, id.pgid)));
        // Another account's process answers its place and nothing else: launchd is root's.
        assert_eq!(identity(1), None);
        assert_eq!(lineage(1), Some((0, 1)));
        assert_eq!(identity(1 << 22 | 1), None);
        assert_eq!(lineage(1 << 22 | 1), None);
    }

    #[test]
    fn names_a_process_by_its_accounting_name_and_by_its_longer_name() {
        let mut child = std::process::Command::new("/bin/sleep").arg("30").stdin(Stdio::null()).spawn().unwrap();
        let id = identity(child.id()).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!((id.comm.as_str(), id.name.as_str()), ("sleep", "sleep"));
    }

    /// This process's own cpu time as getrusage counts it, in seconds.
    fn own_cpu() -> f64 {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) }, 0);
        let usage = unsafe { usage.assume_init() };
        let seconds = |t: libc::timeval| t.tv_sec as f64 + f64::from(t.tv_usec) / 1e6;
        seconds(usage.ru_utime) + seconds(usage.ru_stime)
    }

    #[test]
    fn reads_a_footprint_and_the_cpu_time_getrusage_counts_in_seconds_not_in_mach_ticks() {
        let me = std::process::id();
        let mut n = 0u64;
        let until = std::time::Instant::now() + std::time::Duration::from_millis(100);
        while std::time::Instant::now() < until {
            n = std::hint::black_box(n.wrapping_add(1));
        }
        let before = own_cpu();
        let read = usage(me).unwrap();
        let after = own_cpu();
        assert!(read.footprint > 0);
        // Mach ticks would read 41 times the seconds on Apple silicon; the two counts agree to the clock's grain.
        assert!(read.cpu_seconds >= before - 0.01 && read.cpu_seconds <= after + 0.01, "{before} <= {} <= {after}", read.cpu_seconds);
        assert_eq!(usage(1 << 22 | 1), None);
    }

    #[test]
    fn reads_a_processs_argv_joined_by_spaces_and_cut_at_the_cap() {
        let mut child = std::process::Command::new("/bin/sleep").arg("31").stdin(Stdio::null()).spawn().unwrap();
        let args = argv(child.id(), 4096);
        let cut = argv(child.id(), 5);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(args.as_deref(), Some("/bin/sleep 31"));
        assert_eq!(cut.as_deref(), Some("/bin/"));
        assert_eq!(argv(1 << 22 | 1, 4096), None);
    }

    #[test]
    fn reads_argv_out_of_the_kernels_layout_and_none_out_of_a_short_one() {
        let mut area = 2i32.to_ne_bytes().to_vec();
        area.extend_from_slice(b"/usr/bin/node\0\0\0\0node\0server.js\0PATH=/bin\0");
        assert_eq!(argv_of(&area, 4096).as_deref(), Some("node server.js"));
        assert_eq!(argv_of(&area[..2], 4096), None);
        assert_eq!(argv_of(&2i32.to_ne_bytes(), 4096), None);
    }

    #[test]
    fn reads_the_folder_a_process_runs_in() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("/bin/sleep").arg("30").current_dir(dir.path()).stdin(Stdio::null()).spawn().unwrap();
        let folder = cwd(child.id());
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(folder, Some(dir.path().canonicalize().unwrap()));
    }

    #[test]
    fn finds_this_processs_listening_sockets_by_port_and_address_and_not_a_connected_one() {
        let loopback = TcpListener::bind("127.0.0.1:0").unwrap();
        let any6 = TcpListener::bind("[::]:0").unwrap();
        let (l4, l6) = (loopback.local_addr().unwrap().port(), any6.local_addr().unwrap().port());
        let _client = std::net::TcpStream::connect(("127.0.0.1", l4)).unwrap();
        let mine = listeners(std::process::id());
        assert!(mine.contains(&Listener { port: l4, address: vec![127, 0, 0, 1] }), "{mine:?}");
        assert!(mine.contains(&Listener { port: l6, address: vec![0; 16] }), "{mine:?}");
        // The connected socket on each side is not listening and is not a row.
        assert_eq!(mine.iter().filter(|l| l.port == l4).count(), 1, "{mine:?}");
        assert_eq!(listeners(1 << 22 | 1), vec![]);
    }
}
