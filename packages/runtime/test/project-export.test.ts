// SPDX-License-Identifier: AGPL-3.0-only
import { gzipSync } from "node:zlib";
import { guestAgentHomes, tarOf } from "@wsp/engine";
import type { EventUnion, ProjectExportEvent } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type LandRequest, type LandedProject, type ProjectLander } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { wsRequest } from "./ws-client.js";

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const SOURCE = "/root/work/proj";
const DEST = "/Users/dev/code/proj";
const FOLDER_TGZ = tarOf([{ path: "./src/index.ts", mode: 0o644, content: "export const a = 1;\n" }]);
const STATE_TGZ = tarOf([{ path: "root/.claude-cfg/projects/-root-work-proj/S1.jsonl", mode: 0o644, content: `{"cwd":"${SOURCE}"}\n` }]);
const EXCLUDED = "node_modules\ndist\n";
const ROOTS = ["/root/.claude-cfg/projects", "/root/.codex/state_5.sqlite", "/root/.codex/sessions", "/root/.gemini/projects.json", "/root/.gemini/tmp", "/root/.gemini/history", "/root/.local/share/opencode/opencode.db", "/root/.pi/agent/sessions", "/root/.hermes/state.db"];

/** What the host would do on this computer: remember the probe and the landing, answer with a small result. */
function fakeLander(existing?: number): ProjectLander & { probes: string[]; landings: LandRequest[] } {
  const probes: string[] = [];
  const landings: LandRequest[] = [];
  return {
    probes,
    landings,
    caches: { globs: ["node_modules", "dist"], markers: ["pyvenv.cfg"] },
    probe: async dest => {
      probes.push(dest);
      return existing === undefined ? undefined : { files: existing };
    },
    land: async (req): Promise<LandedProject> => {
      landings.push(req);
      const agents = req.state === undefined ? [] : [
        { agent: "claude", name: "Claude Code", files: 3, bytes: 300, outcome: "moved" as const, sessions: 2 },
        { agent: "codex", name: "Codex", files: 1, bytes: 100, outcome: "transcript-only" as const, sessions: 2, skipped: 1 },
        { agent: "hermes", name: "Hermes Agent", files: 0, bytes: 0, outcome: "nothing" as const, sessions: 1 },
      ];
      return { files: 3, bytes: 4000, agents: req.state?.agents === undefined ? agents : agents.filter(a => req.state!.agents!.includes(a.agent)) };
    },
  };
}

/** The machine: the folder is there, the archives it packs are served for download, and the agent state roots named exist. */
function machineWith(backend: StubBackend, present: readonly string[]): void {
  const base = backend.execImpl;
  const tars = new Map<string, Buffer>();
  backend.downloads = path => tars.get(path) ?? gzipSync(Buffer.alloc(1024));
  backend.execImpl = (m, cmd) => {
    if (cmd.startsWith("test -d ")) return { exitCode: 0, stdout: "yes\n", stderr: "" };
    if (cmd.startsWith("for p in ")) return { exitCode: 0, stdout: present.map(p => `${p}\n`).join(""), stderr: "" };
    const out = /tar czf '([^']+)'/.exec(cmd)?.[1];
    if (out !== undefined && cmd.includes("find .")) {
      tars.set(out, FOLDER_TGZ);
      return { exitCode: 0, stdout: EXCLUDED, stderr: "" };
    }
    if (out !== undefined) {
      tars.set(out, STATE_TGZ);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const sized = /^wc -c < '([^']+)'/.exec(cmd)?.[1];
    if (sized !== undefined) return { exitCode: 0, stdout: `${tars.get(sized)?.length ?? 0}\n`, stderr: "" };
    return base(m, cmd);
  };
}

const exports = (events: EventUnion[]): ProjectExportEvent[] => events.filter((e): e is ProjectExportEvent => e.type === "project.export");

describe("project.export on a workspace", () => {
  it("packs the folder on the machine under the lander's cache rule, brings it and the agents' state roots home, lands both through the lander and reports each stage and every agent", async () => {
    const backend = stubBackend();
    machineWith(backend, ["/root/.claude-cfg/projects", "/root/.codex/state_5.sqlite", "/root/.codex/sessions", "/root/.hermes/state.db"]);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const lander = fakeLander();
    const result = await rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, lander });
    expect(result).toEqual({
      dest: DEST,
      files: 3,
      bytes: 4000,
      excluded: ["dist", "node_modules"],
      agents: [
        { agent: "claude", files: 3, bytes: 300, outcome: "moved", sessions: 2 },
        { agent: "codex", files: 1, bytes: 100, outcome: "transcript-only", sessions: 2, skipped: 1 },
        { agent: "hermes", files: 0, bytes: 0, outcome: "nothing", sessions: 1 },
      ],
    });
    expect(lander.probes).toEqual([DEST]);
    expect(lander.landings).toHaveLength(1);
    const landing = lander.landings[0]!;
    expect(landing).toMatchObject({ source: SOURCE, dest: DEST, replace: false });
    expect(landing.tar.equals(FOLDER_TGZ)).toBe(true);
    expect(landing.state?.tar.equals(STATE_TGZ)).toBe(true);
    expect(landing.state?.homes).toEqual(guestAgentHomes());
    expect(landing.state?.agents).toBeUndefined();
    const stages = exports(events);
    expect(stages.map(e => e.stage)).toEqual(["packing", "downloading", "downloading", "packing", "downloading", "downloading", "landing", "done"]);
    expect(stages[0]!.message).toBe(`Packing ${SOURCE} on the machine.`);
    expect(stages[1]).toMatchObject({ message: `The folder: 0 B of ${FOLDER_TGZ.length} B.`, bytes: 0, total: FOLDER_TGZ.length });
    expect(stages[2]).toMatchObject({ bytes: FOLDER_TGZ.length, total: FOLDER_TGZ.length });
    expect(stages[3]!.message).toBe("Packing the agents' state for it on the machine.");
    expect(stages[4]!.message).toMatch(/^Agent state: 0 B of /);
    expect(stages[6]!.message).toBe(`Landing at ${DEST}.`);
    expect(stages[7]!.message).toBe(`3 files, 3.9 KB, landed at ${DEST}; 2 caches left behind; sessions: Claude Code (2 sessions) moved, Codex (2 sessions) transcripts landed but not yet in its session list here, 1 indexed rollout not under sessions/ skipped, Hermes Agent (1 session) had nothing to bring.`);
    for (const e of stages) expect(e).toMatchObject({ workspaceId: ws.id, source: SOURCE, dest: DEST, elapsedMs: expect.any(Number) });
    const machine = backend.machines[0]!;
    expect(machine.execLog.some(c => c === `test -d '${SOURCE}' && echo yes || echo no`)).toBe(true);
    const pack = machine.runLog.find(s => s.includes("find ."))!;
    expect(pack).toContain(`cd '${SOURCE}'`);
    expect(pack).toContain("-name 'node_modules' -o -name 'dist' -o \\( -type d -exec test -f '{}/pyvenv.cfg' \\; \\)");
    expect(pack).toMatch(/tar czf '\/tmp\/wsp-out-[^']+\.tgz' -X '\/tmp\/wsp-out-[^']+\.tgz\.list' \./);
    const probe = machine.execLog.find(c => c.startsWith("for p in "))!;
    expect(probe).toBe(`for p in ${ROOTS.map(r => `'${r}'`).join(" ")}; do test -e "$p" && echo "$p"; done; true`);
    const state = machine.runLog.find(s => s.startsWith("tar czf") && s.includes("-C /"))!;
    expect(state).toMatch(/^tar czf '\/tmp\/wsp-vault-[^']+\.tgz' -C \/ 'root\/.claude-cfg\/projects' 'root\/.codex\/state_5.sqlite' 'root\/.codex\/sessions' 'root\/.hermes\/state.db'$/);
    expect(machine.execLog.filter(c => c.startsWith("rm -f '/tmp/wsp-"))).toHaveLength(2);
  });

  it("an existing destination is refused with kind exists before anything is asked of the machine, and replaced when asked", async () => {
    const backend = stubBackend();
    machineWith(backend, []);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const commands = backend.machines[0]!.execLog.length;
    const lander = fakeLander(12);
    await expect(rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, lander })).rejects.toMatchObject({ kind: "exists", message: `${DEST} already exists on this computer with 12 files; export with replace to overwrite it` });
    expect(backend.machines[0]!.execLog).toHaveLength(commands);
    expect(lander.landings).toEqual([]);
    expect(exports(events).map(e => [e.stage, e.message])).toEqual([["failed", `${DEST} already exists on this computer with 12 files; export with replace to overwrite it`]]);
    events.length = 0;
    const result = await rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, replace: true, lander });
    expect(lander.landings[0]).toMatchObject({ replace: true });
    expect(lander.landings[0]!.state).toBeUndefined();
    expect(result.agents).toEqual([]);
    expect(exports(events).map(e => e.stage)).toEqual(["packing", "downloading", "downloading", "landing", "done"]);
    expect(exports(events).at(-1)!.message).toBe(`3 files, 3.9 KB, landed at ${DEST}; 2 caches left behind; no agent sessions for it on the machine.`);
  });

  it("agents named narrow the roots looked for on the machine and reach the lander", async () => {
    const backend = stubBackend();
    machineWith(backend, ["/root/.claude-cfg/projects"]);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const lander = fakeLander();
    const result = await rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, agents: ["claude", "pi"], lander });
    const probe = backend.machines[0]!.execLog.find(c => c.startsWith("for p in "))!;
    expect(probe).toContain("for p in '/root/.claude-cfg/projects' '/root/.pi/agent/sessions'; do");
    expect(lander.landings[0]!.state?.agents).toEqual(["claude", "pi"]);
    expect(result.agents.map(a => a.agent)).toEqual(["claude"]);
  });

  it("a folder that is not on the machine, a napping workspace and an unknown one are refused, the lander never asked to land", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const lander = fakeLander();
    await expect(rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, lander })).rejects.toThrow(`${SOURCE} is not a folder on the machine`);
    await rt.workspaces.nap(ws.id);
    await expect(rt.projects.export({ workspaceId: ws.id, source: SOURCE, dest: DEST, lander })).rejects.toThrow(/^Workspace is paused; wake it to export$/);
    await expect(rt.projects.export({ workspaceId: "ws_nope", source: SOURCE, dest: DEST, lander })).rejects.toThrow(/no such workspace/);
    expect(lander.landings).toEqual([]);
    expect(lander.probes).toEqual([DEST]);
  });

  it("over the wire the host's lander answers project.export; a server without one refuses it", async () => {
    const backend = stubBackend();
    machineWith(backend, []);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const lander = fakeLander();
    srv = await serveRuntime(rt, { port: 0, authToken: "t", landing: lander });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "task-1" });
    const exported = await wsRequest(srv.port, "t", { op: "project.export", workspaceId: ws.id, source: SOURCE, dest: DEST, agents: ["claude"] });
    expect(exported).toMatchObject({ ok: true, exported: { dest: DEST, files: 3, bytes: 4000, excluded: ["dist", "node_modules"], agents: [] } });
    expect(lander.landings[0]).toMatchObject({ source: SOURCE, dest: DEST, replace: false });
    await srv.close();
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "project.export", workspaceId: ws.id, source: SOURCE, dest: DEST })).toMatchObject({ ok: false, error: "this runtime cannot write folders on this computer" });
    const refused = await wsRequest(srv.port, "t", { op: "project.export", workspaceId: ws.id, source: SOURCE, dest: DEST, replace: false });
    expect(refused["ok"]).toBe(false);
  });
});
