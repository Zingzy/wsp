// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { localWiring, makeRuntime } from "../src/cli.js";
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
