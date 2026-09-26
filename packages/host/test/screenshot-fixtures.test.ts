// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeHost, type Host } from "@wsp/collect";
import type { Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { readAgents } from "../src/agents-reader.js";
import { localWiring, makeRuntime } from "../src/cli.js";
import { serverTools } from "../src/server-tools.js";
import { copyingFake, fakeDaemonStart } from "./verbs-fixture.js";

interface FixtureState {
  projects: Record<string, { id: string }>;
  workspaces: Record<string, { id: string; project: string }>;
}
interface FixtureModule {
  FIXTURE_NAMES: string[];
  fixtureState(name: string, o: { home: string }): FixtureState;
  fixtureCloud(name: string): string | undefined;
  fixtureFleet(state: FixtureState): unknown;
}

const SCREENSHOTS = fileURLToPath(new URL("../../../apps/web/screenshots/", import.meta.url));
// Plain node beside the app, outside every package's types, so it is loaded by path rather than typed by import.
const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(SCREENSHOTS, file)).href)) as T;
const fixtures = await load<FixtureModule>("fixture-state.mjs");
const { hostEnv } = await load<{ hostEnv(o: { home: string; state: FixtureState; cloud?: string; records?: string }): Record<string, string> }>("host.mjs");
const { writeStandIn } = await load<{ writeStandIn(home: string, held: unknown): string }>("lab-home.mjs");

describe("the screenshot harness's fixtures", () => {
  const dirs: string[] = [];
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    for (const rt of runtimes.splice(0)) await rt.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each(fixtures.FIXTURE_NAMES)("%s loads into a host with every workspace on its project", async name => {
    const home = mkdtempSync(join(tmpdir(), "wsp-fixture-load-"));
    dirs.push(home);
    const state = fixtures.fixtureState(name, { home });
    const statePath = join(home, ".wsp", "state.json");
    mkdirSync(join(home, ".wsp"), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state));
    const cloud = fixtures.fixtureCloud(name);
    const env = hostEnv({ home, state, ...(cloud === undefined ? {} : { cloud }), records: writeStandIn(home, fixtures.fixtureFleet(state)) });
    const rt = makeRuntime({}, statePath, undefined, env, undefined, localWiring(home, env, fakeDaemonStart, statePath, copyingFake()));
    runtimes.push(rt);
    const listed = await rt.workspaces.list();
    expect(listed.map(w => [w.id, w.project.id]).sort()).toEqual(Object.values(state.workspaces).map(w => [w.id, w.project]).sort());
    expect((await rt.projects.list()).map(p => p.id).sort()).toEqual(Object.keys(state.projects).sort());
  });
});

interface HereAgents {
  agents: Record<string, { version: string; status: string }>;
  servers: { name: string; agents: string[]; tools?: { name: string }[] }[];
}
const { HERE_AGENTS } = await load<{ HERE_AGENTS: HereAgents }>("fixture-state.mjs");
const { SYSTEM_PATH, writeHereAgents } = await load<{ SYSTEM_PATH: string; writeHereAgents(home: string, here: HereAgents): string }>("host.mjs");

describe("this computer's agents as the screenshot harness serves them", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The Host a fixture's host reads this computer through: the throwaway home and the path it is started with. */
  const hereIn = (home: string, path: string): Host => {
    const live = nodeHost();
    return { ...live, home, exec: { ...live.exec, run: (cmd, args, o = {}) => live.exec.run(cmd, args, { ...o, env: { ...o.env, HOME: home, PATH: path } }) } };
  };

  it("reads the fixture's agents, servers and tools off the throwaway home, and nothing of this computer's own", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-fixture-agents-"));
    dirs.push(home);
    const host = hereIn(home, `${writeHereAgents(home, HERE_AGENTS)}:${SYSTEM_PATH}`);
    const read = await readAgents(host, { user: "zingzy", vault: {} });
    const installed = read.agents.filter(a => a.installed);
    expect(installed.map(a => [a.id, a.signIn])).toEqual(Object.keys(HERE_AGENTS.agents).map(id => [id, "signed-in"]));
    expect(installed.every(a => a.version !== undefined && a.path?.startsWith("~/") === true)).toBe(true);
    const wanted = HERE_AGENTS.servers.flatMap(s => s.agents.map(agent => [agent, s.name]));
    expect(read.servers.map(r => [r.agent, r.name]).sort()).toEqual(wanted.sort());
    expect(read.refused).toEqual([]);
    const standIn = HERE_AGENTS.servers.find(s => s.tools !== undefined)!;
    const answer = await serverTools({ now: Date.now, log: () => {} }).tools(host, { key: "here", agent: standIn.agents[0]!, name: standIn.name });
    expect([answer.auth, answer.tools?.map(t => t.name)]).toEqual(["connected", standIn.tools!.map(t => t.name)]);
  });
});
