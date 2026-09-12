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
/** The one file the daemon reads its token from, at every auth frame; a guest is root's, so it sits in /root. */
export const DAEMON_TOKEN_PATH = "/root/.wsp-daemon-token";
export const GUEST_INBOX_DIR = "/root/inbox";
export const GUEST_MANIFEST_PATH = "/root/.wsp/manifest.json";
/** BROWSER value and xdg-open target on the guest. A bare path: tools append the URL as the one argument, and
 * the harness treats the literal "true" as its never-open sentinel. */
export const OPEN_SHIM_PATH = "/usr/local/bin/wsp-open";
export const XDG_OPEN_PATH = "/usr/local/bin/xdg-open";
/** Where the shim posts in the guest; root-only through the daemon's umask, unreachable from the edge. */
export const OPEN_SOCKET_PATH = "/root/.wsp/open.sock";

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

/** The four sentences a socket is closed 4401 with before its auth frame passes. */
export const DAEMON_TOKEN_REFUSED = "daemon token refused; the host holds the current one";
export const DAEMON_FIRST_FRAME_NOT_AUTH = "the first frame must be auth";
export const DAEMON_PRE_AUTH_BYTES_EXCEEDED = "too many bytes before the auth frame";
export const DAEMON_AUTH_DEADLINE_PASSED = "no auth frame arrived in time";
/** The reply to a frame that is not JSON, with a null id since none could be read. */
export const DAEMON_INVALID_JSON = "invalid json";
/** Why a daemon started with an empty token file refuses to start at all. */
export const DAEMON_NO_TOKEN = "daemon refuses to start without an auth token";
export const unknownOpLine = (op: string): string => `unknown op: ${op}`;
/** The refusal every op but tunnel ops on the scoped port and ping gets on a socket whose auth frame named a port. */
export const portScopeRefusal = (port: number | string): string => `this socket is scoped to port ${port}: only tunnel ops on it and ping are allowed`;
/** The one line the daemon prints on stdout once it is bound; whoever started it reads the port off this. */
export const daemonListeningLine = (host: string, port: number | string): string => `wsp-daemon listening on ${host}:${port}`;

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
