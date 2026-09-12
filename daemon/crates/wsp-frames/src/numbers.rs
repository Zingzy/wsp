// SPDX-License-Identifier: AGPL-3.0-only
//! The numbers and paths the protocol and the node daemon own, as the contract fixture pins them.

/// The daemon's protocol version, carried in its hello: the length of the protocol's DAEMON_CONTENTS record.
pub const DAEMON_VERSION: u32 = 19;

pub const DEFAULT_HOST: &str = "0.0.0.0";
pub const DEFAULT_PORT: u16 = 7070;
pub const DEFAULT_TOKEN_PATH: &str = "/root/.wsp-daemon-token";
pub const DEFAULT_INBOX_DIR: &str = "/root/inbox";
pub const DEFAULT_MANIFEST_PATH: &str = "/root/.wsp/manifest.json";
pub const DEFAULT_RUN_DIR: &str = "/root/.wsp/run";
pub const DEFAULT_LOG_DIR: &str = "/root/.wsp/logs";
pub const GUEST_DAEMON_DIR: &str = "/root/wsp-daemon";
pub const DAEMON_ROOTS_PATH: &str = "/root/.wsp/roots";
pub const OPEN_SHIM_PATH: &str = "/usr/local/bin/wsp-open";
pub const XDG_OPEN_PATH: &str = "/usr/local/bin/xdg-open";
pub const OPEN_SOCKET_PATH: &str = "/root/.wsp/open.sock";

/// Wire bytes a peer may send before its auth frame passes; an auth frame is under 200.
pub const PRE_AUTH_MAX_BYTES: u64 = 4096;
/// How long a fresh socket has to send its auth frame.
pub const AUTH_DEADLINE_MS: u64 = 5000;
/// Laptop connections one socket may hold open through the forward at once.
pub const TUNNEL_CAP: usize = 64;

pub const EXEC_BODY_MAX: usize = 16 * 1024;
pub const EXEC_OUTPUT_MAX: usize = 2 * 1024 * 1024;
pub const EXEC_TIMEOUT_DEFAULT_MS: u32 = 20_000;
pub const EXEC_TIMEOUT_MAX_MS: u32 = 600_000;
pub const EXEC_DEADLINE_EXIT: i32 = 124;

pub const FS_READ_CAP_BYTES: u64 = 2 * 1024 * 1024;
pub const FS_LIST_CAP_ENTRIES: usize = 10_000;
pub const GIT_DIFF_CAP_BYTES: usize = 2 * 1024 * 1024;
pub const SCROLLBACK_CAP_BYTES: usize = 256 * 1024;
/// How much of /proc/<pid>/cmdline a process row carries.
pub const CMDLINE_BYTES: usize = 200;
/// How much of the holder's cmdline a port row carries; a cut argv ends with an ellipsis.
pub const PORT_CMDLINE_CAP_BYTES: usize = 512;
pub const PROC_CAP: usize = 1000;
/// Linux pid_max ceiling; both proc ops refuse anything above it.
pub const PID_MAX: u32 = 4_194_304;
/// The most one POST /open body may carry.
pub const OPEN_BODY_CAP: usize = 8 * 1024;
pub const OPEN_URL_MAX: usize = 8192;

pub const PLACE_LINK_NONCE_BYTES: usize = 32;

/// The daemon is last for the kernel's memory killer and ahead of every default-priority process.
pub const DAEMON_OOM_SCORE_ADJ: i32 = -999;
pub const DAEMON_NICE: i32 = -10;
/// Work is taken first: every shell the daemon opens starts at this score.
pub const WORK_OOM_SCORE_ADJ: i32 = 500;

/// The sh line that puts a shell, and everything it starts, at the work scores.
pub fn work_score_line() -> String {
    format!("{{ echo {WORK_OOM_SCORE_ADJ} > /proc/self/oom_score_adj; }} 2>/dev/null; renice 0 $$ >/dev/null 2>&1")
}
