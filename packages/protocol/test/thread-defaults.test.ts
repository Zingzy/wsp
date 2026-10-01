// SPDX-License-Identifier: AGPL-3.0-only
// What a new thread starts on when its start names nothing, layer by layer, and
// how each agent's setup on a computer is kept and shown.
import { describe, expect, it } from "vitest";
import {
  accessRefusal,
  accessWordsLine,
  applyPreferencesPatch,
  DEFAULT_PREFERENCES,
  markedDefault,
  markedFor,
  openDefaults,
  Preferences,
  PreferencesPatch,
  resolveThreadDefaults,
  RuntimeRequest,
  setupPatched,
  setupView,
  shapeModels,
  startPicks,
  withCustomModels,
  type HarnessCatalog,
  type HarnessOption,
} from "../src/index.js";

const option = (value: string, isDefault = false): HarnessOption => ({ value, label: value, ...(isDefault ? { isDefault: true } : {}) });

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "table",
  version: null,
  models: [{ ...option("opus", true), efforts: ["low", "high"] }, { ...option("sonnet"), efforts: ["low", "high"], defaultEffort: "low" }, { ...option("haiku"), efforts: [] }],
  legacyModels: [{ ...option("opus-old") }],
  efforts: [option("low"), option("high", true)],
  contextWindows: [],
  permissionModes: [option("default"), option("acceptEdits"), option("bypassPermissions", true)],
  access: { ask: "default", "auto-edit": "acceptEdits", full: "bypassPermissions" },
  steers: true,
  renames: true,
  images: true,
};

const CODEX: HarnessCatalog = {
  ...CLAUDE,
  harness: "codex",
  label: "Codex",
  models: [option("gpt", true)],
  legacyModels: [],
  efforts: [option("low", true), option("high")],
  permissionModes: [option("read-only"), option("workspace-write"), option("danger-full-access", true)],
  access: { ask: "workspace-write", full: "danger-full-access", plan: "read-only" },
};

const catalogs: Record<string, HarnessCatalog> = { claude: CLAUDE, codex: CODEX };
const prefs = (patch: PreferencesPatch = {}): Preferences => applyPreferencesPatch(DEFAULT_PREFERENCES, patch);
const resolve = (o: { named?: string; project?: Parameters<typeof resolveThreadDefaults>[0]["project"]; prefs?: Preferences; only?: string[] } = {}) =>
  resolveThreadDefaults({
    firstAgent: "claude",
    catalogOf: id => (o.only === undefined || o.only.includes(id) ? catalogs[id] : undefined),
    ...(o.named !== undefined ? { named: o.named } : {}),
    ...(o.project !== undefined ? { project: o.project } : {}),
    prefs: o.prefs ?? prefs(),
  });

describe("the agent a new thread runs", () => {
  it("named, then the project's, then the default agent, then the catalog's first, each saying where it came from", () => {
    expect(resolve().agent).toEqual({ value: "claude", from: "catalog" });
    expect(resolve({ prefs: prefs({ defaultAgent: "codex" }) }).agent).toEqual({ value: "codex", from: "default" });
    expect(resolve({ prefs: prefs({ defaultAgent: "codex" }), project: { agent: "claude" } }).agent).toEqual({ value: "claude", from: "project" });
    expect(resolve({ prefs: prefs({ defaultAgent: "codex" }), project: { agent: "claude" }, named: "codex" }).agent).toEqual({ value: "codex", from: "named" });
  });

  it("a layer naming an agent that cannot run here drops to the next", () => {
    expect(resolve({ prefs: prefs({ defaultAgent: "codex" }), project: { agent: "claude" }, only: ["codex"] }).agent).toEqual({ value: "codex", from: "default" });
    expect(resolve({ prefs: prefs({ defaultAgent: "gemini" }) }).agent).toEqual({ value: "claude", from: "catalog" });
  });
});

describe("the model, effort and access a new thread starts on", () => {
  it("the catalog's marks with nothing set, the access as wsp's word beside the agent's mode", () => {
    expect(resolve()).toEqual({
      agent: { value: "claude", from: "catalog" },
      model: { value: "opus", from: "catalog" },
      effort: { value: "high", from: "catalog" },
      access: { value: "full", mode: "bypassPermissions", from: "catalog" },
    });
  });

  it("the agent's defaults over the catalog, the project's over those", () => {
    const set = prefs({ agentDefaults: { claude: { model: "sonnet", effort: "low", access: "ask" } } });
    expect(resolve({ prefs: set })).toMatchObject({ model: { value: "sonnet", from: "default" }, effort: { value: "low", from: "default" }, access: { value: "ask", mode: "default", from: "default" } });
    expect(resolve({ prefs: set, project: { model: "opus", effort: "high", access: "auto-edit" } })).toMatchObject({
      model: { value: "opus", from: "project" },
      effort: { value: "high", from: "project" },
      access: { value: "auto-edit", mode: "acceptEdits", from: "project" },
    });
  });

  it("a project's model kept under another agent drops through rather than refusing the start", () => {
    const project = { agent: "claude", model: "sonnet", effort: "high", access: "auto-edit" as const };
    expect(resolve({ project, named: "codex" })).toEqual({
      agent: { value: "codex", from: "named" },
      model: { value: "gpt", from: "catalog" },
      effort: { value: "low", from: "catalog" },
      access: { value: "full", mode: "danger-full-access", from: "catalog" },
    });
    expect(resolve({ project: { model: "gpt", access: "plan" }, named: "codex" })).toMatchObject({ model: { value: "gpt", from: "project" }, access: { value: "plan", mode: "read-only", from: "project" } });
  });

  it("an effort the resolved model does not take drops to that model's own", () => {
    expect(resolve({ prefs: prefs({ agentDefaults: { claude: { model: "haiku", effort: "high" } } }) })).toMatchObject({ model: { value: "haiku" } });
    expect(resolve({ prefs: prefs({ agentDefaults: { claude: { model: "haiku", effort: "high" } } }) }).effort).toBeUndefined();
  });

  it("a custom model id passes the start and stands as a default", () => {
    const set = prefs({ agentDefaults: { claude: { model: "opus-next", models: { custom: ["opus-next"] } } } });
    const shaped = withCustomModels(CLAUDE, set.agentDefaults["claude"]!.models);
    expect(() => startPicks(CLAUDE, { model: "opus-next" }, true)).toThrow(/is not one claude takes/);
    expect(startPicks(shaped, { model: "opus-next" }, true).model).toBe("opus-next");
    const d = resolveThreadDefaults({ firstAgent: "claude", catalogOf: () => shaped, prefs: set });
    expect(d.model).toEqual({ value: "opus-next", from: "default" });
    expect(startPicks(markedFor(shaped, d), {}, true).model).toBe("opus-next");
  });
});

describe("the marks a catalog carries for its defaults", () => {
  it("a start that names nothing lands on what the defaults resolved to", () => {
    const set = prefs({ agentDefaults: { claude: { model: "sonnet", effort: "high", access: "ask" } } });
    const marked = markedFor(CLAUDE, resolve({ prefs: set }));
    expect(startPicks(marked, {}, true)).toEqual({ model: "sonnet", effort: "high", permissionMode: "default" });
    expect(startPicks(CLAUDE, {}, true)).toEqual({ model: "opus", effort: "high", permissionMode: "bypassPermissions" });
  });

  it("an effort picked moves a model's own default, which reads ahead of the catalog's mark", () => {
    const marked = markedFor(CLAUDE, resolve({ prefs: prefs({ agentDefaults: { claude: { model: "sonnet", effort: "high" } } }) }));
    expect(marked.models.find(m => m.value === "sonnet")?.defaultEffort).toBe("high");
    expect(markedDefault(marked.efforts)?.value).toBe("high");
  });

  it("a legacy model kept as the default is the one an unnamed start runs", () => {
    const marked = markedFor(CLAUDE, resolve({ prefs: prefs({ agentDefaults: { claude: { model: "opus-old" } } }) }));
    expect(markedDefault(marked.models)).toBeUndefined();
    expect(startPicks(marked, {}, true).model).toBe("opus-old");
  });

  it("an agent whose CLI takes any model or effort starts on the one set for it, and still takes any it is named", () => {
    const open: HarnessCatalog = { ...CODEX, harness: "cursor", models: [], legacyModels: undefined, efforts: [] };
    const d = resolveThreadDefaults({ firstAgent: "cursor", catalogOf: () => open, prefs: prefs({ agentDefaults: { cursor: { model: "sonnet-4.5", effort: "max" } } }) });
    expect(d).toMatchObject({ model: { value: "sonnet-4.5", from: "default" }, effort: { value: "max", from: "default" } });
    expect(openDefaults(open, d)).toEqual({ model: "sonnet-4.5", effort: "max" });
    expect(openDefaults(CLAUDE, resolve({ prefs: prefs({ agentDefaults: { claude: { model: "sonnet" } } }) }))).toEqual({});
    expect(startPicks(markedFor(open, d), { model: "gpt-x" }, true).model).toBe("gpt-x");
  });

  it("the catalog's own marks stand where nothing was picked, and a named value never moves one", () => {
    expect(markedFor(CLAUDE, resolve())).toEqual(CLAUDE);
    expect(markedFor(CLAUDE, { model: { value: "haiku", from: "named" } })).toEqual(CLAUDE);
  });
});

describe("the model picker's list", () => {
  it("hidden models leave the list, the person's order comes first, and a hidden default hands its mark to the first shown", () => {
    const shaped = shapeModels(CLAUDE, { hide: ["opus"], order: ["haiku"] });
    expect(shaped.models.map(m => m.value)).toEqual(["haiku", "sonnet"]);
    expect(markedDefault(shaped.models)?.value).toBe("haiku");
  });

  it("a hidden model still starts by name off the unshaped lists", () => {
    expect(startPicks(CLAUDE, { model: "opus" }, true).model).toBe("opus");
  });

  it("no picker leaves the catalog as it is", () => {
    expect(shapeModels(CLAUDE, undefined)).toBe(CLAUDE);
  });
});

describe("access words", () => {
  it("a word the agent's row maps to none of its modes is refused naming the ones it takes", () => {
    expect(accessRefusal(CLAUDE, "full")).toBeNull();
    expect(accessRefusal(CLAUDE, "plan")).toBe("Claude Code takes no plan access; it takes ask, auto-edit, full");
    expect(accessRefusal(CODEX, "auto-edit")).toBe("Codex takes no auto-edit access; it takes ask, full, plan");
    expect(accessRefusal({ label: "Pi", permissionModes: [] }, "ask")).toBe("Pi takes no access of wsp's words");
    expect(accessWordsLine("bypassPermissions")).toBe("--access takes ask, auto-edit, full or plan, and got bypassPermissions");
  });

  it("a start carries the word on the wire, and a harness's own spelling is not one", () => {
    const start = { id: "1", op: "sessions.start", workspaceId: "w", prompt: "hi" };
    expect(RuntimeRequest.safeParse({ ...start, access: "full" }).success).toBe(true);
    expect(RuntimeRequest.safeParse({ ...start, access: "bypassPermissions" }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: "1", op: "workspaces.start", url: "u", access: "acceptEdits" }).success).toBe(false);
  });
});

describe("the defaults on the preferences record", () => {
  it("a patch lands field by field, a null field drops that field, a null record or an emptied one leaves no entry", () => {
    const one = prefs({ defaultAgent: "codex", agentDefaults: { claude: { model: "opus", access: "ask" } }, projectDefaults: { p1: { agent: "codex" } } });
    expect(one.agentDefaults).toEqual({ claude: { model: "opus", access: "ask" } });
    const two = applyPreferencesPatch(one, { agentDefaults: { claude: { access: null, effort: "high" } } });
    expect(two.agentDefaults).toEqual({ claude: { model: "opus", effort: "high" } });
    const three = applyPreferencesPatch(two, { defaultAgent: null, agentDefaults: { claude: { model: null, effort: null } }, projectDefaults: { p1: null } });
    expect(three.defaultAgent).toBeUndefined();
    expect(three.agentDefaults).toEqual({});
    expect(three.projectDefaults).toEqual({});
  });

  it("a record from a host older than the defaults reads with none, and a project override is the four fields alone", () => {
    const { agentDefaults: _a, projectDefaults: _p, ...older } = DEFAULT_PREFERENCES;
    expect(Preferences.parse(older)).toEqual(DEFAULT_PREFERENCES);
    expect(PreferencesPatch.safeParse({ projectDefaults: { p1: { threadsAtOnce: 2 } } }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ projectDefaults: { p1: { program: "/bin/claude" } } }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ agentDefaults: { claude: { access: "bypassPermissions" } } }).success).toBe(false);
  });
});

describe("an agent's setup on a computer", () => {
  it("the view carries every variable's name and never its value", () => {
    const kept = setupPatched(undefined, { program: "/opt/claude", configDir: "/Users/me/claude-wsp", args: ["--debug"], env: { FOO: "bar-secret", ZED: "z" } });
    const view = setupView(kept);
    expect(view).toEqual({ on: true, program: "/opt/claude", configDir: "/Users/me/claude-wsp", args: ["--debug"], envNames: ["FOO", "ZED"] });
    expect(JSON.stringify(view)).not.toContain("bar-secret");
  });

  it("null puts a field back on the agent's own, a null variable goes, and a setup with nothing left is none", () => {
    const kept = setupPatched(undefined, { on: false, program: "/opt/claude", env: { FOO: "bar" } });
    expect(kept).toEqual({ on: false, program: "/opt/claude", env: { FOO: "bar" } });
    expect(setupView(kept).on).toBe(false);
    expect(setupPatched(kept, { on: true, program: null, env: { FOO: null } })).toBeUndefined();
    expect(setupPatched(kept, { env: { BAZ: "q" } })).toEqual({ on: false, program: "/opt/claude", env: { FOO: "bar", BAZ: "q" } });
  });

  it("the wire takes a variable by a shell's name alone", () => {
    const set = { id: "1", op: "agents.setup", placeId: "here", agent: "claude" };
    expect(RuntimeRequest.safeParse({ ...set, env: { FOO: "bar" } }).success).toBe(true);
    expect(RuntimeRequest.safeParse({ ...set, env: { "FOO BAR": "x" } }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ ...set, threads: 3 }).success).toBe(false);
  });
});
