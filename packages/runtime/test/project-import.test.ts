// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarOf } from "@wsp/engine";
import type { EventUnion, ProjectImportEvent, ProjectPlan, ProjectSecret } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type PackedProject, type ProjectBundler } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { wsRequest } from "./ws-client.js";

const dirs: string[] = [];
let srv: RuntimeServer | undefined;
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await srv?.close();
  srv = undefined;
});

const BINARY = Buffer.concat([Buffer.from("#!/bin/sh\necho run\n"), randomBytes(2048), Buffer.from([0x00, 0xff, 0x0a])]);
const SOURCE = "/Users/dev/code/proj";

const GIT_CONFIG: ProjectSecret = { path: ".git/config", bytes: 300, signals: ["url"], rewrite: { urls: ["https://github.com/example/proj.git"], drop: [] } };
const AUTH_CONFIG: ProjectSecret = { path: ".git/config", bytes: 300, signals: ["keys", "url"], rewrite: { urls: ["https://github.com/example/proj.git"], drop: ["http.extraheader"] } };

/** What the host would hand the runtime for a small folder: three secret-shaped files, one binary with an exec bit. */
function fakeBundler(extra: ProjectSecret[] = []): ProjectBundler & { calls: string[] } {
  const plan: ProjectPlan = {
    source: SOURCE,
    repo: true,
    files: 6,
    bytes: 4321,
    secrets: [
      { path: ".env", bytes: 20, signals: ["name", "keys"] },
      ...extra,
      { path: "config/secrets.json", bytes: 25, signals: ["name", "keys"] },
      { path: "keys/id_ed25519", bytes: 80, signals: ["name", "mode", "pem"] },
    ],
    excluded: ["dist", "node_modules"],
    skipped: [],
  };
  const calls: string[] = [];
  return {
    calls,
    plan: async () => {
      calls.push("plan");
      return plan;
    },
    pack: async (carry, rewrite): Promise<PackedProject> => {
      calls.push(`pack ${[...carry].join(",")}${rewrite.size > 0 ? ` rewrite ${[...rewrite].join(",")}` : ""}`);
      const rewritten = plan.secrets.filter(s => s.rewrite !== undefined && rewrite.has(s.path)).map(s => s.path);
      const cut = plan.secrets.map(s => s.path).filter(p => !carry.has(p) && !rewritten.includes(p));
      const tar = tarOf([
        { path: "bin", mode: 0o755, dir: true },
        { path: "bin/run.sh", mode: 0o755, content: BINARY },
        { path: "src/index.ts", mode: 0o644, content: "export const a = 1;\n" },
        ...plan.secrets.filter(s => carry.has(s.path) || rewritten.includes(s.path)).map(s => ({ path: s.path, mode: 0o600, content: `${s.path} body\n` })),
      ]);
      return { tar, files: plan.files - cut.length, bytes: 4000, cut, rewritten };
    },
  };
}

const extract = (tgz: Buffer): string => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-import-out-"));
  dirs.push(dir);
  execFileSync("tar", ["-xzf", "-", "-C", dir], { input: tgz });
  return dir;
};

const imports = (events: EventUnion[]): ProjectImportEvent[] => events.filter((e): e is ProjectImportEvent => e.type === "project.import");

describe("project.import on a workspace", () => {
  it("plans, says what was consented, packs, uploads the archive whole, lands it at the path and reports done", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    // The create uploaded the machine context; the import's PUT is the one after it.
    const before = backend.puts.length;
    const bundler = fakeBundler();
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/work/proj", carry: [".env"], bundler });
    expect(bundler.calls).toEqual(["plan", "pack .env"]);
    expect(result).toEqual({ dest: "/root/work/proj", files: 4, bytes: 4000, parts: 1, cut: ["config/secrets.json", "keys/id_ed25519"], rewritten: [] });
    const stages = imports(events);
    expect(stages.map(e => e.stage)).toEqual(["planned", "consented", "packing", "uploading", "uploading", "landing", "done"]);
    expect(stages[0]!.message).toBe("6 files, 4.2 KB and the repository; 3 secret-shaped files; 2 caches left behind.");
    expect(stages[1]!.message).toBe("Carrying .env; cut config/secrets.json, keys/id_ed25519.");
    expect(stages[2]!.message).toBe("Packing 4 files.");
    expect(stages[3]).toMatchObject({ bytes: 0, total: expect.any(Number) });
    expect(stages[4]).toMatchObject({ bytes: stages[3]!.total, total: stages[3]!.total });
    expect(stages[5]!.message).toBe("Landing at /root/work/proj.");
    expect(stages[6]!.message).toBe("4 files, 3.9 KB, landed at /root/work/proj.");
    for (const e of stages) expect(e).toMatchObject({ workspaceId: ws.id, source: SOURCE, dest: "/root/work/proj", elapsedMs: expect.any(Number) });
    expect(backend.puts).toHaveLength(before + 1);
    const body = backend.puts[before]!.body;
    expect(body.length).toBe(stages[3]!.total);
    const out = extract(body);
    expect(readFileSync(join(out, "bin/run.sh")).equals(BINARY)).toBe(true);
    expect(statSync(join(out, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(out, ".env"), "utf8")).toBe(".env body\n");
    expect(existsSync(join(out, "config/secrets.json"))).toBe(false);
    const machine = backend.machines[0]!;
    expect(machine.execLog.some(c => c.startsWith("test -e '/root/work/proj'"))).toBe(true);
    const untar = machine.runLog.filter(s => s.includes("tar xzf")).at(-1)!;
    expect(untar).toMatch(/mkdir -p '\/root\/work\/proj\.wsp-in-[^']+'\n.*tar xzf - -C '\/root\/work\/proj\.wsp-in-[^']+' --no-same-owner/);
    const landing = machine.runLog.find(s => s.includes("mv "))!;
    expect(landing).toContain("mkdir -p '/root/work'");
    expect(landing).toMatch(/test ! -e '\/root\/work\/proj' \|\| exit 66\nmv '\/root\/work\/proj\.wsp-in-[^']+' '\/root\/work\/proj'/);
  });

  it("a rewrite the person accepted reaches the pack, is said in the consented line and named in the result", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const bundler = fakeBundler([GIT_CONFIG]);
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", carry: [".env"], rewrite: [".git/config"], bundler });
    expect(bundler.calls).toEqual(["plan", "pack .env rewrite .git/config"]);
    expect(result).toEqual({ dest: "/root/proj", files: 4, bytes: 4000, parts: 1, cut: ["config/secrets.json", "keys/id_ed25519"], rewritten: [".git/config"] });
    const stages = imports(events);
    expect(stages[0]!.message).toBe("6 files, 4.2 KB and the repository; 4 secret-shaped files; 2 caches left behind.");
    expect(stages[1]!.message).toBe("Carrying .env; rewriting .git/config to https://github.com/example/proj.git; cut config/secrets.json, keys/id_ed25519.");
    events.length = 0;
    await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/other", rewrite: [".git/config"], bundler: fakeBundler([AUTH_CONFIG]) });
    expect(imports(events)[1]!.message).toBe("Rewriting .git/config to https://github.com/example/proj.git without http.extraheader; cut .env, config/secrets.json, keys/id_ed25519.");
    events.length = 0;
    await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/third", rewrite: [".git/config"], bundler: fakeBundler([{ ...AUTH_CONFIG, rewrite: { urls: [], drop: ["http.extraheader"] } }]) });
    expect(imports(events)[1]!.message).toBe("Rewriting .git/config without http.extraheader; cut .env, config/secrets.json, keys/id_ed25519.");
  });

  it("an existing path is refused with kind exists before any byte goes up, and replaced when asked", async () => {
    const backend = stubBackend();
    const base = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.startsWith("test -e ") ? { exitCode: 0, stdout: "yes\n", stderr: "" } : base(m, cmd));
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const before = backend.puts.length;
    await expect(rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", bundler: fakeBundler() })).rejects.toMatchObject({ kind: "exists" });
    expect(backend.puts).toHaveLength(before);
    const first = imports(events);
    expect(first.map(e => e.stage)).toEqual(["planned", "consented", "packing", "uploading", "failed"]);
    expect(first[1]!.message).toBe("No secret-shaped file travels; cut .env, config/secrets.json, keys/id_ed25519.");
    expect(first[4]!.message).toBe("/root/proj already exists on the machine; import with replace to overwrite it");
    events.length = 0;
    const result = await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", replace: true, bundler: fakeBundler() });
    expect(result.dest).toBe("/root/proj");
    expect(backend.puts).toHaveLength(before + 1);
    expect(imports(events).map(e => e.stage)).toEqual(["planned", "consented", "packing", "uploading", "uploading", "landing", "done"]);
    const landing = backend.machines[0]!.runLog.find(s => s.includes("mv "))!;
    expect(landing).toContain("rm -rf '/root/proj'\nmv ");
    expect(landing).not.toContain("exit 66");
  });

  it("a napping workspace and an unknown one are refused before the folder is read", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    await rt.workspaces.nap(ws.id);
    const bundler = fakeBundler();
    await expect(rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: "/root/proj", bundler })).rejects.toThrow(/is napping; wake it before importing/);
    await expect(rt.projects.import({ workspaceId: "ws_nope", source: SOURCE, dest: "/root/proj", bundler })).rejects.toThrow(/no such workspace/);
    expect(bundler.calls).toEqual([]);
  });

  it("over the wire the host's bundler answers project.plan and feeds project.import; a server without one refuses both", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const sources: string[] = [];
    srv = await serveRuntime(rt, {
      port: 0,
      authToken: "t",
      projects: source => {
        sources.push(source);
        return fakeBundler([GIT_CONFIG]);
      },
    });
    const planned = await wsRequest(srv.port, "t", { op: "project.plan", source: SOURCE });
    expect(planned["ok"]).toBe(true);
    expect((planned["plan"] as ProjectPlan).secrets).toEqual(expect.arrayContaining([GIT_CONFIG]));
    expect((planned["plan"] as ProjectPlan).secrets.map(s => s.path)).toEqual([".env", ".git/config", "config/secrets.json", "keys/id_ed25519"]);
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const imported = await wsRequest(srv.port, "t", { op: "project.import", workspaceId: ws.id, source: SOURCE, dest: "/root/proj", carry: ["keys/id_ed25519"], rewrite: [".git/config"] });
    expect(imported["ok"]).toBe(true);
    expect(imported["imported"]).toEqual({ dest: "/root/proj", files: 4, bytes: 4000, parts: 1, cut: [".env", "config/secrets.json"], rewritten: [".git/config"] });
    expect(sources).toEqual([SOURCE, SOURCE]);
    await srv.close();
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const refused = await wsRequest(srv.port, "t", { op: "project.plan", source: SOURCE });
    expect(refused).toMatchObject({ ok: false, error: "this runtime cannot read folders on this computer" });
    expect(await wsRequest(srv.port, "t", { op: "project.import", workspaceId: ws.id, source: SOURCE, dest: "/root/other" })).toMatchObject({ ok: false, error: "this runtime cannot read folders on this computer" });
  });
});
