// SPDX-License-Identifier: AGPL-3.0-only
// The bundle and the landing a host wires read and write each agent's folder where a launch on this computer finds
// it: the one the person kept in Settings > Agents, else the agent's own, against fake homes under a temp folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { guestAgentHomes, tarOf } from "@wsp/engine";
import { HERE_PLACE_ID } from "@wsp/protocol";
import { createRuntime, HARNESS_ADAPTERS, memoryStore, type AgentsReader, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tarRead } from "../../engine/test/tar-read.js";
import { hostSeed, localWiring } from "../src/cli.js";
import { workspaceRoads } from "../src/server.js";
import { stubBackend } from "./stub-backend.js";

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const rt of runtimes.splice(0)) await rt.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const claudeKey = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");
const session = (id: string, cwd: string): string => `{"type":"user","cwd":"${cwd}","sessionId":"${id}"}\n`;

const READER: AgentsReader = {
  read: async () => ({ home: "/Users/ada", user: "ada", skills: [], servers: [], refused: [], agents: [{ id: "claude", name: "Claude Code", installed: true, version: "1.0.0", road: "own", signIn: "signed-in", signInRoad: "device", wspTools: false }] }),
  tools: async () => ({ auth: "open", readAt: "2026-10-01T12:00:00.000Z" }),
};

describe("the bundle and the landing on a host", () => {
  function setUp(): { user: string; source: string; rt: Runtime } {
    const user = scratch("wsp-homes-user-");
    const source = join(user, "proj");
    put(source, "src/index.ts", "export const a = 1;\n");
    // A road that reads the login's own home finds this one rather than the real one.
    vi.stubEnv("HOME", user);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: HARNESS_ADAPTERS.claude }, local: localWiring(user, { PATH: "/usr/bin:/bin" }), agentsReader: READER, seed: hostSeed() });
    runtimes.push(rt);
    return { user, source, rt };
  }

  it("read and write the config folder the person kept for Claude Code, and nothing under its own", async () => {
    const { user, source, rt } = setUp();
    const kept = join(user, "claude-work");
    put(kept, `projects/${claudeKey(source)}/S1.jsonl`, session("S1", source));
    put(kept, `projects/${claudeKey(source)}/memory/MEMORY.md`, "kept notes\n");
    put(join(user, ".claude"), `projects/${claudeKey(source)}/memory/MEMORY.md`, "default notes\n");
    await rt.agents.setup(HERE_PLACE_ID, "claude", { configDir: kept });
    const roads = workspaceRoads(rt);

    const plan = await roads.planProject(source);
    expect(plan.agents.find(a => a.agent === "claude")).toMatchObject({ sessions: 1 });
    const packed = await roads.bundlerFor(source).packState({ dest: "/root/work/proj", agents: [{ agent: "claude", home: "/root/.claude", present: true }] });
    const memory = tarRead(["-tzf", "-"], packed.tar).toString().split("\n").find(l => l.endsWith("memory/MEMORY.md"));
    expect(memory).toBeDefined();
    expect(tarRead(["-xzOf", "-", memory!], packed.tar).toString()).toBe("kept notes\n");

    const archive = join(scratch("wsp-homes-archive-"), "archive.tgz");
    writeFileSync(archive, tarOf([{ path: "./src/index.ts", mode: 0o644, content: "export const a = 2;\n" }]));
    const state = join(dirname(archive), "state.tgz");
    writeFileSync(state, tarOf([{ path: `root/.claude-cfg/projects/${claudeKey("/root/work/proj")}/S2.jsonl`, mode: 0o644, content: session("S2", "/root/work/proj") }]));
    const dest = join(user, "back");
    await roads.lander.land({ source: "/root/work/proj", dest, replace: false, archive, state: { archive: state, homes: guestAgentHomes() } });
    expect(readFileSync(join(kept, "projects", claudeKey(dest), "S2.jsonl"), "utf8")).toContain(dest);
    expect(() => readFileSync(join(user, ".claude", "projects", claudeKey(dest), "S2.jsonl"))).toThrow();
  });

  it("a seed for wsp add reads Claude Code's memory from the folder the person kept", async () => {
    const { user, source, rt } = setUp();
    const kept = join(user, "claude-work");
    put(kept, `projects/${claudeKey(source)}/memory/MEMORY.md`, "kept notes\n");
    put(join(user, ".claude"), `projects/${claudeKey(source)}/memory/MEMORY.md`, "default notes, longer\n");
    await rt.agents.setup(HERE_PLACE_ID, "claude", { configDir: kept });

    const plan = await rt.projects.seedPlan(source);
    expect(plan.memory).toMatchObject({ files: 1, bytes: "kept notes\n".length });
    const packed = await hostSeed().pack({ plan, choice: { files: [], memory: true, commits: false }, homes: await rt.agents.homesHere() });
    const memory = tarRead(["-tzf", "-"], packed.tar).toString().split("\n").find(l => l.endsWith("MEMORY.md"));
    expect(tarRead(["-xzOf", "-", memory!], packed.tar).toString()).toBe("kept notes\n");
  });

  it("refuse in a launch's words once the kept folder leads out of the home, and read nothing in its place", async () => {
    const { user, source, rt } = setUp();
    const outside = scratch("wsp-homes-outside-");
    mkdirSync(join(user, "real"));
    symlinkSync(join(user, "real"), join(user, "in"));
    await rt.agents.setup(HERE_PLACE_ID, "claude", { configDir: join(user, "in", "claude-work") });
    const kept = join(user, "real", "claude-work");
    rmSync(join(user, "real"), { recursive: true });
    symlinkSync(outside, join(user, "real"));
    const words = `Claude Code does not start with its config folder ${kept}: Claude Code's config folder has to be under the home folder ${user}, and ${kept} is not. Set another with wsp agents setup claude --config, or put its own back with --reset config.`;
    const roads = workspaceRoads(rt);
    await expect(roads.planProject(source)).rejects.toMatchObject({ kind: "usage", message: words });
    const archive = join(outside, "archive.tgz");
    writeFileSync(archive, tarOf([{ path: "./src/index.ts", mode: 0o644, content: "export const a = 2;\n" }]));
    await expect(roads.lander.land({ source: "/root/work/proj", dest: join(user, "back"), replace: false, archive, state: { archive, homes: guestAgentHomes() } })).rejects.toMatchObject({ kind: "usage", message: words });
    expect(existsSync(join(user, "back"))).toBe(false);
  });

  it("take the agent's own folder where none is kept", async () => {
    const { user, source, rt } = setUp();
    put(join(user, ".claude"), `projects/${claudeKey(source)}/S1.jsonl`, session("S1", source));
    const plan = await workspaceRoads(rt).planProject(source);
    expect(plan.agents.find(a => a.agent === "claude")).toMatchObject({ sessions: 1 });
  });
});
