// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import type { FsListReply as WireFsListReply } from "../generated/FsListReply.js";
import type { FsFilesReply as WireFsFilesReply } from "../generated/FsFilesReply.js";
import type { GitPrListReply as WireGitPrListReply } from "../generated/GitPrListReply.js";
import type { GitCheckpointReply as WireGitCheckpointReply } from "../generated/GitCheckpointReply.js";
import type { GitRestoreReply as WireGitRestoreReply } from "../generated/GitRestoreReply.js";
import type { FsSearchReply as WireFsSearchReply } from "../generated/FsSearchReply.js";
import type { GitCommitReply as WireGitCommitReply } from "../generated/GitCommitReply.js";
import type { GitDiscardReply as WireGitDiscardReply } from "../generated/GitDiscardReply.js";
import type { GitDiffFile as WireGitDiffFile } from "../generated/GitDiffFile.js";
import type { FsWriteReply as WireFsWriteReply } from "../generated/FsWriteReply.js";
import type { PullRequest as WirePullRequest } from "../generated/PullRequest.js";
import type { GitPrReadReply as WireGitPrReadReply } from "../generated/GitPrReadReply.js";
import type { GitIssueReadReply as WireGitIssueReadReply } from "../generated/GitIssueReadReply.js";
import type { GitPrCheckoutReply as WireGitPrCheckoutReply } from "../generated/GitPrCheckoutReply.js";
import type { GitPrDiffReply as WireGitPrDiffReply } from "../generated/GitPrDiffReply.js";
import type { GitPrReviewReply as WireGitPrReviewReply } from "../generated/GitPrReviewReply.js";
import type { GitPrViewReply as WireGitPrViewReply } from "../generated/GitPrViewReply.js";
import type { GitPrReplyReply as WireGitPrReplyReply } from "../generated/GitPrReplyReply.js";
import type { GitPrResolveReply as WireGitPrResolveReply } from "../generated/GitPrResolveReply.js";
import type { GitPrReactReply as WireGitPrReactReply } from "../generated/GitPrReactReply.js";
import type { GitRunLogReply as WireGitRunLogReply } from "../generated/GitRunLogReply.js";
import type { GitPrMergeReply as WireGitPrMergeReply } from "../generated/GitPrMergeReply.js";
import type { GitRepoReadReply as WireGitRepoReadReply } from "../generated/GitRepoReadReply.js";
import type { GitUpdateReply as WireGitUpdateReply } from "../generated/GitUpdateReply.js";
import type { SshStartReply as WireSshStartReply } from "../generated/SshStartReply.js";
import type { GitStartOnReply as WireGitStartOnReply } from "../generated/GitStartOnReply.js";
import type { GitBranchCompareReply as WireGitBranchCompareReply } from "../generated/GitBranchCompareReply.js";
import type { GitMergeInReply as WireGitMergeInReply } from "../generated/GitMergeInReply.js";
import type { GitCheckpointDropReply as WireGitCheckpointDropReply } from "../generated/GitCheckpointDropReply.js";
import type { GitWorktreesReply as WireGitWorktreesReply } from "../generated/GitWorktreesReply.js";
import type { GitBranchesReply as WireGitBranchesReply } from "../generated/GitBranchesReply.js";
import { GitBranchCompareReply, GitMergeInReply, GitStartOnReply } from "../tree.js";
import { GitPrReadReply, GitPrViewReply, GitPrMergeReply, GitPrReactReply, GitPrReplyReply, GitPrResolveReply, GitRepoReadReply, GitRunLogReply, GitUpdateReply, MergeMethod, PullRequest, PR_REPLY_BODY_MAX, ReactionContent } from "../pull-request.js";
import { GitIssueReadReply, GitPrCheckoutReply, GitPrDiffReply, GitPrReviewReply } from "../start.js";
import { SSH_KEY_MAX } from "../daemon-contract.js";
import type { UsageStore as WireUsageStore } from "../generated/UsageStore.js";
import { type Held, reqId, type Same } from "./helpers.js";
import { EXEC_BODY_MAX, GUEST_ARGV_MAX, GUEST_CWD_MAX, GUEST_TOKEN_MAX, USAGE_STORES_MAX } from "./limits.js";

// --- daemon wire protocol (ws://0.0.0.0:7070, auth frame first, 4401 on anything else) ---

/** Client-side health of a daemon link. opening: a link that has never been open is being dialled, so nothing is
 * coming back yet and nothing may be promised back. connecting: a link that was open once is being dialled again.
 * unanswered: a link that has never been open and whose first-answer bound has passed, so what it dials is not
 * answering and the person is owed what to do instead of a wait. reauth-needed: the daemon refused the token the
 * host sent. A browser link holds no token of its own, so it opens a channel again and the host dials with the one
 * it holds now; the host's own link stops there. refused: the door answered the upgrade with a status, so no retry
 * at the usual pace opens anything; the link holds this until a dial gets past the door, and retries at the ceiling.
 * dead is terminal. The host's own link reports neither opening nor unanswered, as it reports no refusal: no person
 * reads its words. */
export const DaemonLinkStatus = z.enum(["opening", "connecting", "live", "reauth-needed", "refused", "unanswered", "dead"]);
export type DaemonLinkStatus = z.infer<typeof DaemonLinkStatus>;

/** The first frame on every daemon socket, the URL carries no token: answered {id, ok} then daemon.hello, or
 * the socket closes 4401 with one sentence of reason. Anything else first, or nothing, closes the same way.
 * A peer that sends more than a few KiB before this frame passes is closed 4401 too, so a client sends nothing
 * more until it is answered. port scopes the socket to one guest port: only tunnel ops on that port and ping are
 * answered, everything else is refused with code forbidden. */
export const DaemonAuthRequest = z.object({
  id: reqId,
  op: z.literal("auth"),
  token: z.string(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type DaemonAuthRequest = z.infer<typeof DaemonAuthRequest>;

// Replies carry no op, so each files/diff op has its own reply schema here
// instead of a discriminated union; DaemonOkResponse stays the loose envelope.

export const FsEntryType = z.enum(["file", "dir", "symlink"]);
export type FsEntryType = z.infer<typeof FsEntryType>;
/** name is the entry's own name in the listed directory; size is 0 for
 * anything but a file; mtime is epoch milliseconds. */
export const FsEntry = z.object({ name: z.string(), type: FsEntryType, size: z.number(), mtime: z.number() });
export type FsEntry = z.infer<typeof FsEntry>;
/** total counts the directory's entries after filtering; truncated means
 * entries holds only the first cap of them. */
export const FsListReply = z.object({ entries: z.array(FsEntry), truncated: z.boolean(), total: z.number() });
export type FsListReply = WireFsListReply;
type FsListReplyHeld = Held<Same<z.infer<typeof FsListReply>, FsListReply>>;

/** The checkout's files under the folder asked about, relative to it; truncated means files holds only the first
 * FS_FILES_CAP_ENTRIES of them. */
export const FsFilesReply = z.object({ files: z.array(z.string()), truncated: z.boolean() });
export type FsFilesReply = WireFsFilesReply;
type FsFilesReplyHeld = Held<Same<z.infer<typeof FsFilesReply>, FsFilesReply>>;

/** Which of a git host's two open lists an item came off. */
export const HostItemKind = z.enum(["pull-request", "issue"]);
export type HostItemKind = z.infer<typeof HostItemKind>;
/** One open pull request or issue, its body cut at GIT_PR_LIST_BODY_CAP characters. */
export const HostItem = z.object({ kind: HostItemKind, number: z.number().int(), title: z.string(), body: z.string(), url: z.string() });
export type HostItem = z.infer<typeof HostItem>;
/** The repository's open pull requests, then its open issues; empty with the note where nothing can be listed. */
export const GitPrListReply = z.object({ items: z.array(HostItem), note: z.string().optional(), noCliFor: z.string().optional() });
export type GitPrListReply = WireGitPrListReply;
type GitPrListReplyHeld = Held<Same<z.infer<typeof GitPrListReply>, GitPrListReply>>;

/** A checkpoint's ref, the commit it names, and whether its tree differs from the one that ref named before. */
export const GitCheckpointReply = z.object({ ref: z.string(), commit: z.string(), changed: z.boolean() });
export type GitCheckpointReply = WireGitCheckpointReply;
type GitCheckpointReplyHeld = Held<Same<z.infer<typeof GitCheckpointReply>, GitCheckpointReply>>;
/** The checkpoint of the tree as it stood before a restore, which restores it again, and how many files moved. */
export const GitRestoreReply = z.object({ before: z.string(), files: z.number().int() });
export type GitRestoreReply = WireGitRestoreReply;
type GitRestoreReplyHeld = Held<Same<z.infer<typeof GitRestoreReply>, GitRestoreReply>>;
/** How many of one thread's checkpoint refs a git.checkpointDrop took away. */
export const GitCheckpointDropReply = z.object({ dropped: z.number().int().nonnegative() });
export type GitCheckpointDropReply = WireGitCheckpointDropReply;
type GitCheckpointDropReplyHeld = Held<Same<z.infer<typeof GitCheckpointDropReply>, GitCheckpointDropReply>>;
/** One worktree as git lists it: where, the branch it holds (absent when detached), its commit (absent on a bare
 * repository), and whether its folder is gone while git still holds its record. */
export const GitWorktree = z.object({ path: z.string(), branch: z.string().optional(), head: z.string().optional(), prunable: z.boolean().optional() });
/** Every worktree of the repository a checkout belongs to, the repository's own folder first. */
export const GitWorktreesReply = z.object({ worktrees: z.array(GitWorktree) });
export type GitWorktreesReply = WireGitWorktreesReply;
type GitWorktreesReplyHeld = Held<Same<z.infer<typeof GitWorktreesReply>, GitWorktreesReply>>;
/** One local branch: its commit, when that commit was made in epoch seconds, its upstream and the worktree holding it. */
export const GitLocalBranch = z.object({
  name: z.string(),
  oid: z.string(),
  committed: z.number().int().nonnegative(),
  upstream: z.string().optional(),
  worktree: z.string().optional(),
});
/** A checkout's local branches, newest commit first and at most 500, and the one it is on, absent when detached. */
export const GitBranchesReply = z.object({ current: z.string().optional(), branches: z.array(GitLocalBranch), truncated: z.boolean().optional() });
export type GitBranchesReply = WireGitBranchesReply;
type GitBranchesReplyHeld = Held<Same<z.infer<typeof GitBranchesReply>, GitBranchesReply>>;

export const FsReadEncoding = z.enum(["utf8", "base64"]);
export type FsReadEncoding = z.infer<typeof FsReadEncoding>;
/** How many bytes an fs.write left in the file. */
export const FsWriteReply = z.object({ bytes: z.number().int() });
export type FsWriteReply = WireFsWriteReply;
type FsWriteReplyHeld = Held<Same<z.infer<typeof FsWriteReply>, FsWriteReply>>;
/** size is the whole file's byte length; content holds at most the first 2 MiB. */
export const FsReadReply = z.object({ content: z.string(), size: z.number(), truncated: z.boolean() });
export type FsReadReply = z.infer<typeof FsReadReply>;

export const FsSearchMode = z.enum(["files", "text"]);
export type FsSearchMode = z.infer<typeof FsSearchMode>;
/** path is relative to the folder searched; a text hit adds its line, from 1, and that line's text. truncated means
 * the walk stopped at FS_SEARCH_CAP_FILES or FS_SEARCH_CAP_HITS, or at its time or byte budget, before it had looked
 * everywhere. */
export const FsSearchReply = z.object({
  hits: z.array(z.object({ path: z.string(), line: z.number().int().positive().optional(), text: z.string().optional() })),
  truncated: z.boolean(),
});
export type FsSearchReply = WireFsSearchReply;
type FsSearchReplyHeld = Held<Same<z.infer<typeof FsSearchReply>, FsSearchReply>>;

/** The word git's branch header, and the checkout read off it, carry as the branch of a head on none. */
export const DETACHED_HEAD = "(detached)";

/** Porcelain v2 branch header: head is "(detached)" off a branch, oid
 * "(initial)" before the first commit; without an upstream, or with one whose
 * tracking ref is gone, upstream is absent and ahead/behind count against the
 * default branch. */
export const GitBranch = z.object({
  oid: z.string(),
  head: z.string(),
  upstream: z.string().optional(),
  ahead: z.number(),
  behind: z.number(),
});
export type GitBranch = z.infer<typeof GitBranch>;
/** xy is the two-letter porcelain code ("??" untracked, "!!" ignored, "." for
 * an unchanged side); origPath is set for renames and copies. */
export const GitStatusEntry = z.object({ xy: z.string(), path: z.string(), origPath: z.string().optional() });
export type GitStatusEntry = z.infer<typeof GitStatusEntry>;
/** root is the working tree's top-level directory, absolute on the guest.
 * editsUnread: a stopped workspace's branch was read and its entries were not,
 * so an empty list says nothing about edits never committed. countsUnknown:
 * its history was too long or too slow to walk, so ahead and behind say nothing. */
export const GitStatusReply = z.object({
  branch: GitBranch,
  entries: z.array(GitStatusEntry),
  root: z.string(),
  editsUnread: z.boolean().optional(),
  countsUnknown: z.boolean().optional(),
  /** How many stashes the repository holds; absent where there are none. */
  stashes: z.number().int().positive().optional(),
});
export type GitStatusReply = z.infer<typeof GitStatusReply>;

/** branch: working tree against the merge-base with the default branch;
 * unstaged: working tree against the index; staged: index against HEAD;
 * head: working tree against HEAD with every untracked file as a new one, what a commit could take. */
export const GitDiffScope = z.enum(["branch", "unstaged", "staged", "head"]);
export type GitDiffScope = z.infer<typeof GitDiffScope>;
/** kind is added, modified, deleted, renamed or copied; additions and deletions count lines, none for a binary. blob is
 * the id git gives the file's worktree contents now, absent for a file that is gone: a viewed mark is kept against it,
 * so a file that changes again reads unviewed with nothing compared anywhere. */
export const GitDiffFile = z.object({ path: z.string(), kind: z.string(), additions: z.number(), deletions: z.number(), patch: z.string(), blob: z.string().optional() });
export type GitDiffFile = WireGitDiffFile;
type GitDiffFileHeld = Held<Same<z.infer<typeof GitDiffFile>, GitDiffFile>>;
/** The file a git.discard put back as HEAD has it. */
export const GitDiscardReply = z.object({ path: z.string() });
export type GitDiscardReply = WireGitDiscardReply;
type GitDiscardReplyHeld = Held<Same<z.infer<typeof GitDiscardReply>, GitDiscardReply>>;
/** The commit a git.commit made: its id, its subject, and what it changed as git's short stat counts it. */
export const GitCommitReply = z.object({ oid: z.string(), subject: z.string(), filesChanged: z.number().int(), insertions: z.number().int(), deletions: z.number().int() });
export type GitCommitReply = WireGitCommitReply;
type GitCommitReplyHeld = Held<Same<z.infer<typeof GitCommitReply>, GitCommitReply>>;
// The pull request's shapes live beside its words; each is held to the type the daemon's crate writes.
type PullRequestHeld = Held<Same<PullRequest, WirePullRequest>>;
type GitPrReadReplyHeld = Held<Same<GitPrReadReply, WireGitPrReadReply>>;
type GitIssueReadReplyHeld = Held<Same<GitIssueReadReply, WireGitIssueReadReply>>;
type GitPrCheckoutReplyHeld = Held<Same<GitPrCheckoutReply, WireGitPrCheckoutReply>>;
type GitPrDiffReplyHeld = Held<Same<GitPrDiffReply, WireGitPrDiffReply>>;
type GitPrReviewReplyHeld = Held<Same<GitPrReviewReply, WireGitPrReviewReply>>;
type GitPrViewReplyHeld = Held<Same<GitPrViewReply, WireGitPrViewReply>>;
type GitPrReplyReplyHeld = Held<Same<GitPrReplyReply, WireGitPrReplyReply>>;
type GitPrResolveReplyHeld = Held<Same<GitPrResolveReply, WireGitPrResolveReply>>;
type GitPrReactReplyHeld = Held<Same<GitPrReactReply, WireGitPrReactReply>>;
type GitRunLogReplyHeld = Held<Same<GitRunLogReply, WireGitRunLogReply>>;
type GitPrMergeReplyHeld = Held<Same<GitPrMergeReply, WireGitPrMergeReply>>;
type GitRepoReadReplyHeld = Held<Same<GitRepoReadReply, WireGitRepoReadReply>>;
type GitUpdateReplyHeld = Held<Same<GitUpdateReply, WireGitUpdateReply>>;
/** A workspace's ssh host key as this computer pins it: one `ssh-ed25519 <base64> [comment]` line and nothing
 * more. The key is the daemon's word, and a root inside the workspace can answer in its place, so a second line or
 * a marker (`@cert-authority`) would be a key this computer's ssh trusts for every wsp- alias. */
export const SSH_HOST_KEY_LINE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [!-~]+)?$/;
/** Where a machine's own ssh server listens on its loopback, and its host key as one OpenSSH public key line. */
export const SshStartReply = z.object({ port: z.number().int().min(1).max(65535), hostKey: z.string().min(1).max(SSH_KEY_MAX).regex(SSH_HOST_KEY_LINE) });
export type SshStartReply = WireSshStartReply;
type SshStartReplyHeld = Held<Same<z.infer<typeof SshStartReply>, SshStartReply>>;
// The tree's three replies live beside its words; each is held to the type the daemon's crate writes.
type GitStartOnReplyHeld = Held<Same<GitStartOnReply, WireGitStartOnReply>>;
type GitBranchCompareReplyHeld = Held<Same<GitBranchCompareReply, WireGitBranchCompareReply>>;
type GitMergeInReplyHeld = Held<Same<GitMergeInReply, WireGitMergeInReply>>;
/** base is the ref the branch scope diffed against (null for other scopes);
 * truncated means the 2 MiB patch budget cut files or a patch short. */
export const GitDiffReply = z.object({ base: z.string().nullable(), files: z.array(GitDiffFile), truncated: z.boolean(), moved: z.array(z.string()).default([]) });
export type GitDiffReply = z.infer<typeof GitDiffReply>;
/** The commit a git.snapshot recorded, by its full sha. */
export const GitSnapshotReply = z.object({ commit: z.string() });
export type GitSnapshotReply = z.infer<typeof GitSnapshotReply>;

/** One live or exited pty the daemon still holds; exited ones stay until pty.kill. */
export const PtyListEntry = z.object({
  id: z.string(),
  pid: z.number(),
  cols: z.number(),
  rows: z.number(),
  exited: z.boolean(),
  /** Set on a pty that runs a reply's command and still belongs to that reply: no pane adopts it until pty.tab. */
  reply: z.boolean().optional(),
});
export type PtyListEntry = z.infer<typeof PtyListEntry>;
export const PtyListReply = z.object({ ptys: z.array(PtyListEntry) });
export type PtyListReply = z.infer<typeof PtyListReply>;

export const ProcSignal = z.enum(["TERM", "KILL"]);
export type ProcSignal = z.infer<typeof ProcSignal>;

/** One process as /proc/[pid] shows it. cpu is its busy share of one core
 * over the interval (a threaded process can pass 100); rss in bytes;
 * startedAt epoch milliseconds; cmdline the first 200 bytes with the NULs as
 * spaces, empty for a kernel thread; pty names the daemon pty whose shell
 * this is. The environment never travels: it holds tokens. */
export const ProcEntry = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  user: z.string(),
  state: z.string(),
  comm: z.string(),
  cmdline: z.string(),
  cpu: z.number(),
  rss: z.number(),
  startedAt: z.number(),
  pty: z.string().optional(),
});
export type ProcEntry = z.infer<typeof ProcEntry>;

/** Which column a list of processes is ordered by: what is spending the cpu, or what is holding the memory. */
export type ProcSort = "cpu" | "mem";

/** Processes heaviest first on that column, ties broken by pid so one snapshot always lays out the same way. The
 * app's pane sorts each set of siblings by this and the command line's own list reads it flat; a second copy of the
 * rule is how the two would come to disagree about which process is the busiest. */
export const byProcColumn =
  (sort: ProcSort) =>
  (a: ProcEntry, b: ProcEntry): number => {
    const d = sort === "cpu" ? b.cpu - a.cpu : b.rss - a.rss;
    return d !== 0 ? d : a.pid - b.pid;
  };

/** cwd is null when unreadable; ports are the TCP ports this pid listens on;
 * children are the pids whose parent it is, as of the last snapshot. */
export const ProcInspectReply = z.object({
  pid: z.number().int(),
  cwd: z.string().nullable(),
  ports: z.array(z.number().int()),
  /** Absent where the machine's own processes module cannot count them: this computer reads its processes with ps,
   * which has no thread column on macOS. */
  threads: z.number().int().optional(),
  children: z.array(z.number().int()),
});
export type ProcInspectReply = z.infer<typeof ProcInspectReply>;

/** How much of a command's output one exec op carries back, stdout and stderr together. Past it the reply says
 * truncated and the rest is dropped: the road is a WebSocket frame and a turn that cats a log would otherwise put
 * the machine's whole disk through it. */
export const EXEC_OUTPUT_MAX = 2 * 1024 * 1024;

/** How long an exec frame that named no deadline of its own gets. Every caller on the host's side names one; this
 * is what bounds a frame that did not, so nothing runs without end on a computer somebody owns. */
export const EXEC_TIMEOUT_DEFAULT_MS = 20_000;

/** The longest an exec frame may ask for, which is the cap the daemon holds its own timer to. A caller with a
 * command that can run longer launches it detached and polls it instead. */
export const EXEC_TIMEOUT_MAX_MS = 600_000;

/** The exit code a command killed at its deadline answers with, on every road wsp runs one: the shell's own word
 * for it, so a caller reads one number whether the command was launched detached on a guest or run by an exec op
 * on a place. One home, since the two roads' guards are compared against each other in tests. */
export const EXEC_DEADLINE_EXIT = 124;

/** One command on this machine, for a host driving it over a link it did not open: `bash -c`, in the daemon's own
 * root and environment, with the bytes for its stdin where the caller has any. The byte road a daemon token, a
 * roots file and a project part take on a machine whose backend mints no signed URL. */
export const DaemonExecRequest = z.object({
  id: reqId,
  op: z.literal("exec"),
  cmd: z.string().max(EXEC_BODY_MAX),
  timeoutMs: z.number().int().positive().max(EXEC_TIMEOUT_MAX_MS).optional(),
  /** Bytes for the command's stdin, base64; absent closes stdin at once. */
  stdin: z.string().optional(),
});
export type DaemonExecRequest = z.infer<typeof DaemonExecRequest>;

export const DaemonExecReply = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string(), truncated: z.boolean() });
export type DaemonExecReply = z.infer<typeof DaemonExecReply>;

/** What a guest session carries: the tool server's JSON-RPC messages, or one command line and its streams. */
export const GuestKind = z.enum(["mcp", "cli"]);
export type GuestKind = z.infer<typeof GuestKind>;

/** One agent's store as the host names it to usage.logs: the catalog's id, the format, and where it is under the home
 * the daemon serves, as `~/`; a root anywhere else reads as nothing. */
export const UsageStore = z.object({ agent: z.string().min(1).max(64), format: z.enum(["claude-jsonl", "codex-rollout", "opencode-sqlite"]), root: z.string().min(1).max(4096) });
export type UsageStore = WireUsageStore;
type UsageStoreHeld = Held<Same<z.infer<typeof UsageStore>, UsageStore>>;

export const DaemonRequest = z.discriminatedUnion("op", [
  /** machineId, on these seven and on no other op of this road: the workspace the pty belongs to, on a daemon
   * that runs workspaces. A workspace on a computer somebody owns runs no daemon of its own, so the daemon of
   * the computer holding it opens the shell inside that workspace's namespaces, in the folder the frame names,
   * which is absolute and is asked for, since that daemon has no working directory inside a workspace. Without
   * one the pty is the daemon's own computer's, which is every machine wsp forked; every later op on that pty
   * names the same workspace, and one that names another, or none, is answered no such pty. */
  z.object({
    id: reqId,
    op: z.literal("pty.create"),
    cols: z.number().optional(),
    rows: z.number().optional(),
    shell: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    /** A command line the pty runs through the person's own shell and exits with: a reply's block run where it
     * stands. Such a pty is that reply's, which pty.list marks, until pty.tab hands it to the panes. */
    run: z.string().optional(),
    /** The program the pty runs and its arguments, as its argv: no shell reads a line for it. Never beside a shell or
     * a run. A daemon that ran them says argv on its reply; an older one takes them for no field at all. */
    args: z.array(z.string()).optional(),
    /** The program runs as the computer's login, the owner of its home, so the terminal is handed to that login. */
    asLogin: z.boolean().optional(),
    machineId: z.string().optional(),
  }),
  z.object({ id: reqId, op: z.literal("pty.attach"), ptyId: z.string(), machineId: z.string().optional() }),
  /** This socket's listeners off that pty, the mirror of pty.attach: a pane that closed stops the bytes of its
   * own pty on a socket that many panes share. */
  z.object({ id: reqId, op: z.literal("pty.detach"), ptyId: z.string(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("pty.write"), ptyId: z.string(), data: z.string(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("pty.resize"), ptyId: z.string(), cols: z.number(), rows: z.number(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("pty.kill"), ptyId: z.string(), machineId: z.string().optional() }),
  /** With a workspace named, that workspace's ptys alone; without one, this daemon's own alone. */
  z.object({ id: reqId, op: z.literal("pty.list"), machineId: z.string().optional() }),
  /** With roots, the listeners of the processes they hold: each root's process group and every process under it,
   * and with a folder, every process running in it. A watch that names no roots sees every listener on the machine,
   * which is what the host's own watchers ask for. A second watch on the socket names its roots again. */
  z.object({ id: reqId, op: z.literal("ports.watch"), roots: z.array(z.number().int().nonnegative()).optional(), folder: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("manifest.get") }),
  z.object({
    id: reqId,
    op: z.literal("manifest.record"),
    cmd: z.string(),
    cwd: z.string(),
    port: z.number().optional(),
  }),
  z.object({ id: reqId, op: z.literal("manifest.restartScript") }),
  z.object({ id: reqId, op: z.literal("inbox.watch") }),
  z.object({ id: reqId, op: z.literal("inbox.rescan") }),
  /** Streams sys.sample events to this socket every two seconds until it
   * closes. One sampler serves every subscriber and stops with the last one;
   * the first sample lands one interval after the reply, since cpu is a delta. */
  z.object({ id: reqId, op: z.literal("sys.watch") }),
  // The computer's readings the daemon kept a minute apart, between two instants, folded into steps of stepMs.
  z.object({ id: reqId, op: z.literal("sys.history"), from: z.number().int(), to: z.number().int(), stepMs: z.number().int().nonnegative() }),
  // What each agent's own store on the daemon's computer counted, for the stores the host names: counts, a model and
  // a folder per session and half hour, and the newest plan reading a store kept, never a line of a transcript.
  z.object({ id: reqId, op: z.literal("usage.logs"), stores: z.array(UsageStore).max(USAGE_STORES_MAX) }),
  /** Streams the processes to this socket until proc.unwatch or the socket
   * closes: one whole proc.snapshot first, two seconds after the reply since
   * cpu is a delta (at once where the sampler is already running), then a
   * proc.changes every five seconds naming the frame it follows. A socket
   * already watching that watches again is sent a whole snapshot next. The
   * daemon reads /proc only while some socket watches. */
  z.object({ id: reqId, op: z.literal("proc.watch") }),
  z.object({ id: reqId, op: z.literal("proc.unwatch") }),
  /** One process in depth, replied as a ProcInspectReply; this is the only op
   * that scans /proc/net, and only for that pid's sockets. */
  z.object({ id: reqId, op: z.literal("proc.inspect"), pid: z.number().int().positive() }),
  /** Sends the signal. pid 1, the daemon and the daemon's parent are refused
   * with code forbidden; a pid that is gone answers not-found. */
  z.object({ id: reqId, op: z.literal("proc.kill"), pid: z.number().int().positive(), signal: ProcSignal }),
  z.object({ id: reqId, op: z.literal("ping") }),
  /** Lists one directory's direct children, each request under its own entry
   * cap. Paths are relative to the daemon's home root (HOME unless started
   * with --root) or absolute inside it or an imported project folder named in
   * DAEMON_ROOTS_PATH; anything resolving outside every root, through .. or a
   * symlink, is refused with code outside-root. gitignore hides .git and the
   * entries git would ignore.
   *
   * machineId, on these ten and on no other op of this road: the workspace the frame is for, on a daemon that
   * runs workspaces. A workspace on a computer somebody owns runs no daemon of its own, so the daemon of the
   * computer holding it answers for it: the path then names the folder as that workspace sees it, a file is read
   * through the workspace's own rootfs and a git operation runs inside the workspace, in its namespaces and its
   * cgroup. Without one the path is resolved under the daemon's own roots, which is every other machine. A daemon
   * that runs no workspace answers the missing refusal for any machineId. */
  z.object({
    id: reqId,
    op: z.literal("fs.list"),
    path: z.string(),
    gitignore: z.boolean().optional(),
    machineId: z.string().optional(),
  }),
  /** Every file of the checkout under cwd that git would show, tracked or untracked and never ignored, relative
   * to cwd, answered from `git ls-files` and kept until a folder holding one of them changes. */
  z.object({ id: reqId, op: z.literal("fs.files"), cwd: z.string(), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("fs.read"), path: z.string(), encoding: FsReadEncoding.optional(), machineId: z.string().optional() }),
  /** Replaces an existing regular file's contents whole and answers an FsWriteReply: written beside it and renamed
   * over, its mode and owner kept, never through a link standing where the file should be, and refused over
   * FS_WRITE_CAP_BYTES. The folder resolves inside a root as fs.read's path does. */
  z.object({ id: reqId, op: z.literal("fs.write"), path: z.string(), contents: z.string(), machineId: z.string().optional() }),
  /** A reply's pty handed to the panes, still running: pty.list stops marking it, so every pane adopts it as a tab. */
  z.object({ id: reqId, op: z.literal("pty.tab"), ptyId: z.string(), machineId: z.string().optional() }),
  /** Searches under one folder, resolved as fs.list resolves its path: files answers every file whose path below the
   * folder holds the query's letters in order, text every line of a text file there that holds the query, both
   * case-insensitive. The walk reads the folder's .gitignore and .ignore files, leaves hidden names out, never
   * follows a symlink, and skips a file over FS_READ_CAP_BYTES or holding a NUL byte; it answers what it found when a
   * cap or its time budget stops it, with truncated set. */
  z.object({ id: reqId, op: z.literal("fs.search"), path: z.string(), query: z.string(), mode: FsSearchMode, machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("git.status"), cwd: z.string(), machineId: z.string().optional() }),
  /** paths names files from the checkout's top, each read as a letter-for-letter name; whole gives each patch its
   * whole file in one hunk, which an editor over the new side needs. */
  z.object({
    id: reqId,
    op: z.literal("git.diff"),
    cwd: z.string(),
    scope: GitDiffScope,
    path: z.string().optional(),
    paths: z.array(z.string()).optional(),
    whole: z.boolean().optional(),
    machineId: z.string().optional(),
  }),
  /** Puts one changed file back as HEAD has it, or removes it where HEAD has none, and answers a GitDiscardReply;
   * a file with no change is refused by name. */
  z.object({ id: reqId, op: z.literal("git.discard"), cwd: z.string(), path: z.string(), machineId: z.string().optional() }),
  /** Commits the named files and no others, untracked ones added first, with the message on git's stdin, hooks
   * and all, and answers a GitCommitReply. A held index is waited on once; git knowing no author, and a hook that
   * says no, are refused in one sentence each. */
  z.object({ id: reqId, op: z.literal("git.commit"), cwd: z.string(), message: z.string(), paths: z.array(z.string()), machineId: z.string().optional() }),
  /** Records the checkout as it stands, new files in and ignored ones out, as one commit on top of HEAD through an
   * index of its own, so the checkout's own index is never written; answers a GitSnapshotReply. No ref names it. */
  z.object({ id: reqId, op: z.literal("git.snapshot"), cwd: z.string(), machineId: z.string().optional() }),
  /** The diff between two commits, each its full sha (40 or 64 hex digits) or the frame is refused before git runs; answers
   * a GitDiffReply. */
  z.object({ id: reqId, op: z.literal("git.range"), cwd: z.string(), from: z.string(), to: z.string(), path: z.string().optional(), machineId: z.string().optional() }),
  /** What a turn changed between two of its snapshots, the agent's own work alone, each snapshot its full sha; answers
   * a GitDiffReply with the moves it did not write on `moved`. git.range stays the pure diff of the two trees. */
  z.object({ id: reqId, op: z.literal("git.turn"), cwd: z.string(), from: z.string(), to: z.string(), path: z.string().optional(), machineId: z.string().optional() }),
  /** Pushes the branch the checkout is on to its remote and answers a GitPushReply. The base branch itself is
   * refused: wsp makes no branch and pushes none of the branch the work started from. Without a base the
   * checkout's own default branch is read, which is what a project recorded without one was cloned at. */
  z.object({ id: reqId, op: z.literal("git.push"), cwd: z.string(), base: z.string().optional(), machineId: z.string().optional() }),
  /** Opens the branch's pull request against the base through the git host's own signed-in command line, or
   * answers with the one already open. Refused with code no-host-cli where that command line is not there. */
  z.object({ id: reqId, op: z.literal("git.pr"), cwd: z.string(), base: z.string().optional(), title: z.string().optional(), body: z.string().optional(), machineId: z.string().optional() }),
  /** A pull request by branch or by number through that same command line, the repository named off the remote the
   * frame carries and never off the folder, where nothing is read and no git runs; answered as a GitPrReadReply, with
   * no pull request where the host knows none. The host takes the remote off the project's own record. */
  z.object({
    id: reqId,
    op: z.literal("git.prRead"),
    cwd: z.string(),
    remote: z.string(),
    branch: z.string().optional(),
    number: z.number().int().nonnegative().optional(),
    seen: z.string().optional(),
    machineId: z.string().optional(),
  }),
  /** One pull request's page through that same command line, answered as a GitPrViewReply. */
  z.object({ id: reqId, op: z.literal("git.prView"), cwd: z.string(), remote: z.string(), number: z.number().int().nonnegative(), machineId: z.string().optional() }),
  /** The failed steps of one job of one run, its last CHECK_LOG_LINES lines, answered as a GitRunLogReply. */
  z.object({
    id: reqId,
    op: z.literal("git.runLog"),
    cwd: z.string(),
    remote: z.string(),
    runId: z.number().int().nonnegative(),
    jobId: z.number().int().nonnegative(),
    machineId: z.string().optional(),
  }),
  /** Merges a pull request by the method named, or arms it to merge once its checks pass, only while its head is the
   * commit named, and answers a GitPrMergeReply; a refusal is the command line's own last line. */
  z.object({
    id: reqId,
    op: z.literal("git.prMerge"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    method: MergeMethod,
    auto: z.boolean(),
    headOid: z.string(),
    machineId: z.string().optional(),
  }),
  /** An issue, or a pull request read as the issue it also is, by number in the repository the remote names, answered
   * as a GitIssueReadReply with each body cut as a list cuts it. */
  z.object({ id: reqId, op: z.literal("git.issueRead"), cwd: z.string(), remote: z.string(), number: z.number().int().nonnegative(), machineId: z.string().optional() }),
  /** Puts the copy on a pull request's head branch through the git host's own command line, run inside the copy, the
   * host read off the copy's own remote; answered as a GitPrCheckoutReply naming the branch, which tracks where the
   * head lives. */
  z.object({ id: reqId, op: z.literal("git.prCheckout"), cwd: z.string(), number: z.number().int().nonnegative(), machineId: z.string().optional() }),
  /** A pull request's diff against its base, cut on a file's boundary at maxBytes, never past GIT_DIFF_CAP_BYTES and
   * REVIEW_DIFF_MAX_BYTES where absent, answered as a GitPrDiffReply naming every file the cut left out. */
  z.object({
    id: reqId,
    op: z.literal("git.prDiff"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    maxBytes: z.number().int().positive().optional(),
    machineId: z.string().optional(),
  }),
  /** Posts one review in one call pinned to the head named: the verdict, the body and every comment on a line, a comment
   * whose line falls outside the diff put into the body; answered as a GitPrReviewReply. A refusal is the command
   * line's own last line. */
  z.object({
    id: reqId,
    op: z.literal("git.prReview"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    headOid: z.string(),
    event: z.enum(["comment", "approve", "request_changes"]),
    body: z.string(),
    comments: z.array(z.object({ id: z.string(), path: z.string(), line: z.number().int().nonnegative(), side: z.enum(["LEFT", "RIGHT"]), body: z.string() })),
    machineId: z.string().optional(),
  }),
  /** Posts a reply as the signed-in person: under the comment on a line replyTo names, or, with none, as a new comment
   * in the conversation, the body sent as typed on stdin; answered as a GitPrReplyReply, a line reply carrying the
   * threadId the frame names. */
  z.object({
    id: reqId,
    op: z.literal("git.prReply"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    replyTo: z.number().int().nonnegative().optional(),
    threadId: z.string().optional(),
    body: z.string().max(PR_REPLY_BODY_MAX),
    machineId: z.string().optional(),
  }),
  /** Resolves or unresolves a review thread, named by its node id, as the signed-in person; answered as a
   * GitPrResolveReply. A thread id that is not a node id's shape, or names a thread of any pull request but the
   * repository's number given, is refused before the mutation runs. */
  z.object({
    id: reqId,
    op: z.literal("git.prResolve"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    threadId: z.string(),
    resolved: z.boolean(),
    machineId: z.string().optional(),
  }),
  /** Adds or takes off one reaction on the item a node id names, as the signed-in person; answered as a GitPrReactReply
   * with every reaction on it now. A subject that is not a node id's shape, or is not a comment or a review on the
   * repository's pull request numbered, is refused before the mutation runs. */
  z.object({
    id: reqId,
    op: z.literal("git.prReact"),
    cwd: z.string(),
    remote: z.string(),
    number: z.number().int().nonnegative(),
    subject: z.string(),
    content: ReactionContent,
    on: z.boolean(),
    machineId: z.string().optional(),
  }),
  /** How the repository lets a pull request land, answered as a GitRepoReadReply. */
  z.object({ id: reqId, op: z.literal("git.repoRead"), cwd: z.string(), remote: z.string(), machineId: z.string().optional() }),
  /** Merges the base's latest commits from the remote into the checkout's branch and answers a GitUpdateReply. A
   * checkout with changes no commit holds is refused with the files named; a merge that conflicts is taken back at
   * once and answered with the files, the checkout left as it was. */
  z.object({ id: reqId, op: z.literal("git.update"), cwd: z.string(), base: z.string().optional(), machineId: z.string().optional() }),
  /** Puts the checkout on a branch as the remote holds it, fetched and reset with every untracked file dropped, and
   * answers a GitStartOnReply: what a child's copy starts on, the branch its lead pushed. */
  z.object({ id: reqId, op: z.literal("git.startOn"), cwd: z.string(), branch: z.string(), machineId: z.string().optional() }),
  /** How far one branch is from a base, a branch or a commit, on the git host, through this computer's own command
   * line with the repository named off the remote given, answered as a GitBranchCompareReply; a head the host lacks
   * is not pushed. */
  z.object({ id: reqId, op: z.literal("git.branchCompare"), cwd: z.string(), remote: z.string(), base: z.string(), head: z.string() }),
  /** Merges another branch into the checkout's with a merge commit, from the remote or from a copy's folder on this
   * computer, and answers a GitMergeInReply; refused over changes no commit holds, and a merge that conflicts is
   * taken back and answered with the files. A folder is refused on any daemon but this computer's own. */
  z.object({ id: reqId, op: z.literal("git.mergeIn"), cwd: z.string(), branch: z.string(), from: z.string().optional(), machineId: z.string().optional() }),
  /** The repository's open pull requests and issues through that same command line, answered as a GitPrListReply.
   * No command line for the host, or one nobody signed in, is an empty list with the note saying so. */
  z.object({ id: reqId, op: z.literal("git.prList"), cwd: z.string(), machineId: z.string().optional() }),
  /** Records the checkout's whole tree at a turn's end as a commit outside every branch, under the ref the daemon
   * names from the scope (else the copy's folder), the thread and the turn, and answers a GitCheckpointReply. A
   * thread keeps its newest hundred refs, the `-before-` refs counted. HEAD, the index and the branch never move. */
  z.object({ id: reqId, op: z.literal("git.checkpoint"), cwd: z.string(), thread: z.string(), turn: z.string(), scope: z.string().optional(), machineId: z.string().optional() }),
  /** Puts the tree back to one of the scope's checkpoints (else this copy's), recording the tree as it stood first,
   * and answers a GitRestoreReply whose before restores it again. */
  z.object({ id: reqId, op: z.literal("git.restore"), cwd: z.string(), checkpoint: z.string(), scope: z.string().optional(), machineId: z.string().optional() }),
  /** Takes away one thread's checkpoint refs under the scope and no other thread's; answers a GitCheckpointDropReply. */
  z.object({ id: reqId, op: z.literal("git.checkpointDrop"), cwd: z.string(), scope: z.string().optional(), thread: z.string(), machineId: z.string().optional() }),
  /** Every worktree of the checkout's repository, its own folder first, read off git each time; a GitWorktreesReply. */
  z.object({ id: reqId, op: z.literal("git.worktrees"), cwd: z.string(), machineId: z.string().optional() }),
  /** The checkout's local branches, newest commit first, and the one it is on; a GitBranchesReply. */
  z.object({ id: reqId, op: z.literal("git.branches"), cwd: z.string(), machineId: z.string().optional() }),
  /** Puts the checkout on a new branch at its HEAD with every change carried along and nothing reset; answers a
   * GitStartOnReply. */
  z.object({ id: reqId, op: z.literal("git.switchNew"), cwd: z.string(), branch: z.string(), machineId: z.string().optional() }),
  /** Fetches one branch of a remote, by name or URL, into a local branch (`into`, else the same name): made where it is
   * not there, moved only forward where it is, never forced; answers a GitStartOnReply naming the local branch. */
  z.object({ id: reqId, op: z.literal("git.fetchBranch"), cwd: z.string(), remote: z.string(), branch: z.string(), into: z.string().optional(), machineId: z.string().optional() }),
  /** Replies with a HostFolderListing: one level of folders on the computer this daemon runs on, for the folder
   * picker of a computer somebody owns. The roots are the home of the login the daemon runs as and each of
   * `projects` the home does not hold; `dir` absent lists the home, and so does a folder inside the roots that is
   * gone. A path outside the roots, a relative one, or one through a symlink that leaves them is refused with code
   * outside-root. Folders only, one level, `repo` where the folder holds .git; the dot-named ones are counted and
   * listed only when `hidden`. `repos` answers every repo under the roots instead, as this computer's repos listing
   * does: REPO_DEPTH folders deep and REPO_CAP of them at most, walking into no repo, no link, no dot-named folder and
   * nothing in CACHE_DIRS, each with its branch and when git last wrote there, most recent first. No file is read
   * but a repo's HEAD. */
  z.object({ id: reqId, op: z.literal("fs.folders"), dir: z.string().optional(), hidden: z.boolean().optional(), repos: z.boolean().optional(), projects: z.array(z.string()).optional() }),
  /** One laptop-side connection to a guest loopback port, for the sign-in
   * callback forward. The daemon dials 127.0.0.1 then ::1 (a Node 22 tool
   * binds [::1] only). data is base64; the reply to tunnel.open comes after
   * the guest accepted. */
  /** machineId dials the port inside that workspace's own network namespace, on a daemon that runs workspaces. */
  z.object({ id: reqId, op: z.literal("tunnel.open"), tunnelId: z.string(), port: z.number().int().min(1).max(65535), machineId: z.string().optional() }),
  /** Starts the machine's own ssh server, or the named workspace's, on its loopback where none runs, with the one
   * ed25519 public key given as all it lets in, and answers an SshStartReply. Refused in one sentence where the image
   * has no /usr/sbin/sshd. The server and everything its sessions started are ended once its last session has been
   * closed for SSH_IDLE_MS. */
  z.object({ id: reqId, op: z.literal("ssh.start"), authorizedKey: z.string().min(1).max(SSH_KEY_MAX), machineId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("tunnel.write"), tunnelId: z.string(), data: z.string() }),
  z.object({ id: reqId, op: z.literal("tunnel.close"), tunnelId: z.string() }),
  DaemonExecRequest,
  /** Sweeps wsp off this computer and answers what it took, then the agent exits: the one op whose handler belongs
   * to the link a place opened and not to the daemon's own switch. */
  z.object({ id: reqId, op: z.literal("place.leave") }),
  /** A process inside this machine opens a guest session: the tool server, or one command line. The daemon relays
   * it up the socket the host holds and reads nothing of what rides here; the token is the thread's, and the host
   * is what reads it. Sent on the inbound road alone, since no guest runs on a computer somebody owns. */
  z.object({
    id: reqId,
    op: z.literal("guest.open"),
    kind: GuestKind,
    /** The thread's token off WSP_HOST_TOKEN, "" when the launch carried none; the host reads it, the daemon never does. */
    token: z.string().max(GUEST_TOKEN_MAX),
    turnToken: z.string().max(GUEST_TOKEN_MAX).optional(),
    argv: z.array(z.string()).max(GUEST_ARGV_MAX),
    cwd: z.string().max(GUEST_CWD_MAX),
  }),
  /** One message from the guest process on the session its socket opened. */
  z.object({ id: reqId, op: z.literal("guest.send"), message: z.unknown() }),
  /** The host asks to be handed every guest session this daemon opens; the last socket to ask is where they go. */
  z.object({ id: reqId, op: z.literal("guest.watch") }),
  /** The host's answer on a session, and the host ending one; both are refused on a socket that never watched. */
  z.object({ id: reqId, op: z.literal("guest.reply"), session: z.string(), message: z.unknown() }),
  z.object({ id: reqId, op: z.literal("guest.close"), session: z.string(), error: z.string().optional() }),
  /** The daemon this host deploys, landed on the computer the link runs on and started in place of the one running
   * there. The parts arrive as machine.putBytes's do, in seq order under one upload id on one socket; the part
   * marked last is checked against sha256, moved over the binary the unit starts and answered, and then the agent
   * ends so whatever supervises it starts the new one. Nothing on that computer is swept: the workspaces' records
   * stay on its disk and the daemon that comes up reads them again.
   *
   * The other link op, and for the same reason: a binary is bytes and never a command line, since a command sits in
   * a world readable /proc/<pid>/cmdline while it runs. */
  z.object({
    id: reqId,
    op: z.literal("place.update"),
    uploadId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9]+$/),
    seq: z.number().int().min(0),
    last: z.boolean(),
    data: z.string(),
    /** Lowercase hex sha256 of the whole binary, carried on every part and read on the last: a binary that landed
     * short would otherwise be moved over the one the unit starts, and Restart=always would loop on it. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

/** The reply to guest.open: the id both sides name the session by. Every other guest op answers the empty ok. */
export const GuestOpenReply = z.object({ session: z.string() });
export type GuestOpenReply = z.infer<typeof GuestOpenReply>;

/** What a cli session's messages carry: text for one of the two streams, then the code the line ended with. A tool
 * server session carries the harness's own JSON-RPC, which has no shape of ours. */
export const GuestCliMessage = z.union([
  z.object({ stream: z.enum(["out", "err"]), text: z.string() }),
  z.object({ exit: z.number().int() }),
]);
export type GuestCliMessage = z.infer<typeof GuestCliMessage>;
