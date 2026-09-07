// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { workArgv } from "@wsp/protocol";
import { OpError } from "./workspace-paths.js";

export const GIT_DIFF_CAP_BYTES = 2 * 1024 * 1024;

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** stdout passed maxBytes; the child was killed by pid and code is null. */
  truncated: boolean;
}

/** Spawned as argv behind the work-score line, never interpolated into a shell. GIT_OPTIONAL_LOCKS keeps status
 * from touching the index; LC_ALL=C keeps the not-a-repo message matchable. */
export function runGit(cwd: string, args: string[], opts: { input?: string; maxBytes?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const git = workArgv("git", args);
    const child = spawn(git.file, git.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    const out: Buffer[] = [];
    let outLen = 0;
    let truncated = false;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      out.push(chunk);
      outLen += chunk.length;
      if (opts.maxBytes !== undefined && outLen > opts.maxBytes) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout: Buffer.concat(out), stderr, truncated }));
    child.stdin.end(opts.input ?? "");
  });
}

function checkGit(res: GitResult, what: string): void {
  if (res.truncated || res.code === 0 || res.code === 1) return;
  if (/not a git repository/i.test(res.stderr)) throw new OpError("not-a-git-repo", "not inside a git repository");
  throw new Error(`git ${what} failed (${res.code ?? "killed"}): ${res.stderr.trim()}`);
}

export interface GitBranch {
  oid: string;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface GitStatusEntry {
  xy: string;
  path: string;
  origPath?: string;
}

export interface GitStatus {
  branch: GitBranch;
  entries: GitStatusEntry[];
  /** The working tree's top level, absolute. */
  root: string;
}

/** Porcelain v2 with -z: every record is NUL-terminated and a rename's
 * original path follows as its own record instead of a tab suffix. */
export function parsePorcelainV2(text: string): Omit<GitStatus, "root"> {
  const branch: GitBranch = { oid: "", head: "", ahead: 0, behind: 0 };
  const entries: GitStatusEntry[] = [];
  const tokens = text.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "") continue;
    const kind = tok[0];
    const parts = tok.split(" ");
    if (kind === "#") {
      const key = parts[1];
      if (key === "branch.oid") branch.oid = parts[2] ?? "";
      else if (key === "branch.head") branch.head = parts[2] ?? "";
      else if (key === "branch.upstream") branch.upstream = parts[2] ?? "";
      else if (key === "branch.ab") {
        branch.ahead = Number(parts[2]?.slice(1) ?? 0);
        branch.behind = Number(parts[3]?.slice(1) ?? 0);
      }
    } else if (kind === "1") {
      entries.push({ xy: parts[1]!, path: parts.slice(8).join(" ") });
    } else if (kind === "2") {
      const origPath = tokens[++i] ?? "";
      entries.push({ xy: parts[1]!, path: parts.slice(9).join(" "), origPath });
    } else if (kind === "u") {
      entries.push({ xy: parts[1]!, path: parts.slice(10).join(" ") });
    } else if (kind === "?" || kind === "!") {
      entries.push({ xy: kind + kind, path: tok.slice(2) });
    }
  }
  return { branch, entries };
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const res = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "-z"]);
  checkGit(res, "status");
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  checkGit(top, "rev-parse");
  return { ...parsePorcelainV2(res.stdout.toString("utf8")), root: top.stdout.toString("utf8").trim() };
}

export type GitDiffScope = "branch" | "unstaged" | "staged";

export interface GitDiffFile {
  path: string;
  patch: string;
}

export interface GitDiff {
  base: string | null;
  files: GitDiffFile[];
  truncated: boolean;
}

async function revExists(cwd: string, ref: string): Promise<boolean> {
  const res = await runGit(cwd, ["rev-parse", "--verify", "-q", ref]);
  return res.code === 0;
}

/** origin/HEAD when a remote set it, else a local main or master. */
async function defaultBranch(cwd: string): Promise<string | null> {
  const remote = await runGit(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  checkGit(remote, "symbolic-ref");
  if (remote.code === 0) return remote.stdout.toString("utf8").trim();
  for (const name of ["main", "master"]) {
    if (await revExists(cwd, `refs/heads/${name}`)) return name;
  }
  return null;
}

interface ListedFile {
  path: string;
  origPath?: string;
}

function parseNameStatus(text: string): ListedFile[] {
  const files: ListedFile[] = [];
  const tokens = text.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]!;
    if (status === "") continue;
    const first = tokens[++i] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      files.push({ path: tokens[++i] ?? "", origPath: first });
    } else {
      files.push({ path: first });
    }
  }
  return files;
}

function cutAtLine(bytes: Buffer, limit: number): Buffer {
  if (bytes.length <= limit) return bytes;
  const head = bytes.subarray(0, limit);
  const nl = head.lastIndexOf(0x0a);
  return nl > 0 ? head.subarray(0, nl + 1) : head;
}

/**
 * One name-status pass picks the files (so renames stay renames), then one
 * diff per file spends a shared byte budget; a file past the budget is still
 * listed with an empty patch so the client knows it changed. path narrows
 * relative to cwd; per-file pathspecs use :(top) because git reports names
 * from the repo root whatever cwd is.
 */
export async function gitDiff(cwd: string, scope: GitDiffScope, path?: string, capBytes = GIT_DIFF_CAP_BYTES): Promise<GitDiff> {
  const args: string[] = [];
  let base: string | null = null;
  if (scope === "staged") {
    args.push("--cached");
  } else if (scope === "branch") {
    base = await defaultBranch(cwd);
    if (base === null) {
      args.push("HEAD");
    } else {
      const mb = await runGit(cwd, ["merge-base", base, "HEAD"]);
      checkGit(mb, "merge-base");
      args.push(mb.code === 0 ? mb.stdout.toString("utf8").trim() : "HEAD");
    }
  }
  const pathspec = path !== undefined ? ["--", path] : [];
  const listed = await runGit(cwd, ["diff", ...args, "-M", "--name-status", "-z", ...pathspec]);
  checkGit(listed, "diff --name-status");
  if (listed.code !== 0) throw new Error(`git diff --name-status failed: ${listed.stderr.trim()}`);

  const files: GitDiffFile[] = [];
  let remaining = capBytes;
  let truncated = false;
  for (const f of parseNameStatus(listed.stdout.toString("utf8"))) {
    if (remaining <= 0) {
      truncated = true;
      files.push({ path: f.path, patch: "" });
      continue;
    }
    const specs = f.origPath !== undefined ? [`:(top)${f.origPath}`, `:(top)${f.path}`] : [`:(top)${f.path}`];
    const res = await runGit(cwd, ["diff", ...args, "-M", "--no-color", "--no-ext-diff", "--", ...specs], { maxBytes: remaining });
    checkGit(res, "diff");
    let bytes = res.stdout;
    if (res.truncated || bytes.length > remaining) {
      truncated = true;
      bytes = cutAtLine(bytes, remaining);
      remaining = 0;
    } else {
      remaining -= bytes.length;
    }
    files.push({ path: f.path, patch: new StringDecoder("utf8").write(bytes) });
  }
  return { base, files, truncated };
}
