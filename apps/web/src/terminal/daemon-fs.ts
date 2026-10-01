// SPDX-License-Identifier: AGPL-3.0-only
// Typed calls for the daemon's files and diff ops over any TerminalWire (the
// daemon link in the app, a fake in tests). Replies are parsed against the
// protocol schemas so a malformed daemon answer fails here, not in a pane.
import {
  DaemonErrorCode,
  FsFilesReply,
  FsListReply,
  GitPrListReply,
  FsReadReply,
  FsSearchReply,
  FsWriteReply,
  GitDiffReply,
  GitStatusReply,
  type FsReadEncoding,
  type FsSearchMode,
  type GitDiffScope,
} from "@wsp/protocol";
import type { TerminalWire } from "./link.js";

/** code is present only when the wire preserved the daemon's typed refusal. */
export class DaemonOpError extends Error {
  readonly code: DaemonErrorCode | undefined;
  constructor(message: string, code?: DaemonErrorCode) {
    super(message);
    this.code = code;
  }
}

function wrap(e: unknown): DaemonOpError {
  if (e instanceof DaemonOpError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const raw = (e as { code?: unknown } | null)?.code;
  const parsed = DaemonErrorCode.safeParse(raw);
  return new DaemonOpError(message, parsed.success ? parsed.data : undefined);
}

async function call<T>(wire: TerminalWire, op: string, params: Record<string, unknown>, schema: { parse(v: unknown): T }): Promise<T> {
  let reply: Record<string, unknown>;
  try {
    reply = await wire.request(op, params);
  } catch (e) {
    throw wrap(e);
  }
  return schema.parse(reply);
}

export interface FsListOpts {
  gitignore?: boolean;
}

export function fsList(wire: TerminalWire, path: string, opts: FsListOpts = {}): Promise<FsListReply> {
  const params: Record<string, unknown> = { path };
  if (opts.gitignore !== undefined) params["gitignore"] = opts.gitignore;
  return call(wire, "fs.list", params, FsListReply);
}

export function fsFiles(wire: TerminalWire, cwd: string): Promise<FsFilesReply> {
  return call(wire, "fs.files", { cwd }, FsFilesReply);
}

export function gitPrList(wire: TerminalWire, cwd: string): Promise<GitPrListReply> {
  return call(wire, "git.prList", { cwd }, GitPrListReply);
}

export function fsRead(wire: TerminalWire, path: string, encoding?: FsReadEncoding): Promise<FsReadReply> {
  const params: Record<string, unknown> = { path };
  if (encoding !== undefined) params["encoding"] = encoding;
  return call(wire, "fs.read", params, FsReadReply);
}

/** Every file under `path` whose path holds the query's letters in order, or every line of text there holding it. */
export function fsSearch(wire: TerminalWire, path: string, query: string, mode: FsSearchMode): Promise<FsSearchReply> {
  return call(wire, "fs.search", { path, query, mode }, FsSearchReply);
}

export function gitStatus(wire: TerminalWire, cwd: string): Promise<GitStatusReply> {
  return call(wire, "git.status", { cwd }, GitStatusReply);
}

/** paths names files from the checkout's top; whole gives each patch its whole file in one hunk. */
export function gitDiff(wire: TerminalWire, cwd: string, scope: GitDiffScope, opts: { path?: string; paths?: readonly string[]; whole?: boolean } = {}): Promise<GitDiffReply> {
  const params: Record<string, unknown> = { cwd, scope };
  if (opts.path !== undefined) params["path"] = opts.path;
  if (opts.paths !== undefined) params["paths"] = [...opts.paths];
  if (opts.whole !== undefined) params["whole"] = opts.whole;
  return call(wire, "git.diff", params, GitDiffReply);
}

/** Replaces an existing file's contents whole, as the pane saves an edit. */
export function fsWrite(wire: TerminalWire, path: string, contents: string): Promise<FsWriteReply> {
  return call(wire, "fs.write", { path, contents }, FsWriteReply);
}

/** What changed between two snapshot commits, each named by its full sha: a pure diff of the two trees. */
export function gitRange(wire: TerminalWire, cwd: string, from: string, to: string): Promise<GitDiffReply> {
  return call(wire, "git.range", { cwd, from, to }, GitDiffReply);
}

/** What a turn changed between its two snapshots: the agent's own work, with the HEAD moves it did not write on `moved`. */
export function gitTurn(wire: TerminalWire, cwd: string, from: string, to: string): Promise<GitDiffReply> {
  return call(wire, "git.turn", { cwd, from, to }, GitDiffReply);
}
