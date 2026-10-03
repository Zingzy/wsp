// SPDX-License-Identifier: AGPL-3.0-only
// A computer's setup as the app reads it: the job's frames folded onto the
// record the places list carries, read again once per step that ends and never
// per frame, the pending adds kept off their own events, and the record drawn
// as the rows every list of steps shows.
import { afterEach, describe, expect, it } from "vitest";
import { RecipeFile, type EventUnion, type PendingComputer, type PlaceAddJob, type PlaceProvisionRow, type PlaceSetup, type PlaceView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { checkRows, foldSetup, setupCount, setupRows, setupStanding } from "../src/settings/add/setup.js";
import { caps } from "./caps.js";
import { resetSettings, settingsApi, settle } from "./settings-harness.js";

const RUNNING: PlaceSetup = { state: "running", addId: "a_1", startedAt: "2026-10-03T10:00:00.000Z", steps: [{ step: "floor", state: "running" }], waiting: [] };
const studio: PlaceView = { id: "p_studio", kind: "computer", name: "studio", default: false, present: true, setup: RUNNING };
const choosing: PendingComputer = { id: "a_2", address: "root@jump", step: "choosing", placeId: "p_jump", startedAt: "2026-10-03T10:00:00.000Z", choices: RecipeFile.parse({ name: "jump" }) };

function bound(over: Partial<Api>): { push(e: EventUnion): void } {
  const fake = settingsApi({ listWorkspaces: async () => [], watchStatuses: async () => [], getGolden: async () => undefined, listSessions: async () => [], capabilities: async () => caps(), ...over } as Partial<Api>);
  useStore.getState().bind(fake.api);
  return fake;
}

afterEach(() => resetSettings());

describe("a setup's frames in the store", () => {
  it("folds each frame onto the computer's row and reads the list again only when a step or the job ends", async () => {
    let asked = 0;
    const { push } = bound({ placesList: async () => (asked++, { places: [studio], adds: [], pending: [] }) } as Partial<Api>);
    await settle();
    expect(asked).toBe(1);
    push({ type: "place.setup", addId: "a_1", placeId: "p_studio", line: { step: "floor", state: "done", ms: 72_000 } } as EventUnion);
    push({ type: "place.setup", addId: "a_1", placeId: "p_studio", line: { step: "agents", state: "running" } } as EventUnion);
    push({ type: "place.setup", addId: "a_1", placeId: "p_studio", wait: { row: "signins/codex", label: "Codex", code: "4F2K-9QJM", url: "https://auth.openai.com/device", expiresAt: "2026-10-03T10:10:00.000Z", state: "waiting" } } as EventUnion);
    // A frame of a run the record does not hold changes nothing, not even the list's identity.
    const before = useStore.getState().places;
    push({ type: "place.setup", addId: "a_other", placeId: "p_studio", line: { step: "floor", state: "running" } } as EventUnion);
    expect(useStore.getState().places).toBe(before);
    const row = useStore.getState().places.find(p => p.id === "p_studio")!;
    expect(row.setup?.steps).toEqual([{ step: "floor", state: "done", ms: 72_000 }, { step: "agents", state: "running" }]);
    expect(row.setup?.waiting.map(w => w.code)).toEqual(["4F2K-9QJM"]);
    await settle();
    expect(asked).toBe(2);
  });

  it("keeps the pending adds off the list and their own events, an event with none taking the add away", async () => {
    const { push } = bound({ placesList: async () => ({ places: [], adds: [], pending: [choosing] }) } as Partial<Api>);
    await settle();
    expect(useStore.getState().pending.map(p => p.id)).toEqual(["a_2"]);
    push({ type: "place.pending", id: "a_2", pending: { ...choosing, recipe: "builders" } } as EventUnion);
    expect(useStore.getState().pending).toEqual([{ ...choosing, recipe: "builders" }]);
    push({ type: "place.pending", id: "a_2" } as EventUnion);
    expect(useStore.getState().pending).toEqual([]);
  });

  it("leaves a setup alone for a frame of another run", () => {
    expect(foldSetup(RUNNING, { type: "place.setup", addId: "a_old", placeId: "p_studio", line: { step: "floor", state: "failed" } })).toBe(RUNNING);
  });
});

describe("a setup as rows", () => {
  it("draws every chosen step in order, a step not started waiting, the sign-ins under Agents and a missed item under its step", () => {
    const rows = setupRows({
      setup: { ...RUNNING, state: "done", steps: [{ step: "floor", state: "done", ms: 72_000 }, { step: "agents", state: "done" }, { step: "skills", state: "failed", note: "1 of 2 failed" }], waiting: [{ row: "signins/codex", label: "Codex", code: "4F2K", expiresAt: "x", state: "waiting" }] },
      applied: {
        hash: "h",
        at: "x",
        rows: [
          { id: "claude", label: "Claude Code", outcome: "installed", step: "agents" },
          { id: "signins/claude", label: "Claude Code", outcome: "present", step: "signins", note: "from the vault" },
          { id: "skills/unslop", label: "unslop", outcome: "installed", step: "skills" },
          { id: "skills/taste", label: "zingzy-design-taste", outcome: "failed", step: "skills", note: "a link inside points at a folder", fix: "Replace the link with a copy here and retry." },
        ],
      },
    });
    expect(rows.map(r => [r.name, r.state, r.sub === true])).toEqual([
      ["Install wsp", "done", false],
      ["Base packages", "done", false],
      ["Agents", "done", false],
      ["Claude Code sign-in", "done", true],
      ["Codex sign-in", "needs-you", true],
      ["MCP servers", "waiting", false],
      ["CLIs", "waiting", false],
      ["Skills", "done", false],
      ["zingzy-design-taste", "failed", true],
      ["Plugins", "waiting", false],
      ["GitHub", "waiting", false],
      ["Projects", "waiting", false],
      ["Other config", "waiting", false],
    ]);
    expect(rows.find(r => r.id === "skills")?.note).toBe("unslop.");
    expect(rows.find(r => r.id === "skills/taste")).toMatchObject({ said: "a link inside points at a folder", fix: "Replace the link with a copy here and retry." });
    expect(rows.find(r => r.id === "signins/codex")?.wait?.code).toBe("4F2K");
    expect(setupCount(rows)).toEqual({ done: 4, of: 10 });
  });

  it("draws a sign-in waiting again after a retry by its wait, never also by the row it failed with before", () => {
    const rows = setupRows({
      setup: { ...RUNNING, waiting: [{ row: "signins/codex", label: "Codex", code: "NEW-CODE", expiresAt: "x", state: "waiting" }] },
      applied: { hash: "h", at: "x", rows: [{ id: "signins/codex", label: "Codex", outcome: "failed", step: "signins", note: "the page ran out" }] },
    });
    expect(rows.filter(r => r.id === "signins/codex").map(r => [r.state, r.wait?.code])).toEqual([["needs-you", "NEW-CODE"]]);
  });

  it("says the install landed and dialled back, never with an internal word", () => {
    const install = setupRows({ setup: RUNNING })[0]!;
    expect([install.name, install.state, install.note]).toEqual(["Install wsp", "done", "Dialled back."]);
  });

  it("names up to three of what a step put there, else the first two and how many more", () => {
    const row = (n: number) => ({ id: `clis/${n}`, label: `cli${n}`, outcome: "installed" as const, step: "clis" as const });
    const note = (n: number) => setupRows({ setup: { ...RUNNING, steps: [{ step: "clis", state: "done" }] }, applied: { hash: "h", at: "x", rows: Array.from({ length: n }, (_, i) => row(i + 1)) } }).find(r => r.id === "clis")?.note;
    expect(note(3)).toBe("cli1, cli2, cli3.");
    expect(note(9)).toBe("cli1, cli2 and 7 more.");
  });

  it("says why on the step a setup stopped at, with no items under it", () => {
    const rows = setupRows({ setup: { ...RUNNING, state: "failed", said: "apt-get install exited 100", steps: [{ step: "floor", state: "failed" }] }, applied: { hash: "h", at: "x", rows: [{ id: "floor/stopped", label: "base", outcome: "failed", step: "floor" }] } });
    expect(rows.find(r => r.id === "floor")).toMatchObject({ state: "failed", said: "apt-get install exited 100" });
    expect(rows.some(r => r.id === "floor/stopped")).toBe(false);
  });

  it("reads running, needs you, failed and ready off the record", () => {
    expect(setupStanding({ setup: RUNNING })).toBe("running");
    expect(setupStanding({ setup: { ...RUNNING, state: "failed" } })).toBe("failed");
    expect(setupStanding({ setup: { ...RUNNING, state: "done", waiting: [{ row: "signins/codex", label: "Codex", expiresAt: "x", state: "waiting" }] } })).toBe("needs-you");
    expect(setupStanding({ setup: { ...RUNNING, state: "done" }, applied: { hash: "h", at: "x", rows: [{ id: "f", label: "wsp", outcome: "failed", step: "folders" }] } })).toBe("needs-you");
    expect(setupStanding({ setup: { ...RUNNING, state: "done" } })).toBe("ready");
  });
});

describe("an install as the checks", () => {
  const job = (o: Partial<PlaceAddJob>): PlaceAddJob => ({ addId: "a_1", address: "root@studio", startedAt: "x", state: "running", steps: [], ...o });

  it("ticks each check off its own step and holds Install wsp until the computer joined", () => {
    const rows = checkRows(
      job({
        steps: [
          { step: "connect", state: "done", note: "Ubuntu 24.04" },
          { step: "check", state: "done", note: "root, systemd, cgroup v2" },
          { step: "chip", state: "done", note: "Linux x86_64" },
          { step: "root", state: "done" },
          { step: "system", state: "done", note: "systemd, cgroup v2" },
          { step: "disk", state: "done", note: "61 GB free" },
          { step: "reach", state: "done" },
          { step: "wsp", state: "done" },
          { step: "service", state: "running" },
        ],
      }),
    );
    expect(rows.map(r => [r.name, r.state, r.note])).toEqual([
      ["Connected", "done", "Ubuntu 24.04"],
      ["Chip", "done", "Linux x86_64"],
      ["Root", "done", undefined],
      ["System", "done", "systemd, cgroup v2"],
      ["Disk", "done", "61 GB free"],
      ["Dials back", "done", undefined],
      ["Install wsp", "working", undefined],
    ]);
    expect(checkRows(job({ state: "done", steps: [{ step: "connect", state: "done" }, { step: "chip", state: "done" }, { step: "root", state: "done" }, { step: "system", state: "done" }, { step: "disk", state: "done" }, { step: "reach", state: "done" }, { step: "wsp", state: "done" }, { step: "join", state: "done" }] })).at(-1)?.state).toBe("done");
  });

  it("draws each check's time once its row is done, the install's as its three steps together", () => {
    const rows = checkRows(
      job({
        state: "done",
        steps: [
          { step: "connect", state: "done", ms: 412 },
          { step: "chip", state: "done" },
          { step: "root", state: "done", ms: 2 },
          { step: "system", state: "done", ms: 3 },
          { step: "disk", state: "done", ms: 14 },
          { step: "reach", state: "done", ms: 1_020 },
          { step: "wsp", state: "done", ms: 3_000 },
          { step: "service", state: "done", ms: 900 },
          { step: "join", state: "done" },
        ],
      }),
    );
    expect(rows.map(r => [r.id, r.ms])).toEqual([
      ["connect", 412],
      ["chip", undefined],
      ["root", 2],
      ["system", 3],
      ["disk", 14],
      ["reach", 1_020],
      ["wsp", 3_900],
    ]);
    // A row still running has no time yet.
    expect(checkRows(job({ steps: [{ step: "connect", state: "done", ms: 412 }, { step: "wsp", state: "done", ms: 3_000 }, { step: "service", state: "running" }] })).at(-1)?.ms).toBeUndefined();
  });

  it("says what the running install is doing on its row", () => {
    const rows = checkRows(job({ steps: [{ step: "connect", state: "done" }, { step: "reach", state: "done" }, { step: "wsp", state: "running", note: "x86_64" }] }));
    expect(rows.at(-1)).toMatchObject({ id: "wsp", state: "working", note: "x86_64" });
  });

  it("puts a refusal on the check that was running, the rest after it left waiting", () => {
    const rows = checkRows(job({ state: "failed", said: "jumpbox logs in as a user that is not root", fix: "Add it as root.", steps: [{ step: "connect", state: "done" }, { step: "check", state: "running" }, { step: "chip", state: "done" }, { step: "root", state: "failed", note: "jumpbox logs in as a user that is not root" }] }));
    expect(rows.map(r => r.state)).toEqual(["done", "done", "failed", "waiting", "waiting", "waiting", "waiting"]);
    expect(rows[2]).toMatchObject({ id: "root", said: "jumpbox logs in as a user that is not root", fix: "Add it as root." });
  });
});

describe("what a step says in the list", () => {
  const AT = "2026-10-03T10:00:00.000Z";
  const place = (steps: PlaceSetup["steps"], rows: PlaceProvisionRow[], picks: RecipeFile): Pick<PlaceView, "name" | "setup" | "applied" | "picks"> => ({
    name: "studio",
    setup: { state: "running", addId: "a_1", startedAt: AT, steps, waiting: [] },
    applied: { hash: "h", at: AT, rows },
    picks,
  });

  it("names the GitHub row by what was done, not by its label", () => {
    const done = [{ step: "github" as const, state: "done" as const, ms: 400 }];
    const github = (signin: "vault" | "machine" | "skip", outcome: "present" | "skipped") => setupRows(place(done, [{ id: "github", label: "GitHub", outcome, step: "github", note: "from this computer's vault" }], RecipeFile.parse({ name: "studio", configs: { github: { signin } } })), "studio").find(r => r.id === "github")?.note;
    expect(github("vault", "present")).toBe("Token copied.");
    expect(github("machine", "present")).toBe("Signed in on studio.");
    expect(github("skip", "skipped")).toBe("Skipped.");
  });

  it("says what a running step puts on, off its picks less the rows already there", () => {
    const skills = Object.fromEntries(Array.from({ length: 78 }, (_, i) => [`skill-${i}`, { from: "~/.claude/skills" }]));
    const picks = RecipeFile.parse({ name: "studio", mcp: { wsp: { agents: ["claude"] }, context7: { agents: ["claude"] }, gsc: { agents: ["claude"] } }, clis: { gh: { via: "apt" }, go: { via: "apt" }, bun: { via: "npm" } }, skills, agents: { claude: {}, codex: {} } });
    const rows = setupRows(
      place(
        [
          { step: "floor", state: "done" },
          { step: "agents", state: "running" },
          { step: "mcp", state: "running" },
          { step: "clis", state: "running" },
          { step: "skills", state: "running" },
        ],
        [{ id: "clis/gh", label: "gh", outcome: "present", step: "clis" }],
        picks,
      ),
    );
    const note = (id: string): string | undefined => rows.find(r => r.id === id)?.note;
    expect(note("agents")).toBe("Installing Claude Code, Codex.");
    expect(note("mcp")).toBe("Copying wsp, context7, gsc.");
    expect(note("clis")).toBe("Installing go, bun.");
    expect(note("skills")).toBe("Copying 78 skills.");
    const many = setupRows(place([{ step: "mcp", state: "running" }], [], RecipeFile.parse({ name: "studio", mcp: Object.fromEntries(["wsp", "context7", "gsc", "linear", "github"].map(n => [n, { agents: ["claude"] }])) })));
    expect(many.find(r => r.id === "mcp")?.note).toBe("Copying wsp, context7 and 3 more.");
  });
});

