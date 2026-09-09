// SPDX-License-Identifier: AGPL-3.0-only
// The cloud setup modal over a fake api: it opens on the two roads, takes the
// provider key when the host holds none and never shows it back, draws each
// screen from the host's data and sends the ticks and answers back, asks the
// build's own question, and draws the build as rows from the job's events,
// each sign-in with its mark, its page and its code. Hide shuts it with the
// job running on; the sidebar row reads the same line while it is shut.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SETUP_WORDS, LOGIN_STATE_WORDS, MCP_ADDED_WORD, SIGN_IN_OPEN_STATE, initButtonLine, initCostLine, initProgressLine, type EventUnion, type InitJob, type InitScreen, type InitSetup } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { CloudSetupDialog } from "../src/sidebar/CloudSetupDialog.js";
import { CloudSetupRow } from "../src/sidebar/CloudSetupRow.js";

const AGENTS: InitScreen = {
  id: "agents",
  title: "Agents",
  top: "Which coding agents go on your machine image.",
  counter: "1/6",
  items: [
    { id: "claude", label: "Claude Code", hint: "208.0 MB", why: "on this Mac", detail: ["on this Mac"] },
    { id: "codex", label: "Codex", hint: "455.0 MB", why: "not on this Mac", detail: ["not on this Mac; try it on the machine"] },
  ],
  ticks: ["claude"],
  answers: {},
  footer: [{ text: "On: 1 agent, 208.0 MB" }],
};
const TOOLS: InitScreen = {
  id: "tools",
  title: "Tools",
  top: "What installs on the image, from what you use.",
  counter: "2/6",
  items: [
    { id: "node", label: "node", hint: "60.0 MB", group: "Always on the image", detail: [], lock: "on" },
    { id: "gh", label: "gh", hint: "12.0 MB", group: "You use these", detail: [] },
  ],
  ticks: ["node", "gh"],
  answers: {},
  footer: [{ text: "On: 2 tools, 72.0 MB" }, { text: "Disk: 1.2 GB of 8 GB", tone: "yellow" }],
};
const ALSO: InitScreen = { id: "also", title: "Also on this Mac", top: "What this Mac has installed that a package manager could put on the image too.", counter: "3/6", items: [], ticks: [], answers: {}, footer: [], empty: "nothing found here yet" };
const LOGINS: InitScreen = {
  id: "logins",
  title: "Sign-ins",
  top: "Each row is something the machine needs to be signed in to. Choose how.",
  counter: "4/6",
  items: [{ id: "logins/gh", label: "GitHub CLI login", group: "Developer CLIs", why: "~/.config/gh/hosts.yml", detail: ["gh auth login"], choices: [{ value: "copy", label: "copy from this Mac" }, { value: "machine", label: "sign in on the machine" }, { value: "skip", label: "skip" }] }],
  ticks: [],
  answers: { "logins/gh": "copy" },
  footer: [],
};
const WSP: InitScreen = { id: "wsp", title: "wsp for your agents on this Mac", top: "Add wsp's MCP server and skill to the agents installed here, so they can drive your workspaces.", counter: "5/6", items: [{ id: "wsp-tools/claude", label: "Claude Code", detail: ["writes ~/.claude.json"] }], ticks: ["wsp-tools/claude"], answers: {}, footer: [], empty: "no agent here takes the wsp tools yet" };

const JOB: InitJob = { id: "init_1", road: "manual", phase: "answering", keys: { solari: true, anthropic: false }, screens: [AGENTS, TOOLS, ALSO, LOGINS, WSP], rows: [], progress: { done: 0, total: 0 }, log: [] };
const SETUP: InitSetup = { keys: { solari: false, anthropic: false }, agents: [{ id: "claude", name: "Claude Code", configured: true }], pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 }, job: null };

function fakeApi(over: { setup?: InitSetup; refuse?: string } = {}) {
  const listeners = new Set<(e: EventUnion) => void>();
  let setup = over.setup ?? SETUP;
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
    initGet: vi.fn(async () => setup),
    initKeys: vi.fn(async (keys: { solari?: string; anthropic?: string }) => {
      setup = { ...setup, keys: { solari: setup.keys.solari || keys.solari !== undefined, anthropic: setup.keys.anthropic || keys.anthropic !== undefined } };
      return setup;
    }),
    initStart: vi.fn(async () => {
      if (over.refuse === "start") throw new Error("an init job is already running; cancel it or let it finish first");
      return { ...JOB, phase: "reading" as const, screens: [] };
    }),
    initAnswer: vi.fn(async (o: { screen: string }) => {
      if (over.refuse !== undefined && o.screen === over.refuse) throw new Error(`the ${o.screen} screen was refused by the host`);
      return JOB;
    }),
    initBuild: vi.fn(async () => ({ ...JOB, phase: "building" as const })),
    initCancel: vi.fn(async () => ({ ...JOB, phase: "cancelled" as const })),
  } satisfies Api;
  const emit = (job: InitJob): void => act(() => listeners.forEach(fn => fn({ type: "init.job", job })));
  return { api, emit };
}

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, hasGolden: false, initJob: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
  // Base UI's checkbox re-dispatches a click as a PointerEvent, which jsdom does not have.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(over: { setup?: InitSetup; refuse?: string } = {}) {
  const { api, emit } = fakeApi(over);
  useStore.getState().bind(api);
  const onClose = vi.fn();
  render(<CloudSetupDialog onClose={onClose} />);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(api.initGet).toHaveBeenCalled());
  return { api, emit, dialog, onClose };
}
const k = (root: HTMLElement, key: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`[data-k="${key}"]`);
  if (el === null) throw new Error(`no [data-k=${key}] in the dialog`);
  return el;
};

describe("the cloud setup modal", () => {
  it("opens on the two roads under a caps label, the agent road naming the agents here, and never on a command to run", async () => {
    const { dialog } = await open();
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.choice.label);
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.choice.manual);
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.choice.agent);
    expect(within(dialog).getByRole("radio", { name: CLOUD_SETUP_WORDS.choice.manual }).getAttribute("aria-checked")).toBe("true");
    expect(k(dialog, "harness").textContent).toContain("Claude Code");
    expect(dialog.textContent).not.toMatch(/wsp init|terminal|\$ /);
    // One keycap, one arrow.
    expect(within(dialog).getAllByRole("button").filter(b => b.dataset["k"] === "primary")).toHaveLength(1);
    expect(k(dialog, "primary").textContent).toBe(`${CLOUD_SETUP_WORDS.choice.keycap}→`);
  });

  it("with no key held, Continue is the key screen with its guide and the price; Save sends the key once, shows it held and starts the job, and the key never shows in the dialog", async () => {
    const { api, dialog } = await open();
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(k(dialog, "keys")).toBeDefined());
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.keys.label);
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.keys.where);
    expect(dialog.textContent).toContain(initCostLine({ cpu: 2, memMb: 4096 }, 0.11));
    expect(k(dialog, "solari-state").textContent).toBe(CLOUD_SETUP_WORDS.keys.unset);
    expect((k(dialog, "primary") as HTMLButtonElement).disabled).toBe(true);
    const field = within(dialog).getByLabelText(CLOUD_SETUP_WORDS.keys.solari) as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "slr_live_typed_key" } });
    expect(k(dialog, "primary").textContent).toBe(`${CLOUD_SETUP_WORDS.keys.keycap}→`);
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initKeys).toHaveBeenCalledWith({ solari: "slr_live_typed_key" }));
    await waitFor(() => expect(api.initStart).toHaveBeenCalledWith({ road: "manual" }));
    await waitFor(() => expect(k(dialog, "reading")).toBeDefined());
    expect(dialog.textContent).not.toContain("slr_live_typed_key");
  });

  it("with a key held, Continue starts the job on the road picked; the agent road names its harness", async () => {
    const { api, dialog } = await open({ setup: { ...SETUP, keys: { solari: true, anthropic: false } } });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "road-agent"));
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initStart).toHaveBeenCalledWith({ road: "agent", harness: "claude" }));
    expect(api.initKeys).not.toHaveBeenCalled();
  });

  it("a refusal on a screen shows under its keycap in the host's words, and the screen stays", async () => {
    const { api, emit, dialog } = await open({ setup: { ...SETUP, keys: { solari: true, anthropic: false } }, refuse: "agents" });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initStart).toHaveBeenCalled());
    emit(JOB);
    await waitFor(() => expect(k(dialog, "screen-agents")).toBeDefined());
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(k(dialog, "refusal").textContent).toBe("the agents screen was refused by the host"));
    expect(k(dialog, "screen-agents")).toBeDefined();
    expect(dialog.querySelectorAll("[data-k=refusal]")).toHaveLength(1);
  });

  it("a refused start leaves the choice on the page with the refusal under its keycap, so the person can pick again", async () => {
    const { api, dialog } = await open({ setup: { ...SETUP, keys: { solari: true, anthropic: false } }, refuse: "start" });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initStart).toHaveBeenCalled());
    await waitFor(() => expect(k(dialog, "refusal").textContent).toMatch(/already running/));
    expect(k(dialog, "choice")).toBeDefined();
    expect(dialog.querySelector("[data-k=reading]")).toBeNull();
  });

  it("the harness picker is the kit's own select, not the browser's", async () => {
    const { dialog } = await open({ setup: { ...SETUP, keys: { solari: true, anthropic: false } } });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    expect(dialog.querySelector("select")).toBeNull();
    const picker = k(dialog, "harness");
    expect(picker.getAttribute("data-slot")).toBe("select-trigger");
    expect(picker.textContent).toContain("Claude Code");
  });

  it("draws each screen from the host's data, sends the ticks and answers back on Continue, keeps the counter, and ends on the build's question", async () => {
    const { api, emit, dialog } = await open({ setup: { ...SETUP, keys: { solari: true, anthropic: false } } });
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initStart).toHaveBeenCalled());
    emit(JOB);
    await waitFor(() => expect(k(dialog, "screen-agents")).toBeDefined());
    expect(k(dialog, "counter").textContent).toBe("1/6");
    expect(dialog.textContent).toContain(AGENTS.top);
    const rows = within(dialog).getAllByRole("listitem").filter(li => li.dataset["k"] === "row");
    expect(rows.map(r => r.dataset["row"])).toEqual(["claude", "codex"]);
    expect(rows.map(r => within(r).getByRole("checkbox").getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(rows[0]!.querySelector("[data-k=hint]")!.textContent).toBe("208.0 MB");
    expect(k(dialog, "footer").textContent).toContain("On: 1 agent, 208.0 MB");
    fireEvent.click(within(rows[1]!).getByRole("checkbox"));
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initAnswer).toHaveBeenCalledWith({ screen: "agents", ticks: ["claude", "codex"], answers: {} }));
    await waitFor(() => expect(k(dialog, "screen-tools")).toBeDefined());
    // The floor row is a bullet, not a tick; the disk line carries its tone.
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(dialog.textContent).toContain("Always on the image");
    expect(k(dialog, "footer").querySelector(".text-warning-foreground")!.textContent).toBe("Disk: 1.2 GB of 8 GB");
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(k(dialog, "screen-also")).toBeDefined());
    expect(k(dialog, "empty").textContent).toBe("nothing found here yet");
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(k(dialog, "screen-logins")).toBeDefined());
    const answer = k(dialog, "answer");
    expect(answer.textContent).toBe("copy from this Mac");
    fireEvent.click(answer);
    expect(answer.textContent).toBe("sign in on the machine");
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initAnswer).toHaveBeenCalledWith({ screen: "logins", ticks: [], answers: { "logins/gh": "machine" } }));
    await waitFor(() => expect(k(dialog, "screen-wsp")).toBeDefined());
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(k(dialog, "ask")).toBeDefined());
    expect(k(dialog, "counter").textContent).toBe("6/6");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("first");
    fireEvent.click(k(dialog, "primary"));
    await waitFor(() => expect(api.initBuild).toHaveBeenCalledWith({ firstWorkspace: "first" }));
    // A new job opens on its first screen; Back from there ends the job and returns to the choice.
    emit({ ...JOB, id: "init_2" });
    await waitFor(() => expect(k(dialog, "screen-agents")).toBeDefined());
    fireEvent.click(k(dialog, "secondary"));
    await waitFor(() => expect(api.initCancel).toHaveBeenCalled());
    await waitFor(() => expect(k(dialog, "choice")).toBeDefined());
  });

  it("the build is rows under folding caps labels: a sign-in row carries its mark, its page as a link and its code while it waits, then its state word; Hide shuts the modal and the row shows the same line", async () => {
    const building: InitJob = {
      ...JOB,
      phase: "signing-in",
      screens: [],
      rows: [
        { id: "agent/claude", kind: "agent", label: "Claude Code", state: MCP_ADDED_WORD },
        { id: "stage/creating", kind: "stage", label: "Machine created", state: "done", ms: 12_000 },
        { id: "stage/ready", kind: "stage", label: "Ready", state: "done" },
        { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", code: "8F4A-C21B" },
        { id: "sign-in/claude", kind: "sign-in", tool: "claude", label: "Claude Code login", state: LOGIN_STATE_WORDS["signed-in"] },
        { id: "workspace/first", kind: "workspace", label: "first", state: "waiting" },
      ],
      progress: { done: 4, total: 6 },
      log: ["Recipe saved"],
    };
    useStore.setState({ initJob: building });
    const { emit, dialog, onClose } = await open({ setup: { ...SETUP, keys: { solari: true, anthropic: false }, job: building } });
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    expect(k(dialog, "progress-line").textContent).toBe(initProgressLine(building));
    expect(within(dialog).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("67");
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.build.image);
    expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.build.signIns);
    // The agents given the tools are this computer's rows, under their own label, not the workspace's.
    expect(k(dialog, "computer").textContent).toContain(CLOUD_SETUP_WORDS.build.computer);
    expect(k(dialog, "computer").querySelector('[data-row="agent/claude"]')).not.toBeNull();
    expect(k(dialog, "workspace").querySelector('[data-row="agent/claude"]')).toBeNull();
    const gh = dialog.querySelector<HTMLElement>('[data-row="sign-in/gh"]')!;
    expect(gh.querySelector("[data-sign-in-mark=gh]")).not.toBeNull();
    expect(gh.querySelector<HTMLAnchorElement>("[data-k=open]")!.getAttribute("href")).toBe("https://github.com/login/device");
    expect(gh.querySelector("[data-k=open]")!.getAttribute("target")).toBe("_blank");
    expect(gh.querySelector("[data-k=code]")!.textContent).toBe("8F4A-C21B");
    const claude = dialog.querySelector<HTMLElement>('[data-row="sign-in/claude"]')!;
    expect(claude.querySelector("[data-k=state]")!.textContent).toBe("signed in");
    expect(claude.querySelector("[data-sign-in-mark=claude]")).not.toBeNull();
    // The image's stages fold under their label while a sign-in waits; a click opens them; the fold follows the job as
    // it moves, so a modal left open through the sign-ins folds the image when the first page arrives.
    const image = k(dialog, "image");
    expect(image.dataset["open"]).toBe("false");
    fireEvent.click(within(image).getByRole("button"));
    expect(image.dataset["open"]).toBe("true");
    emit({ ...building, rows: building.rows.map(r => (r.id === "sign-in/gh" ? { ...r, state: LOGIN_STATE_WORDS["signed-in"] } : r)) });
    await waitFor(() => expect(k(dialog, "image").dataset["open"]).toBe("true"));
    emit(building);
    await waitFor(() => expect(k(dialog, "image").dataset["open"]).toBe("false"));
    fireEvent.click(within(k(dialog, "image")).getByRole("button"));
    expect(image.querySelector('[data-row="stage/creating"] [data-k=state]')!.textContent).toBe("done");
    // No chip, no badge, no spinner: state is a word.
    expect(dialog.querySelector("[data-badge], .animate-spin, .animate-status-pulse")).toBeNull();
    // The result lands as a state word and the page link goes.
    emit({ ...building, rows: building.rows.map(r => (r.id === "sign-in/gh" ? { id: r.id, kind: r.kind, tool: r.tool, label: r.label, state: LOGIN_STATE_WORDS["signed-in"] } : r)), progress: { done: 5, total: 6 } });
    await waitFor(() => expect(dialog.querySelector('[data-row="sign-in/gh"] [data-k=state]')!.textContent).toBe("signed in"));
    expect(dialog.querySelector('[data-row="sign-in/gh"] [data-k=open]')).toBeNull();
    fireEvent.click(k(dialog, "secondary"));
    expect(onClose).toHaveBeenCalled();
    // Done: the headline turns and the one keycap opens the workspace.
    emit({ ...building, phase: "done", golden: { version: 1 }, workspace: { id: "ws_first", name: "first" }, rows: building.rows.map(r => ({ ...r, state: r.kind === "workspace" ? "forked" : r.kind === "sign-in" ? LOGIN_STATE_WORDS["signed-in"] : r.state })), progress: { done: 6, total: 6 } });
    await waitFor(() => expect(dialog.textContent).toContain(CLOUD_SETUP_WORDS.build.done));
    expect(k(dialog, "primary").textContent).toBe(`${CLOUD_SETUP_WORDS.build.keycap}→`);
    fireEvent.click(k(dialog, "primary"));
    expect(useStore.getState().selectedId).toBe("ws_first");
    expect(useStore.getState().hasGolden).toBe(true);
  });

  it("opened from the row, the modal outlives the seal: the done screen stays, Open workspace selects the fork, and only then does the row go", async () => {
    const building: InitJob = { ...JOB, phase: "sealing", screens: [], rows: [{ id: "stage/sealed", kind: "stage", label: "Sealing", state: "running" }], progress: { done: 0, total: 1 } };
    const { api, emit } = fakeApi({ setup: { ...SETUP, keys: { solari: true, anthropic: false }, job: building } });
    useStore.setState({ initJob: building });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(k(dialog, "build")).toBeDefined());
    emit({ ...building, phase: "done", golden: { version: 1 }, workspace: { id: "ws_first", name: "first" }, rows: [{ id: "stage/sealed", kind: "stage", label: "Sealed", state: "done" }], progress: { done: 1, total: 1 } });
    await waitFor(() => expect(useStore.getState().hasGolden).toBe(true));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain(CLOUD_SETUP_WORDS.build.done));
    fireEvent.click(k(screen.getByRole("dialog"), "primary"));
    expect(useStore.getState().selectedId).toBe("ws_first");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBeNull();
  });

  it("the sidebar row reads the job's line while it runs and the modal is shut, and the plain words otherwise", async () => {
    const { api } = fakeApi({ setup: { ...SETUP, keys: { solari: true, anthropic: false } } });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    expect(row.textContent).toBe(CLOUD_SETUP_WORDS.row);
    const job: InitJob = { ...JOB, phase: "building", screens: [], rows: [{ id: "stage/creating", kind: "stage", label: "Creating the machine", state: "running" }, { id: "stage/ready", kind: "stage", label: "Waiting for the machine", state: "waiting" }], progress: { done: 0, total: 2 } };
    act(() => useStore.getState().applyEvent({ type: "init.job", job }));
    expect(row.textContent).toBe("building · 0/2");
    expect(row.querySelector("[data-badge], .animate-status-pulse")).toBeNull();
    act(() => useStore.getState().applyEvent({ type: "init.job", job: { ...job, phase: "done" } }));
    // A sealed golden takes the row away, as a golden found at bind does.
    await waitFor(() => expect(screen.queryByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBeNull());
  });
  it("the row is the kit's keycap button: bordered, bevelled, full width, the cloud glyph and the mono words centred inside it", async () => {
    const { api } = fakeApi({ setup: { ...SETUP, keys: { solari: true, anthropic: false } } });
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
    const { api } = fakeApi({ setup: { ...SETUP, keys: { solari: true, anthropic: false } } });
    useStore.getState().bind(api);
    const { container } = render(<CloudSetupRow />);
    await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    const foot = container.querySelector<HTMLElement>("[data-cloud-setup]");
    expect(foot).not.toBeNull();
    expect(foot!.className).not.toMatch(/border-t/);
    expect(container.querySelector("hr, [data-slot=separator]")).toBeNull();
  });

  it("prominence is the keycap and the width, not colour: no accent fill, no glow on the button, one button in the foot", async () => {
    const { api } = fakeApi({ setup: { ...SETUP, keys: { solari: true, anthropic: false } } });
    useStore.getState().bind(api);
    const { container } = render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    expect(row.className).not.toMatch(/bg-primary|border-primary/);
    expect(row.className).not.toContain("drop-shadow");
    expect(row.querySelector("svg")?.getAttribute("class")).toContain("drop-shadow");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("while the job runs the same button carries the stage word in place of the label, and a sealed golden takes it away", async () => {
    const { api } = fakeApi({ setup: { ...SETUP, keys: { solari: true, anthropic: false } } });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    const job: InitJob = { ...JOB, phase: "building", screens: [], rows: [{ id: "stage/creating", kind: "stage", label: "Creating the machine", state: "running" }], progress: { done: 0, total: 1 } };
    act(() => useStore.getState().applyEvent({ type: "init.job", job }));
    expect(screen.getByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBe(row);
    expect(row.getAttribute("data-slot")).toBe("button");
    expect(row.querySelector("[data-cloud-setup-words]")?.textContent).toBe(initProgressLine(job));
    act(() => useStore.getState().applyEvent({ type: "init.job", job: { ...job, phase: "done" } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: CLOUD_SETUP_WORDS.row })).toBeNull());
  });
  it("while the job runs the button is alive: the spinner in the glyph's place, the stage word and count, a line along the bottom at the stages done over the total; a sign-in waiting on the person pauses the spinner and says so", async () => {
    const { api } = fakeApi({ setup: { ...SETUP, keys: { solari: true, anthropic: false } } });
    useStore.getState().bind(api);
    render(<CloudSetupRow />);
    const row = await screen.findByRole("button", { name: CLOUD_SETUP_WORDS.row });
    expect(row.querySelector(".animate-spin")).toBeNull();
    expect(row.querySelector("[data-cloud-setup-progress]")).toBeNull();
    const stages: InitJob["rows"] = [
      { id: "stage/creating", kind: "stage", label: "Machine created", state: "done" },
      { id: "stage/deploying-daemon", kind: "stage", label: "Installing the base", state: "running" },
      { id: "stage/applying-setup", kind: "stage", label: "Applying your setup", state: "waiting" },
      { id: "stage/ready", kind: "stage", label: "Waiting for the machine", state: "waiting" },
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
