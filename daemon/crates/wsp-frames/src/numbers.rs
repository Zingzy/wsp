// SPDX-License-Identifier: AGPL-3.0-only
//! The numbers and paths the protocol and the node daemon own, as the contract fixture pins them.

/// The daemon's protocol version, carried in its hello: the length of the protocol's DAEMON_CONTENTS record.
pub const DAEMON_VERSION: u32 = 53;

pub const DEFAULT_HOST: &str = "0.0.0.0";
pub const DEFAULT_PORT: u16 = 7070;
/// Where the daemon inside a machine keeps everything of its own: its token, its inbox, its manifest, its open
/// socket, its run and log folders and its roots file, every one of them under this folder by default. A
/// workspace on a computer somebody joined has this folder of its own bound over the computer's, so two
/// workspaces there never read or write each other's token and the computer's own daemon folder is not readable
/// from inside at all. The shape is `place_daemon_paths("/root")`'s, which the test below holds it to: one
/// daemon, one rule for where it puts its own files under the home it was given.
pub const GUEST_WSP_HOME: &str = "/root/.wsp";
pub const DEFAULT_TOKEN_PATH: &str = "/root/.wsp/daemon-token";
pub const DEFAULT_INBOX_DIR: &str = "/root/.wsp/inbox";
pub const DEFAULT_MANIFEST_PATH: &str = "/root/.wsp/manifest.json";
pub const DEFAULT_RUN_DIR: &str = "/root/.wsp/run";
pub const DEFAULT_LOG_DIR: &str = "/root/.wsp/logs";
pub const GUEST_DAEMON_DIR: &str = "/root/wsp-daemon";
/// The wsp a process inside a machine runs: two lines the host's deploy writes onto the machine's PATH, handing
/// the whole line to the daemon binary beside them. Here so the two halves of the contract cannot spell it apart.
/// The binary's own path is not pinned: it sits in the bundle under one folder per chip.
pub const GUEST_WSP_PATH: &str = "/usr/local/bin/wsp";
pub const DAEMON_ROOTS_PATH: &str = "/root/.wsp/roots";
pub const OPEN_SHIM_PATH: &str = "/usr/local/bin/wsp-open";
pub const XDG_OPEN_PATH: &str = "/usr/local/bin/xdg-open";
pub const OPEN_SOCKET_PATH: &str = "/root/.wsp/open.sock";

/// The computer's own system directories a workspace on a computer somebody owns reads through an overlay of its
/// own: its /usr is the box's /usr, and what it writes there the box does not have. A directory outside these and
/// outside /root is in no workspace of that computer unless a shared tool root below brings it in. The bundle
/// mounts these and the doctor reads them, both off this one list.
pub const OVERLAID: [&str; 5] = ["/usr", "/etc", "/opt", "/var", "/srv"];
/// Where Homebrew on Linux keeps its own user's home, and the prefix under it every formula is installed into.
pub const HOMEBREW_HOME: &str = "/home/linuxbrew";
pub const HOMEBREW_PREFIX: &str = "/home/linuxbrew/.linuxbrew";
/// Every install root a road writes outside the overlaid trees and outside /root, bound read-only into a workspace
/// where the computer has it: a root left off this list is on the computer and out of every workspace's sight while
/// the PATH inside names it.
pub const SHARED_TOOL_ROOTS: [&str; 1] = [HOMEBREW_HOME];
/// The one PATH the tools on a machine sit on, in one order: a sealed image's login shell reads it from the profile
/// the image writes, every thread and exec carries it, and a workspace on a computer somebody owns boots with it,
/// so the boot's own children and a person's thread find the same gcc and the same gh.
pub const TOOLS_PATH: &str = "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/root/go/bin:/root/.cargo/bin:/root/.local/share/pnpm:/root/.bun/bin:/usr/sbin:/usr/bin:/sbin:/bin";

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
/// How often a daemon samples the computer it runs on for sys.watch and proc.watch, and so how long after the reply
/// to a watch its first sample lands. The protocol's DAEMON_SAMPLER_INTERVAL_MS is the same figure, held so by the
/// contract fixture.
pub const SAMPLER_INTERVAL_MS: u64 = 2000;
/// One tick of the stat files under /proc in milliseconds: the kernel reports those fields at 100 Hz whatever its
/// own timer runs at, so a start time or a cpu count read there is turned into time with this.
pub const STAT_TICK_MS: u64 = 10;
/// The most one POST /open body may carry.
pub const OPEN_BODY_CAP: usize = 8 * 1024;
pub const OPEN_URL_MAX: usize = 8192;

/// One guest message's JSON: a thread's whole transcript is the largest thing that rides this road.
pub const GUEST_MESSAGE_CAP_BYTES: usize = 4 * 1024 * 1024;
/// Frames one guest session may hold while no watcher is attached: its guest's messages and its close, since the
/// frame it opened with rides a field of its own and is named to every watcher that arrives. Past the cap the
/// session is closed to the guest.
pub const GUEST_QUEUE_CAP_FRAMES: usize = 256;
/// How long a guest session stands with nobody watching it. Every watcher that arrives is told the sessions this
/// machine holds, so a host that restarted picks them back up; past this span nobody is coming, and the session
/// ends to its guest rather than leaving the process inside the machine waiting for the life of the workspace.
pub const GUEST_UNWATCHED_MS: u64 = 10 * 60 * 1000;
/// The thread token and the turn token a guest session opens with; the daemon never reads either.
pub const GUEST_TOKEN_MAX: usize = 512;
/// Words in one guest command line, and the length of the folder it runs in.
pub const GUEST_ARGV_MAX: usize = 256;
pub const GUEST_CWD_MAX: usize = 4096;

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every file the daemon inside a machine writes for itself sits under one folder, and that folder is the
    /// workspace's own on a computer somebody joined. A path that slipped out of it would be written into a
    /// `/root` every workspace on that computer shares, where the second workspace's deploy would rewrite the
    /// first one's token.
    #[test]
    fn every_path_the_daemon_writes_for_itself_is_under_the_one_folder() {
        for path in [
            DEFAULT_TOKEN_PATH,
            DEFAULT_INBOX_DIR,
            DEFAULT_MANIFEST_PATH,
            DEFAULT_RUN_DIR,
            DEFAULT_LOG_DIR,
            DAEMON_ROOTS_PATH,
            OPEN_SOCKET_PATH,
        ] {
            assert!(path.starts_with(&format!("{GUEST_WSP_HOME}/")), "{path} is not under {GUEST_WSP_HOME}");
        }
        // And they are the names a daemon on a computer somebody joined uses under that computer's home: one
        // daemon, one rule, whether the machine is a fork or a computer of the person's own.
        let at = crate::place_daemon_paths(std::path::Path::new("/root"));
        assert_eq!(at.wsp, std::path::PathBuf::from(GUEST_WSP_HOME));
        assert_eq!(at.token_path, std::path::PathBuf::from(DEFAULT_TOKEN_PATH));
        assert_eq!(at.inbox, std::path::PathBuf::from(DEFAULT_INBOX_DIR));
        assert_eq!(at.manifest_path, std::path::PathBuf::from(DEFAULT_MANIFEST_PATH));
        assert_eq!(at.open_socket, std::path::PathBuf::from(OPEN_SOCKET_PATH));
        assert_eq!(at.run_dir, std::path::PathBuf::from(DEFAULT_RUN_DIR));
        assert_eq!(at.roots_path, std::path::PathBuf::from(DAEMON_ROOTS_PATH));
        // The binary the host deploys is not one of them: it is the host's to land and lives beside the folder.
        assert!(!GUEST_DAEMON_DIR.starts_with(GUEST_WSP_HOME));
    }
}
