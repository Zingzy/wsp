// SPDX-License-Identifier: AGPL-3.0-only
// The cloud setup sheet over a fake api: it opens on the two roads as radios,
// takes the provider key alone when the host holds none and never shows it
// back, draws each screen from the host's data with one selection state under
// the ticks, the tally and the disk ring, sends the ticks, answers and typed
// keys back, keeps the step on the host so a reopened sheet lands where it
// was shut, skips the screen the first launch answered and hands its answer
// to the build, and draws the build as rows with the sign-ins where they
// happen. Esc hides it with the job running on.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SETUP_WORDS, KEY_REFUSED, KEY_UNCHECKED, SIGN_IN_STAGE_ID, GOLDEN_STAGE_WORDS, INIT_ROW_STATES, INIT_SIGN_IN_WORDS, MACHINE_SWEEP_LINE, MCP_ADDED_WORD, SIGN_IN_OPEN_STATE, STOP_LEFT_MACHINE_LINE, initBuildRows, initDiskLine, initDiskOverLine, MACHINE_GONE_LINE, MACHINE_ROW_LABEL, initStageCount, initStoppedAt, initStageCountLine, initTallyLine, initButtonLine, initProgressLine, initSignInLine, keyRefusedLine, keyUncheckedLine, snapshotStageLine, type EventUnion, type InitJob, type InitScreen, type InitSetup } from "@wsp/protocol";
import { RequestError, type Api } from "../src/protocol/client.js";
import { KEY_REFUSED_LINE, KEY_REFUSED_ROWS, keyStoppedRows } from "./cloud-setup/keyRefusedJob.js";
import { useStore } from "../src/protocol/store.js";
import { CloudSetupDialog } from "../src/sidebar/CloudSetupDialog.js";
import { CloudSetupRow } from "../src/sidebar/CloudSetupRow.js";
import { resetAskedToNotify } from "../src/shell/needsYou.js";
import { caps } from "./caps.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const AGENTS: InitScreen = {
  id: "agents",
  title: "Agents",
  top: "Which agents go on the image",
  items: [
    { id: "claude", label: "Claude Code", size: 208 * MIB, why: "used here, 12 sessions", detail: ["on this Mac"] },
    { id: "codex", label: "Codex", size: 455 * MIB, why: "not installed here", detail: ["not on this Mac; try it on the machine"] },
    { id: "hermes", label: "Hermes Agent", size: 484 * MIB, why: "not installed here", detail: [] },
  ],
  ticks: ["claude"],
  answers: {},
  footer: [],
  tally: "agents",
};
const TOOLS: InitScreen = {
  id: "tools",
  title: "Tools",
  top: "Tools from your usage",
  items: [
    { id: "node", label: "node", size: 60 * MIB, group: "always on the image", detail: [], lock: "on" },
    { id: "gh", label: "gh", size: 12 * MIB, why: "29,623 calls", group: "from your usage", detail: [] },
    { id: "swift", label: "Swift 6.3", size: 3 * GIB, group: "from your usage", detail: [] },
  ],
  ticks: ["node", "gh"],
  answers: {},
  footer: [],
  tally: "tools",
};
const ALSO: InitScreen = { id: "also", title: "Also on this Mac", top: "What else this Mac brings", items: [{ id: "brew/jq", label: "jq", size: 2 * MIB, group: "Homebrew", detail: [] }], ticks: [], answers: {}, footer: [], tally: "more" };
const CHOICES = [
  { value: "copy", label: "copy from this Mac" },
  { value: "machine", label: "sign in on the machine" },
  { value: "key", label: "API key" },
  { value: "skip", label: "skip" },
];
const LOGINS: InitScreen = {
  id: "logins",
  title: "Sign-ins",
  top: "How sign-ins reach the machine",
  items: [
    { id: "logins/claude", label: "Claude Code login", group: "Agents", mark: "claude", why: "Keychain", detail: ["Keychain: Claude Code-credentials", "claude auth login"], choices: CHOICES, key: { name: "ANTHROPIC_API_KEY", saved: false } },
    { id: "logins/gh", label: "GitHub CLI login", group: "Developer CLIs", mark: "gh", why: "hosts.yml", detail: ["~/.config/gh/hosts.yml", "gh auth login"], choices: CHOICES.filter(c => c.value !== "key") },
    { id: "logins/kube", label: "kubeconfig", group: "Developer CLIs", mark: "kube", why: "config", state: CLOUD_SETUP_WORDS.screen.notOnImage, detail: ["~/.kube/config"], choices: CHOICES.filter(c => c.value === "skip") },
  ],
  ticks: [],
  answers: { "logins/claude": "machine", "logins/gh": "copy", "logins/kube": "skip" },
  footer: [],
};
const WSP: InitScreen = { id: "wsp", title: "wsp for your agents on this Mac", top: "Add wsp's MCP server and skill to the agents installed here, so they can drive your workspaces", items: [{ id: "wsp-tools/claude", label: "Claude Code", detail: ["writes ~/.claude.json"] }, { id: "wsp-tools/codex", label: "Codex", detail: ["writes ~/.codex/config.toml"] }], ticks: ["wsp-tools/claude"], answers: {}, footer: [] };

const DISK = { fixed: 2 * GIB, total: 20 * GIB };
const JOB: InitJob = { id: "init_1", road: "manual", phase: "answering", keys: { solari: true }, step: 0, stoppable: true, disk: DISK, screens: [AGENTS, TOOLS, ALSO, LOGINS, WSP], rows: [], progress: { done: 0, total: 0 }, log: [] };
/** The agent road while its thread writes the recipe: no screens yet, the thread named. */
const AGENT_JOB: InitJob = { ...JOB, road: "agent", phase: "agent", screens: [], thread: { id: "th_1", workspaceId: "ws_local", session: "turn_1", harness: "claude" } };
const SETUP: InitSetup = { keys: { solari: false }, home: "/Users/me", agents: [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }, { id: "codex", name: "Codex", configured: false, takesTools: false }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null };
const HELD: InitSetup = { ...SETUP, keys: { solari: true } };

/** How the fake host answers a key: what it refuses with, and whether the answer waits for the test to let it go. */
interface KeyAnswer {
  refusal?: { message: string; kind: string };
  hold?: boolean;
}

function fakeApi(over: { setup?: InitSetup; refuse?: string; key?: KeyAnswer } = {}) {
  const listeners = new Set<(e: EventUnion) => void>();
  let setup = over.setup ?? SETUP;
  /** Lets a held key answer go, so a test reads the Save keycap while the provider is still being asked. */
  let letKeyGo: () => void = () => {};
  /** The job as the host holds it: answers move its step and step moves it back, and every change is an event. */
  let job: InitJob | null = setup.job;
  const emit = (next: InitJob): void => {
    job = next;
    act(() => listeners.forEach(fn => fn({ type: "init.job", job: next })));
  };
  const api = {
    listWorkspaces: vi.fn(async () => []),
    getWorkspace: vi.fn(async () => {
      throw new Error("none");
    }),
    createWorkspace: vi.fn(async () => {
      throw new Error("none");
    }),
    createFromGoldenHead: vi.fn(async () => {
      throw new Error("none");
    }),
    watchStatuses: vi.fn(async () => []),
    nap: vi.fn(async () => {
      throw new Error("none");
    }),
    wake: vi.fn(async () => {
      throw new Error("none");
    }),
    upgrade: vi.fn(async () => {
      throw new Error("none");
    }),
    capabilities: vi.fn(async () => (caps())),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 })),
    startSession: vi.fn(async () => ({ id: "s1", workspaceId: "ws", harness: "claude", status: "running" as const })),
    listSessions: vi.fn(async () => []),
    sessionHistory: vi.fn(async () => []),
    getGolden: vi.fn(async () => undefined),
    listSnapshots: vi.fn(async () => ({ name: "default", head: null, versions: [] })),
    snapshotStorage: vi.fn(async () => null),
    rollbackSnapshot: vi.fn(async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const })),
    subscribe: vi.fn((fn: (e: EventUnion) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
    initGet: vi.fn(async () => ({ ...setup, job })),
    initKeys: vi.fn(async (keys: { solari?: string; rows?: Record<string, string> }) => {
      if (keys.solari !== undefined && over.key !== undefined) {
        // The host checks the key with the provider before it saves it, so this answer is what that check said.
        if (over.key.hold === true) await new Promise<void>(r => (letKeyGo = r));
        if (over.key.refusal !== undefined) throw new RequestError(over.key.refusal.message, over.key.refusal.kind);
      }
      if (keys.solari !== undefined) setup = { ...setup, keys: { solari: true } };
      if (keys.rows !== undefined && job !== null) {
        const saved = new Set(Object.keys(keys.rows));
        emit({ ...job, screens: job.screens.map(s => ({ ...s, items: s.items.map(i => (i.key !== undefined && saved.has(i.id) ? { ...i, key: { ...i.key, saved: true } } : i)) })) });
      }
      return { ...setup, job };
    }),
    initStart: vi.fn(async () => {
      if (over.refuse === "start") throw new Error("an init job is already running; cancel it or let it finish first");
      return { ...JOB, phase: "reading" as const, screens: [] };
    }),
    initAnswer: vi.fn(async (o: { screen: string; ticks?: string[]; answers?: Record<string, string> }) => {
      if (over.refuse !== undefined && o.screen === over.refuse) throw new Error(`the ${o.screen} screen was refused by the host`);
      const current = job ?? JOB;
      const index = current.screens.findIndex(s => s.id === o.screen);
      const next: InitJob = { ...current, step: Math.min(index + 1, current.screens.length), drafts: (current.drafts ?? []).filter(d => d.at !== o.screen), screens: current.screens.map(s => (s.id === o.screen ? { ...s, ticks: o.ticks ?? s.ticks, answers: { ...s.answers, ...o.answers } } : s)) };
      emit(next);
      return next;
    }),
    initStep: vi.fn(async (o: { at: number }) => {
      const next = { ...(job ?? JOB), step: o.at };
      emit(next);
      return next;
    }),
    initDraft: vi.fn(async (o: { at: string; ticks?: string[]; answers?: Record<string, string> }) => {
      const current = job ?? JOB;
      const kept = { at: o.at, ticks: o.ticks ?? [], answers: o.answers ?? {} };
      const next = { ...current, drafts: [...(current.drafts ?? []).filter(d => d.at !== o.at), kept] };
      emit(next);
      return next;
    }),
    initBuild: vi.fn(async () => ({ ...(job ?? JOB), phase: "building" as const })),
    initRetry: vi.fn(async (o: { tool: string }) => {
      const current = job ?? JOB;
      const next = { ...current, rows: current.rows.map(r => (r.tool === o.tool ? { ...r, state: INIT_ROW_STATES.running } : r)) };
      emit(next);
      return next;
    }),
    initCancel: vi.fn(async () => {
      const next = { ...(job ?? JOB), phase: "cancelled" as const };
      emit(next);
      return next;
    }),
    initSignInCode: vi.fn(async () => {
      if (over.refuse === "code") throw new Error("no sign-in for gcloud is waiting for a code from you");
      return job ?? JOB;
    }),
  } satisfies Api;
  return { api, emit, held: () => job, letKeyGo: () => letKeyGo() };
}

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, hasGolden: false, initJob: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, toastAction: null, setupOpen: false, selectedId: null, sessions: {}, ready: false });
  // Base UI's checkbox and radio re-dispatch a click as a PointerEvent, which jsdom does not have.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(over: { setup?: InitSetup; refuse?: string; key?: KeyAnswer } = {}) {
  const { api, emit, held, letKeyGo } = fakeApi(over);
  useStore.setState({ initJob: over.setup?.job ?? null });
  useStore.getState().bind(api);
  const onClose = vi.fn();
  render(<CloudSetupDialog onClose={onClose} />);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(api.initGet).toHaveBeenCalled());
  return { api, emit, held, letKeyGo, dialog, onClose };
}
const k = (root: HTMLElement, key: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`[data-k="${key}"]`);
  if (el === null) throw new Error(`no [data-k=${key}] in the dialog`);
  return el;
};
/** Continue on the choice, then Continue on the key step, which every run passes through and a held key does not stop. */
async function pressPastKeys(t: Awaited<ReturnType<typeof open>>): Promise<void> {
  fireEvent.click(k(t.dialog, "primary"));
  await waitFor(() => expect(k(t.dialog, "keys")).toBeDefined());
  fireEvent.click(k(t.dialog, "primary"));
  await waitFor(() => expect(t.api.initStart).toHaveBeenCalled());
}
/** Walks a fresh job to the screen named, as the person would, answering each screen with what it opened on. */
async function walkTo(t: Awaited<ReturnType<typeof open>>, screenId: string): Promise<void> {
  await pressPastKeys(t);
  t.emit(JOB);
  await waitFor(() => expect(k(t.dialog, "screen-agents")).toBeDefined());
  for (const id of ["agents", "tools", "also", "logins"]) {
    if (id === screenId) return;
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(t.api.initAnswer).toHaveBeenCalledWith(expect.objectContaining({ screen: id })));
  }
}

describe("the cloud setup sheet", () => {
  it("is the whole window with the close at the top right, and opens on the two roads as the app's radios, the agent road naming its harness in the row's slot", async () => {
    const { dialog } = await open({ setup: HELD });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    expect(dialog.getAttribute("data-slot")).toBe("dialog-sheet");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDefined();
    const manual = k(dialog, "road-manual");
    const agent = k(dialog, "road-agent");
    expect([manual.getAttribute("role"), agent.getAttribute("role")]).toEqual(["radio", "radio"]);
    expect(manual.getAttribute("data-slot")).toBe("radio");
    expect([manual.getAttribute("aria-checked"), agent.getAttribute("aria-checked")]).toEqual(["true", "false"]);
    // The picker is the composer's own control: a trigger with the pick and a chevron over a radio menu, not the browser's select.
    expect(k(dialog, "harness").getAttribute("aria-haspopup")).toBe("menu");
    expect(k(dialog, "harness").textContent).toContain("Claude Code");
    expect(k(dialog, "harness").querySelector("svg")).not.toBeNull();
    expect(dialog.querySelector("select")).toBeNull();
    expect(dialog.querySelector("[data-row-mark=claude]")).not.toBeNull();
    // Every step is one layout: label, title, sentence, content, footer.
    for (const key of ["title", "sentence", "content", "footer"]) expect(k(dialog, key)).toBeDefined();
    expect(dialog.querySelector("[data-k=label]"), "no caps label over the title").toBeNull();
  });

  it("the agent picker offers only agents whose thread can be handed the wsp tools; the rest are shown disabled with their word, and with none the road itself is off", async () => {
    const { dialog } = await open({ setup: HELD });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    // Codex is here but its thread takes no wsp tools, so the pick lands on Claude Code and Codex cannot be chosen.
    expect(k(dialog, "harness").getAttribute("data-value")).toBe("claude");
    fireEvent.click(k(dialog, "harness"));
    const options = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-k="option"]')];
      if (found.length === 0) throw new Error("the menu is not open");
      return found;
    });
    expect(options.map(o => o.dataset["value"])).toEqual(["claude", "codex"]);
    const codex = options[1]!;
    expect(codex.getAttribute("data-disabled")).not.toBeNull();
    expect(codex.textContent).toContain(CLOUD_SETUP_WORDS.choice.noTools);
    expect(options[0]!.getAttribute("data-disabled")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    // With no agent here that takes them, the road is off and the row says why rather than reading as empty.
    cleanup();
    const none = await open({ setup: { ...HELD, agents: [{ id: "codex", name: "Codex", configured: false, takesTools: false }] } });
    await waitFor(() => expect(k(none.dialog, "choice")).toBeDefined());
    expect((k(none.dialog, "road-agent") as HTMLButtonElement).getAttribute("data-disabled")).not.toBeNull();
    expect(none.dialog.querySelector("[data-k=harness]")).toBeNull();
    expect(k(none.dialog, "choice").textContent).toContain(CLOUD_SETUP_WORDS.choice.noTools);
  });

  it("with no provider key held, Continue asks for the Solari key alone, saves it once, starts the job and never shows the key back", async () => {
    const { api, dialog } = await open();
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(k(dialog, "keys")).toBeDefined());
    expect(dialog.querySelectorAll("input")).toHaveLength(1);
    expect(dialog.querySelector("input")!.getAttribute("type")).toBe("password");
    expect(dialog.textContent).not.toContain("Anthropic");
    expect(dialog.querySelector("[data-k=solari-state]"), "no state word beside the key field").toBeNull();
    // The link names the company with the external-link glyph and opens the console in the default browser.
    const where = k(dialog, "where") as HTMLAnchorElement;
    expect(where.textContent).toBe(CLOUD_SETUP_WORDS.keys.where);
    expect(where.getAttribute("href")).toBe("https://console.getsolari.com");
    expect(where.getAttribute("target")).toBe("_blank");
    expect(where.querySelector("svg")).not.toBeNull();
    expect(k(dialog, "sentence").textContent).toBe("Solari runs the machines. A 2\u00a0vCPU\u00a0·\u00a04\u00a0GB machine costs about $0.11 an hour while it runs and naps when idle");
    expect(dialog.querySelector("input")!.getAttribute("placeholder")).toBe(CLOUD_SETUP_WORDS.keys.placeholder);
    expect(dialog.querySelectorAll('[data-k="keys"] [data-k=content] [class*=rounded-\\[10px\\]]'), "no card around one field").toHaveLength(0);
    expect((k(dialog, "primary") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.querySelector("input")!, { target: { value: "slr_live_typed_key" } });
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initKeys).toHaveBeenCalledWith({ solari: "slr_live_typed_key" }));
    await waitFor(() => expect(api.initStart).toHaveBeenCalledWith({ road: "manual" }));
    expect(dialog.textContent).not.toContain("slr_live_typed_key");
  });

  it("Save spins while the host asks the provider about the key, and does not send twice", async () => {
    const t = await open({ key: { hold: true } });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "keys")).toBeDefined());
    fireEvent.change(t.dialog.querySelector("input")!, { target: { value: "slr_live_typed_key" } });
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "primary").getAttribute("data-busy")).toBe("true"));
    const keycap = k(t.dialog, "primary") as HTMLButtonElement;
    expect(keycap.querySelector('[data-k="busy"]')).not.toBeNull();
    expect(keycap.disabled).toBe(true);
    expect(keycap.textContent).toContain(CLOUD_SETUP_WORDS.keys.keycap);
    fireEvent.click(keycap);
    expect(t.api.initKeys).toHaveBeenCalledTimes(1);
    await act(async () => {
      t.letKeyGo();
    });
    await waitFor(() => expect(t.api.initStart).toHaveBeenCalled());
    // The spinner ends with the step: the key was taken, so the sheet is on the job.
    expect(t.dialog.querySelector("[data-k=keys]")).toBeNull();
  });

  it("a key the provider refused stays on the step: the field takes the danger tone with the provider's own word under it, and no job starts", async () => {
    const line = keyRefusedLine("401 Unauthorized");
    const t = await open({ key: { refusal: { message: line, kind: KEY_REFUSED } } });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "keys")).toBeDefined());
    fireEvent.change(t.dialog.querySelector("input")!, { target: { value: "slr_live_wrong" } });
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "key-check").textContent).toBe(line));
    // The refusal reads under the field, not in the footer's slot, and the field itself carries the danger tone.
    const field = t.dialog.querySelector("input")!;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(k(t.dialog, "key-check").id);
    expect(t.dialog.querySelector("[data-k=refusal]")).toBeNull();
    // The person stays on the step, the keycap still says Save, and nothing was started.
    expect(k(t.dialog, "keys")).toBeDefined();
    expect(k(t.dialog, "primary").textContent).toContain(CLOUD_SETUP_WORDS.keys.keycap);
    expect(t.api.initStart).not.toHaveBeenCalled();
    expect(t.dialog.textContent).not.toContain("slr_live_wrong");
    // Typing another key takes the refusal with it: it was about the key that was sent, not about this one.
    fireEvent.change(field, { target: { value: "slr_live_another" } });
    await waitFor(() => expect(t.dialog.querySelector("[data-k=key-check]")).toBeNull());
    expect(t.dialog.querySelector("input")!.getAttribute("aria-invalid")).toBe("false");
  });

  it("a check nothing answered says so in the same place, and the keycap turns to Try again", async () => {
    const line = keyUncheckedLine("fetch failed");
    const t = await open({ key: { refusal: { message: line, kind: KEY_UNCHECKED } } });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "keys")).toBeDefined());
    fireEvent.change(t.dialog.querySelector("input")!, { target: { value: "slr_live_maybe" } });
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "key-check").textContent).toBe(line));
    await waitFor(() => expect(k(t.dialog, "primary").textContent).toContain(CLOUD_SETUP_WORDS.keys.retry));
    expect(t.api.initStart).not.toHaveBeenCalled();
    // Pressing again asks the host again, which is the point of that word.
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(t.api.initKeys).toHaveBeenCalledTimes(2));
  });

  it("with a key held the key step still shows: the key as dots with saved, Continue starts the job on the road picked without sending a key, Change empties the field for a new one, and a refused start leaves the step up with the refusal", async () => {
    const { api, dialog } = await open({ setup: HELD });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "road-agent"));
    await waitFor(() => expect(k(dialog, "road-agent").getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(k(dialog, "keys")).toBeDefined());
    // The saved key reads as dots, never the key, in a field that cannot be typed in; saved stands at its right; the link to get a key is gone.
    const field = dialog.querySelector<HTMLInputElement>("#setup-key-solari")!;
    expect(field.value).toMatch(/^•+$/);
    expect(field.readOnly).toBe(true);
    expect(k(dialog, "solari-state").textContent).toBe(CLOUD_SETUP_WORDS.keys.saved);
    expect(dialog.querySelector("[data-k=where]")).toBeNull();
    expect(k(dialog, "primary").textContent).toContain(CLOUD_SETUP_WORDS.screen.keycap);
    expect((k(dialog, "primary") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initStart).toHaveBeenCalledWith({ road: "agent", harness: "claude" }));
    expect(api.initKeys).not.toHaveBeenCalled();
    // Change empties the field for a new key: Save is held until one is typed, and the typed one goes to the host once.
    const again = await open({ setup: HELD });
    await waitFor(() => expect(k(again.dialog, "choice")).toBeDefined());
    fireEvent.click(k(again.dialog, "primary"));
    await waitFor(() => expect(k(again.dialog, "keys")).toBeDefined());
    fireEvent.click(k(again.dialog, "change"));
    const emptied = again.dialog.querySelector<HTMLInputElement>("#setup-key-solari")!;
    expect(emptied.value).toBe("");
    expect(emptied.readOnly).toBe(false);
    expect(again.dialog.querySelector("[data-k=solari-state]")).toBeNull();
    expect(again.dialog.querySelector("[data-k=change]")).toBeNull();
    expect(k(again.dialog, "where")).toBeDefined();
    expect(k(again.dialog, "primary").textContent).toContain(CLOUD_SETUP_WORDS.keys.keycap);
    expect((k(again.dialog, "primary") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(emptied, { target: { value: "slr_live_new_key" } });
    fireEvent.click(k(again.dialog, "primary"));
    await waitFor(() => expect(again.api.initKeys).toHaveBeenCalledWith({ solari: "slr_live_new_key" }));
    await waitFor(() => expect(again.api.initStart).toHaveBeenCalledWith({ road: "manual" }));
    expect(again.dialog.textContent).not.toContain("slr_live_new_key");
    const refused = await open({ setup: HELD, refuse: "start" });
    await waitFor(() => expect(k(refused.dialog, "choice")).toBeDefined());
    fireEvent.click(k(refused.dialog, "primary"));
    await waitFor(() => expect(k(refused.dialog, "keys")).toBeDefined());
    fireEvent.click(k(refused.dialog, "primary"));
    await waitFor(() => expect(k(refused.dialog, "refusal").textContent).toMatch(/already running/));
    expect(k(refused.dialog, "keys")).toBeDefined();
  });

  it("while this computer is read the step shows the work as rows: the spinner on the row being read, a mono word once done, no bare sentence", async () => {
    const { emit, dialog } = await open({ setup: HELD });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "primary"));
    emit({ ...JOB, phase: "reading", screens: [], rows: [{ id: "fact/identity", kind: "fact", label: "Identity", state: "3 found" }, { id: "fact/shell", kind: "fact", label: "Shell", state: INIT_ROW_STATES.running }] });
    await waitFor(() => expect(k(dialog, "reading")).toBeDefined());
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.reading.headline);
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.reading.top);
    const rows = dialog.querySelectorAll('[data-k="reading"] [data-k=row]');
    expect([...rows].map(r => r.getAttribute("data-row"))).toEqual(["fact/identity", "fact/shell"]);
    expect(rows[0]!.querySelector("[data-k=state]")!.textContent).toBe("3 found");
    expect(rows[1]!.querySelector("[data-k=state][role=status]")).not.toBeNull();
    expect(dialog.querySelector("[role=status]:not([data-k=state])")).toBeNull();
  });

  it("draws each screen from the host's data, the wsp screen left out and the counter out of 5, and ticks, tally and meter read one selection: a third row ticked moves both at once", async () => {
    const t = await open({ setup: HELD });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    await walkTo(t, "agents");
    const { dialog } = t;
    expect(k(dialog, "counter").textContent).toBe("1/5");
    expect(k(dialog, "title").textContent).toBe(AGENTS.top);
    const rows = [...dialog.querySelectorAll<HTMLElement>('[data-k="screen-agents"] [data-k=row]')];
    expect(rows.map(r => r.dataset["row"])).toEqual(["claude", "codex", "hermes"]);
    expect(rows.map(r => within(r).getByRole("checkbox").getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(rows[0]!.querySelector("[data-k=size]")!.textContent).toBe("208 MB");
    expect(rows[0]!.querySelector("[data-k=why]")!.textContent).toBe("used here, 12 sessions");
    expect(rows[0]!.querySelector("[data-row-mark=claude]")).not.toBeNull();
    expect(k(dialog, "tally").textContent).toBe(initTallyLine(1, "agents", DISK.fixed + 208 * MIB + 72 * MIB, DISK.total));
    const ring = k(dialog, "disk");
    expect(ring.getAttribute("data-used")).toBe(String(DISK.fixed + 208 * MIB + 72 * MIB));
    expect(ring.getAttribute("data-total")).toBe(String(DISK.total));
    expect(ring.getAttribute("aria-label")).toContain(initDiskLine(DISK.fixed + 280 * MIB, DISK.total));
    // The third row ticked: the checkbox, the tally and the meter move together, before anything is sent.
    fireEvent.click(within(rows[2]!).getByRole("checkbox"));
    await waitFor(() => expect(within(rows[2]!).getByRole("checkbox").getAttribute("aria-checked")).toBe("true"));
    expect(k(dialog, "tally").textContent).toBe(initTallyLine(2, "agents", DISK.fixed + 692 * MIB + 72 * MIB, DISK.total));
    expect(k(dialog, "disk").getAttribute("data-used")).toBe(String(DISK.fixed + 692 * MIB + 72 * MIB));
    expect(t.api.initAnswer).not.toHaveBeenCalled();
    fireEvent.click(within(rows[1]!).getByRole("checkbox"));
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(t.api.initAnswer).toHaveBeenCalledWith({ screen: "agents", ticks: ["claude", "hermes", "codex"], answers: {} }));
    await waitFor(() => expect(k(dialog, "screen-tools")).toBeDefined());
    expect(k(dialog, "counter").textContent).toBe("2/5");
    // Base rows are checked, disabled checkboxes under one divider; usage rows carry one number; the tally counts the base too.
    const groups = [...dialog.querySelectorAll('[data-k="screen-tools"] [data-k=group]')].map(g => g.textContent);
    expect(groups).toEqual(["always on the image", "from your usage"]);
    const node = dialog.querySelector<HTMLElement>('[data-row="node"]')!;
    expect(within(node).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    expect(within(node).getByRole("checkbox").getAttribute("aria-disabled") ?? (within(node).getByRole("checkbox") as HTMLButtonElement).disabled.toString()).toMatch(/true/);
    expect(node.querySelector("[data-k=state]")).toBeNull();
    expect(dialog.querySelector('[data-row="gh"] [data-k=why]')!.textContent).toBe("29,623 calls");
    expect(dialog.querySelector('[data-row="swift"] [data-k=why]')).toBeNull();
    expect(k(dialog, "tally").textContent).toBe(initTallyLine(2, "tools", DISK.fixed + 1147 * MIB + 72 * MIB, DISK.total));
    expect(dialog.querySelectorAll('[data-k="screen-tools"] [data-k=footer-lines]')).toHaveLength(0);
    // Ticking the 3 GB row moves the tally and the meter on this step too.
    fireEvent.click(within(dialog.querySelector<HTMLElement>('[data-row="swift"]')!).getByRole("checkbox"));
    await waitFor(() => expect(k(dialog, "tally").textContent).toBe(initTallyLine(3, "tools", DISK.fixed + 1147 * MIB + 72 * MIB + 3 * GIB, DISK.total)));
    expect(k(dialog, "disk").getAttribute("data-used")).toBe(String(DISK.fixed + 1147 * MIB + 72 * MIB + 3 * GIB));
    expect(k(dialog, "disk").getAttribute("data-tone")).toBe("muted");
  });

  it("every step's tally reads the running image estimate against the disk in the tone its share earns, the agents step's sizes carry no weight tone, and a tick on one step moves the next step's tally", async () => {
    const agents: InitScreen = { ...AGENTS, ticks: ["claude", "codex"] };
    const tools: InitScreen = { ...TOOLS, items: [{ id: "node", label: "node", size: 300 * MIB, group: "always on the image", detail: [], lock: "on" }, { id: "rust", label: "Rust 1.89", size: 4 * GIB, group: "from your usage", detail: [] }, { id: "swift", label: "Swift 6.3", size: 3 * GIB, group: "from your usage", detail: [] }], ticks: ["rust"] };
    const also: InitScreen = { ...ALSO, items: [{ id: "brew/ffmpeg", label: "ffmpeg", size: 200 * MIB, group: "Homebrew", detail: [] }], tally: "more" };
    const t = await open({ setup: { ...HELD, job: { ...JOB, step: 1, disk: { fixed: 0, total: 20 * GIB }, screens: [agents, tools, also, LOGINS, WSP] } } });
    await waitFor(() => expect(k(t.dialog, "screen-tools")).toBeDefined());
    // Agents ticked to 663 MB and tools to 4.3 GB: the tools step counts its own rows and reads the whole image so far, a quarter of the disk, so muted, though 4.9 GB is the danger weight.
    const soFar = 663 * MIB + 300 * MIB + 4 * GIB;
    expect(k(t.dialog, "tally").textContent).toBe(initTallyLine(2, "tools", soFar, 20 * GIB));
    expect(k(t.dialog, "tally").textContent).toContain("4.9 GB of 20 GB");
    expect(k(t.dialog, "tally-size").getAttribute("data-tone")).toBe("muted");
    expect(k(t.dialog, "tally-size").className).toContain("text-muted-foreground");
    expect(k(t.dialog, "disk").getAttribute("data-used")).toBe(String(soFar));
    // The tools step's cells wear their weight; the agents step's wear none, whatever they weigh.
    expect(t.dialog.querySelector('[data-row="rust"] [data-k=size]')!.getAttribute("data-tone")).toBe("danger");
    expect(t.dialog.querySelector('[data-row="node"] [data-k=size]')!.getAttribute("data-tone")).toBe("warning");
    fireEvent.click(k(t.dialog, "secondary"));
    await waitFor(() => expect(k(t.dialog, "screen-agents")).toBeDefined());
    const sizes = [...t.dialog.querySelectorAll<HTMLElement>('[data-k="screen-agents"] [data-k=size]')];
    expect(sizes.map(s => s.textContent)).toEqual(["208 MB", "455 MB", "484 MB"]);
    expect(sizes.map(s => s.getAttribute("data-tone"))).toEqual(["muted", "muted", "muted"]);
    for (const s of sizes) expect(s.className).not.toMatch(/yellow|warning|destructive/);
    // The agents step reads the same estimate, its own count before it.
    expect(k(t.dialog, "tally").textContent).toBe(initTallyLine(2, "agents", soFar, 20 * GIB));
    // On to tools, the 3 GB row ticked, Continue: the what-else step's tally has moved by the same 3 GB.
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "screen-tools")).toBeDefined());
    fireEvent.click(within(t.dialog.querySelector<HTMLElement>('[data-row="swift"]')!).getByRole("checkbox"));
    await waitFor(() => expect(k(t.dialog, "tally").textContent).toBe(initTallyLine(3, "tools", soFar + 3 * GIB, 20 * GIB)));
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "screen-also")).toBeDefined());
    expect(k(t.dialog, "tally").textContent).toBe(initTallyLine(0, "more", soFar + 3 * GIB, 20 * GIB));
    expect(k(t.dialog, "tally").textContent).toContain("7.9 GB of 20 GB");
    expect(k(t.dialog, "disk").getAttribute("data-used")).toBe(String(soFar + 3 * GIB));
  });

  it("the tally's estimate wears the meter's own table: the warning tone from 70 percent of the disk, the danger tone from 90", async () => {
    const t = await open({ setup: { ...HELD, job: { ...JOB, step: 1, disk: { fixed: 15 * GIB, total: 20 * GIB } } } });
    await waitFor(() => expect(k(t.dialog, "screen-tools")).toBeDefined());
    // 15 GB fixed, 208 MB of agents and 72 MB of tools: 76 percent; the 3 GB row takes it to 91.
    expect(k(t.dialog, "tally-size").getAttribute("data-tone")).toBe("warning");
    expect(k(t.dialog, "tally-size").className).toContain("text-warning-foreground");
    expect(k(t.dialog, "disk").getAttribute("data-tone")).toBe("warning");
    fireEvent.click(within(t.dialog.querySelector<HTMLElement>('[data-row="swift"]')!).getByRole("checkbox"));
    await waitFor(() => expect(k(t.dialog, "tally-size").getAttribute("data-tone")).toBe("danger"));
    expect(k(t.dialog, "tally-size").className).toContain("text-destructive-foreground");
  });

  it("over the disk the meter is full in the danger tone and Continue refuses with the over line; under 70 percent it is muted", async () => {
    const heavy: InitScreen = { ...TOOLS, items: [...TOOLS.items, { id: "big", label: "big", size: 18 * GIB, group: "from your usage", detail: [] }] };
    const t = await open({ setup: HELD });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    await pressPastKeys(t);
    t.emit({ ...JOB, step: 1, screens: [AGENTS, heavy, ALSO, LOGINS, WSP] });
    await waitFor(() => expect(k(t.dialog, "screen-tools")).toBeDefined());
    expect(k(t.dialog, "disk").getAttribute("data-tone")).toBe("muted");
    fireEvent.click(within(t.dialog.querySelector<HTMLElement>('[data-row="big"]')!).getByRole("checkbox"));
    await waitFor(() => expect(k(t.dialog, "disk").getAttribute("data-tone")).toBe("danger"));
    const used = DISK.fixed + 208 * MIB + 72 * MIB + 18 * GIB;
    // The overshoot is said in the meter's tooltip and in the refusal, and nowhere as a third line beside the tally.
    expect(k(t.dialog, "disk").getAttribute("aria-label")).toBe(initDiskLine(used, DISK.total));
    expect(k(t.dialog, "disk").getAttribute("aria-label")).toContain(initDiskOverLine(used - DISK.total));
    expect(t.dialog.querySelector("[data-k=disk-over]")).toBeNull();
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "refusal").textContent).toBe(initDiskOverLine(used - DISK.total)));
    expect(t.api.initAnswer).not.toHaveBeenCalled();
  });

  it("the sign-ins step: each row leads with its mark, the how is the app's picker, a fixed row is disabled with its state word, and the API key choice opens a field whose key is saved under the row before the answer goes", async () => {
    const t = await open({ setup: HELD });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    await walkTo(t, "logins");
    const { dialog, api } = t;
    await waitFor(() => expect(k(dialog, "screen-logins")).toBeDefined());
    expect(k(dialog, "counter").textContent).toBe("4/5");
    expect(k(dialog, "title").textContent).toBe("How sign-ins reach the machine");
    const claude = dialog.querySelector<HTMLElement>('[data-row="logins/claude"]')!;
    expect(claude.querySelector("[data-row-mark=claude]")).not.toBeNull();
    expect(dialog.querySelector('[data-row="logins/gh"] [data-row-mark=gh]')).not.toBeNull();
    const picker = claude.querySelector<HTMLElement>("[data-k=answer]")!;
    expect(picker.getAttribute("aria-haspopup")).toBe("menu");
    expect(picker.getAttribute("data-value")).toBe("machine");
    expect(picker.textContent).toContain("sign in on the machine");
    expect(claude.querySelector("[data-k=why]")!.textContent).toBe("Keychain");
    // The full path rides in the app's own tooltip, not the browser's.
    expect(claude.querySelector("[data-k=why]")!.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(claude.querySelector("[data-k=why]")!.getAttribute("title")).toBeNull();
    expect(claude.querySelector("[data-k=key-field]")).toBeNull();
    const kube = dialog.querySelector<HTMLElement>('[data-row="logins/kube"]')!;
    expect(kube.querySelector("[data-k=state]")!.textContent).toBe(CLOUD_SETUP_WORDS.screen.notOnImage);
    expect(kube.querySelector<HTMLButtonElement>("[data-k=answer]")!.disabled).toBe(true);
    expect(kube.querySelector("[data-k=answer]")!.textContent).toContain("skip");
    // No button on this step acts on click: the pickers are selects and nothing runs until the build.
    expect(dialog.querySelectorAll('[data-k="screen-logins"] [data-k=open]')).toHaveLength(0);
    // The API key choice opens the field under the row, named for the variable the agent reads.
    fireEvent.click(picker);
    await waitFor(() => expect(document.querySelector('[data-k=option][data-value="key"]')).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>('[data-k=option][data-value="key"]')!);
    await waitFor(() => expect(claude.querySelector("[data-k=key-field]")).not.toBeNull());
    // The pick closes the menu and hands focus back to the trigger, so the next row's picker opens on its own click.
    await waitFor(() => expect(document.querySelector("[data-k=option]")).toBeNull());
    expect(picker.getAttribute("aria-expanded")).not.toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(picker));
    const ghPicker = dialog.querySelector<HTMLElement>('[data-row="logins/gh"] [data-k=answer]')!;
    fireEvent.click(ghPicker);
    await waitFor(() => expect(document.querySelector('[data-k=option][data-value="machine"]')).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>('[data-k=option][data-value="machine"]')!);
    await waitFor(() => expect(ghPicker.getAttribute("data-value")).toBe("machine"));
    await waitFor(() => expect(document.querySelector("[data-k=option]")).toBeNull());
    expect(claude.querySelector("[data-k=key-field]")!.textContent).toContain("ANTHROPIC_API_KEY");
    expect(claude.querySelector("[data-k=key-state]")!.textContent).toBe(CLOUD_SETUP_WORDS.keys.unset);
    fireEvent.change(claude.querySelector("input")!, { target: { value: "sk-ant-x-typed" } });
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initKeys).toHaveBeenCalledWith({ rows: { "logins/claude": "sk-ant-x-typed" } }));
    await waitFor(() => expect(api.initAnswer).toHaveBeenCalledWith({ screen: "logins", ticks: [], answers: { "logins/claude": "key", "logins/gh": "machine", "logins/kube": "skip" } }));
    expect(dialog.textContent).not.toContain("sk-ant-x-typed");
    // The screen after the sign-ins is the build's question, counted as the fifth: the wsp screen is not shown.
    await waitFor(() => expect(k(dialog, "ask")).toBeDefined());
    expect(k(dialog, "counter").textContent).toBe("5/5");
    expect(dialog.querySelector('[data-k="screen-wsp"]')).toBeNull();
  });

  it("the steps are the screens the host shows and the first workspace's question: with no formulae and no sign-ins three, counted so, and Back from the question lands on the tools step, the last one shown; with no formulae four", async () => {
    const three: InitJob = { ...JOB, screens: [AGENTS, TOOLS, WSP] };
    const t = await open({ setup: { ...HELD, job: three } });
    await waitFor(() => expect(k(t.dialog, "screen-agents")).toBeDefined());
    expect(k(t.dialog, "counter").textContent).toBe("1/3");
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "screen-tools")).toBeDefined());
    expect(k(t.dialog, "counter").textContent).toBe("2/3");
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "ask")).toBeDefined());
    expect(k(t.dialog, "counter").textContent).toBe("3/3");
    expect(t.dialog.querySelector('[data-k="screen-also"]')).toBeNull();
    expect(t.dialog.querySelector('[data-k="screen-logins"]')).toBeNull();
    fireEvent.click(k(t.dialog, "secondary"));
    await waitFor(() => expect(t.api.initStep).toHaveBeenCalledWith({ at: 1 }));
    await waitFor(() => expect(k(t.dialog, "screen-tools")).toBeDefined());
    expect(k(t.dialog, "counter").textContent).toBe("2/3");
    cleanup();
    const four = await open({ setup: { ...HELD, job: { ...JOB, step: 2, screens: [AGENTS, TOOLS, LOGINS, WSP] } } });
    await waitFor(() => expect(k(four.dialog, "screen-logins")).toBeDefined());
    expect(k(four.dialog, "counter").textContent).toBe("3/4");
    fireEvent.click(k(four.dialog, "secondary"));
    await waitFor(() => expect(four.api.initStep).toHaveBeenCalledWith({ at: 1 }));
    await waitFor(() => expect(k(four.dialog, "screen-tools")).toBeDefined());
    expect(k(four.dialog, "counter").textContent).toBe("2/4");
  });

  it("the build's question: the title, the sentence from the recipe's numbers, both fields in the input grammar, the first launch's MCP answer handed to the job with the build", async () => {
    const t = await open({ setup: HELD });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    await pressPastKeys(t);
    t.emit({ ...JOB, step: 4 });
    const { dialog, api } = t;
    await waitFor(() => expect(k(dialog, "ask")).toBeDefined());
    expect(k(dialog, "title").textContent).toBe("Your first cloud workspace");
    expect(k(dialog, "sentence").textContent).toBe("Forked from the image as soon as the build finishes, on a 2 vCPU · 4 GB machine");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("first");
    const folder = within(dialog).getByLabelText(/Project folder/) as HTMLInputElement;
    expect(folder.placeholder).toBe("/Users/me/code/project");
    // In a browser there is no bridge, so no Choose button is drawn.
    expect(dialog.querySelector("[data-k=choose]")).toBeNull();
    fireEvent.change(folder, { target: { value: "/Users/me/code/app" } });
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initBuild).toHaveBeenCalledWith({ firstWorkspace: "first", importFolder: "/Users/me/code/app" }));
    // The wsp screen's answer is the first launch's: the agents it configured, and no other.
    expect(api.initAnswer).toHaveBeenCalledWith({ screen: "wsp", ticks: ["wsp-tools/claude"] });
    // Back from the question returns to the last screen shown, through the host's step.
    t.emit({ ...JOB, step: 4 });
    fireEvent.click(k(dialog, "secondary"));
    await waitFor(() => expect(api.initStep).toHaveBeenCalledWith({ at: 3 }));
    await waitFor(() => expect(k(dialog, "screen-logins")).toBeDefined());
  });

  it("the build's question with the name cleared: the keycap is held and says why, so a folder can never be sent with nothing to fork", async () => {
    const t = await open({ setup: HELD });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    await pressPastKeys(t);
    t.emit({ ...JOB, step: 4 });
    const { dialog, api } = t;
    await waitFor(() => expect(k(dialog, "ask")).toBeDefined());
    fireEvent.change(within(dialog).getByLabelText(/Project folder/), { target: { value: "/Users/me/code/app" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "  " } });
    await waitFor(() => expect(k(dialog, "primary").hasAttribute("disabled")).toBe(true));
    expect(k(dialog, "primary-reason")).toBeDefined();
    fireEvent.click(k(dialog, "primary"));
    expect(api.initBuild).not.toHaveBeenCalled();
    // Enter in either field is the same keycap, so neither road sends a folder with no name.
    fireEvent.keyDown(within(dialog).getByLabelText(/Project folder/), { key: "Enter" });
    expect(api.initBuild).not.toHaveBeenCalled();
    // A name typed back frees it, and the build goes with both.
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "proj" } });
    await waitFor(() => expect(k(dialog, "primary").hasAttribute("disabled")).toBe(false));
    expect(dialog.querySelector("[data-k=primary-reason]")).toBeNull();
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initBuild).toHaveBeenCalledWith({ firstWorkspace: "proj", importFolder: "/Users/me/code/app" }));
  });

  it("the step lives on the host: the sheet opens on the step the job stands at, Back moves the host's step, and the first step's secondary is Start over, which ends the job", async () => {
    const at2: InitJob = { ...JOB, step: 2, screens: JOB.screens.map(s => (s.id === "agents" ? { ...s, ticks: ["claude", "codex"] } : s)) };
    const { api, dialog, emit } = await open({ setup: { ...HELD, job: at2 } });
    await waitFor(() => expect(k(dialog, "screen-also")).toBeDefined());
    expect(k(dialog, "counter").textContent).toBe("3/5");
    fireEvent.click(k(dialog, "secondary"));
    await waitFor(() => expect(api.initStep).toHaveBeenCalledWith({ at: 1 }));
    await waitFor(() => expect(k(dialog, "screen-tools")).toBeDefined());
    emit({ ...at2, step: 0 });
    await waitFor(() => expect(k(dialog, "screen-agents")).toBeDefined());
    // The answers stand as the host holds them: two agents ticked on a reopened step.
    const rows = [...dialog.querySelectorAll<HTMLElement>('[data-k="screen-agents"] [data-k=row]')];
    expect(rows.map(r => within(r).getByRole("checkbox").getAttribute("aria-checked"))).toEqual(["true", "true", "false"]);
    expect(k(dialog, "secondary").textContent).toBe(CLOUD_SETUP_WORDS.screen.again);
    fireEvent.click(k(dialog, "secondary"));
    await waitFor(() => expect(api.initCancel).toHaveBeenCalled());
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
  });

  it("Start over: a view of the new job stands, and the ended job's setup snapshot landing after it never draws over the sheet", async () => {
    const ended: InitJob = { ...JOB, phase: "cancelled", screens: [], rows: [], step: 0 };
    const fresh: InitJob = { ...JOB, id: "init_2", phase: "reading", screens: [], rows: [{ id: "fact/identity", kind: "fact", label: "Identity", state: INIT_ROW_STATES.running }] };
    const { api, emit } = fakeApi({ setup: { ...HELD, job: ended } });
    // The snapshot the connect reads is of the moment it was asked for; the reply is slow.
    // The connect reads the setup and so does the sheet; both are slow, and both come back with the older job.
    const answers: (() => void)[] = [];
    const asked: Promise<InitSetup>[] = [];
    api.initGet = vi.fn(() => {
      const reply = new Promise<void>(r => answers.push(r)).then(() => ({ ...HELD, job: ended }));
      asked.push(reply);
      return reply;
    });
    useStore.setState({ initJob: null });
    useStore.getState().bind(api);
    render(<CloudSetupDialog onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    // Start over ended one job and the next one is already reading, so its view arrives first.
    emit(fresh);
    await waitFor(() => expect(useStore.getState().initJob?.id).toBe("init_2"));
    // The older snapshot lands now. It is the job Start over left, and it does not become what the sheet draws.
    await act(async () => {
      for (const r of answers) r();
      await Promise.all(asked);
      // The store's own then runs a tick after the reply it is chained to.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useStore.getState().initJob?.id).toBe("init_2");
    expect(k(dialog, "title").textContent).not.toBe(CLOUD_SETUP_WORDS.build.failed);
    expect(dialog.querySelector("[data-k=disk]"), "no ring on a step with nothing to tick").toBeNull();
    await waitFor(() => expect(k(dialog, "reading")).toBeDefined());
  });

  it("every tick goes to the host as it happens, so a sheet shut mid-step reopens on what was ticked and not on what the host last answered", async () => {
    const at2: InitJob = { ...JOB, step: 2 };
    const t = await open({ setup: { ...HELD, job: at2 } });
    await waitFor(() => expect(k(t.dialog, "screen-also")).toBeDefined());
    fireEvent.click(k(t.dialog, "secondary"));
    await waitFor(() => expect(k(t.dialog, "screen-tools")).toBeDefined());
    const gh = t.dialog.querySelector<HTMLElement>('[data-row="gh"]')!;
    expect(within(gh).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(gh).getByRole("checkbox"));
    // The tick is on the host before any Continue, so nothing about it lives only in this sheet.
    await waitFor(() => expect(t.api.initDraft).toHaveBeenCalledWith({ at: "tools", ticks: ["node"], answers: {} }));
    expect(t.api.initAnswer).not.toHaveBeenCalled();
    // Shut and open again: the step is the host's and so is what was ticked on it.
    cleanup();
    const again = await open({ setup: { ...HELD, job: t.held()! } });
    await waitFor(() => expect(k(again.dialog, "screen-tools")).toBeDefined());
    const rows = [...again.dialog.querySelectorAll<HTMLElement>('[data-k="screen-tools"] [data-k=row]')];
    expect(rows.map(r => r.dataset["row"])).toEqual(["node", "gh", "swift"]);
    expect(rows.map(r => within(r).getByRole("checkbox").getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(k(again.dialog, "tally").textContent).toContain(initTallyLine(1, "tools", DISK.fixed + 208 * MIB + 60 * MIB, DISK.total));
  });

  it("a key typed under a sign-in row is never drafted: it goes to the key store on Continue and nowhere else", async () => {
    const t = await open({ setup: { ...HELD, job: { ...JOB, step: 3 } } });
    await waitFor(() => expect(k(t.dialog, "screen-logins")).toBeDefined());
    const claude = t.dialog.querySelector<HTMLElement>('[data-row="logins/claude"]')!;
    fireEvent.click(claude.querySelector<HTMLElement>("[data-k=answer]")!);
    await waitFor(() => expect(document.querySelector('[data-k=option][data-value="key"]')).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>('[data-k=option][data-value="key"]')!);
    await waitFor(() => expect(claude.querySelector("[data-k=key-field]")).not.toBeNull());
    // The pick is an answer and is kept; what is typed into the field after it is not.
    await waitFor(() => expect(t.api.initDraft).toHaveBeenCalledWith({ at: "logins", ticks: [], answers: expect.objectContaining({ "logins/claude": "key" }) as Record<string, string> }));
    const before = t.api.initDraft.mock.calls.length;
    fireEvent.change(claude.querySelector("input")!, { target: { value: "sk-ant-x-typed" } });
    expect(t.api.initDraft.mock.calls.length).toBe(before);
    expect(JSON.stringify(t.api.initDraft.mock.calls)).not.toContain("sk-ant-x-typed");
  });

  it("the workspace name typed on the build's question is kept on the host, so Back and a shut sheet both come back to it", async () => {
    const t = await open({ setup: { ...HELD, job: { ...JOB, step: 4 } } });
    await waitFor(() => expect(k(t.dialog, "ask")).toBeDefined());
    const name = t.dialog.querySelector<HTMLInputElement>("#setup-first-name")!;
    expect(name.value).toBe("first");
    fireEvent.change(name, { target: { value: "e2e" } });
    // Typing alone does not push a view to every client; leaving the field is what keeps it.
    expect(t.api.initDraft).not.toHaveBeenCalled();
    fireEvent.blur(name);
    await waitFor(() => expect(t.api.initDraft).toHaveBeenCalledWith({ at: "build", ticks: [], answers: { name: "e2e", folder: "" } }));
    // Leaving a field the person did not change keeps nothing: tabbing through pushes no view to any client.
    const kept = t.api.initDraft.mock.calls.length;
    fireEvent.blur(name);
    fireEvent.blur(t.dialog.querySelector<HTMLInputElement>("#setup-first-folder")!);
    expect(t.api.initDraft.mock.calls.length).toBe(kept);
    // Back to the sign-ins and forward again: the name is where it was left, not back at the default.
    fireEvent.click(k(t.dialog, "secondary"));
    await waitFor(() => expect(k(t.dialog, "screen-logins")).toBeDefined());
    t.emit({ ...t.held()!, step: 4 });
    await waitFor(() => expect(k(t.dialog, "ask")).toBeDefined());
    expect(t.dialog.querySelector<HTMLInputElement>("#setup-first-name")!.value).toBe("e2e");
    // And a sheet shut and opened again lands on it too.
    cleanup();
    const again = await open({ setup: { ...HELD, job: t.held()! } });
    await waitFor(() => expect(k(again.dialog, "ask")).toBeDefined());
    expect(again.dialog.querySelector<HTMLInputElement>("#setup-first-name")!.value).toBe("e2e");
  });

  it("a build the person stopped says it was them with the stage it stopped at, and the first workspace reads not made", async () => {
    const stopped: InitJob = {
      ...JOB,
      phase: "cancelled",
      stoppable: false,
      error: `${initStoppedAt("while creating the machine")} ${MACHINE_GONE_LINE}`,
      rows: [
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: INIT_ROW_STATES.failed, lines: ["sandbox from base"] },
        { id: "stage/snapshotting", kind: "stage", label: GOLDEN_STAGE_WORDS.snapshotting, state: INIT_ROW_STATES.waiting },
        { id: "workspace/e2e", kind: "workspace", label: "e2e", state: INIT_ROW_STATES.notMade },
      ],
      progress: { done: 0, total: 3 },
      log: [],
    };
    const { dialog } = await open({ setup: { ...HELD, job: stopped } });
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    expect(k(dialog, "title").textContent).toBe(CLOUD_SETUP_WORDS.build.stopped);
    expect(k(dialog, "sentence").textContent).toBe(stopped.error);
    expect(dialog.querySelector('[data-row="workspace/e2e"] [data-k=state]')!.textContent).toBe(INIT_ROW_STATES.notMade);
    // The stage the machine never got a slot for still stands in the list, waiting.
    expect(dialog.querySelector('[data-row="stage/snapshotting"] [data-k=state]')!.textContent).toBe(INIT_ROW_STATES.waiting);
    expect(k(dialog, "primary").textContent).toContain(CLOUD_SETUP_WORDS.build.again);
  });

  it("a machine the provider would not take is a row like any other, with its glyph, its name in words and its state word, and it rides on whatever job is current", async () => {
    const sweeping: InitJob = {
      ...JOB,
      phase: "cancelled",
      stoppable: false,
      error: `Stopped while creating the machine. ${STOP_LEFT_MACHINE_LINE}`,
      rows: [
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: INIT_ROW_STATES.stopped, lines: ["sandbox from base"] },
        { id: "machine/b_dlb9oeig", kind: "machine", label: MACHINE_ROW_LABEL, state: INIT_ROW_STATES.retrying, detail: "getaddrinfo ENOTFOUND api.getsolari.com" },
      ],
      progress: { done: 0, total: 1 },
      log: [],
    };
    const { dialog, emit } = await open({ setup: { ...HELD, job: sweeping } });
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    const row = dialog.querySelector<HTMLElement>('[data-row="machine/b_dlb9oeig"]')!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain(MACHINE_ROW_LABEL);
    expect(row.textContent).not.toContain("b_dlb9oeig");
    expect(row.querySelector("[data-k=state]")!.textContent).toBe(INIT_ROW_STATES.retrying);
    // A live row, so a filled glyph and no chevron: there is nothing to open and nothing to press.
    expect(row.querySelector("svg")).toBeNull();
    expect(row.querySelector('[aria-hidden] > span[class*="bg-foreground"]')).not.toBeNull();
    expect(row.getAttribute("aria-expanded")).toBeNull();
    // The stage the person's stop ended reads stopped, not failed: no cross under a headline that says it was them.
    const stage = dialog.querySelector<HTMLElement>('[data-row="stage/creating"]')!;
    expect(stage.querySelector("[data-k=state]")!.textContent).toBe(INIT_ROW_STATES.stopped);
    expect(stage.querySelector("[data-k=state]")!.className).not.toContain("text-destructive-foreground");
    // Once the provider takes it the row says gone and wears the check every ended row wears.
    emit({ ...sweeping, rows: sweeping.rows.map(r => (r.kind === "machine" ? { id: r.id, kind: r.kind, label: r.label, state: INIT_ROW_STATES.gone } : r)) });
    await waitFor(() => expect(dialog.querySelector('[data-row="machine/b_dlb9oeig"] [data-k=state]')!.textContent).toBe(INIT_ROW_STATES.gone));
    expect(dialog.querySelector('[data-row="machine/b_dlb9oeig"] svg')).not.toBeNull();
  });

  it("the sidebar's keycap and the sheet's bar are one count, and while a machine is still being removed the keycap says so", async () => {
    const building: InitJob = {
      ...JOB,
      phase: "building",
      rows: [
        { id: "agent/claude", kind: "agent", label: "Claude Code", state: MCP_ADDED_WORD },
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "done" },
        { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "Sign in to GitHub CLI", state: INIT_ROW_STATES.waiting },
        { id: "stage/snapshotting", kind: "stage", label: GOLDEN_STAGE_WORDS.snapshotting, state: INIT_ROW_STATES.failed },
        { id: "workspace/first", kind: "workspace", label: "first", state: INIT_ROW_STATES.notMade },
      ],
      progress: { done: 1, total: 3 },
      log: [],
    };
    // The host's field is the sheet's own function over the sheet's own rows, so the two can never say two things.
    expect(building.progress).toEqual(initStageCount(initBuildRows(building.rows).rows));
    const { dialog } = await open({ setup: { ...HELD, job: building } });
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    expect(k(dialog, "count").textContent).toBe(initStageCountLine(building.progress));
    expect(initProgressLine(building)).toBe(`building · ${building.progress.done}/${building.progress.total}`);
    // A machine still being removed takes the keycap's line, since that one bills while nobody looks.
    expect(initProgressLine({ ...building, rows: [...building.rows, { id: "machine/b_1", kind: "machine", label: MACHINE_ROW_LABEL, state: INIT_ROW_STATES.retrying }] })).toBe(MACHINE_SWEEP_LINE);
  });

  it("a stage waiting on the account's machine cap reads so on its row with the cap line in its block", async () => {
    const waiting: InitJob = {
      ...JOB,
      phase: "building",
      rows: [{ id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: INIT_ROW_STATES.slot, lines: ["sandbox from base", "Solari account at its machine cap; waiting 30s for a slot (5/20). Nothing is killed."] }],
      progress: { done: 0, total: 1 },
      log: [],
    };
    const { dialog } = await open({ setup: { ...HELD, job: waiting } });
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    const row = dialog.querySelector<HTMLElement>('[data-row="stage/creating"]')!;
    expect(row.querySelector("[data-k=state]")!.textContent).toBe(INIT_ROW_STATES.slot);
    // The wait is the running row, so its block is open on the cap line the runtime wrote.
    expect(row.dataset["open"]).toBe("true");
    expect(row.querySelector("[data-k=lines]")!.textContent).toContain("at its machine cap");
  });

  it("a refusal on a screen shows above the footer in the host's words and in the danger tone, and the screen stays", async () => {
    const t = await open({ setup: HELD, refuse: "agents" });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    await walkTo(t, "agents");
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "refusal").textContent).toBe("the agents screen was refused by the host"));
    expect(k(t.dialog, "screen-agents")).toBeDefined();
    expect(t.dialog.querySelectorAll("[data-k=refusal]")).toHaveLength(1);
    // It sits above the keycap and its link, where the note does, and not under the Back link below them.
    const refusal = k(t.dialog, "refusal");
    expect(refusal.compareDocumentPosition(k(t.dialog, "footer")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(refusal.className).toContain("text-destructive-foreground");
    expect(refusal.className).not.toContain("text-warning-foreground");
  });

  it("ticking past the image's disk refuses Continue with the overshoot, above the footer and in the ring's own tone", async () => {
    const small: InitJob = { ...JOB, step: 1, disk: { fixed: 19 * GIB, total: 20 * GIB } };
    const { dialog, api } = await open({ setup: { ...HELD, job: small } });
    await waitFor(() => expect(k(dialog, "screen-tools")).toBeDefined());
    // Swift takes the image 3 GB past a disk with 1 GB to spare, and the ring says so.
    fireEvent.click(within(dialog.querySelector<HTMLElement>('[data-row="swift"]')!).getByRole("checkbox"));
    const over = initDiskOverLine(19 * GIB + 208 * MIB + 60 * MIB + 12 * MIB + 3 * GIB - 20 * GIB);
    await waitFor(() => expect(dialog.querySelector("[data-k=disk]")!.getAttribute("aria-label")).toContain(over));
    expect(dialog.querySelector("[data-k=disk-over]")).toBeNull();
    expect(dialog.querySelector("[data-k=disk]")!.getAttribute("data-tone")).toBe("danger");
    fireEvent.click(k(dialog, "primary"));
    // The refusal is the ring's own words: one rule, said in one place, read in two.
    await waitFor(() => expect(k(dialog, "refusal").textContent).toBe(over));
    // Nothing was sent, the line is the ring's tone, and it stands above the footer.
    expect(api.initAnswer).not.toHaveBeenCalled();
    const refusal = k(dialog, "refusal");
    expect(refusal.className).toContain("text-destructive-foreground");
    expect(refusal.compareDocumentPosition(k(dialog, "footer")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Esc and the close button hide the sheet with the job running on, and never lose the step", async () => {
    const at1: InitJob = { ...JOB, step: 1 };
    const { api, dialog, onClose } = await open({ setup: { ...HELD, job: at1 } });
    await waitFor(() => expect(k(dialog, "screen-tools")).toBeDefined());
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.initCancel).not.toHaveBeenCalled();
    expect(api.initStep).not.toHaveBeenCalled();
  });

  it("while the sign-in stage runs the build is a slide of large sign-in rows with the code, the keycap and the hand-off's line, the stages folded to one line; once the last settles the list is back: stages in order, the running one open with its lines, a done one folded and openable, the sign-ins one stage, the agent rows gone, one footer link that asks once; Esc hides it with the note saying the build goes on", async () => {
    const building: InitJob = {
      ...JOB,
      phase: "signing-in",
      screens: [],
      rows: [
        { id: "agent/claude", kind: "agent", label: "Claude Code", state: MCP_ADDED_WORD },
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "done", ms: 12_000, lines: ["sandbox from base"] },
        { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "done" },
        { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "Sign in to GitHub CLI", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", code: "8F4A-C21B" },
        { id: "sign-in/claude", kind: "sign-in", tool: "claude", label: "Sign in to Claude Code", state: INIT_ROW_STATES.keySet },
        // The host's note names the command the machine ran; no screen shows it.
        { id: "sign-in/codex", kind: "sign-in", tool: "codex", label: "Sign in to Codex", state: INIT_SIGN_IN_WORDS.copied, detail: "codex login --api-key exited 0" },
        { id: "sign-in/wrangler", kind: "sign-in", tool: "wrangler", label: "Sign in to Cloudflare Wrangler", state: INIT_SIGN_IN_WORDS["not-signed-in"], detail: "wrangler login exited 1; no sign-in within 16m" },
        { id: "stage/snapshotting", kind: "stage", label: GOLDEN_STAGE_WORDS.snapshotting, state: INIT_ROW_STATES.running, lines: [snapshotStageLine(13 * GIB)], since: Date.now() - 41_000 },
        { id: "stage/sealed", kind: "stage", label: GOLDEN_STAGE_WORDS.sealed, state: "waiting" },
        { id: "workspace/first", kind: "workspace", label: "first", state: "waiting" },
      ],
      progress: { done: 5, total: 9 },
      log: ["Recipe saved"],
    };
    const { emit, dialog, onClose, api } = await open({ setup: { ...HELD, job: building } });
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    // A page waits on the person, so the screen is the sign-ins slide: its own title and sentence, the stages folded to one line with the count (two of the five stages done, the first workspace beside them counting for neither end), one large row per sign-in in order.
    expect(k(dialog, "title").textContent).toBe(CLOUD_SETUP_WORDS.build.slideHeadline);
    expect(k(dialog, "sentence").textContent).toBe(CLOUD_SETUP_WORDS.build.slideTop);
    expect(k(dialog, "stages-folded").textContent).toBe(`${CLOUD_SETUP_WORDS.build.headline} · 2 of 5`);
    expect(dialog.querySelector("[data-k=count]")).toBeNull();
    expect([...dialog.querySelectorAll<HTMLElement>("[data-k=signin]")].map(r => r.dataset["row"])).toEqual(["sign-in/gh", "sign-in/claude", "sign-in/codex", "sign-in/wrangler"]);
    expect(dialog.querySelector('[data-row="agent/claude"]'), "the MCP rows are not build stages").toBeNull();
    expect(dialog.querySelector('[data-row="stage/snapshotting"]'), "the stage list is folded away").toBeNull();
    // The slide's rows carry the mark, the code in the large mono, and the keycap that opens the page.
    const gh = dialog.querySelector<HTMLElement>('[data-row="sign-in/gh"]')!;
    expect(gh.dataset["k"]).toBe("signin");
    expect(gh.querySelector("[data-k=code]")!.className).toContain("text-[20px]");
    expect(gh.querySelector("[data-row-mark=gh]")).not.toBeNull();
    expect(gh.querySelector("[data-k=state]")!.textContent).toBe("waiting for you");
    expect(gh.querySelector<HTMLAnchorElement>("[data-k=open]")!.getAttribute("href")).toBe("https://github.com/login/device");
    expect(gh.querySelector("[data-k=open]")!.getAttribute("target")).toBe("_blank");
    expect(gh.querySelector("[data-k=open]")!.textContent).toContain(CLOUD_SETUP_WORDS.build.open);
    expect(gh.querySelector("[data-k=code]")!.textContent).toBe("8F4A-C21B");
    expect(dialog.querySelector('[data-row="sign-in/claude"] [data-k=state]')!.textContent).toBe("key set");
    expect(dialog.querySelector('[data-row="sign-in/codex"] [data-k=state]')!.textContent).toBe("copied from this Mac");
    // One line per row unless there is something to do: the waiting row and the one to retry carry the action line, the code
    // and the keycap on it with the protocol's sentence; the key-set and copied rows are the name's line alone. The state
    // word stays on the name's line, and no command the machine ran reaches any row, on the line or as a title.
    const slideRows = [...dialog.querySelectorAll<HTMLElement>("[data-k=signin]")];
    expect(slideRows.map(r => [r.dataset["row"], r.dataset["acts"], r.children.length])).toEqual([
      ["sign-in/gh", "true", 2],
      ["sign-in/claude", "false", 1],
      ["sign-in/codex", "false", 1],
      ["sign-in/wrangler", "true", 2],
    ]);
    for (const r of slideRows) expect(r.firstElementChild!.querySelector("[data-k=state]"), `${r.dataset["row"]}: the state word on the name's line`).not.toBeNull();
    expect(gh.querySelector("[data-k=act] [data-k=code]")).not.toBeNull();
    expect(gh.querySelector("[data-k=act] [data-k=open]")).not.toBeNull();
    expect(gh.querySelector("[data-k=act] [data-k=why]")!.textContent).toBe(initSignInLine({ state: SIGN_IN_OPEN_STATE, code: "8F4A-C21B" }));
    expect(dialog.querySelector('[data-row="sign-in/wrangler"] [data-k=act] [data-k=retry]')).not.toBeNull();
    expect(dialog.querySelector("[data-k=handoff]")).toBeNull();
    expect(dialog.textContent).not.toMatch(/exited|codex login|wrangler login/);
    expect(dialog.querySelectorAll("[data-k=signin] [title]:not([data-k=state])")).toHaveLength(0);
    // Every row reserves the mark's column once one row has a mark, the one without a mark of its own included.
    expect(slideRows.map(r => r.querySelector("[data-k=mark-column]") !== null)).toEqual([true, true, true, true]);
    expect(dialog.querySelector('[data-row="sign-in/wrangler"] [data-row-mark]')).toBeNull();
    // No chip, no badge: state is a word or the spinner.
    expect(dialog.querySelector("[data-badge], .animate-status-pulse")).toBeNull();
    // One footer action: the cancel link asks once; the note says the build keeps running and wsp tells them when needed.
    expect(dialog.querySelector("[data-k=primary]")).toBeNull();
    expect(k(dialog, "note").textContent).toBe(CLOUD_SETUP_WORDS.build.keeps);
    expect(k(dialog, "secondary").textContent).toBe(CLOUD_SETUP_WORDS.build.cancel);
    const contentBefore = k(dialog, "content").innerHTML;
    fireEvent.click(k(dialog, "secondary"));
    expect(api.initCancel).not.toHaveBeenCalled();
    expect(k(dialog, "secondary").textContent).toBe(CLOUD_SETUP_WORDS.build.cancelSure);
    expect(k(dialog, "note").textContent).toBe(CLOUD_SETUP_WORDS.build.cancelWhy);
    // The question is one block in the footer: the two answers side by side under the sentence, nothing under the card.
    const links = k(dialog, "links");
    expect(links.children).toHaveLength(2);
    expect(links.querySelector("[data-k=secondary]")).not.toBeNull();
    expect(links.querySelector("[data-k=aside]")).not.toBeNull();
    expect(k(dialog, "aside").textContent).toBe(CLOUD_SETUP_WORDS.build.cancelKeep);
    expect(k(dialog, "footer").contains(k(dialog, "aside"))).toBe(true);
    expect(k(dialog, "content").innerHTML).toBe(contentBefore);
    expect(dialog.querySelector("[data-k=keep]")).toBeNull();
    fireEvent.click(k(dialog, "aside"));
    expect(k(dialog, "secondary").textContent).toBe(CLOUD_SETUP_WORDS.build.cancel);
    expect(dialog.querySelector("[data-k=aside]")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.initCancel).not.toHaveBeenCalled();
    // The result lands as a state word and the page link goes.
    emit({ ...building, rows: building.rows.map(r => (r.id === "sign-in/gh" || r.id === "sign-in/wrangler" ? { id: r.id, kind: r.kind, tool: r.tool, label: r.label, state: INIT_SIGN_IN_WORDS["signed-in"] } : r)), progress: { done: 6, total: 9 } });
    // With the last sign-in settled the list is back: stages in order, the sign-ins one stage reading done and folded, the count and the line along the card's top edge.
    await waitFor(() => expect(k(dialog, "title").textContent).toBe(CLOUD_SETUP_WORDS.build.headline));
    expect(within(dialog).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
    expect(k(dialog, "count").textContent).toBe("3 of 5");
    const rows = [...dialog.querySelectorAll<HTMLElement>('[data-k="build"] [data-k=card] > * > * > ul > li[data-k=row]')];
    expect(rows.map(r => r.dataset["row"])).toEqual(["stage/creating", "stage/ready", SIGN_IN_STAGE_ID, "stage/snapshotting", "stage/sealed", "workspace/first"]);
    const signIns = dialog.querySelector<HTMLElement>(`[data-row="${SIGN_IN_STAGE_ID}"]`)!;
    expect(signIns.dataset["state"]).toBe("done");
    expect(signIns.dataset["open"]).toBe("false");
    fireEvent.click(within(signIns).getByRole("button"));
    expect([...signIns.querySelectorAll<HTMLElement>("[data-k=sign-ins] [data-k=row]")].map(r => r.dataset["row"])).toEqual(["sign-in/gh", "sign-in/claude", "sign-in/codex", "sign-in/wrangler"]);
    expect(dialog.querySelector('[data-row="sign-in/gh"] [data-k=state]')!.textContent).toBe("done");
    expect(dialog.querySelector('[data-row="sign-in/gh"] [data-k=open]')).toBeNull();
    // The sub-rows reserve the mark's column too, and carry no title with the machine's command.
    expect([...signIns.querySelectorAll<HTMLElement>("[data-k=sign-ins] [data-k=row]")].map(r => r.querySelector("[data-k=mark-column]") !== null)).toEqual([true, true, true, true]);
    expect(signIns.querySelectorAll("[data-k=sign-ins] [title]:not([data-k=state])")).toHaveLength(0);
    // The running stage is open on its own with the machine's lines, the block as tall as its one line and the seconds it has run beside the spinner; the done one is folded and opens on a click.
    const snap = dialog.querySelector<HTMLElement>('[data-row="stage/snapshotting"]')!;
    expect(snap.dataset["open"]).toBe("true");
    expect(snap.querySelector("[data-k=lines]")!.textContent).toBe(snapshotStageLine(13 * GIB));
    expect(snap.querySelector<HTMLElement>("[data-k=lines]")!.dataset["lines"]).toBe("1");
    expect(snap.querySelector<HTMLElement>("[data-k=lines]")!.style.getPropertyValue("--stage-lines")).toBe("1");
    expect(snap.querySelector("[data-k=elapsed]")!.textContent).toMatch(/^4[0-9]s$/);
    expect(snap.querySelector("[data-k=state][role=status]")).not.toBeNull();
    expect(dialog.querySelector('[data-row="stage/creating"] [data-k=elapsed]'), "a done stage has no clock").toBeNull();
    const creating = dialog.querySelector<HTMLElement>('[data-row="stage/creating"]')!;
    expect(creating.dataset["open"]).toBe("false");
    fireEvent.click(within(creating).getByRole("button"));
    expect(creating.dataset["open"]).toBe("true");
    expect(creating.querySelector("[data-k=lines]")!.textContent).toBe("sandbox from base");
    expect(dialog.querySelector('[data-row="stage/sealed"] [role=button]')).toBeNull();
    // Done: the headline turns and the one keycap opens the workspace.
    emit({ ...building, phase: "done", golden: { version: 1 }, workspace: { id: "ws_first", name: "first" }, rows: building.rows.map(r => ({ ...r, state: r.kind === "workspace" ? "forked" : r.kind === "sign-in" ? INIT_SIGN_IN_WORDS["signed-in"] : "done" })), progress: { done: 9, total: 9 } });
    await waitFor(() => expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.build.done));
    // The sentence says what stands, not what was running.
    expect(k(dialog, "sentence").textContent).toBe(CLOUD_SETUP_WORDS.build.doneTop);
    expect(k(dialog, "primary").textContent).toBe(`${CLOUD_SETUP_WORDS.build.keycap}→`);
    expect(dialog.querySelector("[data-k=secondary]")).toBeNull();
    fireEvent.click(k(dialog, "primary"));
    expect(useStore.getState().selectedId).toBe("ws_first");
    expect(useStore.getState().hasGolden).toBe(true);
  });

  it("the agent step shows the thread's own latest line in the mono block with the spinner, and its link focuses the thread and shuts the sheet", async () => {
    const { emit, dialog, onClose } = await open({ setup: { ...HELD, job: AGENT_JOB } });
    await waitFor(() => expect(k(dialog, "agent")).toBeDefined());
    expect(k(dialog, "title").textContent).toBe(CLOUD_SETUP_WORDS.agent.headline);
    // Before the thread's first line the block says what it waits for, and nothing fakes a step.
    expect(k(dialog, "line").textContent).toBe(CLOUD_SETUP_WORDS.agent.waiting);
    expect(k(dialog, "spinner")).toBeDefined();
    expect(dialog.querySelector("[data-k=primary]")).toBeNull();
    emit({ ...AGENT_JOB, line: "$ recipe_scan" });
    await waitFor(() => expect(k(dialog, "line").textContent).toBe("$ recipe_scan"));
    fireEvent.click(k(dialog, "open-thread"));
    expect(useStore.getState().selectedId).toBe("ws_local");
    expect(useStore.getState().selectedThreadId).toBe("th_1");
    expect(onClose).toHaveBeenCalled();
  });

  it("a turn that ended without the recipe says so on the agent step, with Retry starting the same agent again and Start over going back to the choice", async () => {
    const stopped: InitJob = { ...AGENT_JOB, phase: "failed", line: "Permission for Bash: wsp recipe scan --json", error: "the thread ended without writing /Users/me/.wsp/recipe.json" };
    const { api, dialog } = await open({ setup: { ...HELD, job: stopped } });
    await waitFor(() => expect(k(dialog, "agent")).toBeDefined());
    expect(k(dialog, "title").textContent).toBe(CLOUD_SETUP_WORDS.agent.failed);
    expect(k(dialog, "sentence").textContent).toBe(stopped.error);
    expect(k(dialog, "line").textContent).toBe(stopped.line);
    expect(dialog.querySelector("[data-k=spinner]")).toBeNull();
    expect(k(dialog, "primary").textContent).toBe(`${CLOUD_SETUP_WORDS.agent.retry}→`);
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initStart).toHaveBeenCalledWith({ road: "agent", harness: "claude" }));
    expect(k(dialog, "secondary").textContent).toBe(CLOUD_SETUP_WORDS.agent.again);
    fireEvent.click(k(dialog, "secondary"));
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
  });

  it("a job stopped from elsewhere carries no reason, so the step says the thread ended rather than falling back to the running sentence", async () => {
    const { dialog } = await open({ setup: { ...HELD, job: { ...AGENT_JOB, phase: "cancelled" } } });
    await waitFor(() => expect(k(dialog, "agent")).toBeDefined());
    expect(k(dialog, "title").textContent).toBe(CLOUD_SETUP_WORDS.agent.failed);
    expect(k(dialog, "sentence").textContent).toBe(CLOUD_SETUP_WORDS.agent.stopped);
    expect(k(dialog, "primary").textContent).toContain(CLOUD_SETUP_WORDS.agent.retry);
  });

  it("a sign-in that ran out shows Retry, which runs it again on the machine; while the seal runs the cancel link is disabled with its reason as the tooltip and no amber refusal", async () => {
    const sealing: InitJob = {
      ...JOB,
      phase: "sealing",
      stoppable: false,
      screens: [],
      rows: [
        { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "done" },
        { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "Sign in to GitHub CLI", state: INIT_SIGN_IN_WORDS["not-signed-in"], detail: "no sign-in within 16m" },
        { id: "stage/snapshotting", kind: "stage", label: GOLDEN_STAGE_WORDS.snapshotting, state: INIT_ROW_STATES.running },
      ],
      progress: { done: 1, total: 3 },
    };
    const { api, dialog } = await open({ setup: { ...HELD, job: sealing } });
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    const gh = dialog.querySelector<HTMLElement>('[data-row="sign-in/gh"]')!;
    expect(gh.querySelector("[data-k=state]")!.textContent).toBe("not signed in");
    // The stage the run-out folds into wears the failed glyph beside not signed in, open or folded, never a tick.
    const stage = dialog.querySelector<HTMLElement>(`[data-row="${SIGN_IN_STAGE_ID}"]`)!;
    expect(stage.querySelector("[data-k=state]")!.textContent).toBe("not signed in");
    expect(stage.querySelector("[data-glyph]")!.getAttribute("data-glyph")).toBe("failed");
    expect(stage.dataset["open"]).toBe("true");
    const stageRow = stage.querySelector<HTMLElement>(':scope > div[role="button"]')!;
    fireEvent.click(stageRow);
    expect(stage.dataset["open"]).toBe("false");
    expect(stage.querySelector("[data-glyph]")!.getAttribute("data-glyph")).toBe("failed");
    fireEvent.click(stageRow);
    expect(stage.dataset["open"]).toBe("true");
    // The sub-rows are drawn again on the reopen, so the keycap is looked up again.
    fireEvent.click(dialog.querySelector<HTMLElement>('[data-row="sign-in/gh"] [data-k=retry]')!);
    await waitFor(() => expect(api.initRetry).toHaveBeenCalledWith({ tool: "gh" }));
    const cancel = k(dialog, "secondary") as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(cancel.getAttribute("title")).toBeNull();
    expect(dialog.querySelector("[data-k=secondary-reason]"), "the reason rides on the tooltip's wrapper").not.toBeNull();
    // Quiet at rest: the muted foreground, the danger tone only on hover and focus, the disabled link at half opacity.
    expect(cancel.className).toContain("text-muted-foreground");
    expect(cancel.className).toContain("hover:text-destructive-foreground");
    expect(cancel.className).toContain("disabled:opacity-50");
    fireEvent.click(cancel);
    expect(api.initCancel).not.toHaveBeenCalled();
    expect(dialog.querySelector("[data-k=refusal]")).toBeNull();
  });

  it("a sign-in whose page hands a code back takes it on its row and sends it to the host for that tool; a refused submit says so and the row stays", async () => {
    const PASTED = "4/0AfakeCodeFromThePage";
    const signing: InitJob = {
      ...JOB,
      phase: "signing-in",
      screens: [],
      rows: [{ id: "sign-in/gcloud", kind: "sign-in", tool: "gcloud", label: "Sign in to Google Cloud", state: SIGN_IN_OPEN_STATE, page: "https://accounts.google.com/o/oauth2/auth", finish: "code" }],
      progress: { done: 0, total: 1 },
    };
    const { api, dialog } = await open({ setup: { ...HELD, job: signing }, refuse: "code" });
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    // The field is the line under the row it belongs to, inside it, and no other row has one.
    expect(dialog.querySelectorAll("[data-k=code-line]")).toHaveLength(1);
    expect(dialog.querySelector('[data-row="sign-in/gcloud"] [data-k=code-field]')).not.toBeNull();
    fireEvent.change(k(dialog, "code-field"), { target: { value: PASTED } });
    fireEvent.click(k(dialog, "code-submit"));
    await waitFor(() => expect(api.initSignInCode).toHaveBeenCalledWith({ tool: "gcloud", code: PASTED }));
    // The host refused this one: its words show under the keycap and the field is still there to try again.
    await waitFor(() => expect(k(dialog, "refusal").textContent).toBe("no sign-in for gcloud is waiting for a code from you"));
    expect(k(dialog, "code-field")).toBeDefined();
    expect(dialog.textContent).not.toContain(PASTED);
  });

  it("opened from the row, the sheet outlives the seal: the done screen stays, Open workspace selects the fork, and only then does the row go", async () => {
    const building: InitJob = { ...JOB, phase: "sealing", screens: [], rows: [{ id: "stage/sealed", kind: "stage", label: GOLDEN_STAGE_WORDS.sealed, state: "running" }], progress: { done: 0, total: 1 } };
    const { api, emit } = fakeApi({ setup: { ...HELD, job: building } });
    useStore.setState({ initJob: building });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    emit({ ...building, phase: "done", golden: { version: 1 }, workspace: { id: "ws_first", name: "first" }, rows: [{ id: "stage/sealed", kind: "stage", label: GOLDEN_STAGE_WORDS.sealed, state: "done" }], progress: { done: 1, total: 1 } });
    await waitFor(() => expect(useStore.getState().hasGolden).toBe(true));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain(CLOUD_SETUP_WORDS.build.done));
    fireEvent.click(k(screen.getByRole("dialog"), "primary"));
    expect(useStore.getState().selectedId).toBe("ws_first");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBeNull();
  });

  it("a saved key refused at build time draws the job the host leaves: the first stage failed with the refusal, the rows after it never reached, nothing counted as done, and Change the key back to the keys step", async () => {
    const stopped: InitJob = { ...JOB, phase: "failed", screens: [], rows: KEY_REFUSED_ROWS, progress: { done: 0, total: KEY_REFUSED_ROWS.length }, error: KEY_REFUSED_LINE, keyRefused: true };
    const t = await open({ setup: { ...HELD, job: stopped } });
    await waitFor(() => expect(k(t.dialog, "build")).toBeDefined());
    expect(k(t.dialog, "title").textContent).toBe(CLOUD_SETUP_WORDS.build.failed);
    expect(k(t.dialog, "sentence").textContent).toBe(KEY_REFUSED_LINE);
    expect(t.dialog.textContent).not.toContain("Nothing was booted");
    // Nothing on the screen reads as work done: the count is none of the stages and the bar is at nothing.
    const { rows } = initBuildRows(KEY_REFUSED_ROWS);
    expect(initStageCount(rows).done).toBe(0);
    expect(k(t.dialog, "count").textContent).toBe(initStageCountLine(initStageCount(rows)));
    expect(k(t.dialog, "progress").getAttribute("aria-valuenow")).toBe("0");
    // The first stage carries the refusal as its line; the sign-in fold and the workspace read as never reached.
    const state = (row: string): string | null => t.dialog.querySelector(`[data-row="${row}"]`)!.getAttribute("data-state");
    expect(state("stage/creating")).toBe(INIT_ROW_STATES.failed);
    expect(within(t.dialog.querySelector<HTMLElement>('[data-row="stage/creating"]')!).getByText(KEY_REFUSED_LINE)).toBeDefined();
    expect(state(SIGN_IN_STAGE_ID)).toBe(INIT_ROW_STATES.skipped);
    // A workspace nothing made reads not made; skipped would read as a step the build chose to pass on.
    expect(state("workspace/first")).toBe(INIT_ROW_STATES.notMade);
    expect([...t.dialog.querySelectorAll("[data-row]")].map(r => r.getAttribute("data-state"))).not.toContain(INIT_ROW_STATES.done);
    // The way on is the step that takes a key, not another build off the same one.
    const keycap = k(t.dialog, "primary");
    expect(keycap.textContent).toContain(CLOUD_SETUP_WORDS.keys.changeKey);
    expect(keycap.textContent).not.toContain(CLOUD_SETUP_WORDS.build.again);
    fireEvent.click(keycap);
    await waitFor(() => expect(k(t.dialog, "keys")).toBeDefined());
    expect(t.dialog.querySelector("[data-k=key-check]")).toBeNull();
    expect(t.api.initStart).not.toHaveBeenCalled();
    // The refused key is not the one to keep: the step opens on an empty field for a new one, not on the saved dots.
    const field = t.dialog.querySelector<HTMLInputElement>("#setup-key-solari")!;
    expect(field.value).toBe("");
    expect(field.readOnly).toBe(false);
    expect(t.dialog.querySelector("[data-k=solari-state]")).toBeNull();
    expect((k(t.dialog, "primary") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a build that could not ask the provider about the key offers Start over: the saved key may be fine", async () => {
    const line = keyUncheckedLine("fetch failed");
    const rows = keyStoppedRows(line);
    const stopped: InitJob = { ...JOB, phase: "failed", screens: [], rows, progress: { done: 0, total: rows.length }, error: line };
    const t = await open({ setup: { ...HELD, job: stopped } });
    await waitFor(() => expect(k(t.dialog, "build")).toBeDefined());
    expect(k(t.dialog, "sentence").textContent).toBe(line);
    expect(k(t.dialog, "primary").textContent).toContain(CLOUD_SETUP_WORDS.build.again);
  });

  it("the sidebar row reads the job's line while it runs and the sheet is shut, and the plain words otherwise", async () => {
    const { api } = fakeApi({ setup: HELD });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    expect(row.textContent).toBe(CLOUD_SETUP_WORDS.row);
    const job: InitJob = { ...JOB, phase: "building", screens: [], rows: [{ id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "running" }, { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "waiting" }], progress: { done: 0, total: 2 } };
    act(() => useStore.getState().applyEvent({ type: "init.job", job }));
    expect(row.textContent).toBe("building · 0/2");
    expect(row.querySelector("[data-badge], .animate-status-pulse")).toBeNull();
    act(() => useStore.getState().applyEvent({ type: "init.job", job: { ...job, phase: "done" } }));
    // A sealed golden takes the row away, as a golden found at bind does.
    await waitFor(() => expect(screen.queryByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBeNull());
  });
  it("the row is the kit's keycap button: bordered, bevelled, full width, the cloud glyph and the mono words centred inside it", async () => {
    const { api } = fakeApi({ setup: HELD });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    expect(row.getAttribute("data-slot")).toBe("button");
    expect(row.className).toMatch(/\bborder\b/);
    expect(row.className).toContain("inset-shadow-");
    expect(row.className).toContain("w-full");
    expect(row.className).toContain("font-mono");
    // Regular weight, like every other mono word in the sidebar; the kit's medium is dropped.
    expect(row.className).toContain("font-normal");
    expect(row.className).not.toContain("font-medium");
    expect(row.className).toContain("transition-[color,background-color,box-shadow]");
    expect(row.className).toContain("justify-center");
    expect(row.className).toContain("focus-visible:ring-2");
    expect(row.querySelector("svg")).not.toBeNull();
    expect(row.querySelector("[data-cloud-setup-words]")?.textContent).toBe(CLOUD_SETUP_WORDS.row);
  });

  it("no hairline sits over the row: the button's own border and the spacing separate it", async () => {
    const { api } = fakeApi({ setup: HELD });
    useStore.getState().bind(api);
    const { container } = render(<CloudSetupRow />);
    await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    const foot = container.querySelector<HTMLElement>("[data-cloud-setup]");
    expect(foot).not.toBeNull();
    expect(foot!.className).not.toMatch(/border-t/);
    expect(container.querySelector("hr, [data-slot=separator]")).toBeNull();
  });

  it("prominence is the keycap and the width, not colour: no accent fill, no glow on the button, one button in the foot", async () => {
    const { api } = fakeApi({ setup: HELD });
    useStore.getState().bind(api);
    const { container } = render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    expect(row.className).not.toMatch(/bg-primary|border-primary/);
    expect(row.className).not.toContain("drop-shadow");
    expect(row.querySelector("svg")?.getAttribute("class")).toContain("drop-shadow");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("while the job runs the same button carries the stage word in place of the label, and a sealed golden takes it away", async () => {
    const { api } = fakeApi({ setup: HELD });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    const job: InitJob = { ...JOB, phase: "building", screens: [], rows: [{ id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "running" }], progress: { done: 0, total: 1 } };
    act(() => useStore.getState().applyEvent({ type: "init.job", job }));
    expect(screen.getByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBe(row);
    expect(row.getAttribute("data-slot")).toBe("button");
    expect(row.querySelector("[data-cloud-setup-words]")?.textContent).toBe(initProgressLine(job));
    act(() => useStore.getState().applyEvent({ type: "init.job", job: { ...job, phase: "done" } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBeNull());
  });
  it("while the job runs the button is alive: the spinner in the glyph's place, the stage word and count, a line along the bottom at the stages done over the total; a sign-in waiting on the person pauses the spinner and says so", async () => {
    const { api } = fakeApi({ setup: HELD });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    expect(row.querySelector(".animate-spin")).toBeNull();
    expect(row.querySelector("[data-cloud-setup-progress]")).toBeNull();
    const stages: InitJob["rows"] = [
      { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "done" },
      { id: "stage/deploying-daemon", kind: "stage", label: GOLDEN_STAGE_WORDS["deploying-daemon"], state: "running" },
      { id: "stage/applying-setup", kind: "stage", label: GOLDEN_STAGE_WORDS["applying-setup"], state: "waiting" },
      { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "waiting" },
    ];
    const job: InitJob = { ...JOB, phase: "building", screens: [], rows: stages, progress: { done: 1, total: 4 } };
    act(() => useStore.getState().applyEvent({ type: "init.job", job }));
    expect(row.querySelector(".lucide-cloud")).toBeNull();
    const spinner = row.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
    expect(spinner!.getAttribute("class")).not.toContain("paused");
    expect(row.querySelector("[data-cloud-setup-words]")?.textContent).toBe("building · 1/4");
    const line = row.querySelector<HTMLElement>("[data-cloud-setup-progress]");
    expect(line).not.toBeNull();
    expect(line!.getAttribute("role")).toBe("progressbar");
    expect(line!.getAttribute("aria-valuenow")).toBe("25");
    expect(line!.style.width).toBe("25%");
    expect(line!.className).toContain("duration-300");
    act(() => useStore.getState().applyEvent({ type: "init.job", job: { ...job, rows: stages.map((r, i) => (i < 2 ? { ...r, state: "done" } : r)), progress: { done: 2, total: 4 } } }));
    expect(line!.style.width).toBe("50%");
    expect(row.querySelector("[data-cloud-setup-words]")?.textContent).toBe("building · 2/4");
    const waiting: InitJob = { ...job, phase: "signing-in", progress: { done: 2, total: 4 }, rows: [...stages, { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", code: "8F4A-C21B" }], needsYou: { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 } };
    act(() => useStore.getState().applyEvent({ type: "init.job", job: waiting }));
    expect(row.querySelector("[data-cloud-setup-words]")?.textContent).toBe(initButtonLine(waiting));
    expect(row.querySelector("[data-cloud-setup-words]")?.textContent).toBe("waiting for you");
    expect(row.querySelector(".animate-spin")!.getAttribute("class")).toContain("paused");
    expect(line!.style.width).toBe("50%");
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
  });

  it("the press that opens the setup is where the browser is asked for leave to notify, since a request off an event is one it quietens", async () => {
    resetAskedToNotify();
    const asks: string[] = [];
    class FakeNotification {
      static permission = "default";
      static requestPermission = () => {
        asks.push("asked");
        return Promise.resolve("granted");
      };
    }
    vi.stubGlobal("Notification", FakeNotification);
    const { api } = fakeApi({ setup: HELD });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    expect(asks, "nothing on mount: a prompt out of nowhere is one nobody grants").toEqual([]);
    fireEvent.click(row);
    expect(asks).toEqual(["asked"]);
    expect(useStore.getState().setupOpen).toBe(true);
    vi.unstubAllGlobals();
  });

  it("a build that needs the person turns the whole keycap to the warning tone, and it goes back to muted zinc when the need does", async () => {
    const { api } = fakeApi({ setup: HELD });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    const signIn: InitJob["rows"][number] = { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device" };
    const job: InitJob = { ...JOB, phase: "signing-in", screens: [], rows: [{ id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "done" }, signIn], progress: { done: 1, total: 2 } };
    act(() => useStore.getState().applyEvent({ type: "init.job", job }));
    // Waiting on the machine: the row is the sidebar's own muted zinc, and no warning token is anywhere on it.
    expect(row.className).toContain("text-sidebar-muted-foreground");
    expect(row.className).not.toMatch(/warning/);
    expect(row.hasAttribute("data-waiting-on-you")).toBe(false);
    expect(row.querySelector<HTMLElement>("[data-cloud-setup-progress]")!.className).toContain("bg-sidebar-muted-foreground");
    const needed: InitJob = { ...job, needsYou: { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 } };
    act(() => useStore.getState().applyEvent({ type: "init.job", job: needed }));
    expect(row.hasAttribute("data-waiting-on-you")).toBe(true);
    expect(row.className).toContain("text-warning-foreground");
    expect(row.className).toContain("border-warning/50");
    expect(row.className).not.toContain("text-sidebar-muted-foreground");
    // The tone is the tokens' warning and nothing literal, and the fill stays quiet: it is a wait, not a confirm.
    expect(row.className).not.toMatch(/amber|orange|#|rgb\(/);
    expect(row.querySelector<HTMLElement>("[data-cloud-setup-progress]")!.className).toContain("bg-warning");
    act(() => useStore.getState().applyEvent({ type: "init.job", job }));
    expect(row.hasAttribute("data-waiting-on-you")).toBe(false);
    expect(row.className).toContain("text-sidebar-muted-foreground");
    expect(row.className).not.toMatch(/warning/);
  });
});
