// SPDX-License-Identifier: AGPL-3.0-only
//! Every sentence the daemon emits that a client or a test matches on, spelled once.

/// The four reasons a socket is closed 4401 before it is served.
pub const AUTH_TOKEN_REFUSED: &str = "daemon token refused; the host holds the current one";
pub const AUTH_FIRST_FRAME: &str = "the first frame must be auth";
pub const AUTH_TOO_MANY_BYTES: &str = "too many bytes before the auth frame";
pub const AUTH_NO_FRAME_IN_TIME: &str = "no auth frame arrived in time";
/// What a socket already through the door is cut with once the token it authed with is no longer the file's: a
/// rotation takes the sockets the old token opened with it, rather than leaving them answering for the life of
/// the connection. Under the same close code the four above travel with.
pub const AUTH_TOKEN_ROTATED: &str = "the daemon token was rotated; dial again with the current one";
/// The WebSocket close code every one of them travels under.
pub const AUTH_CLOSE_CODE: u16 = 4401;

pub const INVALID_JSON: &str = "invalid json";
pub const NO_TOKEN_AT_START: &str = "daemon refuses to start without an auth token";
/// The bin's own prefix on a start that failed; the node daemon's is the same. Not in the shared set: no client matches on it.
pub const FAILED_TO_START: &str = "wsp-daemon failed to start";

/// One sampler serves every watcher and starts with the first and stops with the last; these four lines are how a
/// test reads that without a counter inside the daemon.
pub const SYS_SAMPLER_STARTED: &str = "sys sampler started";
pub const SYS_SAMPLER_STOPPED: &str = "sys sampler stopped";
pub const PROC_SAMPLER_STARTED: &str = "proc sampler started";
pub const PROC_SAMPLER_STOPPED: &str = "proc sampler stopped";

/// The sentence the node daemon used before the road refusal covered the leave op too; no client matches on it now.
/// What an inbound socket gets for the leave op and the machine ops: they are the link's alone.
pub const NOT_ON_THIS_ROAD: &str = "not on this road";
pub const NOT_ON_THIS_KIND: &str = "not on this kind";
/// The link's fallback when a refusal frame carries no error; the host's own sentence rides it otherwise.
pub const HOST_REFUSED_PLACE: &str = "the host refused this place";
pub const NO_PLACE_FILE: &str =
    "no place file here, so there is no host to dial; wsp join <address> --code <code> makes this computer a place";

/// What a create naming a template or a snapshot is refused with on a computer somebody joined, and what a road
/// above answers for a saved image there without asking: a workspace on such a computer is made from that
/// computer's own directories and a copy of a checkout on it, so there is nothing to pull and nothing to build.
pub const NO_IMAGES_HERE: &str = "this computer keeps no images: a workspace here is a copy of the computer itself";

/// What a socket that never asked to watch guest sessions is told when it answers or ends one.
pub const GUEST_NOT_WATCHER: &str = "only the socket that sent guest.watch may answer or close a guest session";
/// Why a session with nobody reading it is ended: the host has been away past the queue's cap.
pub const GUEST_QUEUE_FULL: &str = "the host has not read this session for too long";
/// Why a guest message is refused where its workspace already has the cap's worth of bytes waiting to be read:
/// the frame is turned away and the session stands, so a sender whose host is reading slowly goes on.
pub const GUEST_IN_FLIGHT_FULL: &str = "too many guest bytes are waiting to be read here; send this one again";
/// Why an open is refused where this workspace already holds as many sessions as it may: the sessions standing
/// are the ones a host is still reading, so the one asking is told to end one of its own rather than the
/// workspace losing them all.
pub const GUEST_WORKSPACE_FULL: &str = "this workspace already holds as many guest sessions as it may; end one and run it again";
/// Why a session is ended once nobody has watched it for a whole span: the guest prints this and exits, so the
/// agent that ran the line can run it again against a host that is there.
pub const GUEST_UNWATCHED: &str = "the host stopped watching; run it again";

/// Why one path a leave would have taken is still there: a folder on the way to it under the home is a link, and
/// a workspace on a computer somebody owns writes in that home, so following it would take the computer's own
/// file of that name. Said on both roads a leave runs on, and pinned to one text by the contract fixture.
pub fn place_kept_for_link(path: impl std::fmt::Display) -> String {
    format!("nothing was removed at {path}: a folder on the way to it is a link")
}

pub fn guest_no_daemon_line(port: impl std::fmt::Display) -> String {
    format!("this machine's wsp daemon is not answering on 127.0.0.1:{port}")
}

/// What a request is answered with when the host's socket went before the host answered it, the words the command
/// line's own dial says a host that went in.
pub const HOST_CLOSED: &str = "the host closed the connection";

/// The close reasons the link puts on a socket it ends. Not in the shared set: no client matches on a close reason.
pub const LINK_CLOSE_STOPPING: &str = "place agent stopping";
pub const LINK_CLOSE_UPDATING: &str = "place agent restarting on the daemon the host sent";
pub const LINK_CLOSE_ATTEMPT_OVER: &str = "place link ending its attempt";
pub const LINK_CLOSE_QUIET: &str = "the host went quiet";

pub fn unknown_op(op: &str) -> String {
    format!("unknown op: {op}")
}

/// What a folder listing outside every root it browses is refused with, naming the roots it does browse.
pub fn folders_outside(dir: impl std::fmt::Display, roots: impl std::fmt::Display) -> String {
    format!("{dir} is outside the folders wsp browses on that computer: {roots}")
}

pub fn port_scope_refusal(port: impl std::fmt::Display) -> String {
    format!("this socket is scoped to port {port}: only tunnel ops on it and ping are allowed")
}

pub fn not_on_this_kind(kind: &str) -> String {
    format!("{NOT_ON_THIS_KIND}: this daemon serves a {kind} machine, which reads neither its own load nor its own processes")
}

pub fn host_key_refusal(url: &str) -> String {
    format!("the host at {url} did not prove the key this computer learned at join; nothing was sent to it")
}

pub fn listening_line(host: &str, port: impl std::fmt::Display) -> String {
    format!("wsp-daemon listening on {host}:{port}")
}

pub fn ready_line(ms: u128) -> String {
    format!("ready in {ms} ms")
}

pub fn oom_not_set(reason: &str) -> String {
    format!("oom_score_adj not set: {reason}")
}

pub fn priority_not_set(reason: &str) -> String {
    format!("priority not set: {reason}")
}

pub fn link_could_not_dial(url: &str, reason: &str) -> String {
    format!("{url} could not be dialled: {reason}")
}

pub fn link_no_answer_in(url: &str, seconds: impl std::fmt::Display) -> String {
    format!("{url} did not answer in {seconds}s")
}

pub fn link_not_a_frame(url: &str) -> String {
    format!("{url} sent something that is not a frame")
}

pub fn link_refused(url: &str, line: &str) -> String {
    format!("{url}: {line}")
}

pub fn link_unreadable_auth_reply(url: &str, reason: &str) -> String {
    format!("{url} answered place.auth with something this computer cannot read: {reason}")
}

pub fn link_no_answer_to_dial(url: &str) -> String {
    format!("{url} did not answer the dial")
}

/// What an address that answered something the handshake's order does not allow is passed over with. The id a
/// frame carries says nothing about who sent it, so the order is the only thing a place holds a host to before the
/// key is proved.
pub fn link_out_of_order(url: &str) -> String {
    format!("{url} answered out of order; nothing was sent to it and the next address is tried")
}

/// What a host that answered the handshake with no key agreement of its own is passed over with: it runs a wsp
/// older than this one, and a link neither end can seal is one this computer does not hold.
pub fn link_host_unsealed(url: &str) -> String {
    format!("the host at {url} agreed no key for this link; it runs an older wsp")
}

pub fn link_linked(url: &str) -> String {
    format!("linked to the host at {url}")
}

pub fn link_quiet(url: &str, seconds: impl std::fmt::Display) -> String {
    format!("the host at {url} sent nothing for {seconds}s; cutting the link and dialling again")
}

/// What an update's parts are refused with. The parts of one upload arrive in order on one socket, so a part that
/// is not the one waited for, a repeat or a skip alike, is an upload that starts again rather than a file with a
/// hole in it or the same bytes twice.
pub fn update_out_of_order(seq: u64, wanted: u64, upload_id: &str) -> String {
    format!("part {seq} of {upload_id} arrived where part {wanted} was waited for; the update is dropped and starts again")
}

/// What a binary whose bytes are not the ones the host named is refused with. Read before anything is moved over
/// the binary the unit starts: one that landed short would be started again and again under Restart=always.
pub fn update_bytes_differ(upload_id: &str, wanted: &str, landed: &str) -> String {
    format!("the update {upload_id} landed as sha256 {landed}, and the host named {wanted}; nothing was moved")
}

/// What the log says once the new binary stands where the unit starts it.
pub fn update_landed(at: &str) -> String {
    format!("the daemon the host sent is at {at}; this one is ending so its supervisor starts the new one")
}

/// What the agent says when it starts and finds parts of an update nothing will name again.
pub fn update_swept(parts: usize) -> String {
    format!("swept {parts} leftover update part(s) from a link that dropped mid-upload")
}

/// What a bring back on the branch the work started from is refused with: wsp makes no branch and pushes no base,
/// so the commits move to a branch of their own first.
pub fn on_base_refusal(base: &str) -> String {
    format!("this workspace is on {base}, the branch it started from; move the commits onto a branch of their own and bring back again")
}

/// What a bring back in a checkout that is on no branch at all is refused with.
pub const NOT_ON_A_BRANCH: &str = "this workspace is not on a branch, so there is nothing to bring back yet";

/// What a bring back of a branch the base already holds every commit of is refused with.
pub fn nothing_ahead(branch: &str, base: &str) -> String {
    format!("{branch} has no commits that {base} lacks, so there is nothing to bring back")
}

/// What a commit or a discard is refused with while another git in the same copy holds its index, after waiting once.
pub const COPY_BUSY: &str = "the copy is busy: its agent's git holds the index; try again in a moment";

/// What a commit is refused with where git knows no author: wsp sets no identity anywhere, so the fix is the copy's.
pub fn no_git_identity(name: &str) -> String {
    format!("no git identity in {name}: run `git config --global user.name` and `user.email` in it")
}

/// What a discard or a commit naming a file git sees no change in is refused with.
pub fn no_change(path: &str) -> String {
    format!("{path} has no change")
}

/// What a pane's save of more than the write cap is refused with.
pub fn too_large_to_write(cap: u64) -> String {
    format!("that is more than {} MB, the most a pane saves", cap / (1024 * 1024))
}

/// What a commit naming no file is refused with.
pub const NOTHING_TO_COMMIT: &str = "nothing to commit: no file was named";

/// What a commit git refused is refused with: git's own last line, which is a hook's when a hook said no.
pub fn commit_refused(said: &str) -> String {
    format!("the commit was refused: {said}")
}

/// What a bring back in a checkout with nowhere to push is refused with.
pub const NO_REMOTE: &str = "this project has no remote to push to";

/// What a pull request is answered with where the git host's own command line is not on this computer: the push
/// stands, so a client reads this beside it as a note rather than as the bring back having failed.
pub fn no_host_cli(host: &str) -> String {
    format!("no signed-in command line for {host} is on this computer; the branch is pushed and the pull request waits for one")
}

/// What an update's fetch git refused for want of an https credential is refused with: nothing was fetched and the
/// branch is as it was, and the fix is the host module's to name, as for a push.
pub fn no_fetch_credential(host: &str, fix: Option<&str>) -> String {
    let said = match fix {
        Some(fix) => format!("; {fix}, then update again"),
        None => String::new(),
    };
    format!("this computer has no git credential for {host}, so nothing was fetched{said}")
}

/// What an update is refused with while the checkout holds changes no commit has: a merge over them could lose them,
/// so the files are named and nothing is fetched.
pub fn update_dirty(files: &[String]) -> String {
    const NAMED: usize = 5;
    let shown = files.iter().take(NAMED).map(String::as_str).collect::<Vec<_>>().join(", ");
    let more = if files.len() > NAMED { format!(" and {} more", files.len() - NAMED) } else { String::new() };
    format!("commit or discard the changes in {shown}{more} before updating")
}

/// What an update git refused for any other reason is refused with: git's own last line.
pub fn update_refused(said: &str) -> String {
    format!("the update was refused: {said}")
}

/// What a merge the git host's command line refused is refused with: its own last line, which names branch
/// protection, a head that moved, or a repository that merges nothing by itself.
pub fn merge_refused(said: &str) -> String {
    format!("the merge was refused: {said}")
}

/// What a push git refused for want of an https credential is refused with: nothing reached the remote, so this is
/// the bring back's own refusal and not a note beside a landed push. The fix is the git host's own module to name,
/// since only it knows which command signs its command line in; a host wsp knows no module for gets the sentence
/// with no fix in it rather than a command that would do nothing there.
pub fn no_git_credential(host: &str, fix: Option<&str>) -> String {
    let said = match fix {
        Some(fix) => format!("; {fix}, then bring back again"),
        None => String::new(),
    };
    format!("this computer has no git credential for {host}, so nothing was pushed{said}")
}

/// What an ssh.start is refused with on a machine whose image carries no OpenSSH server: an editor reaches a
/// workspace through one, and nothing of wsp's stands in for it.
pub const NO_SSHD: &str = "this workspace's image has no ssh server (/usr/sbin/sshd), so an editor cannot open it; seal a new image, which installs openssh-server";

/// What an ssh.start naming no workspace is refused with on a daemon that answers for the workspaces on a computer
/// somebody owns: it runs as that computer's root, and starts no ssh server there for anybody's editor.
pub const SSH_NOT_ON_A_PLACE: &str = "this daemon starts an ssh server inside a workspace on this computer, never on the computer itself; name the workspace the editor is for";

/// What an ssh.start is refused with where the key is not one ed25519 public key line.
pub const SSH_KEY_SHAPE: &str = "the key is not one ssh-ed25519 public key line";
