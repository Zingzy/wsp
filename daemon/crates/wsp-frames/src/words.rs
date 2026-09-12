// SPDX-License-Identifier: AGPL-3.0-only
//! Every sentence the daemon emits that a client or a test matches on, spelled once.

/// The four reasons a socket is closed 4401 before it is served.
pub const AUTH_TOKEN_REFUSED: &str = "daemon token refused; the host holds the current one";
pub const AUTH_FIRST_FRAME: &str = "the first frame must be auth";
pub const AUTH_TOO_MANY_BYTES: &str = "too many bytes before the auth frame";
pub const AUTH_NO_FRAME_IN_TIME: &str = "no auth frame arrived in time";
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

pub const PLACE_LEAVE_ROAD_REFUSAL: &str =
    "place.leave is answered only on the link this computer opened to its host; run wsp leave here to take this computer out of a wsp";
/// Not in the shared set until the branch that adds the machine ops to the protocol lands.
pub const NOT_ON_THIS_ROAD: &str = "not on this road";
pub const NOT_ON_THIS_KIND: &str = "not on this kind";
/// The link's fallback when a refusal frame carries no error; the host's own sentence rides it otherwise.
pub const HOST_REFUSED_PLACE: &str = "the host refused this place";
pub const NO_PLACE_FILE: &str =
    "no place file here, so there is no host to dial; wsp join <address> --code <code> makes this computer a place";

/// The close reasons the link puts on a socket it ends. Not in the shared set: no client matches on a close reason.
pub const LINK_CLOSE_STOPPING: &str = "place agent stopping";
pub const LINK_CLOSE_ATTEMPT_OVER: &str = "place link ending its attempt";
pub const LINK_CLOSE_QUIET: &str = "the host went quiet";

pub fn unknown_op(op: &str) -> String {
    format!("unknown op: {op}")
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

pub fn link_linked(url: &str) -> String {
    format!("linked to the host at {url}")
}

pub fn link_quiet(url: &str, seconds: impl std::fmt::Display) -> String {
    format!("the host at {url} sent nothing for {seconds}s; cutting the link and dialling again")
}
