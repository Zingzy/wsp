// SPDX-License-Identifier: AGPL-3.0-only
// Every op runs over the wire against a real git repo built in a temp root,
// so the tests cover confinement, git parsing and the byte caps as a client
// sees them. Nothing here reaches the network or a cloud machine.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FS_READ_CAP_BYTES, listDir } from "../src/fs-ops.js";
import { GIT_DIFF_CAP_BYTES } from "../src/git-ops.js";
import { startDaemon, type DaemonHandle } from "../src/main.js";

const TOKEN = "fs-token";
const root = mkdtempSync(join(tmpdir(), "wsp-fsgit-root-"));
const outside = mkdtempSync(join(tmpdir(), "wsp-fsgit-outside-"));
const repo = join(root, "repo");
const bigRepo = join(root, "bigrepo");

interface WireMsg {
  id?: string | number | null;
  ok?: boolean;
  error?: string;
  code?: string;
  [k: string]: unknown;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
  });
}

function buildRepo(): void {
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# readme\n");
  writeFileSync(join(repo, "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\nbuild/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  git(repo, "add", "feature.txt");
  git(repo, "commit", "-q", "-m", "feature");
  writeFileSync(join(repo, "src", "index.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "staged.txt"), "staged\n");
  git(repo, "add", "staged.txt");
  git(repo, "mv", "README.md", "docs.md");
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");
  writeFileSync(join(repo, "ignored.log"), "log\n");
  mkdirSync(join(repo, "build"));
  writeFileSync(join(repo, "build", "out.js"), "out\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync(outside, join(repo, "escape"));
  symlinkSync(join(repo, "docs.md"), join(repo, "docs-link.md"));
  writeFileSync(join(root, "big.bin"), Buffer.alloc(FS_READ_CAP_BYTES + 10, 7));
  writeFileSync(join(root, "multibyte.txt"), "héllo wörld\n");

  mkdirSync(bigRepo);
  git(bigRepo, "init", "-q", "-b", "main");
  git(bigRepo, "config", "commit.gpgsign", "false");
  writeFileSync(join(bigRepo, "large.txt"), "one line\n");
  writeFileSync(join(bigRepo, "small.txt"), "small\n");
  git(bigRepo, "add", "-A");
  git(bigRepo, "commit", "-q", "-m", "init");
  const lines: string[] = [];
  for (let i = 0; i < 120_000; i++) lines.push(`line ${i} ${"x".repeat(20)}`);
  writeFileSync(join(bigRepo, "large.txt"), lines.join("\n") + "\n");
  writeFileSync(join(bigRepo, "small.txt"), "small changed\n");
}

async function connect(port: number): Promise<{
  request: (op: string, params?: Record<string, unknown>) => Promise<WireMsg>;
  close: () => void;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const pending = new Map<number, (m: WireMsg) => void>();
  let nextId = 1;
  ws.on("message", raw => {
    const m = JSON.parse(String(raw)) as WireMsg;
    if (typeof m.id === "number" && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  });
  return {
    request: (op, params = {}) => {
      const id = nextId++;
      return new Promise(resolve => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, op, ...params }));
      });
    },
    close: () => ws.close(),
  };
}

let daemon: DaemonHandle;
let c: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  buildRepo();
  daemon = await startDaemon({ port: 0, token: TOKEN, root, portsSource: async () => [] });
  c = await connect(daemon.port);
});

afterAll(async () => {
  c?.close();
  await daemon?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const names = (m: WireMsg) => (m["entries"] as { name: string }[]).map(e => e.name).sort();
const byName = (m: WireMsg, name: string) => (m["entries"] as Record<string, unknown>[]).find(e => e["name"] === name);

describe("fs.list", () => {
  it("lists direct children with type, size and mtime", async () => {
    const res = await c.request("fs.list", { path: "repo" });
    expect(res.ok).toBe(true);
    expect(res["truncated"]).toBe(false);
    expect(names(res)).toEqual(
      [".git", ".gitignore", "build", "docs-link.md", "docs.md", "escape", "feature.txt", "ignored.log", "src", "staged.txt", "untracked.txt"].sort(),
    );
    expect(byName(res, "src")).toMatchObject({ type: "dir", size: 0 });
    expect(byName(res, "escape")).toMatchObject({ type: "symlink" });
    expect(byName(res, "docs-link.md")).toMatchObject({ type: "symlink" });
    const staged = byName(res, "staged.txt")!;
    expect(staged).toMatchObject({ type: "file", size: 7 });
    expect(typeof staged["mtime"]).toBe("number");
    expect(staged["mtime"] as number).toBeGreaterThan(1_600_000_000_000);
  });

  it("orders directories first, then by name", async () => {
    const res = await c.request("fs.list", { path: "repo", gitignore: true });
    const order = (res["entries"] as { name: string; type: string }[]).map(e => `${e.type}:${e.name}`);
    const firstFile = order.findIndex(x => !x.startsWith("dir:"));
    expect(order.slice(0, firstFile).every(x => x.startsWith("dir:"))).toBe(true);
    expect(order.slice(firstFile).some(x => x.startsWith("dir:"))).toBe(false);
  });

  it("walks to the requested depth with slash-joined names and never through symlinks", async () => {
    const res = await c.request("fs.list", { path: "repo", depth: 2, gitignore: true });
    expect(names(res)).toContain("src/index.ts");
    expect(names(res)).toContain(".git/HEAD");
    expect(names(res).some(n => n.startsWith("escape/"))).toBe(false);
  });

  it("hides gitignored entries and does not descend into ignored directories when asked", async () => {
    const plain = await c.request("fs.list", { path: "repo", depth: 2 });
    expect(names(plain)).toContain("ignored.log");
    expect(names(plain)).toContain("build/out.js");
    const filtered = await c.request("fs.list", { path: "repo", depth: 2, gitignore: true });
    expect(names(filtered)).not.toContain("ignored.log");
    expect(names(filtered)).not.toContain("build");
    expect(names(filtered)).not.toContain("build/out.js");
    expect(names(filtered)).toContain("untracked.txt");
    expect(names(filtered)).toContain(".gitignore");
  });

  it("treats the gitignore flag as a no-op outside a git repo", async () => {
    const res = await c.request("fs.list", { path: ".", gitignore: true });
    expect(res.ok).toBe(true);
    expect(names(res)).toEqual(["big.bin", "bigrepo", "multibyte.txt", "repo"]);
  });

  it("accepts an absolute path inside the root and refuses one outside", async () => {
    const inside = await c.request("fs.list", { path: join(root, "repo", "src") });
    expect(names(inside)).toEqual(["index.ts"]);
    const out = await c.request("fs.list", { path: outside });
    expect(out).toMatchObject({ ok: false, code: "outside-root" });
  });

  it("refuses .. escapes and symlinks that leave the root with a typed error", async () => {
    expect(await c.request("fs.list", { path: ".." })).toMatchObject({ ok: false, code: "outside-root" });
    expect(await c.request("fs.list", { path: "repo/../.." })).toMatchObject({ ok: false, code: "outside-root" });
    expect(await c.request("fs.list", { path: "repo/escape" })).toMatchObject({ ok: false, code: "outside-root" });
  });

  it("types a file target and a missing target", async () => {
    expect(await c.request("fs.list", { path: "repo/docs.md" })).toMatchObject({ ok: false, code: "not-a-directory" });
    expect(await c.request("fs.list", { path: "repo/nope" })).toMatchObject({ ok: false, code: "not-found" });
    expect(await c.request("fs.list", { path: 7 })).toMatchObject({ ok: false, code: "bad-request" });
  });
});

describe("listDir entry cap", () => {
  it("stops at the cap and flags the listing as truncated", async () => {
    const res = await listDir(join(root, "repo"), { depth: 2, maxEntries: 3 });
    expect(res.entries).toHaveLength(3);
    expect(res.truncated).toBe(true);
    const full = await listDir(join(root, "repo"), { depth: 2 });
    expect(full.truncated).toBe(false);
    expect(full.entries.length).toBeGreaterThan(3);
  });
});

describe("fs.read", () => {
  it("reads utf8 by default and reports the byte size", async () => {
    const res = await c.request("fs.read", { path: "repo/staged.txt" });
    expect(res).toMatchObject({ ok: true, content: "staged\n", size: 7, truncated: false });
    const mb = await c.request("fs.read", { path: "multibyte.txt" });
    expect(mb["content"]).toBe("héllo wörld\n");
    expect(mb["size"]).toBe(Buffer.byteLength("héllo wörld\n"));
  });

  it("reads base64 when asked", async () => {
    const res = await c.request("fs.read", { path: "repo/staged.txt", encoding: "base64" });
    expect(Buffer.from(res["content"] as string, "base64").toString()).toBe("staged\n");
  });

  it("follows a symlink that stays inside and refuses one that leaves", async () => {
    const ok = await c.request("fs.read", { path: "repo/docs-link.md" });
    expect(ok).toMatchObject({ ok: true, content: "# readme\n" });
    const bad = await c.request("fs.read", { path: "repo/escape/secret.txt" });
    expect(bad).toMatchObject({ ok: false, code: "outside-root" });
  });

  it("caps content at 2 MiB and flags the cut", async () => {
    const res = await c.request("fs.read", { path: "big.bin", encoding: "base64" });
    expect(res["truncated"]).toBe(true);
    expect(res["size"]).toBe(FS_READ_CAP_BYTES + 10);
    expect(Buffer.from(res["content"] as string, "base64").length).toBe(FS_READ_CAP_BYTES);
  });

  it("types directories, missing files and bad encodings", async () => {
    expect(await c.request("fs.read", { path: "repo/src" })).toMatchObject({ ok: false, code: "not-a-file" });
    expect(await c.request("fs.read", { path: "repo/none.txt" })).toMatchObject({ ok: false, code: "not-found" });
    expect(await c.request("fs.read", { path: "repo/docs.md", encoding: "hex" })).toMatchObject({ ok: false, code: "bad-request" });
  });
});

describe("git.status", () => {
  it("parses the branch header and every entry kind from porcelain v2", async () => {
    const res = await c.request("git.status", { cwd: "repo" });
    expect(res.ok).toBe(true);
    const branch = res["branch"] as Record<string, unknown>;
    expect(branch["head"]).toBe("feature");
    expect(branch["oid"]).toMatch(/^[0-9a-f]{40}$/);
    expect(branch).toMatchObject({ ahead: 0, behind: 0 });
    expect(branch["upstream"]).toBeUndefined();
    const entries = res["entries"] as Record<string, unknown>[];
    expect(entries).toContainEqual({ xy: ".M", path: "src/index.ts" });
    expect(entries).toContainEqual({ xy: "A.", path: "staged.txt" });
    expect(entries).toContainEqual({ xy: "R.", path: "docs.md", origPath: "README.md" });
    expect(entries).toContainEqual({ xy: "??", path: "untracked.txt" });
    expect(entries.some(e => e["path"] === "ignored.log")).toBe(false);
  });

  it("reports ahead/behind against an upstream", async () => {
    git(repo, "branch", "--set-upstream-to=main", "feature");
    const res = await c.request("git.status", { cwd: "repo" });
    expect(res["branch"]).toMatchObject({ upstream: "main", ahead: 1, behind: 0 });
    git(repo, "branch", "--unset-upstream", "feature");
  });

  it("works from a subdirectory and reports repo-relative paths", async () => {
    const res = await c.request("git.status", { cwd: "repo/src" });
    const entries = res["entries"] as Record<string, unknown>[];
    expect(entries).toContainEqual({ xy: ".M", path: "src/index.ts" });
  });

  it("types a non-repo and a confined cwd", async () => {
    expect(await c.request("git.status", { cwd: "." })).toMatchObject({ ok: false, code: "not-a-git-repo" });
    expect(await c.request("git.status", { cwd: "../" })).toMatchObject({ ok: false, code: "outside-root" });
  });
});

describe("git.diff", () => {
  const paths = (m: WireMsg) => (m["files"] as { path: string }[]).map(f => f.path).sort();
  const patchOf = (m: WireMsg, p: string) => (m["files"] as { path: string; patch: string }[]).find(f => f.path === p)?.patch;

  it("unstaged: working tree against the index", async () => {
    const res = await c.request("git.diff", { cwd: "repo", scope: "unstaged" });
    expect(res).toMatchObject({ ok: true, base: null, truncated: false });
    expect(paths(res)).toEqual(["src/index.ts"]);
    const patch = patchOf(res, "src/index.ts")!;
    expect(patch).toContain("diff --git a/src/index.ts b/src/index.ts");
    expect(patch).toContain("-export const a = 1;");
    expect(patch).toContain("+export const a = 2;");
  });

  it("staged: index against HEAD, renames kept as renames", async () => {
    const res = await c.request("git.diff", { cwd: "repo", scope: "staged" });
    expect(paths(res)).toEqual(["docs.md", "staged.txt"]);
    expect(patchOf(res, "docs.md")).toContain("rename from README.md");
    expect(patchOf(res, "staged.txt")).toContain("+staged");
  });

  it("branch: everything since the merge-base with the default branch", async () => {
    const res = await c.request("git.diff", { cwd: "repo", scope: "branch" });
    expect(res["base"]).toBe("main");
    expect(paths(res)).toEqual(["docs.md", "feature.txt", "src/index.ts", "staged.txt"]);
    expect(patchOf(res, "feature.txt")).toContain("+feature");
  });

  it("narrows to a path", async () => {
    const res = await c.request("git.diff", { cwd: "repo", scope: "branch", path: "src" });
    expect(paths(res)).toEqual(["src/index.ts"]);
    const none = await c.request("git.diff", { cwd: "repo", scope: "unstaged", path: "feature.txt" });
    expect(none).toMatchObject({ ok: true, files: [] });
  });

  it("stays clean on a branch with nothing to show", async () => {
    const res = await c.request("git.diff", { cwd: "repo", scope: "staged", path: "src" });
    expect(res).toMatchObject({ ok: true, files: [], truncated: false });
  });

  it("caps the total patch bytes and flags the cut without dropping small files silently", async () => {
    const res = await c.request("git.diff", { cwd: "bigrepo", scope: "unstaged" });
    expect(res.ok).toBe(true);
    expect(res["truncated"]).toBe(true);
    const files = res["files"] as { path: string; patch: string }[];
    const total = files.reduce((n, f) => n + Buffer.byteLength(f.patch), 0);
    expect(total).toBeLessThanOrEqual(GIT_DIFF_CAP_BYTES);
    expect(files.map(f => f.path)).toEqual(["large.txt", "small.txt"]);
    expect(patchOf(res, "small.txt")).toBe("");
    expect(patchOf(res, "large.txt")!.startsWith("diff --git a/large.txt b/large.txt")).toBe(true);
  });

  it("types bad scopes, non-repos and confined cwds", async () => {
    expect(await c.request("git.diff", { cwd: "repo", scope: "all" })).toMatchObject({ ok: false, code: "bad-request" });
    expect(await c.request("git.diff", { cwd: ".", scope: "unstaged" })).toMatchObject({ ok: false, code: "not-a-git-repo" });
    expect(await c.request("git.diff", { cwd: "repo/escape", scope: "unstaged" })).toMatchObject({ ok: false, code: "outside-root" });
  });
});
