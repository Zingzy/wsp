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
import { CLOUD_SETUP_WORDS, GOLDEN_STAGE_WORDS, INIT_ROW_STATES, INIT_SIGN_IN_WORDS, MCP_ADDED_WORD, SIGN_IN_OPEN_STATE, initDiskLine, initDiskOverLine, initTallyLine, initButtonLine, initProgressLine, type EventUnion, type InitJob, type InitScreen, type InitSetup } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { CloudSetupDialog } from "../src/sidebar/CloudSetupDialog.js";
import { CloudSetupRow } from "../src/sidebar/CloudSetupRow.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const AGENTS: InitScreen = {
  id: "agents",
  title: "Agents",
  top: "Which agents go on the image",
  counter: "1/6",
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
  counter: "2/6",
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
const ALSO: InitScreen = { id: "also", title: "Also on this Mac", top: "What else this Mac could bring", counter: "3/6", items: [], ticks: [], answers: {}, footer: [], empty: "nothing found here yet" };
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
  counter: "4/6",
  items: [
    { id: "logins/claude", label: "Claude Code login", group: "Agents", mark: "claude", why: "Keychain", detail: ["Keychain: Claude Code-credentials", "claude auth login"], choices: CHOICES, key: { name: "ANTHROPIC_API_KEY", saved: false } },
    { id: "logins/gh", label: "GitHub CLI login", group: "Developer CLIs", mark: "gh", why: "hosts.yml", detail: ["~/.config/gh/hosts.yml", "gh auth login"], choices: CHOICES.filter(c => c.value !== "key") },
    { id: "logins/kube", label: "kubeconfig", group: "Developer CLIs", mark: "kube", why: "config", state: CLOUD_SETUP_WORDS.screen.notOnImage, detail: ["~/.kube/config"], choices: CHOICES.filter(c => c.value === "skip") },
  ],
  ticks: [],
  answers: { "logins/claude": "machine", "logins/gh": "copy", "logins/kube": "skip" },
  footer: [],
};
const WSP: InitScreen = { id: "wsp", title: "wsp for your agents on this Mac", top: "Add wsp's MCP server and skill to the agents installed here, so they can drive your workspaces", counter: "5/6", items: [{ id: "wsp-tools/claude", label: "Claude Code", detail: ["writes ~/.claude.json"] }, { id: "wsp-tools/codex", label: "Codex", detail: ["writes ~/.codex/config.toml"] }], ticks: ["wsp-tools/claude"], answers: {}, footer: [], empty: "no agent here takes the wsp tools yet" };

const DISK = { fixed: 2 * GIB, total: 20 * GIB };
const JOB: InitJob = { id: "init_1", road: "manual", phase: "answering", keys: { solari: true }, step: 0, stoppable: true, disk: DISK, screens: [AGENTS, TOOLS, ALSO, LOGINS, WSP], rows: [], progress: { done: 0, total: 0 }, log: [] };
const SETUP: InitSetup = { keys: { solari: false }, home: "/Users/me", agents: [{ id: "claude", name: "Claude Code", configured: true }, { id: "codex", name: "Codex", configured: false }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null };
const HELD: InitSetup = { ...SETUP, keys: { solari: true } };

function fakeApi(over: { setup?: InitSetup; refuse?: string } = {}) {
  const listeners = new Set<(e: EventUnion) => void>();
  let setup = over.setup ?? SETUP;
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
    capabilities: vi.fn(async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, templates: false, kept: false, sizes: [] })),
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
      const next: InitJob = { ...current, step: Math.min(index + 1, current.screens.length), screens: current.screens.map(s => (s.id === o.screen ? { ...s, ticks: o.ticks ?? s.ticks, answers: { ...s.answers, ...o.answers } } : s)) };
      emit(next);
      return next;
    }),
    initStep: vi.fn(async (o: { at: number }) => {
      const next = { ...(job ?? JOB), step: o.at };
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
  return { api, emit, held: () => job };
}

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, hasGolden: false, initJob: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
  // Base UI's checkbox and radio re-dispatch a click as a PointerEvent, which jsdom does not have.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(over: { setup?: InitSetup; refuse?: string } = {}) {
  const { api, emit, held } = fakeApi(over);
  useStore.setState({ initJob: over.setup?.job ?? null });
  useStore.getState().bind(api);
  const onClose = vi.fn();
  render(<CloudSetupDialog onClose={onClose} />);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(api.initGet).toHaveBeenCalled());
  return { api, emit, held, dialog, onClose };
}
const k = (root: HTMLElement, key: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`[data-k="${key}"]`);
  if (el === null) throw new Error(`no [data-k=${key}] in the dialog`);
  return el;
};
/** Walks a fresh job to the screen named, as the person would, answering each screen with what it opened on. */
async function walkTo(t: Awaited<ReturnType<typeof open>>, screenId: string): Promise<void> {
  fireEvent.click(k(t.dialog, "primary"));
  await waitFor(() => expect(t.api.initStart).toHaveBeenCalled());
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
    for (const key of ["label", "title", "sentence", "content", "footer"]) expect(k(dialog, key)).toBeDefined();
  });

  it("with no provider key held, Continue asks for the Solari key alone, saves it once, starts the job and never shows the key back", async () => {
    const { api, dialog } = await open();
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(k(dialog, "keys")).toBeDefined());
    expect(dialog.querySelectorAll("input")).toHaveLength(1);
    expect(dialog.querySelector("input")!.getAttribute("type")).toBe("password");
    expect(dialog.textContent).not.toContain("Anthropic");
    expect(k(dialog, "solari-state").textContent).toBe(CLOUD_SETUP_WORDS.keys.unset);
    // The link names the company with the external-link glyph and opens the console in the default browser.
    const where = k(dialog, "where") as HTMLAnchorElement;
    expect(where.textContent).toBe(CLOUD_SETUP_WORDS.keys.where);
    expect(where.getAttribute("href")).toBe("https://console.getsolari.com");
    expect(where.getAttribute("target")).toBe("_blank");
    expect(where.querySelector("svg")).not.toBeNull();
    expect(dialog.textContent).toContain("$0.11/hr");
    expect((k(dialog, "primary") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.querySelector("input")!, { target: { value: "slr_live_typed_key" } });
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initKeys).toHaveBeenCalledWith({ solari: "slr_live_typed_key" }));
    await waitFor(() => expect(api.initStart).toHaveBeenCalledWith({ road: "manual" }));
    expect(dialog.textContent).not.toContain("slr_live_typed_key");
  });

  it("with a key held, Continue starts the job on the road picked; the agent road names its harness; a refused start leaves the choice up with the refusal", async () => {
    const { api, dialog } = await open({ setup: HELD });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "road-agent"));
    await waitFor(() => expect(k(dialog, "road-agent").getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initStart).toHaveBeenCalledWith({ road: "agent", harness: "claude" }));
    expect(api.initKeys).not.toHaveBeenCalled();
    const refused = await open({ setup: HELD, refuse: "start" });
    await waitFor(() => expect(k(refused.dialog, "choice")).toBeDefined());
    fireEvent.click(k(refused.dialog, "primary"));
    await waitFor(() => expect(k(refused.dialog, "refusal").textContent).toMatch(/already running/));
    expect(k(refused.dialog, "choice")).toBeDefined();
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

  it("draws each screen from the host's data, the wsp screen left out and the counter out of 5, and ticks, tally and ring read one selection: a third row ticked moves both at once", async () => {
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
    expect(k(dialog, "tally").textContent).toBe(initTallyLine(1, "agents", 208 * MIB));
    const ring = k(dialog, "disk");
    expect(ring.getAttribute("data-used")).toBe(String(DISK.fixed + 208 * MIB + 72 * MIB));
    expect(ring.getAttribute("data-total")).toBe(String(DISK.total));
    expect(ring.getAttribute("aria-label")).toContain(initDiskLine(DISK.fixed + 280 * MIB, DISK.total));
    // The third row ticked: the checkbox, the tally and the ring move together, before anything is sent.
    fireEvent.click(within(rows[2]!).getByRole("checkbox"));
    await waitFor(() => expect(within(rows[2]!).getByRole("checkbox").getAttribute("aria-checked")).toBe("true"));
    expect(k(dialog, "tally").textContent).toBe(initTallyLine(2, "agents", 692 * MIB));
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
    expect(k(dialog, "tally").textContent).toBe(initTallyLine(2, "tools", 72 * MIB));
    expect(dialog.querySelectorAll('[data-k="screen-tools"] [data-k=footer-lines]')).toHaveLength(0);
    // Ticking the 3 GB row moves the tally and the ring on this step too.
    fireEvent.click(within(dialog.querySelector<HTMLElement>('[data-row="swift"]')!).getByRole("checkbox"));
    await waitFor(() => expect(k(dialog, "tally").textContent).toBe(initTallyLine(3, "tools", 72 * MIB + 3 * GIB)));
    expect(k(dialog, "disk").getAttribute("data-used")).toBe(String(DISK.fixed + 1147 * MIB + 72 * MIB + 3 * GIB));
    expect(k(dialog, "disk").getAttribute("data-tone")).toBe("muted");
  });

  it("over the disk the ring is full in the danger tone and Continue refuses with the over line; under 70 percent it is muted", async () => {
    const heavy: InitScreen = { ...TOOLS, items: [...TOOLS.items, { id: "big", label: "big", size: 18 * GIB, group: "from your usage", detail: [] }] };
    const t = await open({ setup: HELD });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(t.api.initStart).toHaveBeenCalled());
    t.emit({ ...JOB, step: 1, screens: [AGENTS, heavy, ALSO, LOGINS, WSP] });
    await waitFor(() => expect(k(t.dialog, "screen-tools")).toBeDefined());
    expect(k(t.dialog, "disk").getAttribute("data-tone")).toBe("muted");
    fireEvent.click(within(t.dialog.querySelector<HTMLElement>('[data-row="big"]')!).getByRole("checkbox"));
    await waitFor(() => expect(k(t.dialog, "disk").getAttribute("data-tone")).toBe("danger"));
    const used = DISK.fixed + 208 * MIB + 72 * MIB + 18 * GIB;
    expect(k(t.dialog, "disk").getAttribute("aria-label")).toContain(initDiskOverLine(used - DISK.total));
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
    expect(claude.querySelector("[data-k=key-field]")!.textContent).toContain("ANTHROPIC_API_KEY");
    expect(claude.querySelector("[data-k=key-state]")!.textContent).toBe(CLOUD_SETUP_WORDS.keys.unset);
    fireEvent.change(claude.querySelector("input")!, { target: { value: "sk-ant-x-typed" } });
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initKeys).toHaveBeenCalledWith({ rows: { "logins/claude": "sk-ant-x-typed" } }));
    await waitFor(() => expect(api.initAnswer).toHaveBeenCalledWith({ screen: "logins", ticks: [], answers: { "logins/claude": "key", "logins/gh": "copy", "logins/kube": "skip" } }));
    expect(dialog.textContent).not.toContain("sk-ant-x-typed");
    // The screen after the sign-ins is the build's question, counted as the fifth: the wsp screen is not shown.
    await waitFor(() => expect(k(dialog, "ask")).toBeDefined());
    expect(k(dialog, "counter").textContent).toBe("5/5");
    expect(dialog.querySelector('[data-k="screen-wsp"]')).toBeNull();
  });

  it("the build's question: the title, the sentence from the recipe's numbers, both fields in the input grammar, the first launch's MCP answer handed to the job with the build", async () => {
    const t = await open({ setup: HELD });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(t.api.initStart).toHaveBeenCalled());
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

  it("a refusal on a screen shows under its footer in the host's words, and the screen stays", async () => {
    const t = await open({ setup: HELD, refuse: "agents" });
    await waitFor(() => expect(k(t.dialog, "choice")).toBeDefined());
    await walkTo(t, "agents");
    fireEvent.click(k(t.dialog, "primary"));
    await waitFor(() => expect(k(t.dialog, "refusal").textContent).toBe("the agents screen was refused by the host"));
    expect(k(t.dialog, "screen-agents")).toBeDefined();
    expect(t.dialog.querySelectorAll("[data-k=refusal]")).toHaveLength(1);
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

  it("the build is rows in the job's order: the running stage open with its lines and the spinner, a done stage folded and openable, the sign-ins where they happen with the page's keycap, one footer link that asks once; Esc hides it with the note saying the build goes on", async () => {
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
        { id: "sign-in/codex", kind: "sign-in", tool: "codex", label: "Sign in to Codex", state: INIT_SIGN_IN_WORDS.copied },
        { id: "stage/snapshotting", kind: "stage", label: GOLDEN_STAGE_WORDS.snapshotting, state: INIT_ROW_STATES.running, lines: ["snapshot wsp-h1-default-v1 requested", "waiting on the provider"] },
        { id: "stage/sealed", kind: "stage", label: GOLDEN_STAGE_WORDS.sealed, state: "waiting" },
        { id: "workspace/first", kind: "workspace", label: "first", state: "waiting" },
      ],
      progress: { done: 5, total: 9 },
      log: ["Recipe saved"],
    };
    const { emit, dialog, onClose, api } = await open({ setup: { ...HELD, job: building } });
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    expect(within(dialog).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("56");
    expect(dialog.querySelector("[data-k=progress-line]")).toBeNull();
    const rows = [...dialog.querySelectorAll<HTMLElement>('[data-k="build"] [data-k=row]')];
    expect(rows.map(r => r.dataset["row"])).toEqual(building.rows.map(r => r.id));
    // The running stage is open on its own with the machine's lines; the done one is folded and opens on a click.
    const snap = dialog.querySelector<HTMLElement>('[data-row="stage/snapshotting"]')!;
    expect(snap.dataset["open"]).toBe("true");
    expect(snap.querySelector("[data-k=lines]")!.textContent).toContain("waiting on the provider");
    expect(snap.querySelector("[data-k=state][role=status]")).not.toBeNull();
    const creating = dialog.querySelector<HTMLElement>('[data-row="stage/creating"]')!;
    expect(creating.dataset["open"]).toBe("false");
    fireEvent.click(within(creating).getByRole("button"));
    expect(creating.dataset["open"]).toBe("true");
    expect(creating.querySelector("[data-k=lines]")!.textContent).toBe("sandbox from base");
    expect(dialog.querySelector('[data-row="stage/sealed"] [role=button]')).toBeNull();
    // The sign-in rows sit where they happen, with the mark, the code and the keycap that opens the page.
    const gh = dialog.querySelector<HTMLElement>('[data-row="sign-in/gh"]')!;
    expect(gh.querySelector("[data-row-mark=gh]")).not.toBeNull();
    expect(gh.querySelector("[data-k=state]")!.textContent).toBe("waiting for you");
    expect(gh.querySelector<HTMLAnchorElement>("[data-k=open]")!.getAttribute("href")).toBe("https://github.com/login/device");
    expect(gh.querySelector("[data-k=open]")!.getAttribute("target")).toBe("_blank");
    expect(gh.querySelector("[data-k=open]")!.textContent).toContain(CLOUD_SETUP_WORDS.build.open);
    expect(gh.querySelector("[data-k=code]")!.textContent).toBe("8F4A-C21B");
    expect(dialog.querySelector('[data-row="sign-in/claude"] [data-k=state]')!.textContent).toBe("key set");
    expect(dialog.querySelector('[data-row="sign-in/codex"] [data-k=state]')!.textContent).toBe("copied from this Mac");
    // No chip, no badge: state is a word or the spinner.
    expect(dialog.querySelector("[data-badge], .animate-status-pulse")).toBeNull();
    // One footer action: the cancel link asks once; the note says the build keeps running.
    expect(dialog.querySelector("[data-k=primary]")).toBeNull();
    expect(k(dialog, "note").textContent).toBe(CLOUD_SETUP_WORDS.build.keeps);
    expect(k(dialog, "secondary").textContent).toBe(CLOUD_SETUP_WORDS.build.cancel);
    fireEvent.click(k(dialog, "secondary"));
    expect(api.initCancel).not.toHaveBeenCalled();
    expect(k(dialog, "secondary").textContent).toBe(CLOUD_SETUP_WORDS.build.cancelSure);
    expect(k(dialog, "note").textContent).toBe(CLOUD_SETUP_WORDS.build.cancelWhy);
    fireEvent.click(k(dialog, "keep"));
    expect(k(dialog, "secondary").textContent).toBe(CLOUD_SETUP_WORDS.build.cancel);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.initCancel).not.toHaveBeenCalled();
    // The result lands as a state word and the page link goes.
    emit({ ...building, rows: building.rows.map(r => (r.id === "sign-in/gh" ? { id: r.id, kind: r.kind, tool: r.tool, label: r.label, state: INIT_SIGN_IN_WORDS["signed-in"] } : r)), progress: { done: 6, total: 9 } });
    await waitFor(() => expect(dialog.querySelector('[data-row="sign-in/gh"] [data-k=state]')!.textContent).toBe("done"));
    expect(dialog.querySelector('[data-row="sign-in/gh"] [data-k=open]')).toBeNull();
    // Done: the headline turns and the one keycap opens the workspace.
    emit({ ...building, phase: "done", golden: { version: 1 }, workspace: { id: "ws_first", name: "first" }, rows: building.rows.map(r => ({ ...r, state: r.kind === "workspace" ? "forked" : r.kind === "sign-in" ? INIT_SIGN_IN_WORDS["signed-in"] : "done" })), progress: { done: 9, total: 9 } });
    await waitFor(() => expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.build.done));
    expect(k(dialog, "primary").textContent).toBe(`${CLOUD_SETUP_WORDS.build.keycap}→`);
    expect(dialog.querySelector("[data-k=secondary]")).toBeNull();
    fireEvent.click(k(dialog, "primary"));
    expect(useStore.getState().selectedId).toBe("ws_first");
    expect(useStore.getState().hasGolden).toBe(true);
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
    fireEvent.click(gh.querySelector<HTMLElement>("[data-k=retry]")!);
    await waitFor(() => expect(api.initRetry).toHaveBeenCalledWith({ tool: "gh" }));
    const cancel = k(dialog, "secondary") as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(cancel.getAttribute("title")).toMatch(/cannot be stopped/);
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
    const waiting: InitJob = { ...job, phase: "signing-in", progress: { done: 2, total: 4 }, rows: [...stages, { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", code: "8F4A-C21B" }] };
    act(() => useStore.getState().applyEvent({ type: "init.job", job: waiting }));
    expect(row.querySelector("[data-cloud-setup-words]")?.textContent).toBe(initButtonLine(waiting));
    expect(row.querySelector("[data-cloud-setup-words]")?.textContent).toBe("waiting for you");
    expect(row.querySelector(".animate-spin")!.getAttribute("class")).toContain("paused");
    expect(line!.style.width).toBe("50%");
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
  });
});
