// SPDX-License-Identifier: AGPL-3.0-only
// wsp computers set --name against a runtime holding a computer the person
// added: the verbs run over a socket to that runtime, so every listing reads
// the name the way a person's own command line does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DAEMON_VERSION, EXIT_CODES, HERE_PLACE_ID, heldPlaceScript, placeFileText, placeRenameRefusal, placeSshOtherRefusal, placeSshRefusal, placeSshUncheckedRefusal, refusalLine, RecipeFile, type RefusalHalves, type PendingComputer, type PlaceView, type ProjectView, type TurnResult } from "@wsp/protocol";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessAdapterFactory } from "../../runtime/src/runtime.js";
import type { PlaceWiring } from "../../runtime/src/places.js";
import type { Store } from "../../runtime/src/store.js";
import { ctx, sockets, serving, code, join as joinHost, forks, placesOf, asRoot, ROOT_LOGIN } from "../../runtime/test/places-fixture.js";
import { report } from "../../runtime/test/place-join.js";
import { projectOn } from "../../runtime/test/stub-backend.js";
import { WsClient } from "../../runtime/test/ws-client.js";
import { CLI_VERBS, runVerb, type HostClient } from "../src/verbs.js";
import { copyKey } from "../../runtime/src/runtime.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { captured } from "./verbs-fixture.js";

const dir = mkdtempSync(join(tmpdir(), "wsp-rename-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A turn that answers at once, so a thread stands on the computer's workspace. */
const answers: HarnessAdapterFactory = () => ({
  steers: false,
  start: ({ onEvent }) => {
    const sessionId = randomUUID();
    const result: TurnResult = { status: "completed", text: "ok" };
    onEvent({ type: "session.start", sessionId });
    onEvent({ type: "turn.done", sessionId, result });
    onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
    return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
  },
});

/** The host's socket as a verb dials it: a refusal thrown with its kind, which is what the exit code is read off. */
async function hostClient(): Promise<HostClient> {
  const ws = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
  sockets.push(ws.ws);
  const client = {
    request: async (op: string, params: Record<string, unknown> = {}) => {
      const reply = await ws.request(op, params);
      if (reply.ok !== true) throw Object.assign(new Error(String(reply["error"])), typeof reply["kind"] === "string" ? { kind: reply["kind"] } : {});
      return reply;
    },
    events: async (): Promise<void> => {},
    onFrame: () => () => {},
    closed: new Promise<void>(() => {}),
    closeWords: () => "closed",
    close: () => {},
    terminate: () => {},
  };
  return client as unknown as HostClient;
}

async function wsp(...argv: string[]): Promise<{ code: number; lines: string[]; errors: string[]; json: () => Record<string, unknown> }> {
  const io = captured();
  const verb = CLI_VERBS.filter(v => v.name.split(" ").every((w, i) => argv[i] === w)).sort((a, b) => b.name.length - a.name.length)[0]!;
  const client = await hostClient();
  const code = await runVerb(verb, argv, io, () => join(dir, "state.json"), { env: {}, dial: async () => client });
  return { code, lines: io.lines, errors: io.errors, json: () => JSON.parse(io.lines.at(-1)!) as Record<string, unknown> };
}

/** A host holding a computer added as spoo, with a project, a workspace and a thread on it, and a second computer. */
async function hostWithSpoo(road: { runOver?: PlaceWiring["runOver"]; back?: PlaceWiring["back"]; dialWaitMs?: number } = {}) {
  const { hostKey, store } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 }, adapters: { claude: answers }, ...road });
  const spoo = await joinHost(hostKey, { code: await code(), name: "spoo", report: report("spoo", { daemonVersion: DAEMON_VERSION, login: ROOT_LOGIN }), answers: c => void forks(c, undefined, asRoot) });
  sockets.push(spoo.client.ws);
  const other = await joinHost(hostKey, { code: await code(), name: "attic", report: report("attic") });
  sockets.push(other.client.ws);
  const project = await projectOn(ctx.runtime!, "spoo", undefined, { name: "spoo-api" });
  const made = await ctx.runtime!.workspaces.create({ project: project.id, name: "work" });
  await (await ctx.runtime!.sessions.start(made.id, { prompt: "look around", harness: "claude" })).finished;
  return { store, hostKey, spoo: { ...spoo, placeView: (await placesOf()).find(p => p.id === spoo.placeId)! }, other, project, made };
}

describe("wsp computers set --name", () => {
  it("renames a computer the person added, and the record, its project and its workspace keep their ids", async () => {
    const { store, spoo, project, made } = await hostWithSpoo();
    const before = (await store.get("places", spoo.placeId)) as Record<string, unknown>;
    // An add of it still choosing its picks, which wsp computers lists and a resume finds by the computer's name.
    await store.put("pending-computers", "a_spoo", { id: "a_spoo", address: "root@spoo", name: "spoo", placeId: spoo.placeId, step: "choosing", choices: RecipeFile.parse({ name: "spoo" }), startedAt: "2026-10-07T00:00:00.000Z" });
    expect(((await wsp("computers", "--json")).json()["pending"] as PendingComputer[]).map(p => p.name)).toEqual(["spoo"]);
    const set = await wsp("computers", "set", "spoo", "--name", "hetzner", "--json");
    expect(set.code, set.errors.join("\n")).toBe(0);
    expect(set.json()).toMatchObject({ computer: { id: spoo.placeId, kind: "computer", name: "hetzner" } });
    const listed = await wsp("computers", "--json");
    const rows = (listed.json()["computers"] as PlaceView[]).filter(p => p.id === spoo.placeId || p.name === "spoo" || p.name === "hetzner");
    expect(rows.map(p => [p.id, p.name])).toEqual([[spoo.placeId, "hetzner"]]);
    expect((listed.json()["pending"] as PendingComputer[]).map(p => [p.id, p.name, p.placeId])).toEqual([["a_spoo", "hetzner", spoo.placeId]]);
    expect((await wsp("computers")).lines.join("\n")).toMatch(/^hetzner\b/m);
    // The record is the same record with its name moved: its key, its join and its report stand.
    expect(await store.get("places", spoo.placeId)).toEqual({ ...before, name: "hetzner" });
    expect((await ctx.runtime!.projects.list()).find(p => p.id === project.id)).toMatchObject({ id: project.id, computer: spoo.placeId });
    expect(await ctx.runtime!.workspaces.get(made.id)).toMatchObject({ id: made.id, machineId: made.machineId, project: { id: project.id, computer: spoo.placeId } });
    // The old name names nothing now, and the new one is the word every line takes.
    expect((await wsp("computers", "set", "spoo", "--threads", "1")).code).toBe(EXIT_CODES.usage);
    expect((await wsp("computers", "set", "hetzner", "--threads", "1")).code).toBe(0);
  });

  it("is what a thread and a project on that computer read in wsp threads and wsp projects", async () => {
    const { project, made } = await hostWithSpoo();
    expect((await wsp("computers", "set", "spoo", "--name", "hetzner")).code).toBe(0);
    const threads = (await wsp("threads", "--json")).json()["threads"] as { workspaceId: string; computerName: string }[];
    expect(threads.filter(t => t.workspaceId === made.id).map(t => t.computerName)).toEqual(["hetzner"]);
    const table = (await wsp("projects")).lines.join("\n").split("\n");
    const row = table.find(line => line.includes(project.id))!.split(/ {2,}/);
    expect(row.slice(0, 3)).toEqual(["spoo-api", project.id, "hetzner"]);
    expect((await wsp("projects", "--json")).json()["projects"] as ProjectView[]).toContainEqual(expect.objectContaining({ id: project.id, computer: project.computer }));
  });

  it("refuses this computer, a cloud, a blank name and a name another computer answers to, and renames nothing", async () => {
    const { store, spoo, other } = await hostWithSpoo();
    const places = await placesOf();
    const here = places.find(p => p.id === HERE_PLACE_ID)!;
    const solari = places.find(p => p.id === "solari")!;
    const refused = async (argv: string[], said: string): Promise<void> => {
      const run = await wsp(...argv);
      expect(run.code, argv.join(" ")).toBe(EXIT_CODES.usage);
      expect(run.errors.join("\n")).toContain(said);
    };
    const line = (said: RefusalHalves): string => refusalLine(said.happened, said.fix);
    await refused(["computers", "set", HERE_PLACE_ID, "--name", "laptop"], line(placeRenameRefusal(here, "laptop", places)!));
    await refused(["computers", "set", "solari", "--name", "cheap"], line(placeRenameRefusal(solari, "cheap", places)!));
    await refused(["computers", "set", "spoo", "--name", "  "], "a computer's name cannot be blank. Give it a name with a letter or a digit in it.");
    for (const taken of ["attic", here.name, "Solari", other.placeId]) await refused(["computers", "set", "spoo", "--name", taken], `${taken} is already the name of another computer. Pick a name no other computer goes by.`);
    // A setting named beside a refused name is not made either.
    await refused(["computers", "set", "spoo", "--name", "attic", "--threads", "1"], "attic is already the name of another computer");
    // Nor is a recipe: every flag is checked before any is written.
    await refused(["computers", "set", "spoo", "--recipe", "none", "--name", "attic"], "attic is already the name of another computer");
    expect(await store.get("caps", spoo.placeId)).toBeUndefined();
    expect(((await store.get("places", spoo.placeId)) as { recipe?: string }).recipe).toBeUndefined();
    expect((await placesOf()).filter(p => p.kind === "computer" && p.id !== HERE_PLACE_ID).map(p => p.name).sort()).toEqual(["attic", "spoo"]);
  });

  it("says the name it had before the one it has, and a set of nothing names the name and the login it takes", async () => {
    await hostWithSpoo();
    const set = await wsp("computers", "set", "spoo", "--name", "hetzner");
    expect(set.lines).toEqual(["spoo is hetzner now"]);
    const both = await wsp("computers", "set", "hetzner", "--name", "hetzner-1", "--threads", "1");
    expect(both.lines.join("\n").split("\n")).toEqual(["hetzner is hetzner-1 now", expect.stringMatching(/^hetzner-1: 1 thread at once/)]);
    // A recipe named beside a name goes on with it, and is said after it.
    const followed = await wsp("computers", "set", "hetzner-1", "--recipe", "none", "--name", "hetzner");
    expect(followed.lines.join("\n").split("\n")).toEqual(["hetzner-1 is hetzner now", "hetzner follows no recipe; it keeps what it has"]);
    expect(((await placesOf()).find(p => p.name === "hetzner") as PlaceView & { recipe?: string }).recipe).toBe("none");
    const nothing = await wsp("computers", "set", "hetzner");
    expect(nothing.code).toBe(EXIT_CODES.usage);
    expect(nothing.errors.join("\n")).toContain("nothing to set on hetzner: it takes threads at once, nap after, turn limit, agents may start agents, levels deep, a new name and a new ssh login");
  });
});

describe("wsp computers set --ssh", () => {
  /** The box behind each login: hetzner is spoo itself, prod and blank are other machines, locked asks sudo for a
   * password, silent never answers. Every script asked is kept, so a refusal before the dial shows as nothing asked. */
  function logins() {
    const asked: { ssh: string; script: string }[] = [];
    const at: { placeId: string; hostPublicKey: string } = { placeId: "", hostPublicKey: "" };
    const file = (placeId: string, hostPublicKey: string): string => placeFileText({ placeId, name: "spoo", hostName: "zingzys-mac", hostUrls: ["http://192.168.1.10:14621"], hostPublicKey, keyPath: "/home/maya/.wsp/place.key", joinedAt: "2026-10-07T00:00:00.000Z" });
    const runOver: NonNullable<PlaceWiring["runOver"]> = async (login, script) => {
      asked.push({ ssh: login.ssh, script });
      if (login.ssh === "root@hetzner") return { exitCode: 0, stdout: file(at.placeId, at.hostPublicKey), stderr: "" };
      if (login.ssh === "root@prod") return { exitCode: 0, stdout: file("p_0000000000000000", at.hostPublicKey), stderr: "" };
      if (login.ssh === "root@blank") return { exitCode: 0, stdout: "", stderr: "" };
      if (login.ssh === "maya@locked") return { exitCode: 1, stdout: "", stderr: "sudo: a password is required" };
      if (login.ssh === "root@silent") return new Promise(() => {});
      throw new Error(`ssh: Could not resolve hostname ${login.ssh}`);
    };
    const held: string[] = [];
    const back: NonNullable<PlaceWiring["back"]> = {
      hold: async (login, b) => (held.push(`hold ${login.ssh}`), b),
      release: login => void held.push(`release ${login.ssh}`),
      door: () => {},
      close: () => {},
    };
    return { asked, at, runOver, back, held };
  }

  /** spoo as an add over ssh leaves it: reached as root@spoo, dialling back through a forward on its own loopback. */
  async function addedOverSsh() {
    const road = logins();
    const host = await hostWithSpoo({ runOver: road.runOver, back: road.back, dialWaitMs: 1000 });
    road.at.placeId = host.spoo.placeId;
    road.at.hostPublicKey = host.hostKey.publicKey;
    const record = (await host.store.get("places", host.spoo.placeId)) as Record<string, unknown>;
    await host.store.put("places", host.spoo.placeId, { ...record, road: { ssh: "root@spoo", back: { boxPort: 13758 } } });
    return { ...host, road };
  }
  const roadOf = async (store: Store, placeId: string): Promise<unknown> => ((await store.get("places", placeId)) as { road?: unknown }).road;

  it("saves a login that reaches the same computer, and the forward back moves onto it", async () => {
    const { store, spoo, road } = await addedOverSsh();
    const set = await wsp("computers", "set", "spoo", "--name", "hetzner", "--ssh", "root@hetzner");
    expect(set.code, set.errors.join("\n")).toBe(0);
    expect(set.lines.join("\n").split("\n")).toEqual(["spoo is hetzner now", "hetzner is reached over ssh as root@hetzner from now"]);
    expect(road.asked).toEqual([{ ssh: "root@hetzner", script: heldPlaceScript(ROOT_LOGIN.HOME) }]);
    expect(await roadOf(store, spoo.placeId)).toEqual({ ssh: "root@hetzner", back: { boxPort: 13758 } });
    expect(road.held).toEqual(["release root@spoo", "hold root@hetzner"]);
    expect(((await wsp("computers", "--json")).json()["computers"] as PlaceView[]).find(p => p.id === spoo.placeId)).toMatchObject({ name: "hetzner" });
  });

  it("refuses a login that reaches another machine, or one it cannot read, and writes nothing", async () => {
    const { store, spoo, road } = await addedOverSsh();
    const refused = async (argv: string[], said: RefusalHalves): Promise<void> => {
      const run = await wsp(...argv);
      expect(run.code, argv.join(" ")).toBe(EXIT_CODES.usage);
      expect(run.errors.join("\n")).toContain(refusalLine(said.happened, said.fix));
    };
    await refused(["computers", "set", "spoo", "--ssh", "root@prod", "--name", "hetzner", "--threads", "1"], placeSshOtherRefusal("root@prod", "spoo"));
    await refused(["computers", "set", "spoo", "--ssh", "root@blank"], placeSshOtherRefusal("root@blank", "spoo"));
    await refused(["computers", "set", "spoo", "--ssh", "maya@locked"], placeSshUncheckedRefusal("maya@locked", "spoo", "sudo: a password is required"));
    await refused(["computers", "set", "spoo", "--ssh", "root@nowhere"], placeSshUncheckedRefusal("root@nowhere", "spoo", "ssh: Could not resolve hostname root@nowhere"));
    expect(road.asked.map(a => a.ssh)).toEqual(["root@prod", "root@blank", "maya@locked", "root@nowhere"]);
    // A word that is no login, and a computer reached over no login of the person's, are refused before any dial.
    await refused(["computers", "set", "spoo", "--ssh", "hetzner"], placeSshRefusal(spoo.placeView, "hetzner")!);
    await refused(["computers", "set", HERE_PLACE_ID, "--ssh", "root@hetzner"], placeSshRefusal((await placesOf()).find(p => p.id === HERE_PLACE_ID)!, "root@hetzner")!);
    expect(road.asked).toHaveLength(4);
    expect(await roadOf(store, spoo.placeId)).toEqual({ ssh: "root@spoo", back: { boxPort: 13758 } });
    expect(await store.get("caps", spoo.placeId)).toBeUndefined();
    expect((await placesOf()).find(p => p.id === spoo.placeId)!.name).toBe("spoo");
    expect(road.held).toEqual([]);
  });

  it("refuses a blank login with what was blank and how to write one, and dials nothing", async () => {
    const { store, spoo, road } = await addedOverSsh();
    const said = placeSshRefusal(spoo.placeView, "")!;
    expect(said.happened).toBe("an ssh login cannot be blank");
    const run = await wsp("computers", "set", "spoo", "--ssh", "");
    expect(run.code).toBe(EXIT_CODES.usage);
    expect(run.errors.join("\n")).toContain(refusalLine(said.happened, said.fix));
    expect(road.asked).toEqual([]);
    expect(await roadOf(store, spoo.placeId)).toEqual({ ssh: "root@spoo", back: { boxPort: 13758 } });
  });

  it("refuses a login whose computer never answers once the dial's bound passes, and writes nothing", async () => {
    const { store, spoo, road } = await addedOverSsh();
    const run = await wsp("computers", "set", "spoo", "--ssh", "root@silent");
    expect(run.code).toBe(EXIT_CODES.usage);
    const said = placeSshUncheckedRefusal("root@silent", "spoo", "ssh root@silent was not answered in 1s");
    expect(run.errors.join("\n")).toContain(refusalLine(said.happened, said.fix));
    expect(road.asked.map(a => a.ssh)).toEqual(["root@silent"]);
    expect(await roadOf(store, spoo.placeId)).toEqual({ ssh: "root@spoo", back: { boxPort: 13758 } });
  });
});

describe("the computer a thread row names", () => {
  it("is the name wsp projects prints, a cloud's included", async () => {
    const { store } = await hostWithSpoo();
    await store.put("goldens", copyKey("solari", "default"), SEALED_GOLDEN);
    const project = await projectOn(ctx.runtime!, "solari", undefined, { name: "cloud-api" });
    const made = await ctx.runtime!.workspaces.create({ project: project.id, name: "cloudwork", golden: "snap_g" });
    await (await ctx.runtime!.sessions.start(made.id, { prompt: "look", harness: "claude" })).finished;
    const threads = (await wsp("threads", "--json")).json()["threads"] as { workspaceId: string; computerName: string }[];
    const row = (await wsp("projects")).lines.join("\n").split("\n").find(l => l.includes(project.id))!.split(/ {2,}/);
    expect(row[2]).toBe("Solari");
    expect(threads.filter(t => t.workspaceId === made.id).map(t => t.computerName)).toEqual(["Solari"]);
    expect((await ctx.runtime!.sessions.list()).find(r => r.workspaceId === made.id)).toMatchObject({ project: { id: project.id, name: "cloud-api" }, computerName: "Solari" });
  });
});
