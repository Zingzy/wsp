// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { addedProjectLine, addedProjectOn, type PlaceView } from "@wsp/protocol";
import { hostPlatform } from "../src/verbs.js";
import { addCommand, addFlags } from "../src/places.js";
import { captured } from "./verbs-fixture.js";
import { fakeRunner, noBoxSignIn, opts, systemPlaceDeps, tmp } from "./places-fixture.js";

describe("wsp add <folder> --on <computer>: the menu before anything travels", () => {
  const FOLDER = "/Users/dev/spoo-landing";
  const PLAN = {
    source: FOLDER,
    remote: "https://github.com/spoo-me/frontend.git",
    branch: "refactor/dashboard-polish",
    defaultBranch: "main",
    unpushed: { commits: 2, base: "9f1c2e4aa11b0c3d4e5f60718293a4b5c6d7e8f9" },
    uncommitted: 4,
    memory: { key: "-Users-dev-spoo-landing", files: 5, bytes: 28_000 },
    files: [
      { path: ".env.local", dir: false, bytes: 4096, kind: "config", row: { id: "next", name: "Next" }, ticked: true },
      { path: "node_modules", dir: true, bytes: 2_600_000_000, kind: "rebuilt", row: { id: "node", name: "Node" }, ticked: false },
      { path: ".git-credentials", dir: false, bytes: 300, kind: "never", row: { id: "logins", name: "logins" }, ticked: false },
      { path: "docs", dir: true, bytes: 18_000_000, kind: "unknown", ticked: false },
    ],
    remembered: false,
  };
  /** The computers a host lists: this one, which works a folder where it sits, and a box that clones. */
  const PLACES: PlaceView[] = [
    { id: "here", kind: "computer", name: "studio.local", default: false, present: true },
    { id: "p_1", kind: "computer", name: "spoo", default: true },
  ];
  const project = {
    id: "pr_1",
    name: "spoo-landing",
    computer: "p_1",
    source: { kind: "folder", path: FOLDER },
    path: "/root/spoo-landing",
    remote: PLAN.remote,
    defaultBranch: "main",
    memoryKey: PLAN.memory.key,
    memoryDir: "/wsp/projects/pr_1/memory",
    createdAt: new Date(0).toISOString(),
  };

  /** A host answering the menu and the add, keeping what it was asked. */
  const menuClient = (): { dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]; asked: { op: string; params?: Record<string, unknown> }[] } => {
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    return {
      asked,
      dial: () =>
        Promise.resolve({
          request: (op: string, params?: Record<string, unknown>) => {
            asked.push({ op, ...(params === undefined ? {} : { params }) });
            if (op === "project.seed.plan") return Promise.resolve({ plan: PLAN } as never);
            if (op === "projects.add") return Promise.resolve({ project } as never);
            if (op === "places.list") return Promise.resolve({ places: PLACES } as never);
            return Promise.reject(new Error(`unexpected op ${op}`));
          },
          events: () => Promise.resolve(),
          onFrame: () => () => {},
          closed: Promise.resolve(),
          closeWords: () => "",
          close: () => {},
          drop: () => {},
        } as never),
    };
  };

  const menuDeps = (dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]): Parameters<typeof addCommand>[4] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "darwin",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("prints the menu and sends nothing until the person says what travels", async () => {
    const home = tmp("add-seed-menu");
    const { dial, asked } = menuClient();
    const io = captured();
    expect(await addCommand(io, opts(home), [FOLDER], { on: "spoo" }, menuDeps(dial))).toBe(0);
    const printed = io.lines.join("\n");
    // Every row with its size and the words its catalogue row ends in, widest first, and the ticks the catalogue decided.
    expect(printed).toContain("[x]  .env.local");
    expect(printed).toContain("rebuilt on the box");
    expect(printed).toContain("never travels");
    expect(printed).toContain("not in the catalogue");
    expect(printed).toContain("2.4 GB");
    // What stays here, and the two lines that send it.
    expect(printed).toContain("nothing was sent");
    expect(printed).toContain("4 uncommitted changes stay on this computer");
    expect(printed).toContain("--yes");
    // The computer's own kind is read first, then the menu, and nothing was recorded.
    expect(asked.map(a => a.op)).toEqual(["places.list", "project.seed.plan"]);
  });

  it("--into sends the folder a repo is cloned into, resolved where it was typed, and reads no seed menu", async () => {
    const { dial, asked } = menuClient();
    expect(await addCommand(captured(), opts(tmp("add-into")), ["https://github.com/spoo-me/spoo.me"], addFlags(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {}, undefined, "clones/spoo.me"), menuDeps(dial))).toBe(0);
    expect(asked.map(a => a.op)).toEqual(["places.list", "projects.add"]);
    expect(asked.find(a => a.op === "projects.add")?.params).toEqual({ source: "https://github.com/spoo-me/spoo.me", into: resolve("clones/spoo.me") });
    // The home and an absolute path are the host's to read as they stand.
    expect(addFlags(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {}, undefined, "~/code/spoo.me")).toEqual({ into: "~/code/spoo.me" });
    expect(addFlags(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {}, undefined, "/srv/spoo.me")).toEqual({ into: "/srv/spoo.me" });
  });

  it("with --yes it sends the ticks the catalogue decided, and the keeps and cuts move them", async () => {
    const home = tmp("add-seed-yes");
    for (const [flags, files] of [
      [{ on: "spoo", yes: true }, [".env.local"]],
      [{ on: "spoo", yes: true, cut: [".env.local"] }, []],
      [{ on: "spoo", yes: true, keep: ["docs"] }, [".env.local", "docs"]],
    ] as const) {
      const { dial, asked } = menuClient();
      expect(await addCommand(captured(), opts(home), [FOLDER], { ...flags }, menuDeps(dial))).toBe(0);
      expect(asked.find(a => a.op === "projects.add")?.params).toMatchObject({ source: FOLDER, on: "spoo", seed: { files, memory: true, commits: true } });
    }
  });

  it("the two words that leave the memory and the patch here, and the one that remembers the ticks", async () => {
    const home = tmp("add-seed-flags");
    const { dial, asked } = menuClient();
    expect(await addCommand(captured(), opts(home), [FOLDER], { on: "spoo", yes: true, noMemory: true, noCommits: true, remember: true }, menuDeps(dial))).toBe(0);
    expect(asked.find(a => a.op === "projects.add")?.params).toMatchObject({ seed: { files: [".env.local"], memory: false, commits: false, remember: true } });
  });

  it("refuses to carry a login by name, whatever was kept", async () => {
    const home = tmp("add-seed-login");
    const { dial, asked } = menuClient();
    const io = captured();
    await expect(addCommand(io, opts(home), [FOLDER], { on: "spoo", yes: true, keep: [".git-credentials"] }, menuDeps(dial))).rejects.toThrow(/never travels in a seed/);
    expect(asked.map(a => a.op)).toEqual(["places.list", "project.seed.plan"]);
  });

  it("draws and sends the ticks a remembered choice put on the plan, not the catalogue's own", async () => {
    const home = tmp("add-seed-remembered");
    // What the host answers once a choice was remembered for this folder: their ticks on the same rows.
    const remembered = { ...PLAN, remembered: true, files: PLAN.files.map(f => ({ ...f, ticked: f.path === "docs" })) };
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    const dial = (): Promise<never> =>
      Promise.resolve({
        request: (op: string, params?: Record<string, unknown>) => {
          asked.push({ op, ...(params === undefined ? {} : { params }) });
          if (op === "project.seed.plan") return Promise.resolve({ plan: remembered } as never);
          if (op === "projects.add") return Promise.resolve({ project } as never);
          if (op === "places.list") return Promise.resolve({ places: PLACES } as never);
          return Promise.reject(new Error(`unexpected op ${op}`));
        },
        events: () => Promise.resolve(),
        onFrame: () => () => {},
        closed: Promise.resolve(),
        closeWords: () => "",
        close: () => {},
        drop: () => {},
      } as never);
    const io = captured();
    expect(await addCommand(io, opts(home), [FOLDER], { on: "spoo" }, menuDeps(dial))).toBe(0);
    // The menu reads their ticks: the config row they unticked is unticked and the folder they kept is ticked.
    expect(io.lines.join("\n")).toContain("[ ]  .env.local");
    expect(io.lines.join("\n")).toContain("[x]  docs/");
    // And --yes sends those, not the catalogue's.
    const sent = menuClient();
    expect(await addCommand(captured(), opts(home), [FOLDER], { on: "spoo", yes: true }, menuDeps(dial))).toBe(0);
    expect(asked.filter(a => a.op === "projects.add").at(-1)?.params).toMatchObject({ seed: { files: ["docs"] } });
    void sent;
  });

  it("a folder onto this computer is worked where it sits, so no menu is read and nothing is asked about it", async () => {
    const home = tmp("add-seed-here");
    const { dial, asked } = menuClient();
    // The computer the app runs on, named by the word its own row carries.
    expect(await addCommand(captured(), opts(home), [FOLDER], { on: "here" }, menuDeps(dial))).toBe(0);
    // The places listing is read before the add now, since the add's own stages land while it runs and each names
    // the computer by its id.
    expect(asked.map(a => a.op)).toEqual(["places.list", "places.list", "projects.add"]);
  });

  it("a folder with no computer named is a project here and reads no menu at all", async () => {
    const home = tmp("add-seed-here");
    const { dial, asked } = menuClient();
    expect(await addCommand(captured(), opts(home), [FOLDER], {}, menuDeps(dial))).toBe(0);
    expect(asked.map(a => a.op)).toEqual(["places.list", "projects.add"]);
  });
});

describe("wsp add <owner/repo>: a repo the computer's own command line clones", () => {
  it("is a project's source like any other word that names one, and never a provider or an address", async () => {
    const home = tmp("add-owner-repo");
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    const project = {
      id: "pr_2",
      name: "frontend",
      computer: "p_1",
      source: { kind: "github", repo: "spoo-me/frontend" },
      path: "/root/frontend",
      remote: "https://github.com/spoo-me/frontend.git",
      defaultBranch: "main",
      memoryKey: "-root-frontend",
      memoryDir: "/root/.claude-cfg/projects/-root-frontend/memory",
      createdAt: new Date(0).toISOString(),
    };
    const dial = (): Promise<never> =>
      Promise.resolve({
        request: (op: string, params?: Record<string, unknown>) => {
          asked.push({ op, ...(params === undefined ? {} : { params }) });
          if (op === "projects.add") return Promise.resolve({ project } as never);
          if (op === "places.list") return Promise.resolve({ places: [{ id: "p_1", kind: "computer", name: "spoo", default: true }] } as never);
          return Promise.reject(new Error(`unexpected op ${op}`));
        },
        events: () => Promise.resolve(),
        onFrame: () => () => {},
        closed: Promise.resolve(),
        closeWords: () => "",
        close: () => {},
        drop: () => {},
      } as never);
    const io = captured();
    expect(await addCommand(io, opts(home), ["spoo-me/frontend"], { on: "spoo" }, { ...systemPlaceDeps, dial })).toBe(0);
    // It reaches the host as the word that was typed, and no menu is read: only a folder here has one.
    expect(asked.map(a => a.op)).toEqual(["places.list", "projects.add"]);
    expect(asked[1]?.params).toMatchObject({ source: "spoo-me/frontend", on: "spoo" });
    expect(io.lines.join("\n")).toContain("frontend pr_2");
  });
});

describe("what wsp add prints while a project lands on a computer", () => {
  const spooRow: PlaceView = { id: "p_1", kind: "computer", name: "spoo", default: true, joinedAt: new Date(0).toISOString(), agents: ["claude"] };
  const landed = {
    id: "pr_1a2b3c4d",
    name: "landing-906",
    computer: "p_1",
    source: { kind: "git" as const, url: "https://github.com/spoo-me/spoo-ts" },
    path: "/srv/landing-906",
    remote: "https://github.com/spoo-me/spoo-ts",
    defaultBranch: "main",
    memoryKey: "-srv-landing-906",
    memoryDir: "/wsp/projects/pr_1a2b3c4d/memory",
    checkout: "/wsp/projects/pr_1a2b3c4d/checkout",
    createdAt: new Date(0).toISOString(),
  };

  /** A host that pushes the add's own stages while the request is in flight, which is how they land: the reply
   * comes only once the clone and the install are over. */
  const staging = (frames: readonly Record<string, unknown>[], notice?: string): NonNullable<Parameters<typeof addCommand>[4]>["dial"] => {
    const sinks: ((f: Record<string, unknown>) => void)[] = [];
    return () =>
      Promise.resolve({
        request: (op: string) => {
          if (op === "places.list") return Promise.resolve({ places: [spooRow] } as never);
          if (op === "projects.add") {
            for (const frame of frames) for (const sink of sinks) sink(frame);
            return Promise.resolve({ project: landed, ...(notice === undefined ? {} : { notice }) } as never);
          }
          return Promise.reject(new Error(`unexpected op ${op}`));
        },
        events: () => Promise.resolve(),
        onFrame: (fn: (f: Record<string, unknown>) => void) => {
          sinks.push(fn);
          return () => {};
        },
        closed: Promise.resolve(),
        closeWords: () => "",
        close: () => {},
        drop: () => {},
      } as never);
  };

  const stage = (computer: string, stage: string, message: string): Record<string, unknown> => ({ type: "project.add", projectId: landed.id, computer, stage, message, elapsedMs: 1 });

  const addDeps = (dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]): Parameters<typeof addCommand>[4] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "linux",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("prints each stage as it lands there, and says where the project is once: the done stage and no line of its own", async () => {
    const io = captured();
    const done = addedProjectOn(landed, "spoo");
    const lost = "the 1 commit on main did not land on spoo: fatal: empty ident name (for <>) not allowed; the checkout is on main";
    const dial = staging(
      [
        stage("p_1", "planned", "landing-906 from https://github.com/spoo-me/spoo-ts, nothing seeded."),
        stage("p_1", "cloning", "Cloning https://github.com/spoo-me/spoo-ts into /wsp/projects/pr_1a2b3c4d/checkout."),
        // Another computer's add, running at the same time on the same host: none of its lines are this one's.
        stage("p_2", "cloning", "Cloning something else."),
        stage("p_1", "seeding", lost),
        stage("p_1", "installing", "npm ci in /srv/landing-906."),
        stage("p_1", "done", done),
      ],
      lost,
    );
    expect(await addCommand(io, opts(tmp("add-stages")), ["https://github.com/spoo-me/spoo-ts"], { on: "spoo", name: "landing-906" }, addDeps(dial))).toBe(0);
    // The computer's own stages are the whole of it: where the project is is said once, and what did not land
    // the way it was asked is said once too, by the stage that said it while it was happening.
    expect(io.lines).toEqual([
      "landing-906 from https://github.com/spoo-me/spoo-ts, nothing seeded.",
      "Cloning https://github.com/spoo-me/spoo-ts into /wsp/projects/pr_1a2b3c4d/checkout.",
      lost,
      "npm ci in /srv/landing-906.",
      done,
    ]);
  });

  it("leaves a failed stage's sentence to the failure, which the terminal prints once", async () => {
    const io = captured();
    const sentence = "git clone https://github.com/spoo-me/spoo-ts failed on spoo: Repository not found.";
    const sinks: ((f: Record<string, unknown>) => void)[] = [];
    const dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"] = () =>
      Promise.resolve({
        request: (op: string) => {
          if (op === "places.list") return Promise.resolve({ places: [spooRow] } as never);
          for (const sink of sinks) {
            sink(stage("p_1", "cloning", "Cloning https://github.com/spoo-me/spoo-ts into /wsp/projects/pr_1a2b3c4d/checkout."));
            sink(stage("p_1", "failed", sentence));
          }
          return Promise.reject(new Error(sentence));
        },
        events: () => Promise.resolve(),
        onFrame: (fn: (f: Record<string, unknown>) => void) => {
          sinks.push(fn);
          return () => {};
        },
        closed: Promise.resolve(),
        closeWords: () => "",
        close: () => {},
        drop: () => {},
      } as never);
    await expect(addCommand(io, opts(tmp("add-stage-failed")), ["https://github.com/spoo-me/spoo-ts"], { on: "spoo" }, addDeps(dial))).rejects.toThrow(sentence);
    expect(io.lines).toEqual(["Cloning https://github.com/spoo-me/spoo-ts into /wsp/projects/pr_1a2b3c4d/checkout."]);
    expect(io.errors).toEqual([]);
  });

  it("prints no stage at all where no computer was named, so another session's add never lands in this terminal", async () => {
    const io = captured();
    const folder = tmp("add-here-stages");
    // Another session's add on a computer, arriving on this socket while a folder is recorded here.
    const dial = staging([stage("p_1", "cloning", "Cloning somebody else's repo."), stage("p_1", "done", "theirs is on spoo.")]);
    expect(await addCommand(io, opts(tmp("add-here")), [folder], {}, addDeps(dial))).toBe(0);
    expect(io.lines.filter(line => line.includes("somebody else"))).toEqual([]);
    expect(io.lines.some(line => line.includes("theirs is on spoo"))).toBe(false);
    // A record that landed with no stage of its own to read still says where the project is, off the answer.
    expect(io.lines).toEqual([addedProjectLine(landed, new Map([["p_1", "spoo"]]), hostPlatform())]);
  });

  it("says where the project is itself, with what did not travel, where the host sent no stage of this add", async () => {
    const io = captured();
    const lost = "1 login inside the folders you ticked stayed on this computer: config/.netrc";
    // Another session's add finishing on the same computer while this one runs: its done line is that project's,
    // so this add still says its own.
    const theirs = { type: "project.add", projectId: "pr_someone", computer: "p_1", stage: "done", message: "theirs is on spoo.", elapsedMs: 1 };
    const dial = staging([theirs], lost);
    expect(await addCommand(io, opts(tmp("add-no-stages")), ["https://github.com/spoo-me/spoo-ts"], { on: "spoo" }, addDeps(dial))).toBe(0);
    expect(io.lines).toEqual(["theirs is on spoo.", addedProjectLine(landed, new Map([["p_1", "spoo"]]), hostPlatform()), lost]);
  });
});
