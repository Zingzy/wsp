// SPDX-License-Identifier: AGPL-3.0-only
// The init job on the wire: the one view the terminal, the app's modal and an
// agent over MCP read, its event, its ops, and the words every client prints
// for it.
import { describe, expect, it } from "vitest";
import {
  CLOUD_SETUP_WORDS,
  EventUnion,
  InitJob,
  InitJobEvent,
  InitSetup,
  LOGIN_STATE_WORDS,
  RuntimeRequest,
  INIT_ROW_STATES,
  SOLARI_CONSOLE,
  initAgentPrompt,
  initCostLine,
  initJobBuilding,
  initJobOver,
  initPhaseWord,
  initProgressLine,
  initRowOver,
  initSetupLines,
  type InitRow,
} from "../src/index.js";

const row = (over: Partial<InitRow> = {}): InitRow => ({ id: "stage/creating", kind: "stage", label: "Creating the machine", state: "done", ...over });

const JOB: InitJob = {
  id: "init_1",
  road: "manual",
  phase: "building",
  keys: { solari: true, anthropic: false },
  screens: [],
  rows: [row(), row({ id: "stage/deploying-daemon", label: "Installing the base (tools and daemon)", state: "running" }), row({ id: "stage/ready", label: "Waiting for the machine", state: "waiting" })],
  progress: { done: 1, total: 3 },
  log: ["Recipe saved to /tmp/recipe.json"],
};

describe("the init job view", () => {
  it("parses a job with screens, rows and progress, and refuses a phase or a row kind outside the enum", () => {
    expect(InitJob.parse(JOB)).toEqual(JOB);
    expect(InitJob.safeParse({ ...JOB, phase: "sleeping" }).success).toBe(false);
    expect(InitJob.safeParse({ ...JOB, rows: [row({ kind: "chore" as InitRow["kind"] })] }).success).toBe(false);
    const screen = {
      id: "agents",
      title: "Agents",
      top: "Which coding agents go on your machine image.",
      counter: "1/6",
      items: [{ id: "claude", label: "Claude Code", hint: "208.0 MB", why: "on this Mac", detail: ["on this Mac", "about 208.0 MB installed on the machine (measured 2026-09-01)"] }],
      ticks: ["claude"],
      answers: {},
      footer: [{ text: "On: 1 agent, 208.0 MB" }],
    };
    expect(InitJob.parse({ ...JOB, screens: [screen] }).screens[0]).toEqual(screen);
  });

  it("the setup the modal opens on carries the keys' presence alone, never a key, the agents here and the price", () => {
    const setup = InitSetup.parse({ keys: { solari: false, anthropic: false }, agents: [{ id: "claude", name: "Claude Code", configured: true }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null });
    expect(setup.job).toBeNull();
    expect(Object.keys(setup.keys)).toEqual(["solari", "anthropic"]);
    expect(InitSetup.safeParse({ keys: { solari: "slr_live_x", anthropic: false }, agents: [], pricing: null, job: null }).success).toBe(false);
  });

  it("the event rides the events channel beside the runtime's own, and the ops parse as requests", () => {
    const event = InitJobEvent.parse({ type: "init.job", job: JOB });
    expect(EventUnion.parse({ ...event, seq: 3 })).toEqual({ ...event, seq: 3 });
    for (const op of [
      { id: 1, op: "init.get" },
      { id: 2, op: "init.keys", solari: "slr_live_x" },
      { id: 3, op: "init.start", road: "agent", harness: "claude" },
      { id: 4, op: "init.answer", screen: "tools", ticks: ["gh"], answers: {} },
      { id: 5, op: "init.build", firstWorkspace: "first", importFolder: "/Users/me/proj" },
      { id: 6, op: "init.cancel" },
    ]) {
      expect(RuntimeRequest.safeParse(op).success, op.op).toBe(true);
    }
    expect(RuntimeRequest.safeParse({ id: 7, op: "init.start", road: "wizard" }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: 8, op: "init.answer", screen: "build" }).success).toBe(false);
  });
});

describe("the words the clients print for the job", () => {
  it("one word per phase, in lower case, since it sits in a muted mono slot", () => {
    expect(initPhaseWord("agent")).toBe("agent writing the recipe");
    expect(initPhaseWord("reading")).toBe("reading this computer");
    expect(initPhaseWord("answering")).toBe("waiting for you");
    expect(initPhaseWord("building")).toBe("building");
    expect(initPhaseWord("signing-in")).toBe("signing in");
    expect(initPhaseWord("sealing")).toBe("sealing");
    expect(initPhaseWord("finishing")).toBe("finishing");
    expect(initPhaseWord("done")).toBe("done");
    expect(initPhaseWord("failed")).toBe("failed");
    expect(initPhaseWord("cancelled")).toBe("cancelled");
  });

  it("the collapsed row's line is the phase and the count while it builds, the sign-in waited on while one is open, and the phase alone otherwise", () => {
    expect(initProgressLine(JOB)).toBe("building · 1/3");
    const waiting = { ...JOB, phase: "signing-in" as const, rows: [...JOB.rows, row({ id: "sign-in/gh", kind: "sign-in", label: "GitHub CLI login", state: "open", page: "https://github.com/login/device", code: "8F4A-C21B" })] };
    expect(initProgressLine(waiting)).toBe("sign in to GitHub CLI login");
    expect(initProgressLine({ ...JOB, phase: "answering", rows: [] })).toBe("waiting for you");
    expect(initProgressLine({ ...JOB, phase: "failed", rows: [] })).toBe("failed");
  });

  it("the cost line names the size and the rate once, from the backend's own number", () => {
    expect(initCostLine({ cpu: 2, memMb: 4096 }, 0.11)).toBe("A 2 vCPU · 4 GB machine costs about $0.11/hr while it runs; it naps when idle.");
  });

  it("the agent's first message names the two tools and where the recipe goes, and asks the agent to ask nothing", () => {
    const prompt = initAgentPrompt("/Users/me/.wsp/recipe.json");
    expect(prompt).toContain("recipe_scan");
    expect(prompt).toContain("recipe");
    expect(prompt).toContain("/Users/me/.wsp/recipe.json");
    expect(prompt).toMatch(/ask (them|the person) nothing/i);
    expect(prompt).not.toContain("wsp init");
  });

  it("wsp setup prints the keys as held or not, the agents with their tools, the price, and the job's rows with the page a sign-in waits on", () => {
    const setup = { keys: { solari: true, anthropic: false }, agents: [{ id: "claude", name: "Claude Code", configured: true }, { id: "codex", name: "Codex", configured: false }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null };
    expect(initSetupLines(setup)).toEqual([
      "Solari key: saved; Anthropic key: not set",
      "Agents here: Claude Code (MCP added), Codex",
      "A 2 vCPU · 4 GB machine costs about $0.11/hr while it runs; it naps when idle.",
      "No setup is running; the app's sidebar row starts one.",
    ]);
    const waiting = { ...JOB, phase: "signing-in" as const, rows: [row(), row({ id: "sign-in/gh", kind: "sign-in", label: "GitHub CLI login", state: "open", page: "https://github.com/login/device", code: "8F4A-C21B" })] };
    expect(initSetupLines({ ...setup, job: waiting }).slice(3)).toEqual(["Setup on the manual road: sign in to GitHub CLI login", "  Creating the machine: done", "  GitHub CLI login: open https://github.com/login/device code 8F4A-C21B"]);
    expect(JSON.stringify(initSetupLines(setup))).not.toMatch(/slr_live|sk-ant/);
  });

  it("the login states have one spelling, the one the terminal and the modal both print", () => {
    expect(LOGIN_STATE_WORDS).toEqual({ "signed-in": "signed in", "not-signed-in": "not signed in", copied: "copied", "not-verified": "not verified", skipped: "skipped" });
  });

  it("a row's state words have one table, and one predicate says which of them end the row", () => {
    expect(INIT_ROW_STATES).toEqual({ waiting: "waiting", running: "running", done: "done", failed: "failed", forking: "forking", forked: "forked", importing: "importing", imported: "imported", open: "open", mcpAdded: "MCP added" });
    for (const word of ["done", "failed", "forked", "imported", "MCP added", "signed in", "not signed in", "copied", "not verified", "skipped"]) expect(initRowOver(word), word).toBe(true);
    for (const word of ["waiting", "running", "forking", "importing", "open"]) expect(initRowOver(word), word).toBe(false);
  });

  it("one predicate says the job is over and one that it is building, so no client spells the phases again", () => {
    expect(["done", "failed", "cancelled"].map(p => initJobOver(p as InitJob["phase"]))).toEqual([true, true, true]);
    expect(["agent", "reading", "answering", "building", "signing-in", "sealing", "finishing"].map(p => initJobOver(p as InitJob["phase"]))).toEqual([false, false, false, false, false, false, false]);
    expect(["building", "signing-in", "sealing", "finishing"].map(p => initJobBuilding(p as InitJob["phase"]))).toEqual([true, true, true, true]);
    expect(["agent", "reading", "answering", "done", "failed", "cancelled"].map(p => initJobBuilding(p as InitJob["phase"]))).toEqual([false, false, false, false, false, false]);
  });

  it("a sign-in row names its tool beside its id, so a client draws its mark without parsing the id", () => {
    const signIn = row({ id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: "open", page: "https://github.com/login/device" });
    expect(InitJob.parse({ ...JOB, rows: [signIn] }).rows[0]).toEqual(signIn);
  });

  it("the provider's console is spelled once, and the key screen's guide reads it", () => {
    expect(SOLARI_CONSOLE).toBe("console.getsolari.com");
    expect(CLOUD_SETUP_WORDS.keys.where).toBe(`Get one at ${SOLARI_CONSOLE}`);
  });

  it("the row's words never ask the person to run a command", () => {
    const text = JSON.stringify(CLOUD_SETUP_WORDS);
    expect(text).not.toMatch(/wsp init|terminal/i);
    expect(CLOUD_SETUP_WORDS.row).toBe("Set up cloud machines");
  });
});
