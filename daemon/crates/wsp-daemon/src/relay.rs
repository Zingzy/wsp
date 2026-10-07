// SPDX-License-Identifier: AGPL-3.0-only
//! The guest half of the sign-in callback relay: the unix socket the browser shim posts a URL to, what the daemon
//! tells every authed socket about it, and the listener heuristic for a flow whose URL names no port.

use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use wsp_frames::{numbers, DaemonEvent, RelayPort};

use crate::{clock, urls, Ctx};

/// How long after the open to wait for a loopback listener to appear.
const SPOT_WINDOW_MS: u64 = 5_000;
/// The most one request head may be before the socket is answered 400 and closed.
const HEAD_CAP: usize = 16 * 1024;
/// How much of an oversized body is read before the 400, so the shim's curl sees the answer rather than a reset.
const BODY_READ_MAX: usize = 1024 * 1024;
/// How long one request has to arrive whole. The shim's curl gives up after one second, so a peer still sending at
/// five is not the shim; a head or a body it never finishes must not hold the task and its buffer for good.
const READ_DEADLINE: Duration = Duration::from_secs(5);

/// Pairs a browser.open that names no port with the loopback listener the port watcher reports after it, within
/// the window. A listener already there when the open came is not the flow's: a dev server on 3000 must never have
/// the laptop's 3000 bound. Tools bind and open milliseconds apart, and the open hurries the watcher to a read a
/// second through the window, so the flow's own listener still lands after.
pub(crate) struct CallbackSpotter {
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    after_ms: u64,
    /// At most one open ask: a second spot while one waits replaces it instead of doubling the answer.
    pending_until: Option<u64>,
}

impl CallbackSpotter {
    pub(crate) fn new() -> CallbackSpotter {
        CallbackSpotter::with(Box::new(clock::now_ms), SPOT_WINDOW_MS)
    }

    pub(crate) fn with(now: Box<dyn Fn() -> u64 + Send + Sync>, after_ms: u64) -> CallbackSpotter {
        CallbackSpotter { now, after_ms, pending_until: None }
    }

    /// The port to announce as the flow's callback, if this open answers the ask that is waiting. A port the laptop
    /// could not bind is never named; the protocol's own rule for that is RelayPort.
    pub(crate) fn note_open(&mut self, port: u16, loopback: bool) -> Option<u16> {
        if !loopback || RelayPort::new(port).is_none() {
            return None;
        }
        let until = self.pending_until.take()?;
        (until >= (self.now)()).then_some(port)
    }

    pub(crate) fn spot(&mut self) {
        self.pending_until = Some((self.now)() + self.after_ms);
    }
}

/// A tool asked for a browser: open on the laptop now, name the callback port when the URL or a new loopback
/// listener gives one.
pub(crate) fn open(ctx: &Ctx, url: &str) {
    let port = urls::callback_port_of(url).and_then(RelayPort::new);
    let local = urls::localhost_port_of(url).and_then(RelayPort::new);
    // A local page with no callback port (a dev server opening itself) is not a sign-in: forwarded and listed, no
    // page announced. A local authorize page whose redirect_uri names a port (a local Supabase or Keycloak) is
    // both: the page to click and a local URL.
    if port.is_some() || local.is_none() {
        ctx.broadcast(&DaemonEvent::BrowserOpen { url: url.to_owned(), port });
    }
    match local {
        Some(port) => ctx.broadcast(&DaemonEvent::LocalhostUrl { port }),
        None if port.is_none() => {
            ctx.spotter.lock().unwrap_or_else(|e| e.into_inner()).spot();
            ctx.ports.hurry(Duration::from_millis(SPOT_WINDOW_MS));
        }
        None => {}
    }
}

/// An open a browser.open with no port is waiting for becomes the callback.port every authed socket hears.
pub(crate) fn note_opens(ctx: &Ctx, events: &[DaemonEvent]) {
    for event in events {
        if let DaemonEvent::PortOpen { port, loopback, .. } = event {
            let spotted = ctx.spotter.lock().unwrap_or_else(|e| e.into_inner()).note_open(*port, *loopback == Some(true));
            if let Some(port) = spotted.and_then(RelayPort::new) {
                ctx.broadcast(&DaemonEvent::CallbackPort { port });
            }
        }
    }
}

/// The open socket, bound in its folder, and that folder held open: what the hand-over to a login changes, by name in
/// the folder it holds rather than by a path the login could rearrange in between.
pub(crate) struct OpenSocket {
    pub(crate) listener: UnixListener,
    folder: OwnedFd,
    name: String,
}

/// The unix socket the shim posts to, bound in its folder. The folder sits under a home whose login can put a link
/// where a folder was, so it is walked from the top one name at a time with no link followed, a missing one made
/// there, and refused unless this daemon owns it; a stale socket from an earlier daemon is unlinked in it and the new
/// one bound in it. A link root owns on the way is the system's own (a /home that is a link into /var), which no
/// login can make, and the walk starts again at where it points; any other link is refused.
pub(crate) fn listen_open_socket(path: &Path) -> io::Result<OpenSocket> {
    use nix::sys::stat::fstat;
    use nix::unistd::{unlinkat, UnlinkatFlags};
    let (folder, name) = crate::beneath::from_top(path, true)?;
    if fstat(&folder)?.st_uid != nix::unistd::geteuid().as_raw() {
        return Err(io::Error::other(format!("{} is not this daemon's folder", path.parent().unwrap_or(path).display())));
    }
    match unlinkat(&folder, name.as_str(), UnlinkatFlags::NoRemoveDir) {
        Ok(()) | Err(nix::errno::Errno::ENOENT) => {}
        Err(e) => return Err(e.into()),
    }
    let listener = UnixListener::bind(bound_at(&folder, &name, path))?;
    Ok(OpenSocket { listener, folder, name })
}

/// The name the bind takes: the held folder through /proc, so the socket lands in that folder whatever the path names
/// by now.
#[cfg(target_os = "linux")]
fn bound_at(folder: &OwnedFd, name: &str, _path: &Path) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("/proc/self/fd/{}/{name}", folder.as_raw_fd()))
}

/// macOS has no /proc, and a daemon there runs as the person whose home it is, so no other login stands to swap a
/// folder between the walk and the bind.
#[cfg(not(target_os = "linux"))]
fn bound_at(_folder: &OwnedFd, _name: &str, path: &Path) -> std::path::PathBuf {
    path.to_path_buf()
}

/// The bound socket handed to one login, that login's alone to open: what a tool a line runs as that login posts a
/// page to. Changed by name in the folder the bind held, which is refused unless this daemon alone may write in it,
/// so nothing the login does can put another file at the name, and a link standing there is changed itself and names
/// nothing. The login has to get through that folder to the socket, so where the folder is not already the login's
/// it is made searchable by that login alone, never listable, and by no other login or group.
pub(crate) fn hand_open_socket(open: &OpenSocket, uid: u32) -> io::Result<()> {
    use nix::sys::stat::{fchmodat, fstat, fstatat, FchmodatFlags, Mode, SFlag};
    use nix::unistd::{fchownat, Uid};
    let held = fstat(&open.folder)?;
    if held.st_mode & 0o022 != 0 {
        return Err(io::Error::other("its folder is not this daemon's alone to write"));
    }
    let socket = fstatat(&open.folder, open.name.as_str(), nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW)?;
    if SFlag::from_bits_truncate(socket.st_mode) & SFlag::S_IFMT != SFlag::S_IFSOCK {
        return Err(io::Error::other("what stands at its name is not a socket"));
    }
    if held.st_uid != uid {
        search_for(&open.folder, uid)?;
    }
    fchmodat(&open.folder, open.name.as_str(), Mode::from_bits_truncate(0o600), FchmodatFlags::NoFollowSymlink)?;
    fchownat(&open.folder, open.name.as_str(), Some(Uid::from_raw(uid)), None, nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW)?;
    Ok(())
}

/// The folder's access list set whole: its owner keeps its own bits, the one login may search it, and its group
/// and every other login may do nothing, so the mode reads 0710 with the group bits standing for the list's mask. A
/// group would let in every login that shares it, and a login's primary group is often shared.
#[cfg(target_os = "linux")]
fn search_for(folder: &OwnedFd, uid: u32) -> io::Result<()> {
    use xattr::FileExt as _;
    const UNDEFINED: u32 = u32::MAX;
    let owner = (nix::sys::stat::fstat(folder)?.st_mode >> 6) & 0o7;
    // posix_acl_xattr: a version word, then (tag, perm, id) rows in tag order: the owner, a named user, the
    // group, the mask, the others.
    let rows: [(u16, u32, u32); 5] =
        [(0x01, owner, UNDEFINED), (0x02, 0o1, uid), (0x04, 0, UNDEFINED), (0x10, 0o1, UNDEFINED), (0x20, 0, UNDEFINED)];
    let mut list = 2u32.to_le_bytes().to_vec();
    for (tag, perm, id) in rows {
        list.extend_from_slice(&tag.to_le_bytes());
        list.extend_from_slice(&(perm as u16).to_le_bytes());
        list.extend_from_slice(&id.to_le_bytes());
    }
    std::fs::File::from(folder.try_clone()?).set_xattr("system.posix_acl_access", &list)
}

/// A daemon off Linux runs as the person whose home it is, so its folder is already the login's.
#[cfg(not(target_os = "linux"))]
fn search_for(_folder: &OwnedFd, uid: u32) -> io::Result<()> {
    Err(io::Error::other(format!("only Linux hands a folder to uid {uid} alone")))
}

/// Whether that login reaches the socket at its path, asked of the kernel as that login: search on every folder on
/// the way and write on the socket, which is what a connect needs. What the report's loginReach rests on, so a
/// folder above the socket that shuts the login out is never reported as a road it has.
pub(crate) fn login_reaches(path: &Path, uid: u32) -> bool {
    use std::os::unix::process::CommandExt;
    let gid = nix::unistd::User::from_uid(nix::unistd::Uid::from_raw(uid)).ok().flatten().map_or(uid, |user| user.gid.as_raw());
    let mut test = std::process::Command::new("/bin/sh");
    test.args(["-c", "test -w \"$1\"", "sh"]).arg(path).env_clear().uid(uid).gid(gid);
    test.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    test.status().is_ok_and(|status| status.success())
}

pub(crate) async fn serve_open_socket(listener: UnixListener, ctx: Arc<Ctx>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { return };
        let ctx = Arc::clone(&ctx);
        tokio::spawn(async move {
            if let Some(url) = answer(stream).await {
                open(&ctx, &url);
            }
        });
    }
}

enum Status {
    NoContent,
    BadRequest,
    NotFound,
    Timeout,
}

impl Status {
    fn line(&self) -> &'static str {
        match self {
            Status::NoContent => "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n",
            Status::BadRequest => "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            Status::NotFound => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            Status::Timeout => "HTTP/1.1 408 Request Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        }
    }
}

/// One request per connection: the head to the blank line, the body by its Content-Length, one answer, the
/// connection closed. The URL is returned only when it was answered 204.
async fn answer(stream: UnixStream) -> Option<String> {
    answer_within(stream, READ_DEADLINE).await
}

/// A peer that has not finished its request when the deadline passes is answered 408 and cut.
async fn answer_within(mut stream: UnixStream, deadline: Duration) -> Option<String> {
    let (status, url) = match tokio::time::timeout(deadline, read_request(&mut stream)).await {
        Ok(Ok(Some((method, target, body)))) => judge(&method, &target, &body),
        Ok(Ok(None)) => return None,
        Ok(Err(status)) => (status, None),
        Err(_) => (Status::Timeout, None),
    };
    let _ = stream.write_all(status.line().as_bytes()).await;
    let _ = stream.shutdown().await;
    url
}

/// The method, the target and the whole body as bytes; None when the peer went before a head arrived.
async fn read_request(stream: &mut UnixStream) -> Result<Option<(String, String, Vec<u8>)>, Status> {
    let mut buf = Vec::with_capacity(1024);
    let head_end = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        if buf.len() > HEAD_CAP {
            return Err(Status::BadRequest);
        }
        let mut chunk = [0u8; 4096];
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return Ok(None),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or("").split(' ');
    let method = request_line.next().unwrap_or("").to_owned();
    let target = request_line.next().unwrap_or("").to_owned();
    let mut length = 0usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().map_err(|_| Status::BadRequest)?;
            }
        }
    }
    if length > BODY_READ_MAX {
        return Err(Status::BadRequest);
    }
    let mut body = buf.split_off(head_end + 4);
    while body.len() < length {
        let mut chunk = vec![0u8; (length - body.len()).min(64 * 1024)];
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return Ok(None),
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    body.truncate(length);
    Ok(Some((method, target, body)))
}

/// POST /open with one http or https URL under the cap is taken; any other path is 404, anything else 400.
fn judge(method: &str, target: &str, body: &[u8]) -> (Status, Option<String>) {
    if method != "POST" || target != "/open" {
        return (Status::NotFound, None);
    }
    if body.len() > numbers::OPEN_BODY_CAP {
        return (Status::BadRequest, None);
    }
    let url = String::from_utf8_lossy(body).trim().to_owned();
    if !urls::is_open_url(&url) {
        return (Status::BadRequest, None);
    }
    (Status::NoContent, Some(url))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn spotter(clock: &Arc<AtomicU64>) -> CallbackSpotter {
        let clock = Arc::clone(clock);
        CallbackSpotter::with(Box::new(move || clock.load(Ordering::SeqCst)), 5_000)
    }

    #[test]
    fn a_listener_that_was_already_there_when_the_open_came_is_not_the_flows() {
        let t = Arc::new(AtomicU64::new(1_000_000));
        let mut sp = spotter(&t);
        assert_eq!(sp.note_open(3000, true), None);
        t.fetch_add(2_000, Ordering::SeqCst);
        sp.spot();
        t.fetch_add(1_000, Ordering::SeqCst);
        assert_eq!(sp.note_open(8976, true), Some(8976));
    }

    #[test]
    fn waits_for_the_next_loopback_listener_within_the_window_and_forgets_the_ask_after_it() {
        let t = Arc::new(AtomicU64::new(1_000_000));
        let mut sp = spotter(&t);
        sp.spot();
        t.fetch_add(1_000, Ordering::SeqCst);
        assert_eq!(sp.note_open(3000, false), None);
        t.fetch_add(1_000, Ordering::SeqCst);
        assert_eq!(sp.note_open(45543, true), Some(45543));
        assert_eq!(sp.note_open(45544, true), None);
    }

    #[test]
    fn two_asks_pending_on_the_same_window_answer_once_when_the_listener_appears() {
        let t = Arc::new(AtomicU64::new(1_000_000));
        let mut sp = spotter(&t);
        sp.spot();
        t.fetch_add(500, Ordering::SeqCst);
        sp.spot();
        t.fetch_add(500, Ordering::SeqCst);
        assert_eq!(sp.note_open(8976, true), Some(8976));
        assert_eq!(sp.note_open(8977, true), None);
    }

    #[test]
    fn an_ask_that_expired_is_not_answered_and_ports_below_1024_are_never_named() {
        let t = Arc::new(AtomicU64::new(1_000_000));
        let mut sp = spotter(&t);
        sp.spot();
        t.fetch_add(6_000, Ordering::SeqCst);
        assert_eq!(sp.note_open(8086, true), None);
        sp.spot();
        assert_eq!(sp.note_open(631, true), None);
        assert_eq!(sp.note_open(8976, true), Some(8976));
    }

    #[test]
    fn post_open_with_one_url_is_taken_and_everything_else_is_refused_with_its_status() {
        let taken = judge("POST", "/open", b"https://github.com/login/device\n");
        assert!(matches!(taken, (Status::NoContent, Some(ref url)) if url == "https://github.com/login/device"));
        assert!(matches!(judge("POST", "/other", b"https://github.com/login/device"), (Status::NotFound, None)));
        assert!(matches!(judge("GET", "/open", b""), (Status::NotFound, None)));
        assert!(matches!(judge("POST", "/open", b"file:///etc/passwd"), (Status::BadRequest, None)));
        assert!(matches!(judge("POST", "/open", b"not a url"), (Status::BadRequest, None)));
        assert!(matches!(judge("POST", "/open", b""), (Status::BadRequest, None)));
        let long = format!("https://x.test/{}", "a".repeat(numbers::OPEN_URL_MAX));
        assert!(matches!(judge("POST", "/open", long.as_bytes()), (Status::BadRequest, None)));
        // The cap is on the body as sent, before the trim that would leave a URL under it.
        let padded = format!("https://github.com/login/device{}", "\n".repeat(numbers::OPEN_BODY_CAP));
        assert!(matches!(judge("POST", "/open", padded.as_bytes()), (Status::BadRequest, None)));
    }

    async fn post(path: &Path, request: &[u8]) -> String {
        let mut s = UnixStream::connect(path).await.unwrap();
        s.write_all(request).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    /// Whatever the socket answers within two seconds, EOF included; a socket that keeps the peer waiting fails here
    /// rather than hanging the test.
    async fn answered_within_two_seconds(s: &mut UnixStream) -> String {
        let mut out = String::new();
        tokio::time::timeout(Duration::from_secs(2), s.read_to_string(&mut out)).await.expect("an answer and the close in time").unwrap();
        out
    }

    #[tokio::test]
    async fn a_peer_that_stalls_mid_head_or_never_fills_its_length_is_answered_408_and_cut_while_others_are_served() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("open.sock");
        let listener = listen_open_socket(&path).unwrap().listener;
        let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = Arc::clone(&heard);
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let seen = Arc::clone(&seen);
                tokio::spawn(async move {
                    if let Some(url) = answer_within(stream, Duration::from_millis(200)).await {
                        seen.lock().unwrap().push(url);
                    }
                });
            }
        });
        let mut half_head = UnixStream::connect(&path).await.unwrap();
        half_head.write_all(b"POST /open HTTP/1.1\r\nContent-Len").await.unwrap();
        let mut short_body = UnixStream::connect(&path).await.unwrap();
        short_body.write_all(b"POST /open HTTP/1.1\r\nContent-Length: 31\r\n\r\nhttps://gi").await.unwrap();
        // A whole request beside the stalled ones is answered as ever.
        let url = "https://github.com/login/device";
        let whole = format!("POST /open HTTP/1.1\r\nContent-Length: {}\r\n\r\n{url}", url.len());
        assert!(post(&path, whole.as_bytes()).await.starts_with("HTTP/1.1 204 "));
        assert!(answered_within_two_seconds(&mut half_head).await.starts_with("HTTP/1.1 408 "));
        assert!(answered_within_two_seconds(&mut short_body).await.starts_with("HTTP/1.1 408 "));
        assert_eq!(*heard.lock().unwrap(), [url]);
    }

    #[tokio::test]
    async fn the_socket_reads_one_request_to_its_content_length_and_answers_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("open.sock");
        std::fs::write(&path, "stale").unwrap();
        let listener = listen_open_socket(&path).unwrap().listener;
        let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = Arc::clone(&heard);
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                if let Some(url) = answer(stream).await {
                    seen.lock().unwrap().push(url);
                }
            }
        });
        let url = "https://github.com/login/device";
        let request = format!("POST /open HTTP/1.1\r\nHost: wsp\r\nUser-Agent: curl\r\nAccept: */*\r\nContent-Length: {}\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\n{url}", url.len());
        assert!(post(&path, request.as_bytes()).await.starts_with("HTTP/1.1 204 "));
        // The head and the body in two writes, the length header in another case.
        let mut s = UnixStream::connect(&path).await.unwrap();
        s.write_all(format!("POST /open HTTP/1.1\r\ncontent-length: {}\r\n\r\n", url.len()).as_bytes()).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        s.write_all(url.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 204 "), "{out}");
        assert!(post(&path, b"POST /other HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc").await.starts_with("HTTP/1.1 404 "));
        assert!(post(&path, b"POST /open HTTP/1.1\r\nContent-Length: 17\r\n\r\nfile:///etc/passw").await.starts_with("HTTP/1.1 400 "));
        let big = format!("https://x.test/{}", "a".repeat(numbers::OPEN_BODY_CAP));
        assert!(post(&path, format!("POST /open HTTP/1.1\r\nContent-Length: {}\r\n\r\n{big}", big.len()).as_bytes())
            .await
            .starts_with("HTTP/1.1 400 "));
        assert!(post(&path, b"POST /open HTTP/1.1\r\nContent-Length: x\r\n\r\n").await.starts_with("HTTP/1.1 400 "));
        assert_eq!(*heard.lock().unwrap(), [url, url]);
    }

    /// The socket handed to the login is that login's alone to open, which the kernel holds every other login to;
    /// it is handed only from a folder this daemon alone writes, and that folder is made searchable by the login
    /// alone, so the 0700 folder an add leaves lets the login through and no other login or group. Run as root it is
    /// handed to nobody; run as anyone else the uid is their own, whose folder it already is.
    #[tokio::test]
    async fn the_open_socket_is_handed_to_the_login_alone_and_only_from_a_folder_this_daemon_alone_writes() {
        use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
        let me = nix::unistd::geteuid().as_raw();
        let login = if me == 0 { 65534 } else { me };
        let folder = |mode: u32| {
            let dir = tempfile::tempdir().unwrap();
            let at = dir.path().canonicalize().unwrap();
            std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o755)).unwrap();
            let wsp = at.join(".wsp");
            std::fs::create_dir(&wsp).unwrap();
            std::fs::set_permissions(&wsp, std::fs::Permissions::from_mode(mode)).unwrap();
            (dir, wsp)
        };

        for mode in [0o755, 0o700] {
            let (_held, at) = folder(mode);
            let path = at.join("open.sock");
            let open = listen_open_socket(&path).unwrap();
            hand_open_socket(&open, login).unwrap();
            let socket = std::fs::symlink_metadata(&path).unwrap();
            assert_eq!((socket.uid(), socket.mode() & 0o777), (login, 0o600), "the login's to open, and no group's or other login's");
            let searched = std::fs::metadata(&at).unwrap().mode() & 0o777;
            assert!(login_reaches(&path, login), "folder {mode:o}");
            if me == 0 {
                // The login searches the folder; another login, one in the login's group and one in the folder's own
                // group do not, so none of them opens anything in it by name.
                assert!(searches(&at, login, 65534), "folder {mode:o}");
                assert!(!searches(&at, 65533, 65533), "folder {mode:o}: another login");
                assert!(!searches(&at, 65533, 65534), "folder {mode:o}: a login in the login's group");
                assert!(!searches(&at, 65533, 0), "folder {mode:o}: a login in the folder's own group");
                assert_eq!(searched, 0o710, "folder {mode:o}: the group bits are the access list's mask, which lets one login search");
            } else {
                assert_eq!(searched, mode, "a folder already the login's own is left as it was");
            }
        }

        let (_shared, at) = folder(0o777);
        let path = at.join("open.sock");
        let open = listen_open_socket(&path).unwrap();
        let refused = hand_open_socket(&open, login).unwrap_err().to_string();
        assert!(refused.contains("not this daemon's alone"), "{refused}");
        assert_eq!(std::fs::symlink_metadata(&path).unwrap().uid(), me, "a socket in a folder others write in stays as bound");

        // A link standing at the socket's own name is taken away by the bind, and what it named is left alone.
        let (_linked, at) = folder(0o755);
        let named = at.join("named");
        std::fs::write(&named, "theirs").unwrap();
        std::os::unix::fs::symlink(&named, at.join("open.sock")).unwrap();
        let open = listen_open_socket(&at.join("open.sock")).unwrap();
        hand_open_socket(&open, login).unwrap();
        assert_eq!(std::fs::read_to_string(&named).unwrap(), "theirs");
        assert!(std::fs::symlink_metadata(at.join("open.sock")).unwrap().file_type().is_socket());
    }

    /// Whether `uid` with `gid` as its group may search the folder, asked of the kernel as that login.
    fn searches(folder: &Path, uid: u32, gid: u32) -> bool {
        use std::os::unix::process::CommandExt;
        let mut test = std::process::Command::new("/bin/sh");
        test.args(["-c", "test -x \"$1\"", "sh"]).arg(folder).env_clear().uid(uid).gid(gid);
        test.status().is_ok_and(|status| status.success())
    }

    /// A link root owns on the way is the system's own, a /home that points into /var, and the socket lands where it
    /// points; only root can make one, so the case runs as root.
    #[tokio::test]
    async fn a_link_root_owns_on_the_way_is_followed_to_where_it_points() {
        if !nix::unistd::geteuid().is_root() {
            return;
        }
        let top = tempfile::tempdir().unwrap();
        let top = top.path().canonicalize().unwrap();
        std::fs::create_dir_all(top.join("var").join("home").join(".wsp")).unwrap();
        std::os::unix::fs::symlink("var/home", top.join("home")).unwrap();
        let open = listen_open_socket(&top.join("home").join(".wsp").join("open.sock")).unwrap();
        drop(open);
        assert!(top.join("var").join("home").join(".wsp").join("open.sock").exists());
    }

    /// The socket's folder sits under a home its login owns, who can put a link where wsp's folder was. The bind
    /// walks to the folder with no link followed, so a link standing there, or anywhere on the way, is refused and
    /// nothing is unlinked or bound where it points.
    #[tokio::test]
    async fn a_link_put_in_place_of_the_sockets_folder_is_refused_and_nothing_lands_where_it_points() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        let elsewhere = home.join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("open.sock"), "not wsp's").unwrap();
        std::os::unix::fs::symlink(&elsewhere, home.join(".wsp")).unwrap();
        // The login planted it, so it is the login's: run as root that is nobody's link.
        let planted = |link: &std::path::Path| {
            if nix::unistd::geteuid().is_root() {
                std::os::unix::fs::lchown(link, Some(65534), Some(65534)).unwrap();
            }
        };
        planted(&home.join(".wsp"));
        let refused = listen_open_socket(&home.join(".wsp").join("open.sock")).err().map(|e| e.to_string());
        assert!(refused.as_deref().is_some_and(|said| said.contains("link")), "{refused:?}");
        assert_eq!(std::fs::read_to_string(elsewhere.join("open.sock")).unwrap(), "not wsp's", "what the link names was unlinked");

        // A link further up the way is refused the same.
        std::fs::remove_file(home.join(".wsp")).unwrap();
        std::os::unix::fs::symlink(&home, home.join("up")).unwrap();
        planted(&home.join("up"));
        std::fs::create_dir(home.join("real")).unwrap();
        assert!(listen_open_socket(&home.join("up").join("real").join("open.sock")).is_err());
        assert!(!home.join("real").join("open.sock").exists());
    }
}
