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
  SIGN_IN_CODE_MAX,
  SOLARI_CONSOLE,
  SignInFinish,
  initAgentNoRecipeLine,
  initAgentPrompt,
  initAgentStep,
  initButtonLine,
  initCostLine,
  initJobBuilding,
  initJobOver,
  initPhaseWord,
  initProgressLine,
  initProgressState,
  initRowOver,
  initSetupLines,
  initTallyLine,
  threadWorkingLine,
  INIT_SIGN_IN_WORDS,
  initDiskLine,
  initBuildRows,
  initStageCount,
  initStageCountLine,
  SIGN_IN_STAGE_ID,
  sizeTone,
  diskTone,
  initDiskOverLine,
  fmtCalls,
  type InitRow,
  type InitScreen,
} from "../src/index.js";

const MIB = 1024 * 1024;

const row = (over: Partial<InitRow> = {}): InitRow => ({ id: "stage/creating", kind: "stage", label: "Creating the machine", state: "done", ...over });

const SCREEN: InitScreen = { id: "agents", title: "Agents", top: "Which agents go on the image", counter: "1/6", items: [], ticks: [], answers: {}, footer: [] };

const JOB: InitJob = {
  id: "init_1",
  road: "manual",
  phase: "building",
  keys: { solari: true },
  step: 0,
  stoppable: true,
  screens: [],
  rows: [row(), row({ id: "stage/deploying-daemon", label: "Installing the base tools", state: "running" }), row({ id: "stage/ready", label: "Waiting for the machine", state: "waiting" })],
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
      top: "Which agents go on the image",
      counter: "1/6",
      items: [{ id: "claude", label: "Claude Code", size: 208 * MIB, why: "on this Mac", detail: ["on this Mac", "about 208 MB installed on the machine (measured 2026-09-01)"] }],
      ticks: ["claude"],
      answers: {},
      footer: [],
      tally: "agents",
    };
    expect(InitJob.parse({ ...JOB, screens: [screen] }).screens[0]).toEqual(screen);
  });

  it("a row carries its size in bytes, null where nothing measured it, and a sign-in row the key variable its agent reads with whether the home holds one", () => {
    const items = [
      { id: "yq", label: "yq", size: null, detail: [] },
      { id: "logins/claude", label: "Claude Code login", detail: [], choices: [{ value: "machine", label: "sign in during the build" }, { value: "key", label: "paste an API key" }], key: { name: "ANTHROPIC_API_KEY", saved: false } },
    ];
    const screen = { id: "logins", title: "Sign-ins", top: "Each row is something the machine needs to be signed in to", counter: "4/6", items, ticks: [], answers: { "logins/claude": "key" }, footer: [] };
    expect(InitJob.parse({ ...JOB, screens: [screen] }).screens[0]!.items).toEqual(items);
    expect(InitJob.safeParse({ ...JOB, screens: [{ ...screen, items: [{ id: "x", label: "x", size: "208 MB", detail: [] }] }] }).success).toBe(false);
  });

  it("the job says which step the person is on and what the image's disk holds before their ticks, so a reopened setup lands where it was closed and the ring has a base", () => {
    const job = InitJob.parse({ ...JOB, step: 3, disk: { fixed: 3 * 1024 * MIB, total: 20 * 1024 * MIB } });
    expect(job.step).toBe(3);
    expect(job.disk).toEqual({ fixed: 3 * 1024 * MIB, total: 20 * 1024 * MIB });
    expect(InitJob.safeParse({ ...JOB, step: -1 }).success).toBe(false);
    const { step: _step, ...noStep } = JOB;
    expect(InitJob.safeParse(noStep).success).toBe(false);
    // The facts read off this computer are rows too, so the reading step fills row by row.
    const fact = row({ id: "fact/agents", kind: "fact", label: "Agents", state: "3 found" });
    expect(InitJob.parse({ ...JOB, rows: [fact] }).rows[0]).toEqual(fact);
  });

  it("the setup the modal opens on carries the provider key's presence alone, never a key, the agents here and the price", () => {
    const setup = InitSetup.parse({ keys: { solari: false }, home: "/Users/me", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null });
    expect(setup.job).toBeNull();
    expect(Object.keys(setup.keys)).toEqual(["solari"]);
    expect(InitSetup.safeParse({ keys: { solari: "slr_live_x" }, home: "/Users/me", agents: [], pricing: null, job: null }).success).toBe(false);
  });

  it("the event rides the events channel beside the runtime's own, and the ops parse as requests", () => {
    const event = InitJobEvent.parse({ type: "init.job", job: JOB });
    expect(EventUnion.parse({ ...event, seq: 3 })).toEqual({ ...event, seq: 3 });
    for (const op of [
      { id: 1, op: "init.get" },
      { id: 2, op: "init.keys", solari: "slr_live_x" },
      { id: 2, op: "init.keys", rows: { "logins/codex": "sk-x-fake" } },
      { id: 3, op: "init.start", road: "agent", harness: "claude" },
      { id: 4, op: "init.answer", screen: "tools", ticks: ["gh"], answers: {} },
      { id: 4, op: "init.step", at: 2 },
      { id: 5, op: "init.build", firstWorkspace: "first", importFolder: "/Users/me/proj" },
      { id: 6, op: "init.cancel" },
      { id: 7, op: "init.signInCode", tool: "gcloud", code: "4/0Afake" },
    ]) {
      expect(RuntimeRequest.safeParse(op).success, op.op).toBe(true);
    }
    expect(RuntimeRequest.safeParse({ id: 7, op: "init.start", road: "wizard" }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: 8, op: "init.answer", screen: "build" }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: 9, op: "init.step", at: -1 }).success).toBe(false);
    // A code is one line typed into a terminal on the machine, so the wire takes neither an empty one nor a flood.
    expect(RuntimeRequest.safeParse({ id: 10, op: "init.signInCode", tool: "gcloud", code: "" }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: 11, op: "init.signInCode", tool: "gcloud", code: "x".repeat(SIGN_IN_CODE_MAX + 1) }).success).toBe(false);
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
    const waiting = { ...JOB, phase: "signing-in" as const, rows: [...JOB.rows, row({ id: "sign-in/gh", kind: "sign-in", label: "GitHub CLI login", state: INIT_ROW_STATES.open, page: "https://github.com/login/device", code: "8F4A-C21B" })] };
    expect(initProgressLine(waiting)).toBe("sign in to GitHub CLI login");
    expect(initProgressLine({ ...JOB, phase: "answering", rows: [] })).toBe("waiting for you");
    expect(initProgressLine({ ...JOB, phase: "failed", rows: [] })).toBe("failed");
  });

  it("the sidebar button's facts: the rows over as a fraction of the total, whether the person is waited on, and its words", () => {
    expect(initProgressState(JOB)).toEqual({ fraction: 1 / 3, waitingOnYou: false });
    expect(initButtonLine(JOB)).toBe("building · 1/3");
    const waiting = { ...JOB, phase: "signing-in" as const, progress: { done: 2, total: 4 }, rows: [...JOB.rows, row({ id: "sign-in/gh", kind: "sign-in", label: "GitHub CLI login", state: INIT_ROW_STATES.open, page: "https://github.com/login/device", code: "8F4A-C21B" })] };
    expect(initProgressState(waiting)).toEqual({ fraction: 0.5, waitingOnYou: true });
    expect(initButtonLine(waiting)).toBe("waiting for you");
    const answering = { ...JOB, phase: "answering" as const, rows: [], progress: { done: 0, total: 0 } };
    expect(initProgressState(answering)).toEqual({ fraction: 0, waitingOnYou: true });
    expect(initButtonLine(answering)).toBe("waiting for you");
    expect(initButtonLine({ ...JOB, phase: "sealing", progress: { done: 3, total: 3 } })).toBe("sealing · 3/3");
  });

  it("the cost line names the size and the rate once, from the backend's own number", () => {
    expect(initCostLine({ cpu: 2, memMb: 4096 }, 0.11)).toBe("A 2 vCPU · 4 GB machine costs about $0.11 an hour while it runs and naps when idle");
  });

  it("the agent's first message names the two tools and where the recipe goes, asks the agent to ask nothing, and says plainly to run no commands", () => {
    const prompt = initAgentPrompt("/Users/me/.wsp/recipe.json");
    expect(prompt).toContain("recipe_scan");
    expect(prompt).toContain("recipe");
    expect(prompt).toContain("/Users/me/.wsp/recipe.json");
    expect(prompt).toMatch(/ask (them|the person) nothing/i);
    // The tools are named as the only road: a thread that reached for the command line instead asked for permission
    // once per call and got nowhere.
    expect(prompt).toMatch(/run no commands/i);
    expect(prompt).not.toContain("wsp init");
  });

  it("the line when the thread ended with no recipe names the file waited on, and the turn's own reason where it had one", () => {
    expect(initAgentNoRecipeLine("/Users/me/.wsp/recipe.json")).toBe("the thread ended without writing /Users/me/.wsp/recipe.json");
    expect(initAgentNoRecipeLine("/Users/me/.wsp/recipe.json", "the harness died")).toBe("the thread ended without writing /Users/me/.wsp/recipe.json: the harness died");
  });

  it("one predicate says the job's step is the agent's: its road writing the recipe, and a job that ended before any screen", () => {
    const agent = { ...JOB, road: "agent" as const, screens: [] };
    expect(initAgentStep({ ...agent, phase: "agent" })).toBe(true);
    expect(initAgentStep({ ...agent, phase: "failed" })).toBe(true);
    expect(initAgentStep({ ...agent, phase: "cancelled" })).toBe(true);
    // Past the step: the screens exist, so a failure there is the build's own.
    expect(initAgentStep({ ...agent, phase: "answering" })).toBe(false);
    expect(initAgentStep({ ...agent, phase: "failed", screens: [SCREEN] })).toBe(false);
    expect(initAgentStep({ ...JOB, road: "manual", phase: "failed" })).toBe(false);
  });

  it("a thread's one line is the tool it is running, the prompt it is blocked on, else its own last line; anything else leaves the line alone", () => {
    const scope = { workspaceId: "ws_1", sessionId: "s_1" };
    expect(threadWorkingLine({ type: "session.delta", ...scope, kind: "text", text: "reading\nwriting the recipe" })).toBe("writing the recipe");
    expect(threadWorkingLine({ type: "session.delta", ...scope, kind: "tool_use", toolName: "Bash", text: JSON.stringify({ command: "wsp recipe scan --json" }) })).toBe("$ wsp recipe scan --json");
    expect(threadWorkingLine({ type: "session.permission", ...scope, askId: "a1", toolName: "Bash", input: "{}", detail: "wsp recipe scan --json", options: [] })).toBe("Permission for Bash: wsp recipe scan --json");
    expect(threadWorkingLine({ type: "session.delta", ...scope, kind: "tool_result", text: "ok" })).toBeUndefined();
    expect(threadWorkingLine({ type: "session.end", ...scope, exitCode: 0, sawResult: true })).toBeUndefined();
  });

  it("wsp setup prints the keys as held or not, the agents with their tools, the price, and the job's rows with the page a sign-in waits on", () => {
    const setup = { keys: { solari: true }, home: "/Users/me", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }, { id: "codex", name: "Codex", configured: false, takesTools: false }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null };
    expect(initSetupLines(setup)).toEqual([
      "Solari key: saved",
      "Agents here: Claude Code (MCP added), Codex",
      "A 2 vCPU · 4 GB machine costs about $0.11 an hour while it runs and naps when idle",
      "No setup is running; the app's sidebar row starts one.",
    ]);
    const waiting = { ...JOB, phase: "signing-in" as const, rows: [row(), row({ id: "sign-in/gh", kind: "sign-in", label: "GitHub CLI login", state: INIT_ROW_STATES.open, page: "https://github.com/login/device", code: "8F4A-C21B" })] };
    expect(initSetupLines({ ...setup, job: waiting }).slice(3)).toEqual(["Setup on the manual road: sign in to GitHub CLI login", "  Creating the machine: done", "  GitHub CLI login: waiting for you https://github.com/login/device code 8F4A-C21B"]);
    expect(JSON.stringify(initSetupLines(setup))).not.toMatch(/slr_live|sk-ant/);
  });

  it("the login states have one spelling, the one the terminal and the modal both print", () => {
    expect(LOGIN_STATE_WORDS).toEqual({ "signed-in": "signed in", "not-signed-in": "not signed in", copied: "copied", "not-verified": "not verified", skipped: "skipped" });
  });

  it("a row's state words have one table, and one predicate says which of them end the row", () => {
    expect(INIT_ROW_STATES).toEqual({ waiting: "waiting", running: "running", done: "done", failed: "failed", forking: "forking", forked: "forked", importing: "importing", imported: "imported", open: "waiting for you", keySet: "key set", skipped: "skipped", mcpAdded: "MCP added" });
    for (const word of ["done", "failed", "forked", "imported", "MCP added", "key set", "signed in", "not signed in", "copied", "copied from this Mac", "not verified", "skipped"]) expect(initRowOver(word), word).toBe(true);
    for (const word of ["waiting", "running", "forking", "importing", "waiting for you"]) expect(initRowOver(word), word).toBe(false);
    // The app's row words for a sign-in's outcome: done once the machine has the credential, the copy named as such.
    expect(INIT_SIGN_IN_WORDS).toEqual({ "signed-in": "done", "not-signed-in": "not signed in", copied: "copied from this Mac", "not-verified": "not verified", skipped: "skipped" });
  });

  it("one predicate says the job is over and one that it is building, so no client spells the phases again", () => {
    expect(["done", "failed", "cancelled"].map(p => initJobOver(p as InitJob["phase"]))).toEqual([true, true, true]);
    expect(["agent", "reading", "answering", "building", "signing-in", "sealing", "finishing"].map(p => initJobOver(p as InitJob["phase"]))).toEqual([false, false, false, false, false, false, false]);
    expect(["building", "signing-in", "sealing", "finishing"].map(p => initJobBuilding(p as InitJob["phase"]))).toEqual([true, true, true, true]);
    expect(["agent", "reading", "answering", "done", "failed", "cancelled"].map(p => initJobBuilding(p as InitJob["phase"]))).toEqual([false, false, false, false, false, false]);
  });

  it("a sign-in row names its tool beside its id, so a client draws its mark without parsing the id", () => {
    const signIn = row({ id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: INIT_ROW_STATES.open, page: "https://github.com/login/device" });
    expect(InitJob.parse({ ...JOB, rows: [signIn] }).rows[0]).toEqual(signIn);
  });

  it("a sign-in row names the road it finishes on, so a client knows which row takes a code from the person", () => {
    expect(SignInFinish.options).toEqual(["callback", "code", "none"]);
    const takesCode = row({ id: "sign-in/gcloud", kind: "sign-in", tool: "gcloud", label: "Google Cloud login", state: INIT_ROW_STATES.open, page: "https://accounts.google.com/o/oauth2/auth", finish: "code" });
    expect(InitJob.parse({ ...JOB, rows: [takesCode] }).rows[0]).toEqual(takesCode);
    expect(InitJob.safeParse({ ...JOB, rows: [row({ finish: "paste" as InitRow["finish"] })] }).success).toBe(false);
  });

  it("the provider's console is spelled once, and the key screen's link names the company, not the host", () => {
    expect(SOLARI_CONSOLE).toBe("console.getsolari.com");
    expect(CLOUD_SETUP_WORDS.keys.where).toBe("Get one at Solari");
    expect(JSON.stringify(CLOUD_SETUP_WORDS)).not.toContain(SOLARI_CONSOLE);
  });

  it("every step has a sentence under its title, and no title or sentence ends in a period", () => {
    expect(CLOUD_SETUP_WORDS.build.slideTop).not.toMatch(/[.;]$/);
    for (const step of [CLOUD_SETUP_WORDS.choice, CLOUD_SETUP_WORDS.keys, CLOUD_SETUP_WORDS.reading, CLOUD_SETUP_WORDS.agent, CLOUD_SETUP_WORDS.build, CLOUD_SETUP_WORDS.ask]) {
      expect(step.top.length, step.top).toBeGreaterThan(20);
      expect(step.top, step.top).not.toMatch(/\.$/);
      expect(step.headline, step.headline).not.toMatch(/\.$/);
    }
  });

  it("the tally, the disk words and a row's calls come from one formatter each: whole units under a gigabyte, a thousands separator on calls", () => {
    expect(initTallyLine(3, "agents", 1.1 * 1024 * MIB)).toBe("3 agents on the image · 1.1 GB");
    expect(initTallyLine(1, "tools", 60 * MIB)).toBe("1 tool on the image · 60 MB");
    expect(initTallyLine(0, "agents", 0)).toBe("0 agents on the image · 0 B");
    expect(initTallyLine(3, "more", 1.2 * 1024 * MIB)).toBe("3 more on the image · 1.2 GB");
    expect(initTallyLine(1, "more", MIB)).toBe("1 more on the image · 1 MB");
    expect(initDiskLine(1.1 * 1024 * MIB, 20 * 1024 * MIB)).toBe("about 1.1 GB of 20 GB on the image");
    const rows: InitRow[] = [
      { id: "agent/claude", kind: "agent", label: "Claude Code", state: "MCP added" },
      { id: "stage/creating", kind: "stage", label: "Creating the machine", state: "done" },
      { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "Sign in to GitHub CLI", state: "waiting for you" },
      { id: "sign-in/claude", kind: "sign-in", tool: "claude", label: "Sign in to Claude Code", state: "key set" },
      { id: "stage/snapshotting", kind: "stage", label: "Taking the snapshot", state: "waiting" },
      { id: "workspace/first", kind: "workspace", label: "first", state: "waiting" },
    ];
    const folded = initBuildRows(rows);
    expect(folded.rows.map(r => r.id)).toEqual(["stage/creating", SIGN_IN_STAGE_ID, "stage/snapshotting", "workspace/first"]);
    expect(folded.rows[1]).toMatchObject({ kind: "stage", label: "Signing in on the machine", state: "waiting for you" });
    expect(folded.signIns.map(r => r.id)).toEqual(["sign-in/gh", "sign-in/claude"]);
    const settled = initBuildRows(rows.map(r => (r.id === "sign-in/gh" ? { ...r, state: "not signed in" } : r)));
    expect(settled.rows[1]!.state, "a sign-in that ran out keeps the stage from reading done").toBe("not signed in");
    expect(initBuildRows(rows.map(r => (r.id === "sign-in/gh" ? { ...r, state: "done" } : r))).rows[1]!.state).toBe("done");
    expect(initBuildRows(rows.map(r => (r.kind === "sign-in" ? { ...r, state: "waiting" } : r))).rows[1]!.state).toBe("waiting");
    expect(initStageCount(folded.rows)).toEqual({ done: 1, total: 4 });
    expect(initStageCount([row({ state: "done" }), row({ id: "stage/ready", state: "failed" })]), "a failed row is not done").toEqual({ done: 1, total: 2 });
    expect(initStageCountLine({ done: 3, total: 12 })).toBe("3 of 12");
    expect([sizeTone(1024 * MIB), sizeTone(300 * MIB), sizeTone(100 * MIB), sizeTone(99 * MIB), sizeTone(0)]).toEqual(["danger", "warning", "yellow", "muted", "muted"]);
    expect([diskTone(13, 20), diskTone(14, 20), diskTone(18, 20), diskTone(21, 20), diskTone(1, 0)]).toEqual(["muted", "warning", "danger", "danger", "danger"]);
    expect(initDiskOverLine(300 * MIB)).toBe("over by 300 MB");
    expect(fmtCalls(29_623)).toBe("29,623 calls");
    expect(fmtCalls(1)).toBe("1 call");
  });

  it("the row's words never ask the person to run a command", () => {
    const text = JSON.stringify(CLOUD_SETUP_WORDS);
    expect(text).not.toMatch(/wsp init|terminal/i);
    expect(CLOUD_SETUP_WORDS.row).toBe("Set up cloud machines");
  });
});
