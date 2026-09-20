// SPDX-License-Identifier: AGPL-3.0-only
// What the daemon and every client of it read alike and neither may spell for
// itself: the sentences a pane or a test matches on, the caps a client sees
// hit, and the paths a deploy and a daemon both name. One home, so the daemon
// that runs on a machine and the schemas here cannot drift, and so a second
// daemon speaking this wire is held to the same words. The contract fixture
// set under daemon/fixtures/contract is regenerated from these exports and
// checked against them by the protocol's daemon-contract test.

/** Where the daemon binds by default: every interface, since the previewUrl edge dials the guest's eth0 and
 * loopback answers 502. A local run names loopback with --host so the firewall stays quiet. */
export const DAEMON_DEFAULT_HOST = "0.0.0.0";
export const DAEMON_DEFAULT_PORT = 7070;
/** Where the daemon inside a machine keeps everything of its own: its token, its inbox, its manifest, its open
 * socket, its run and log folders and its roots file, every one of them under this folder. A workspace on a
 * computer somebody joined has this folder of its own bound over the computer's, so two workspaces there never
 * read or write each other's token and the computer's own daemon folder is not readable from inside at all. The
 * names are the ones a daemon on a computer somebody joined uses under that computer's home, which
 * placeDaemonPaths lays out and the contract test holds these to. */
export const GUEST_WSP_HOME = "/root/.wsp";
/** The one file the daemon reads its token from, at every auth frame; a guest is root's, so it sits under root's
 * own wsp folder, where a workspace's is its own and not the computer's. */
export const DAEMON_TOKEN_PATH = `${GUEST_WSP_HOME}/daemon-token`;
export const GUEST_INBOX_DIR = `${GUEST_WSP_HOME}/inbox`;
export const GUEST_MANIFEST_PATH = `${GUEST_WSP_HOME}/manifest.json`;
/** BROWSER value and xdg-open target on the guest. A bare path: tools append the URL as the one argument, and
 * the harness treats the literal "true" as its never-open sentinel. */
export const OPEN_SHIM_PATH = "/usr/local/bin/wsp-open";
export const XDG_OPEN_PATH = "/usr/local/bin/xdg-open";
/** Where the shim posts in the guest; root-only through the daemon's umask, unreachable from the edge. */
export const OPEN_SOCKET_PATH = `${GUEST_WSP_HOME}/open.sock`;
/** The socket a process inside a workspace on a computer somebody owns reaches its host over. The daemon of that
 * computer binds one per workspace in that workspace's own wsp folder, which is bound over the folder above
 * inside it, so the file is in that workspace's view and in no other's and nowhere on the computer's own. The file
 * itself is the gate and no token rides this road; a fork has no such socket and dials the port instead. */
export const GUEST_DAEMON_SOCKET_PATH = `${GUEST_WSP_HOME}/daemon.sock`;
/** The whole of the wsp a machine carries at GUEST_WSP_PATH: two lines handing the line to the binary named, which
 * opens a session on the daemon that serves this machine. The fork's deploy writes it onto the binary its bundle
 * left, and the workspace runtime writes it into a workspace's own upper onto the init already bound inside; one
 * text, so the word means the same thing on both roads. */
export const guestWspShim = (binary: string): string => `#!/bin/sh\nexec ${binary} wsp "$@"\n`;

/** The computer's own system directories a workspace on a computer somebody owns reads through an overlay of its
 * own: its /usr is the box's /usr, and what it writes there the box does not have. A directory outside these and
 * outside /root is in no workspace of that computer unless a shared tool root below brings it in. */
export const WORKSPACE_OVERLAID = ["/usr", "/etc", "/opt", "/var", "/srv"] as const;
/** Where Homebrew on Linux keeps its own user's home, and the prefix under it every formula is installed into. */
export const HOMEBREW_HOME = "/home/linuxbrew";
export const HOMEBREW_PREFIX = `${HOMEBREW_HOME}/.linuxbrew`;
/** Every install root a road writes outside the overlaid trees and outside /root, bound read-only into a workspace
 * on a computer somebody owns where that computer has it: a root left off this list is on the box and out of every
 * workspace's sight while the PATH inside names it. The catalogue's own test holds every road to it. */
export const SHARED_TOOL_ROOTS = [HOMEBREW_HOME] as const;
/** Where pnpm puts what it installs globally on a machine; on the PATH below and in the login line the image writes. */
export const PNPM_HOME = "/root/.local/share/pnpm";
/** The one PATH the tools on a machine sit on, in one order: the login shell of a sealed image reads it from the
 * profile the image writes, every thread and exec carries it, and a workspace on a computer somebody owns boots
 * with it, so the boot's own children and a person's thread find the same gcc and the same gh. */
export const TOOLS_PATH = `/root/.local/bin:/usr/local/sbin:/usr/local/bin:${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin:/root/go/bin:/root/.cargo/bin:${PNPM_HOME}:/root/.bun/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** Wire bytes a peer may send before its auth frame passes; an auth frame is under 200. */
export const PRE_AUTH_MAX_BYTES = 4096;
/** How long a fresh socket has to send its auth frame. */
export const AUTH_DEADLINE_MS = 5_000;
/** Laptop connections one socket may hold open through the forward at once. */
export const TUNNEL_CAP = 64;
/** How much of one file fs.read carries; the whole size travels beside it. */
export const FS_READ_CAP_BYTES = 2 * 1024 * 1024;
/** Entries one fs.list carries; total counts the rest. */
export const FS_LIST_CAP_ENTRIES = 10_000;
/** Bytes of patch one git.diff carries across its files, cut at a line. */
export const GIT_DIFF_CAP_BYTES = 2 * 1024 * 1024;
/** Bytes of a pty's output kept for the next client to attach. */
export const PTY_SCROLLBACK_CAP_BYTES = 256 * 1024;
/** The first bytes of a process's command line in a snapshot row, whichever module read it: the whole of one can
 * run to ARG_MAX and every row carries it. */
export const PROC_CMDLINE_BYTES = 200;
/** The first bytes of a listening port holder's command line, on the wire in every close; a cut argv ends with an ellipsis. */
export const PORT_COMMAND_BYTES = 512;
/** Rows one proc.snapshot carries at most; total counts what the machine had. */
export const PROC_CAP = 1000;
/** Linux pid_max ceiling: above it proc.inspect and proc.kill refuse alike as bad-request. */
export const PID_MAX = 4_194_304;

/** One guest message's JSON: a thread's whole transcript is the largest thing that rides the guest road. */
export const GUEST_MESSAGE_CAP_BYTES = 4 * 1024 * 1024;
/** Frames one guest session may hold while no watcher is attached: its guest's messages and its close, since the
 * frame it opened with rides a field of its own and is named to every watcher that arrives. Past the cap the
 * session is closed to the guest. */
export const GUEST_QUEUE_CAP_FRAMES = 256;
/** How long a guest session stands with nobody watching it. Every watcher that arrives is told the sessions the
 * machine holds, so a host that restarted picks them back up; past this span nobody is coming and the session ends
 * to its guest, rather than leaving the process inside the machine waiting for the life of the workspace. */
export const GUEST_UNWATCHED_MS = 10 * 60 * 1_000;
/** The four sentences a socket is closed 4401 with before its auth frame passes. */
export const DAEMON_TOKEN_REFUSED = "daemon token refused; the host holds the current one";
export const DAEMON_FIRST_FRAME_NOT_AUTH = "the first frame must be auth";
export const DAEMON_PRE_AUTH_BYTES_EXCEEDED = "too many bytes before the auth frame";
export const DAEMON_AUTH_DEADLINE_PASSED = "no auth frame arrived in time";
/** What a socket already through the door is cut with once the token it authed with is no longer the file's: a
 * rotation takes the sockets the old token opened with it, rather than leaving them answering for the life of the
 * connection. Under the same close code the four above travel with. */
export const DAEMON_TOKEN_ROTATED = "the daemon token was rotated; dial again with the current one";
/** The reply to a frame that is not JSON, with a null id since none could be read. */
export const DAEMON_INVALID_JSON = "invalid json";
/** Why a daemon started with an empty token file refuses to start at all. */
export const DAEMON_NO_TOKEN = "daemon refuses to start without an auth token";
export const unknownOpLine = (op: string): string => `unknown op: ${op}`;
/** The refusal every op but tunnel ops on the scoped port and ping gets on a socket whose auth frame named a port. */
export const portScopeRefusal = (port: number | string): string => `this socket is scoped to port ${port}: only tunnel ops on it and ping are allowed`;
/** The one line the daemon prints on stdout once it is bound; whoever started it reads the port off this. */
export const daemonListeningLine = (host: string, port: number | string): string => `wsp-daemon listening on ${host}:${port}`;

/** How often a daemon samples the machine it runs on for sys.watch and proc.watch, and so how long after the reply
 * to a watch its first sample lands. The node daemon's two samplers default to it, and the Rust daemon's own
 * SAMPLER_INTERVAL_MS is held equal to it by the contract fixture set. A client waiting on a first reading waits
 * two of these, since a box under load slips a tick and one interval would be a race with the daemon on every
 * reading. */
export const DAEMON_SAMPLER_INTERVAL_MS = 2_000;

/** The sampler lines the daemon logs: one sampler serves every watcher, starts with the first and stops with the
 * last, and these two pairs are how a test reads that without a counter inside the daemon. */
export const SYS_SAMPLER_STARTED = "sys sampler started";
export const SYS_SAMPLER_STOPPED = "sys sampler stopped";
export const PROC_SAMPLER_STARTED = "proc sampler started";
export const PROC_SAMPLER_STOPPED = "proc sampler stopped";

/** What the link a place holds to its host logs, one line per turn of its state. */
export const NO_PLACE_FILE_LINE = "no place file here, so there is no host to dial; wsp join <address> --code <code> makes this computer a place";
export const linkedLine = (url: string): string => `linked to the host at ${url}`;
export const hostQuietLine = (url: string, seconds: number | string): string => `the host at ${url} sent nothing for ${seconds}s; cutting the link and dialling again`;
export const dialUnansweredLine = (url: string): string => `${url} did not answer the dial`;
export const dialTimedOutLine = (url: string, seconds: number | string): string => `${url} did not answer in ${seconds}s`;
export const dialFailedLine = (url: string, error: string): string => `${url} could not be dialled: ${error}`;
export const notAFrameLine = (url: string): string => `${url} sent something that is not a frame`;
export const authUnreadableLine = (url: string, error: string): string => `${url} answered place.auth with something this computer cannot read: ${error}`;
export const hostRefusedLine = (url: string, refusal: string): string => `${url}: ${refusal}`;
/** What a host that answered the handshake with no key agreement of its own is passed over with: it runs a wsp
 * older than this one, and a link neither end can seal is one this computer does not hold. */
export const linkHostUnsealedLine = (url: string): string => `the host at ${url} agreed no key for this link; it runs an older wsp`;
/** What an address that answered something the handshake's order does not allow is passed over with: the id a frame
 * carries says nothing about who sent it, so the order is the only thing a place holds a host to before the key. */
export const linkOutOfOrderLine = (url: string): string => `${url} answered out of order; nothing was sent to it and the next address is tried`;

/** What a socket that never asked to watch guest sessions is told when it answers or ends one. */
export const GUEST_NOT_WATCHER = "only the socket that sent guest.watch may answer or close a guest session";
/** Why a session with nobody reading it is ended: the host has been away past the queue's cap. */
export const GUEST_QUEUE_FULL = "the host has not read this session for too long";
/** Why a session is ended once nobody has watched it for a whole span: the guest prints this and exits, so the
 * agent that ran the line can run it again against a host that is there. */
export const GUEST_UNWATCHED = "the host stopped watching; run it again";
/** What a guest process prints when nothing answers on its own machine's daemon port. */
export const guestNoDaemonLine = (port: number | string): string => `this machine's wsp daemon is not answering on 127.0.0.1:${port}`;

/** What a bring back on the branch the work started from is refused with: wsp makes no branch and pushes no base,
 * so the commits move onto a branch of their own first. */
export const onBaseRefusal = (base: string): string =>
  `this workspace is on ${base}, the branch it started from; move the commits onto a branch of their own and bring back again`;
/** What a bring back in a checkout that is on no branch at all is refused with. */
export const NOT_ON_A_BRANCH = "this workspace is not on a branch, so there is nothing to bring back yet";
/** What a bring back of a branch the base already holds every commit of is refused with. */
export const nothingAheadLine = (branch: string, base: string): string => `${branch} has no commits that ${base} lacks, so there is nothing to bring back`;
/** What a bring back in a checkout with nowhere to push is refused with. */
export const NO_REMOTE = "this project has no remote to push to";
/** What the pull request is answered with where the git host's own command line is not on the machine: the push
 * stands, so the bring back carries this beside it as a note rather than failing. */
export const noHostCliLine = (host: string): string => `no signed-in command line for ${host} is on this computer; the branch is pushed and the pull request waits for one`;
/** What a push git refused for want of an https credential is refused with: nothing reached the remote, so this is
 * the bring back's own refusal and not a note beside a landed push. The fix is the git host's own to name, since
 * only that host's module knows which command signs its command line in, and a host wsp knows no module for gets
 * the sentence with no fix in it rather than a command that would do nothing there. */
export const noGitCredentialLine = (host: string, fix?: string): string =>
  `this computer has no git credential for ${host}, so nothing was pushed${fix === undefined ? "" : `; ${fix}, then bring back again`}`;
