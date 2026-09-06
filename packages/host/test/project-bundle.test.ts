// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INSTALL_NAMES, OUTPUT_NAMES } from "@wsp/collect";
import { afterEach, describe, expect, it } from "vitest";
import { isCacheName, packProject, planProject, projectBundler } from "../src/project-bundle.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BINARY = Buffer.concat([Buffer.from("#!/bin/sh\necho run\n"), randomBytes(2048), Buffer.from([0x00, 0xff, 0x0a])]);

function put(root: string, rel: string, content: string | Buffer, mode?: number): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (mode !== undefined) chmodSync(abs, mode);
}

const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).toString();

/** A repository with tracked source, committed build output, untracked notes, ignored state and every cache shape. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-proj-"));
  dirs.push(root);
  git(root, "init", "-q");
  put(root, "src/index.ts", "export const a = 1;\n");
  put(root, "bin/run.sh", BINARY, 0o755);
  put(root, "dist/keep.js", "tracked output\n");
  put(root, "build/README.md", "tracked doc in a build dir\n");
  put(root, ".gitignore", "node_modules\ndist\nbuild\n.env\n*.sqlite\n.venv\nenv\n.cache\ntarget\n.mypy_cache\n.eslintcache\n");
  git(root, "add", "-f", "src", "bin", ".gitignore", "dist/keep.js", "build/README.md");
  git(root, "commit", "-q", "-m", "init");
  put(root, "notes.txt", "untracked, carried\n");
  put(root, ".env", "API_TOKEN=sk-ant-x\n");
  put(root, ".env.example", "API_TOKEN=\n");
  put(root, "config/secrets.json", JSON.stringify({ token: "sk-ant-x" }));
  put(root, "config/settings.json", JSON.stringify({ theme: "dark" }));
  put(root, "keys/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n", 0o600);
  put(root, "keys/id_ed25519.pub", "ssh-ed25519 AAAA dev\n");
  put(root, "data.sqlite", randomBytes(600));
  put(root, "node_modules/left/index.js", "cache\n");
  put(root, "dist/output.js", "untracked output beside the tracked file\n");
  put(root, "build/app.js", "untracked output\n");
  put(root, ".venv/lib/python3/site-packages/x.py", "venv\n");
  put(root, "env/pyvenv.cfg", "home = /usr/bin\n");
  put(root, "env/bin/python", "venv by marker\n");
  put(root, ".cache/x", "cache\n");
  put(root, "target/debug/bin", "rust output\n");
  put(root, ".mypy_cache/3.12/x.json", "{}");
  put(root, ".eslintcache", "cache file\n");
  put(root, "empty-dir/.keep", "");
  mkdirSync(join(root, "really-empty"));
  symlinkSync("src/index.ts", join(root, "inside-link"));
  symlinkSync("/etc/hosts", join(root, "outside-link"));
  symlinkSync("../elsewhere", join(root, "up-link"));
  return root;
}

const extract = (tgz: Buffer): string => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-proj-out-"));
  dirs.push(dir);
  execFileSync("tar", ["-xzf", "-", "-C", dir], { input: tgz });
  return dir;
};

const listed = (tgz: Buffer): string[] => execFileSync("tar", ["-tzf", "-"], { input: tgz }).toString().trim().split("\n").filter(l => l !== "").sort();

describe("planProject", () => {
  it("carries the tracked tree, the untracked and ignored state and the repository, and leaves every cache shape behind", async () => {
    const root = fixture();
    const { plan, files } = await planProject(root);
    const rels = files.map(f => f.rel);
    expect(plan.repo).toBe(true);
    expect(plan.source).toBe(root);
    for (const kept of ["src/index.ts", "bin/run.sh", "notes.txt", ".env", "config/secrets.json", "data.sqlite", ".git/HEAD", ".git/config", "dist/keep.js", "build/README.md", "empty-dir/.keep", "really-empty", "inside-link"]) {
      expect(rels, kept).toContain(kept);
    }
    expect(rels.some(r => r.startsWith(".git/objects/"))).toBe(true);
    for (const gone of ["node_modules/left/index.js", "dist/output.js", "build/app.js", ".venv/lib/python3/site-packages/x.py", "env/bin/python", ".cache/x", "target/debug/bin", ".mypy_cache/3.12/x.json", ".eslintcache", "outside-link", "up-link"]) {
      expect(rels, gone).not.toContain(gone);
    }
    expect(plan.excluded).toEqual([".cache", ".eslintcache", ".mypy_cache", ".venv", "build", "dist", "env", "node_modules", "target"]);
    expect(plan.skipped).toEqual([
      { path: "outside-link", note: "a link to /etc/hosts, outside the folder; not followed" },
      { path: "up-link", note: "a link to ../elsewhere, outside the folder; not followed" },
    ]);
    expect(files.find(f => f.rel === "bin/run.sh")).toMatchObject({ mode: 0o755, bytes: BINARY.length });
    expect(files.find(f => f.rel === "inside-link")).toMatchObject({ kind: "link", target: "src/index.ts" });
    const regular = files.filter(f => f.kind === "file");
    expect(plan.files).toBe(regular.length);
    expect(plan.bytes).toBe(regular.reduce((n, f) => n + (f.kind === "file" ? f.bytes : 0), 0));
  });

  it("names the secret-shaped files by the collector's rules and nothing else", async () => {
    const root = fixture();
    const { plan } = await planProject(root);
    expect(plan.secrets).toEqual([
      { path: ".env", bytes: Buffer.byteLength("API_TOKEN=sk-ant-x\n"), signals: ["name", "keys"] },
      { path: "config/secrets.json", bytes: Buffer.byteLength(JSON.stringify({ token: "sk-ant-x" })), signals: ["name", "keys"] },
      { path: "keys/id_ed25519", bytes: Buffer.byteLength("-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n"), signals: ["name", "mode", "pem"] },
    ]);
  });

  it("a folder without a repository travels as files under the same cache rules", async () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-plain-"));
    dirs.push(root);
    put(root, "a.txt", "a\n");
    put(root, "dist/b.js", "b\n");
    put(root, "node_modules/c/index.js", "c\n");
    const { plan, files } = await planProject(root);
    expect(plan.repo).toBe(false);
    expect(files.map(f => f.rel)).toEqual(["a.txt"]);
    expect(plan.excluded).toEqual(["dist", "node_modules"]);
  });

  it("a .git file is named and left: the repository it points at does not travel", async () => {
    const root = fixture();
    const tree = mkdtempSync(join(tmpdir(), "wsp-wt-"));
    dirs.push(tree);
    rmSync(tree, { recursive: true });
    git(root, "worktree", "add", "-q", tree, "-b", "side");
    const { plan, files } = await planProject(tree);
    expect(plan.repo).toBe(true);
    expect(files.map(f => f.rel)).not.toContain(".git");
    expect(plan.skipped).toEqual([{ path: ".git", note: expect.stringMatching(/^a worktree or submodule checkout: its repository is at .*worktrees\/.* and does not travel$/) }]);
    expect(files.map(f => f.rel)).toContain("src/index.ts");
  });

  it("refuses a relative path and a path that is not a folder", async () => {
    await expect(planProject("relative/dir")).rejects.toThrow(/absolute path/);
    const root = fixture();
    await expect(planProject(join(root, "notes.txt"))).rejects.toThrow(/not a folder/);
    await expect(planProject(join(root, "missing"))).rejects.toThrow(/not a folder/);
  });

  it("the cache rule is the collector's name sets plus the word", () => {
    for (const n of [...INSTALL_NAMES, ...OUTPUT_NAMES]) expect(isCacheName(n)).toBe(true);
    for (const n of [".parcel-cache", "__pycache__", ".pytest_cache", "CacheStorage"]) expect(isCacheName(n)).toBe(true);
    for (const n of ["src", "lib", "cached-results.md", "Cargo.lock", "yarn.lock"]) expect(isCacheName(n)).toBe(n === "cached-results.md");
  });
});

describe("packProject", () => {
  it("round-trips every byte, the exec bit, the empty directory and the link; secret-shaped files travel only when named", async () => {
    const root = fixture();
    const listing = await planProject(root);
    const packed = packProject(listing, new Set([".env"]));
    expect(packed.cut).toEqual(["config/secrets.json", "keys/id_ed25519"]);
    expect(packed.files).toBe(listing.plan.files - 2);
    const names = listed(packed.tar);
    expect(names).toContain(".env");
    expect(names).not.toContain("config/secrets.json");
    expect(names).not.toContain("keys/id_ed25519");
    expect(names).toContain("keys/id_ed25519.pub");
    const out = extract(packed.tar);
    expect(readFileSync(join(out, "bin/run.sh")).equals(BINARY)).toBe(true);
    expect(statSync(join(out, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(out, "data.sqlite")).equals(readFileSync(join(root, "data.sqlite")))).toBe(true);
    expect(statSync(join(out, "really-empty")).isDirectory()).toBe(true);
    expect(lstatSync(join(out, "inside-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(out, "inside-link"))).toBe("src/index.ts");
    expect(existsSync(join(out, "node_modules"))).toBe(false);
    const status = (dir: string): string[] => git(dir, "status", "--porcelain").split("\n").filter(l => l !== "").sort();
    expect(status(out)).toEqual(status(root).filter(l => !/outside-link|up-link/.test(l)));
    expect(status(out)).toContain("?? .env.example");
    expect(git(out, "log", "--format=%H")).toBe(git(root, "log", "--format=%H"));
  });

  it("with nothing named every secret-shaped file is cut", async () => {
    const listing = await planProject(fixture());
    const packed = packProject(listing, new Set());
    expect(packed.cut).toEqual([".env", "config/secrets.json", "keys/id_ed25519"]);
    expect(listed(packed.tar)).not.toContain(".env");
  });
});

describe("projectBundler", () => {
  it("plans once and packs from that plan with the consent given", async () => {
    const root = fixture();
    const b = projectBundler(root);
    const plan = await b.plan();
    expect(plan.secrets.map(s => s.path)).toEqual([".env", "config/secrets.json", "keys/id_ed25519"]);
    expect(await b.plan()).toBe(plan);
    const packed = await b.pack(new Set([".env"]));
    expect(packed.cut).toEqual(["config/secrets.json", "keys/id_ed25519"]);
    expect(packed.files).toBe(plan.files - 2);
    const names = listed(packed.tar);
    expect(names).toContain(".env");
    expect(names).not.toContain("config/secrets.json");
  });
});
