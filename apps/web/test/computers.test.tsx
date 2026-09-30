// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Computers: the list off the host's own rows, which it draws and
// which it leaves out, each row's facts and state word; a computer's own page
// with its lines, its connection, the agents on it and what the recipe put
// beside them, the workspaces standing on it and the two acts; the cloud's
// page with the image behind its row; and the one-field sheet that adds
// another computer.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InitJob, COPY_CURRENT, DEFAULT_PREFERENCES, PLACES_TICKET_REFUSAL, PLACES_WORDS, PLACE_CONNECTS, PLACE_LOGIN_REFUSED_KIND, PlaceAddStep, absentRoad, fmtBytes, fmtSize, imageCopyStaysLine, placeAddSheetWord, placeDaemonBehind, placeNoDialLine, provisionWord, type AgentsReport, type AgentsTarget, type EventUnion, type InitSetup, type PlaceAddJob, type PlaceProvision, type PlaceView, type SealedImage, type SessionView, type WorkspaceStatus, type WorkspaceView, PLACE_INSTALL, PROVIDER_KEY_WORDS } from "@wsp/protocol";
import { render } from "@testing-library/react";
import { makeApi, ProtocolClient, RequestError, type Api, type SshLogin } from "../src/protocol/client.js";
import { useContextMenuStore } from "../src/actions/contextMenu.js";
import { useStore } from "../src/protocol/store.js";
import { AddComputer } from "../src/settings/AddComputer.js";
import { useAdds } from "../src/settings/adds.js";
import { AGENTS_LIST_WORDS } from "../src/components/agents/agentsRows.js";
import { ADD_COMPUTER_WORDS, WHERE_WORDS, capitalised } from "../src/settings/format.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { IMAGE_WORDS } from "../src/settings/image.js";
import { absentOf } from "../src/settings/places.js";
import { openImageRecipe } from "../src/settings/openAt.js";
import { useSettingsStore, type SettingsAt } from "../src/settings/settingsStore.js";
import { SidebarCorner } from "../src/sidebar/SidebarCorner.js";
import { shortcutLabelForCommand } from "../src/keybindings.js";
import { currentKeybindings } from "../src/shell/useKeybindings.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ScriptedSocket, type Frame } from "./scripted-socket.js";
import { descriptionOf, lineLabels, lineOf, mountSettings, pageAt, resetSettings, rowOf, settingsApi, settle, wordOf } from "./settings-harness.js";
import { pickOption } from "./select.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

/** What the host says about its own setup: which keys it holds, which is the rule a cloud row stands under, and
 * the agents on this computer, which are this computer's own rows. */
const setupOf = (over: Partial<InitSetup> = {}): InitSetup => ({ keys: { box: false, solari: false }, home: "/Users/dev", agents: [], pricing: null, job: null, ...over }) as InitSetup;

/** A Linux box the ssh installer hands back: it runs Docker, so it can hold copies of the image. */
const box: PlaceView = {
  id: "p_2",
  kind: "computer",
  name: "hetzner",
  default: false,
  present: true,
  takesForks: true,
  engine: "docker",
  os: "Ubuntu 24.04",
  shape: { cpu: 2, memMb: 4096 },
  diskFreeBytes: 38 * 1024 ** 3,
  joinedAt: "2026-09-12T11:00:00.000Z",
  lastSeenAt: "2026-09-12T11:59:00.000Z",
};

const MAC = "zingzy's MacBook Pro";
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: MAC, default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 210 * 1024 ** 3 };
const laptop: PlaceView = {
  id: "p_1",
  kind: "computer",
  name: "old-macbook",
  default: false,
  present: false,
  takesForks: true,
  engine: "none",
  os: "Ubuntu 24.04",
  agents: ["claude", "codex"],
  shape: { cpu: 4, memMb: 8192 },
  diskFreeBytes: 91 * 1024 ** 3,
  lastSeenAt: "2026-09-12T10:00:00.000Z",
};
const ascii: PlaceView = { id: "box", kind: "provider", name: "box", default: false, shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.018, takesForks: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true };
const AT = "2026-09-12T11:00:00.000Z";

/** The workspaces the app holds, as the sidebar lists them: this computer's own, and the forks, whether they stand
 * at a provider or on a computer somebody joined. */
const workspace = (id: string, kind: WorkspaceView["kind"], machineId: string): WorkspaceView => ({ id, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, name: id, kind, machineId, phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z" });
const mine = workspace("ws_a", "local", "local");
const onLaptop: WorkspaceView = { ...workspace("ws_b", "cloud", "ctr_9f"), place: "p_1" };
const fork = (id: string): WorkspaceView => workspace(id, "cloud", `fk_${id}`);
/** A fork stamped with the cloud it was made at, which is what stands its row on that cloud's row. */
const atSolari = (id: string): WorkspaceView => ({ ...fork(id), provider: "solari" });
/** One thread on a workspace, in the shape the sidebar's tree reads. */
const session = (id: string, workspaceId: string): SessionView => ({ id, workspaceId, harness: "claude", status: "completed", prompt: id, startedBy: "person", startedAt: Date.parse(AT) });

/** The api the Computers pages read: the setup, and whatever else a case names. */
const computersApi = (over: Partial<Api> = {}, setup: InitSetup = setupOf()) => settingsApi({ initGet: async () => setup, ...over });

/** The list page, drawn: one row per computer by id. */
const listIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-grid-row][data-place-row]")].map(row => row.dataset["placeRow"] ?? "");
const listRow = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-settings-page] [data-grid-row][data-place-row='${id}']`)!;
const nameOf = (id: string): string | undefined => listRow(id).querySelector("[data-grid-name]")?.textContent ?? undefined;
const stateOf = (id: string): string | undefined => listRow(id).querySelector("[data-state-cell]")?.textContent ?? undefined;
/** One cell of a row by the column it stands in. */
const cellOf = (id: string, k: string): string | undefined => listRow(id).querySelector(`[data-k='${k}']`)?.textContent ?? undefined;
const openPage = (id: string): void => {
  fireEvent.click(listRow(id));
};

/** A report with nothing on it. */
const EMPTY_REPORT: AgentsReport = { ...AGENTS_REPORT, agents: [], skills: [], servers: [], projects: [] };

let live: ProtocolClient | undefined;

beforeEach(() => {
  resetSettings();
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false } });
});

afterEach(() => {
  live?.close();
  live = undefined;
  cleanup();
});

const mountComputers = async (api: Api, at: SettingsAt = { kind: "group", group: "computers" }): Promise<void> => {
  mountSettings({ api, at });
  await settle();
};

describe("the Computers list", () => {
  it("lists this computer first with its default tag, cores, memory, running threads and Ready, and a computer that is not answering by its word", async () => {
    useStore.setState({ places: [here, laptop], workspaces: [mine, onLaptop] });
    await mountComputers(computersApi().api);
    expect(listIds()).toEqual(["here", "p_1"]);
    expect(nameOf("here")).toBe(MAC);
    expect(listRow("here").textContent).not.toContain("zingzy-mbp");
    expect(listRow("here").querySelector("[data-grid-tag]")?.textContent).toBe("default");
    expect(cellOf("here", "cores")).toBe("8");
    expect(cellOf("here", "memory")).toBe("16 GB");
    expect(cellOf("here", "threads")).toBe("0");
    expect(stateOf("here")).toBe("Ready");
    // The slot holds the one word for the silence, capitalised; the whole sentence rides the hover.
    expect(stateOf("p_1")).toBe("No answer");
    expect(listRow("p_1").getAttribute("title")).toBe(absentOf(laptop, Date.now())?.sentence);
    // No chip, no middle dot, no rule: facts are cells on the template.
    expect(document.querySelector("[data-settings-page] [data-chip]")).toBeNull();
    expect(document.querySelector("[data-settings-page]")?.textContent).not.toContain("\u00b7");
    expect(listRow("here").className).toContain("h-13");
  });

  it("says this computer's own daemon is not running in the slot, rather than listing this Mac as perfectly fine", async () => {
    const silent = { id: mine.id, phase: "running", machineState: "running", reach: { state: "unreachable" }, machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, kind: "local", size: { cpu: 8, memMb: 16384 }, name: mine.name, golden: "", createdAt: mine.createdAt } as unknown as WorkspaceStatus;
    useStore.setState({ places: [here], workspaces: [mine], statuses: { [mine.id]: silent } });
    await mountComputers(computersApi().api);
    expect(stateOf("here")).toBe("No daemon");
    expect(listRow("here").textContent).not.toContain("Unreachable");
  });

  it("leaves a fact a computer has not reported blank, never a dash, and keeps the row's height", async () => {
    useStore.setState({ places: [{ id: "p_2", kind: "computer", name: "attic", default: false, present: true }] });
    await mountComputers(computersApi().api);
    expect(cellOf("p_2", "cores")).toBe("");
    expect(cellOf("p_2", "memory")).toBe("");
    expect(listRow("p_2").textContent).not.toMatch(/[-\u2014]/);
    expect(listRow("p_2").className).toContain("h-13");
  });

  it("counts the threads with a turn running on the workspaces each row holds, and a zero as 0", async () => {
    const running = (id: string, workspaceId: string): SessionView => ({ ...session(id, workspaceId), status: "running" });
    useStore.setState({ places: [here, laptop], workspaces: [mine, onLaptop], sessions: { ws_a: [running("r1", "ws_a"), session("d1", "ws_a"), running("r2", "ws_a")], ws_b: [session("d2", "ws_b")] } });
    await mountComputers(computersApi().api);
    expect(cellOf("here", "threads")).toBe("2");
    expect(cellOf("p_1", "threads")).toBe("0");
  });

  it("keeps every row's state at every width, the word or the act, on the computers and the clouds alike", async () => {
    const behind: PlaceView = { ...box, daemonVersion: 1 };
    useStore.setState({ places: [here, behind, solari], workspaces: [] });
    await mountComputers(computersApi({ placesUpdate: async () => ({ name: "hetzner" }) } as unknown as Partial<Api>).api);
    for (const id of ["here", "p_2", "solari"]) {
      const cell = listRow(id).querySelector<HTMLElement>("[data-state-cell]")!;
      expect(cell.textContent, id).not.toBe("");
      // A phone's list keeps the state: nothing on the cell or on the row's template hides it below a width.
      expect(cell.className, id).not.toMatch(/max-\w+:hidden|(^|\s)hidden(\s|$)/);
      expect(listRow(id).className, id).toMatch(/max-md:grid-cols-\[minmax\(0,1fr\)_auto_100px_14px\]/);
    }
    expect(stateOf("p_2")).toBe(WHERE_WORDS.update);
  });

  it("draws the clouds as their own list on the same template, and no machines column while the host reads none", async () => {
    const withRoom: PlaceView = { ...solari, forks: { running: 1, room: 1 } };
    useStore.setState({ places: [here, withRoom, ascii], workspaces: [] });
    await mountComputers(computersApi().api);
    const grids = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-grid]")];
    expect(grids.map(g => g.dataset["grid"])).toEqual(["computers", "clouds"]);
    expect(grids.map(g => [...g.querySelectorAll("[data-grid-head] span")].map(c => c.textContent))).toEqual([["Computer", "Cores", "Memory", "Threads"], ["Cloud"]]);
    // The two lists share one column template, so the state column is one line down the page.
    expect(new Set(grids.map(g => g.querySelector("[data-grid-row]")?.className.match(/grid-cols-\[[^\s]+\]/)?.[0])).size).toBe(1);
    expect(nameOf("solari")).toBe("Solari");
    expect(stateOf("solari")).toBe("Ready");
    // Nothing on the host writes a cloud's running count or its room yet, so none is drawn, even off a row that says one.
    expect(listRow("solari").textContent).not.toContain("1/2");
    expect(document.querySelector("[data-settings-page]")?.textContent).not.toMatch(/this month|Machines/);
  });

  it("draws a cloud row the host lists even with no key held and no workspace on it, as a stand-in serving that cloud is", async () => {
    useStore.setState({ places: [here, solari], workspaces: [] });
    await mountComputers(computersApi({}, setupOf({ keys: {} })).api);
    expect(listIds()).toEqual(["here", "solari"]);
  });

  it("draws a cloud row as soon as its key is saved, with no reload: the places, the landings and the setup are read again", async () => {
    let keys: Record<string, boolean> = { box: false, solari: false };
    let places: PlaceView[] = [here];
    const saved: unknown[] = [];
    const api = computersApi({
      initGet: async () => setupOf({ keys }),
      placesList: async () => ({ places, adds: [] }),
      initKeys: async (asked: unknown) => {
        saved.push(asked);
        keys = { ...keys, box: true };
        places = [here, ascii];
        return setupOf({ keys });
      },
    } as Partial<Api>).api;
    useStore.setState({ places });
    await mountComputers(api);
    expect(listIds()).toEqual(["here"]);
    // A landing asked before the save was answered without the new computer, so it goes with the places read.
    useStore.setState({ landings: { pr_1: null } });
    await act(async () => {
      await useStore.getState().saveKeys({ provider: "box", key: "ascii_live_fake" });
    });
    await settle();
    expect(saved).toEqual([{ provider: "box", key: "ascii_live_fake" }]);
    expect(listIds()).toEqual(["here", "box"]);
    expect(useStore.getState().landings).toEqual({});
    expect(useSettingsStore.getState().reads.setup?.keys["box"]).toBe(true);
  });

  it("reads the state cell in one order: blocked, not answering, the recipe on it, the daemon behind, a sign-in, then Ready", async () => {
    const running: PlaceProvision = { state: "running", addId: "a_1", recipeAt: AT, startedAt: AT, rows: [], at: { label: "uv", index: 3, of: 7 } };
    const failed: PlaceProvision = {
      state: "done",
      addId: "a_1",
      recipeAt: AT,
      startedAt: AT,
      finishedAt: AT,
      rows: [
        { id: "tools/gh", label: "GitHub CLI", outcome: "failed", note: "no release for this chip" },
        { id: "tools/uv", label: "uv", outcome: "failed", note: "the script exited 1" },
        ...Array.from({ length: 5 }, (_, at) => ({ id: `tools/t${at}`, label: `t${at}`, outcome: "installed" as const })),
      ],
    };
    const stuck = { ...box, id: "p_stuck", name: "stuck", blocked: "its login cannot run docker", provision: running };
    const busy = { ...box, id: "p_busy", name: "busy", provision: running };
    const broke = { ...box, id: "p_broke", name: "broke", provision: failed };
    const gone = { ...laptop, id: "p_gone", name: "gone", provision: running };
    const behind = { ...box, id: "p_old", name: "old", daemonVersion: 1 };
    const unsigned = { ...box, id: "p_sign", name: "sign", signIns: { claude: "signed-in", codex: "none" } } as PlaceView;
    useStore.setState({ places: [here, stuck, busy, broke, gone, behind, unsigned, box] });
    await mountComputers(computersApi().api);
    expect(stateOf("p_stuck")).toBe("Blocked");
    expect(listRow("p_stuck").getAttribute("title")).toBe("its login cannot run docker");
    expect(stateOf("p_busy")).toBe("Building 3/7");
    expect(listRow("p_busy").getAttribute("title")).toBe(provisionWord(running));
    expect(stateOf("p_broke")).toBe("Failed");
    expect(listRow("p_broke").getAttribute("title")).toBe("2 of 7 failed: GitHub CLI, uv");
    expect(stateOf("p_gone")).toBe("No answer");
    // Behind with no road to update reads the word; the button stands only where a press can go.
    expect(stateOf("p_old")).toBe("Behind");
    expect(listRow("p_old").getAttribute("title")).toBe(placeDaemonBehind(behind));
    expect(listRow("p_sign").querySelector("[data-k='sign-in']")?.textContent).toBe("Sign in");
    expect(listRow("p_sign").getAttribute("title")).toBe("needs a sign-in: Codex");
    expect(stateOf("p_2")).toBe("Ready");
    // Sign in goes to the computer's page, whose agent rows carry each one's own.
    fireEvent.click(listRow("p_sign").querySelector("[data-k='sign-in']")!);
    expect(pageAt()).toBe("computer:p_sign");
  });

  it("offers Update in the cell of a computer behind this wsp's daemon, puts it there on a press, and reads the job in the cell after", async () => {
    const asked: string[] = [];
    const provision: PlaceProvision = { state: "running", addId: "a_2", recipeAt: AT, startedAt: AT, rows: [], at: { label: "uv", index: 3, of: 7 } };
    const behind: PlaceView = { ...box, daemonVersion: 1 };
    const api = computersApi({ placesUpdate: async (placeId: string) => (asked.push(placeId), { name: "hetzner", provision }) } as unknown as Partial<Api>).api;
    useStore.setState({ places: [here, behind] });
    await mountComputers(api);
    const update = listRow("p_2").querySelector<HTMLElement>("[data-k='update']")!;
    expect(update.textContent).toBe(WHERE_WORDS.update);
    fireEvent.click(update);
    await waitFor(() => expect(asked).toEqual(["p_2"]));
    // The press is the button's own: the row does not open the page under it.
    expect(pageAt()).toBe("computers");
    await waitFor(() => expect(useStore.getState().places.find(place => place.id === "p_2")?.provision).toEqual(provision));
  });

  it("draws Add a computer under the computers and Add a cloud under the clouds, each opening the panel on its road, and a row opens its page", async () => {
    useStore.setState({ places: [here, box, solari] });
    await mountComputers(computersApi().api);
    expect([...document.querySelectorAll("[data-settings-card='computers'] [data-place-row]")].map(r => r.getAttribute("data-place-row"))).toEqual(["here", "p_2"]);
    expect([...document.querySelectorAll("[data-settings-card='computers'] [data-add-button]")].map(b => b.textContent)).toEqual([ADD_COMPUTER_WORDS.title]);
    expect([...document.querySelectorAll("[data-settings-card='clouds'] [data-add-button]")].map(b => b.textContent)).toEqual([ADD_COMPUTER_WORDS.addCloud]);
    expect(document.querySelector("[data-k='add-computer']")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ADD_COMPUTER_WORDS.addCloud }));
    expect(document.querySelector("[data-add-road='cloud']")?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: ADD_COMPUTER_WORDS.title }));
    expect(document.querySelector("[data-k='add-computer'] [data-add-road='ssh']")).toBeTruthy();
    openPage("p_2");
    expect(pageAt()).toBe("computer:p_2");
  });

  it("draws Add a computer alone where the host registered no cloud, and no CLOUD list over nothing", async () => {
    useStore.setState({ places: [here, box] });
    await mountComputers(computersApi({}, setupOf({ keys: {} })).api);
    expect([...document.querySelectorAll("[data-settings-card='computers'] [data-add-button]")].map(b => b.textContent)).toEqual([ADD_COMPUTER_WORDS.title]);
    expect(document.querySelector("[data-settings-card='clouds']")).toBeNull();
    expect(document.querySelectorAll("[data-settings-page] [data-add-button]")).toHaveLength(1);
  });

  it("finds a computer by its name in the settings search", async () => {
    useStore.setState({ places: [here, box] });
    await mountComputers(computersApi().api);
    act(() => useSettingsStore.getState().setSearch("hetz"));
    await settle();
    expect([...document.querySelectorAll("[data-settings-page] [data-place-row]")].map(r => r.getAttribute("data-place-row"))).toEqual(["p_2"]);
  });

  it("asks the host once for the month and follows the meter, and says no money on the list", async () => {
    let asks = 0;
    const fake = computersApi({
      spend: async () => {
        asks += 1;
        return Promise.reject(new Error(PLACES_TICKET_REFUSAL));
      },
    } as Partial<Api>);
    useStore.setState({ places: [here, ascii], workspaces: [fork("ws_x")] });
    await mountComputers(fake.api);
    await waitFor(() => expect(asks).toBe(1));
    act(() => fake.push({ type: "workspace.cost", workspaceId: "ws_x", phase: "running", rateUsdPerHour: 0.16, awakeMs: 60_000, accruedUsd: 0.41, at: AT, seq: 1 } as EventUnion));
    await settle();
    expect(asks).toBe(1);
    expect(listRow("box").textContent).not.toContain("$");
  });
});

describe("a computer's own page", () => {
  const withWorkspaces = (): void => {
    useStore.setState({
      places: [here, laptop],
      workspaces: [{ id: "ws_b", name: "spoo-fix", kind: "cloud", machineId: "ctr_9f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, place: "p_1", phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z", home: "/home/dev" }] as never,
      sessions: { ws_b: [session("s1", "ws_b"), session("s2", "ws_b")] },
    });
  };
  const gridHeads = (): string[] => [...document.querySelectorAll("[data-settings-page] [data-grid] [data-grid-head] span:first-child")].map(s => s.textContent ?? "");
  const kindRows = (grid: string): string[] => [...document.querySelectorAll(`[data-settings-page] [data-grid='${grid}'] [data-grid-row] [data-grid-name]`)].map(n => n.textContent ?? "");
  const noteOf = (grid: string, name: string): string | undefined =>
    [...document.querySelectorAll(`[data-settings-page] [data-grid='${grid}'] [data-grid-row]`)].find(r => r.querySelector("[data-grid-name]")?.textContent === name)?.querySelector("[data-grid-note]")?.textContent ?? undefined;

  it("heads the page with its crumbs, its name and its state, and none of the old cards", async () => {
    useStore.setState({ places: [here, { ...box, os: "Ubuntu 24.04", joinedAt: AT, copies: "reflink" }] });
    await mountComputers(computersApi({ agentsRead: async () => AGENTS_REPORT }).api, { kind: "computer", id: "p_2" });
    expect(document.querySelector("[data-k='page-crumbs']")?.textContent).toBe("Computers/hetzner");
    expect(document.querySelector("[data-settings-page] h1")?.textContent).toBe("hetzner");
    expect(document.querySelector("[data-k='place-state']")?.textContent).toBe("Ready");
    for (const k of ["system", "size", "disk-free", "joined", "address", "answered", "copies", "ports", "computer-icon", "workspace-line"]) expect(document.querySelector(`[data-settings-page] [data-k='${k}']`)).toBeNull();
    expect(document.querySelector("[data-settings-page] [data-settings-card]")).toBeNull();
    fireEvent.click(document.querySelector("[data-k='page-crumbs-group']")!);
    expect(pageAt()).toBe("computers");
  });

  it("lists the agents with their version and sign-in, and the MCP servers with their state, off the computer's own report", async () => {
    const asked: AgentsTarget[] = [];
    useStore.setState({ places: [here] });
    await mountComputers(computersApi({ agentsRead: async (target: AgentsTarget) => (asked.push(target), AGENTS_REPORT) }).api, { kind: "computer", id: "here" });
    expect(asked).toEqual([{ placeId: "here" }]);
    const installed = AGENTS_REPORT.agents.filter(a => a.installed);
    expect(kindRows("agents")).toEqual(installed.map(a => a.name));
    expect(gridHeads().slice(0, 2)).toEqual(["Agents", "MCP servers"]);
    const claude = installed.find(a => a.id === "claude")!;
    const row = [...document.querySelectorAll("[data-grid='agents'] [data-grid-row]")].find(r => r.querySelector("[data-grid-name]")?.textContent === claude.name)!;
    expect(row.querySelector("[data-k='lead-tile'] svg")).not.toBeNull();
    if (claude.version !== undefined) expect(row.textContent).toContain(claude.version);
    // The sign-in is the quiet note, in sentence case, never a dot.
    expect(noteOf("agents", claude.name)).toMatch(/^[A-Z]/);
    expect(document.querySelector("[data-settings-page] [data-grid='agents'] .rounded-full")).toBeNull();
    expect(kindRows("servers").length).toBeGreaterThan(0);
    // No manager shell, tabs or search on the page.
    expect(document.querySelector("[data-settings-page] [role='radiogroup']")).toBeNull();
    for (const k of ["remove", "update", "dial"]) expect(document.querySelector(`[data-settings-page] [data-k='${k}']`)).toBeNull();
  });

  it("offers Sign in on an agent that needs one there, and draws its flow under the row once it starts", async () => {
    const report: AgentsReport = { ...EMPTY_REPORT, agents: [{ id: "claude", name: "Claude Code", installed: true, version: "2.1.283", road: "wsp", signIn: "none", signInRoad: "device", wspTools: false }] };
    const started: string[] = [];
    const agentsSignIn = async (_target: AgentsTarget, agent: string, _server: unknown, step: (e: { state: string; url?: string }) => void) => {
      started.push(agent);
      step({ state: "waiting", url: "https://example.test/login" });
      return { stop: () => {} };
    };
    useStore.setState({ places: [here, box] });
    await mountComputers(computersApi({ agentsRead: async () => report, agentsSignIn } as unknown as Partial<Api>).api, { kind: "computer", id: "p_2" });
    expect(noteOf("agents", "Claude Code")).toBe("Needs sign-in");
    const signIn = document.querySelector<HTMLElement>("[data-grid='agents'] [data-k='act-sign-in']")!;
    expect(signIn.textContent).toBe("Sign in");
    fireEvent.click(signIn);
    await settle();
    expect(started).toEqual(["claude"]);
    expect(document.querySelector("[data-grid='agents'] [data-k='sign-in-flow']")).not.toBeNull();
    // While the flow waits on the person its own controls are the step, and the note says so.
    expect(document.querySelector("[data-grid='agents'] [data-k='act-sign-in']")).toBeNull();
    expect(noteOf("agents", "Claude Code")).toBe(capitalised(AGENTS_LIST_WORDS.waitingOnYou));
  });

  it("puts the recipe's rows that did not land and the report's refusals under the lists as quiet lines", async () => {
    const provision: PlaceProvision = {
      state: "done",
      addId: "a_1",
      recipeAt: AT,
      startedAt: AT,
      finishedAt: AT,
      rows: [
        { id: "agents/claude", label: "Claude Code", outcome: "installed" },
        { id: "agents/codex", label: "Codex", outcome: "failed", note: "npm exited 1" },
        { id: "tools/gh", label: "GitHub CLI", outcome: "failed" },
        { id: "agents/mcp/linear", label: "linear", outcome: "skipped", kind: "server", note: "waited on GitHub CLI" },
      ],
    };
    useStore.setState({ places: [here, { ...laptop, present: true, name: "spoo", provision }] });
    await mountComputers(computersApi({ agentsRead: async () => ({ ...EMPTY_REPORT, refused: ["skills: the folder is not readable"] }) }).api, { kind: "computer", id: "p_1" });
    expect([...document.querySelectorAll("[data-k='agents-misses'] [data-refused-line]")].map(l => [l.querySelector("[data-refused-label]")?.textContent, l.querySelector("[data-refused-value]")?.textContent])).toEqual([
      ["Skills", "the folder is not readable"],
      ["Codex", "failed: npm exited 1"],
      ["linear", "set aside: waited on GitHub CLI"],
    ]);
  });

  it("says a computer that is not answering in the state line with the dial beside it, whose answer takes the sentence's place", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said } };
    const line = "root@65.21.4.12 answered over ssh in 412 ms, so the computer is on; the agent on it is not dialling this host.";
    useStore.setState({ places: [here, vps] });
    await mountComputers(computersApi(dialling(line)).api, { kind: "computer", id: "p_3" });
    const state = document.querySelector("[data-k='place-state']")!;
    expect(state.querySelector("[data-state-cell]")?.textContent).toBe("No answer");
    // The last refusal the record kept is the sentence until a press asks again.
    expect(document.querySelector("[data-k='place-sentence']")?.textContent).toBe(said);
    expect(state.querySelector("[data-k='dial']")?.textContent).toBe("Try over ssh");
    fireEvent.click(state.querySelector("[data-k='dial']")!);
    await waitFor(() => expect(document.querySelector("[data-k='place-sentence']")?.textContent).toBe(line));
    expect(document.querySelector("[data-k='place-sentence']")?.getAttribute("title")).toBe(line);
  });

  it("draws a refused dial under the state line with the host's fix", async () => {
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" } };
    useStore.setState({ places: [here, vps] });
    const refused = { dialPlace: async () => Promise.reject(new RequestError("wsp holds no login for vps. Add it again over ssh.", undefined, "Add it again over ssh.")) } as unknown as Partial<Api>;
    await mountComputers(computersApi(refused).api, { kind: "computer", id: "p_3" });
    fireEvent.click(document.querySelector("[data-k='dial']")!);
    const slot = await waitFor(() => {
      const found = document.querySelector("[data-settings-page] [data-k='dial-refusal']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(slot.textContent).toBe("wsp holds no login for vps. Add it again over ssh.");
    expect(slot.querySelector("span.text-foreground")?.textContent?.trim()).toBe("Add it again over ssh.");
  });

  it("offers no dial where there is no road to dial over or the client cannot dial, and none on a computer that is answering", async () => {
    const byCode: PlaceView = { ...laptop, road: { from: "192.168.1.34" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said: placeNoDialLine("old-macbook") } };
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" } };
    useStore.setState({ places: [here, byCode, vps, box] });
    await mountComputers(computersApi(dialling()).api, { kind: "computer", id: "p_1" });
    expect(document.querySelector("[data-k='place-sentence']")?.textContent).toBe(placeNoDialLine("old-macbook"));
    expect(document.querySelector("[data-k='dial']")).toBeNull();
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "p_2" }));
    await settle();
    expect(document.querySelector("[data-k='dial']")).toBeNull();
    cleanup();
    await mountComputers(computersApi().api, { kind: "computer", id: "p_3" });
    expect(document.querySelector("[data-k='place-sentence']")?.textContent).toBe(WHERE_WORDS.cannotDial);
    expect(document.querySelector("[data-k='dial']")).toBeNull();
  });

  it("puts Update in the state line of a computer behind this wsp's daemon, with the reading as its sentence", async () => {
    const behind: PlaceView = { ...box, daemonVersion: 1 };
    useStore.setState({ places: [here, behind] });
    await mountComputers(computersApi({ placesUpdate: async () => ({ name: "hetzner" }) } as unknown as Partial<Api>).api, { kind: "computer", id: "p_2" });
    expect(document.querySelector("[data-k='place-state'] [data-k='update']")?.textContent).toBe(WHERE_WORDS.update);
    expect(document.querySelector("[data-k='place-sentence']")?.textContent).toBe(placeDaemonBehind(behind));
  });

  it("lists the threads on the workspaces it holds, each opening its thread, with the project and the one status slot", async () => {
    const running = { ...session("s1", "ws_b"), status: "running" as const, threadId: "t_1" };
    useStore.setState({
      places: [here, laptop],
      workspaces: [{ ...onLaptop, project: { id: "pr_1", name: "spoo-landing", path: "/root", computer: "p_1" } }],
      sessions: { ws_b: [running] },
    });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    const rows = [...document.querySelectorAll("[data-grid='threads-here'] [data-thread-row]")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector("[data-thread-place]")?.textContent).toBe("spoo-landing");
    expect(rows[0]?.querySelector("[data-thread-status]")?.getAttribute("data-thread-status")).toBe("working");
    expect(document.querySelector("[data-grid='threads-here'] [data-grid-head]")?.textContent).toBe("Threads running here");
  });

  it("lists the threads running or asking on a computer as the THREADS list does: the agent's mark, the title, the project, and the one status slot, a working one's time in the working ink with the crab", async () => {
    const running: SessionView = { ...session("s_run", "ws_b"), prompt: "move the relay", status: "running", startedAt: Date.now() - 22 * 60_000 };
    const asking: SessionView = { ...session("s_ask", "ws_b"), prompt: "fix the checkout", status: "running", startedAt: Date.now() - 30 * 60_000, asking: "Permission for Bash: ls" };
    const failed: SessionView = { ...session("s_fail", "ws_b"), prompt: "release notes", status: "failed", startedAt: Date.now() - 90 * 60_000, endedAt: Date.now() - 80 * 60_000 };
    const resting: SessionView = { ...session("s_rest", "ws_b"), prompt: "old refactor" };
    useStore.setState({ places: [here, laptop], workspaces: [{ ...onLaptop, name: "spoo-fix" }], sessions: { ws_b: [running, asking, failed, resting] } });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    const card = document.querySelector<HTMLElement>("[data-settings-page] [data-grid='threads-here']")!;
    expect(card.querySelector("[data-grid-head]")?.textContent).toBe(WHERE_WORDS.heads.threadsHere);
    const rows = [...card.querySelectorAll<HTMLElement>("[data-thread-row]")];
    // Running here is what the head says: a failed or a resting thread is no longer running anywhere.
    expect(rows.map(row => row.textContent?.replace(/(Needs you|\d+m).*$/, ""))).toEqual(["move the relay", "fix the checkout"].map(t => expect.stringMatching(new RegExp(`^${t}`))));
    expect(card.textContent).not.toMatch(/release notes|old refactor/);
    for (const row of rows) {
      // The mark keeps its own ink, as the tiles draw it, never the row's muted one over it.
      expect(row.querySelector("[data-harness-mark=claude]")?.getAttribute("class")).not.toContain("text-muted-foreground");
      expect(row.querySelector("[data-thread-place]")?.textContent).toBe("the-project");
    }
    const slot = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>("[data-thread-status]")!;
    expect(slot(rows[0]!).dataset["tone"]).toBe("working");
    expect(slot(rows[0]!).textContent).toContain("22m");
    expect(slot(rows[0]!).querySelector("[data-crab]")).not.toBeNull();
    expect(slot(rows[1]!).textContent).toBe("Needs you");
    expect(card.textContent).not.toMatch(/Running|\d+ threads?/);
    expect(card.querySelector("[data-thread-rows-head]")).toBeNull();
  });

  it("draws no threads list for a computer where nothing is running or asking", async () => {
    const resting: SessionView = { ...session("s_rest", "ws_b"), prompt: "old refactor" };
    useStore.setState({ places: [here, laptop], workspaces: [{ ...onLaptop, name: "spoo-fix" }], sessions: { ws_b: [resting] } });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    expect(document.querySelector("[data-settings-page] [data-grid='threads-here']")).toBeNull();
  });

  it("computes the Remove sentence from what that computer holds, hands an offline one the line to run by hand, and takes it out on the host's own road", async () => {
    const removed: string[] = [];
    withWorkspaces();
    await mountComputers(computersApi({ removePlace: async (id: string) => (removed.push(id), { removed: true, swept: [] }) } as unknown as Partial<Api>).api, { kind: "computer", id: "p_1" });
    expect(document.querySelector("[data-k='remove-line']")?.textContent).toContain("Remove old-macbook");
    expect(document.querySelector("[data-k='remove-note']")?.textContent).toBe(WHERE_WORDS.removeDescription("old-macbook", MAC));
    fireEvent.click(document.querySelector("[data-settings-page] [data-k='remove']")!);
    expect(screen.getByText("Remove old-macbook?")).toBeTruthy();
    expect(document.querySelector("[data-k='remove-sentence']")?.textContent).toBe("wsp and its task come off old-macbook, which is otherwise left as it is, and the copy of your image stays where it is. The task's record and 2 threads leave zingzy's MacBook Pro. It is offline; what is on it is swept the next time it connects.");
    expect(document.querySelector("[data-k='leave-line']")?.textContent).toBe(PLACES_WORDS.remove.leaveLine);
    expect(document.querySelector("[data-remove-place-dialog]")?.textContent).toContain(imageCopyStaysLine());
    fireEvent.click(document.querySelector("[data-k='remove-confirm']")!);
    await waitFor(() => expect(removed).toEqual(["p_1"]));
    await waitFor(() => expect(pageAt()).toBe("computers"));
  });

  it("draws a refused remove in the refusal slot, the host's fix in the fix ink, and a remove the host did not make in that same slot", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    // The refusal comes back a moment later, as a host's does over its socket; the slot stands empty until it lands.
    let answer: () => Promise<unknown> = async () => new Promise((_, no) => setTimeout(() => no(new RequestError("old-macbook still holds a running workspace. Stop it first, then remove again.", undefined, "Stop it first, then remove again.")), 50));
    await mountComputers(computersApi({ removePlace: async () => answer() } as unknown as Partial<Api>).api, { kind: "computer", id: "p_1" });
    fireEvent.click(document.querySelector("[data-settings-page] [data-k='remove']")!);
    fireEvent.click(document.querySelector("[data-k='remove-confirm']")!);
    await waitFor(() => expect(document.querySelector("[data-k='remove-refusal']")?.textContent).toBe("old-macbook still holds a running workspace. Stop it first, then remove again."));
    const slot = document.querySelector("[data-k='remove-refusal']")!;
    expect(slot.className).toContain("text-destructive-foreground");
    answer = async () => ({ removed: false, swept: [], note: "old-macbook was not removed: its record is locked" });
    fireEvent.click(document.querySelector("[data-k='remove-confirm']")!);
    await waitFor(() => expect(document.querySelector("[data-k='remove-refusal']")?.textContent).toBe("old-macbook was not removed: its record is locked"));
  });

  it("gives a computer that is answering no line to run by hand, and the Mac no Remove at all", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    fireEvent.click(document.querySelector("[data-settings-page] [data-k='remove']")!);
    expect(screen.getByText("Remove old-macbook?")).toBeTruthy();
    expect(document.querySelector("[data-k='leave-line']")).toBeNull();
    cleanup();
    await mountComputers(computersApi().api, { kind: "computer", id: "here" });
    expect(document.querySelector("[data-k='remove-line']")).toBeNull();
  });
});

/** A client that can dial, so a button drawn beside a row is held for the row's own reason and never the app's. */
function dialling(line = "vps answered in 12 ms."): Partial<Api> {
  return { dialPlace: async (placeId: string) => ({ dialled: { at: "2026-09-12T12:00:00.000Z", answered: true, roundTripMs: 12 }, line, place: { ...laptop, id: placeId } }) } as unknown as Partial<Api>;
}

describe("a computer's icon", () => {
  it("draws each computer's own icon on its Settings sidebar row, the size and edge of the group's glyph: this Mac the model it is, a joined computer a server, a cloud its provider's mark", async () => {
    useStore.setState({ places: [{ ...here, mac: "mac-mini" }, box, solari, ascii], workspaces: [] });
    await mountComputers(computersApi().api);
    const glyph = (id: string): Element | null => document.querySelector(`[data-slot=sidebar] [data-row-id="computer:${id}"] [data-computer-glyph]`);
    expect(glyph("here")?.getAttribute("data-computer-glyph")).toBe("mac-mini");
    expect(glyph("p_2")?.classList.contains("lucide-server")).toBe(true);
    expect(glyph("solari")?.getAttribute("data-brand-mark")).toBe("solari");
    expect(glyph("box")?.getAttribute("data-brand-mark")).toBe("boat");
    for (const id of ["here", "p_2", "solari", "box"]) expect(glyph(id)?.getAttribute("class"), id).toMatch(/(^|\s)size-4(\s|$)/);
    // The Computers list draws the same icon, so the row and the page cannot disagree about what a computer is.
    expect(listRow("here").querySelector("[data-computer-glyph]")?.getAttribute("data-computer-glyph")).toBe("mac-mini");
    expect(listRow("solari").querySelector("[data-computer-glyph]")?.getAttribute("data-brand-mark")).toBe("solari");
  });

  it("an iMac reads as a monitor and a MacBook as a laptop whatever it is named, and a pick still wins over the model", async () => {
    useStore.setState({ places: [{ ...here, label: "the studio", mac: "macbook" }], workspaces: [] });
    await mountComputers(computersApi().api);
    expect(listRow("here").querySelector("[data-computer-glyph]")?.classList.contains("lucide-laptop")).toBe(true);
    cleanup();
    useStore.setState({ places: [{ ...here, mac: "imac" }], workspaces: [] });
    await mountComputers(computersApi().api);
    expect(listRow("here").querySelector("[data-computer-glyph]")?.classList.contains("lucide-monitor")).toBe(true);
    cleanup();
    useStore.setState({ places: [{ ...here, mac: "imac" }, solari], workspaces: [], preferences: { ...DEFAULT_PREFERENCES, labs: false, computerLook: { here: { icon: "home" }, solari: { icon: "server" } } } });
    await mountComputers(computersApi().api);
    expect(listRow("here").querySelector("[data-computer-glyph]")?.classList.contains("lucide-house")).toBe(true);
    expect(listRow("solari").querySelector("[data-computer-glyph]")?.classList.contains("lucide-server")).toBe(true);
  });

  it("reads the default off what the computer is, offers every other icon in the row's context menu, and the row draws the pick", async () => {
    useStore.setState({ places: [here, box], workspaces: [] });
    const { api, sets } = computersApi();
    await mountComputers(api);
    expect(listRow("p_2").querySelector("[data-computer-glyph]")?.classList.contains("lucide-server")).toBe(true);
    fireEvent.contextMenu(listRow("p_2"));
    const menu = useContextMenuStore.getState().menu!;
    expect(menu.items.map(item => item.id)).not.toContain("icon-server");
    expect(menu.items.find(item => item.id === "icon-home")?.label).toBe("Home icon");
    act(() => menu.choose("icon-home"));
    await waitFor(() => expect(sets).toEqual([{ computerLook: { p_2: { icon: "home" } } }]));
    cleanup();
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false, computerLook: { p_2: { icon: "home" } } } });
    await mountComputers(computersApi().api);
    expect(listRow("p_2").querySelector("[data-computer-glyph]")?.classList.contains("lucide-house")).toBe(true);
    // Named a MacBook but with no model read, this computer is a desktop: its name is not what it is.
    expect(listRow("here").querySelector("[data-computer-glyph]")?.classList.contains("lucide-monitor")).toBe(true);
  });
});

describe("the cloud's page", () => {
  const HASH = "a".repeat(63) + "1";
  const IMAGE: SealedImage = {
    name: "default",
    version: 2,
    hash: HASH,
    recipeHash: "recipe-1",
    pins: [{ id: "claude", tag: "2.1.283" }],
    recipe: { version: 1, at: AT, histories: [], rows: [{ id: "claude", kind: "agent", on: true, source: { kind: "popular", sessions: 0, images: 0 } }] },
    logins: [{ name: "claude", state: "copied" }, { name: "gh", state: "signed-in" }],
    sealedAt: "2026-09-12T09:12:00.000Z",
    sealedFrom: "this Mac",
    vault: { sha256: "c".repeat(64), bytes: 4_200, paths: 7, takenAt: AT },
    usedBytes: 4.2 * 1024 ** 3,
  } as SealedImage;
  const copy = { place: "solari", version: 2, hash: HASH, snapshotId: "snap_s", builtAt: "2026-09-12T10:00:00.000Z", sizeBytes: 4.2 * 1024 ** 3 };

  it("lists the image's agents and your image as one row with the tools on one line and no recipe list, while the key is held", async () => {
    const api = computersApi(
      { image: async () => ({ image: IMAGE, copies: [copy], projects: [] }), spend: async () => [{ place: "solari", todayUsd: 0.38, monthUsd: 4.12, rateUsdPerHour: 0.16 }], initStart: async () => ({}) as InitJob } as Partial<Api>,
      setupOf({ keys: { solari: true } }),
    ).api;
    useStore.setState({ places: [here, { ...solari, buildsImages: true }], workspaces: [atSolari("ws_y")] });
    await mountComputers(api, { kind: "computer", id: "solari" });
    expect([...document.querySelectorAll("[data-grid='agents'] [data-grid-name]")].map(n => n.textContent)).toEqual(["Claude Code"]);
    expect(document.querySelector("[data-grid='agents'] [data-k='act-edit-image']")).toBeNull();
    const image = document.querySelector("[data-k='image-state']")!;
    expect(image.getAttribute("data-state")).toBe("ready");
    expect(image.querySelector("[data-grid-name]")?.textContent).toBe(WHERE_WORDS.yourImage);
    expect(image.querySelector("[data-grid-note]")?.textContent).toMatch(/^built .*; Claude Code$/);
    // The locked row carries neither a version nor a build's time beside its press.
    expect(image.textContent).not.toContain("v2");
    expect(image.querySelector("[data-k='image-cost']")).toBeNull();
    expect(document.querySelector("[data-settings-page] [data-chip]")).toBeNull();
    // The long list is the Image page's: no recipe, no Edit and no copies here.
    for (const k of ["recipe", "edit-recipe", "image-holds", "image-copy", "spend"]) expect(document.querySelector(`[data-settings-page] [data-k='${k}']`)).toBeNull();
    expect(document.querySelector("[data-k='remove-note']")?.textContent).toBe(WHERE_WORDS.removeCloudDescription);
  });

  it("opens no recipe on a page asked to edit the image, since the list is not drawn on these pages", async () => {
    const api = computersApi({ image: async () => ({ image: IMAGE, copies: [copy], projects: [] }), initStart: async () => ({}) as InitJob } as Partial<Api>, setupOf({ keys: { solari: true } })).api;
    useStore.setState({ places: [here, { ...solari, buildsImages: true }] });
    openImageRecipe("solari");
    mountSettings({ api });
    await settle();
    expect(pageAt()).toBe("computer:solari");
    expect(document.querySelector("[data-settings-page] [data-k='recipe']")).toBeNull();
    expect(document.querySelector("[data-k='image-state']")).not.toBeNull();
  });

  it("says nothing about the image on a cloud whose key this host does not hold, and keeps Remove neutral at rest", async () => {
    const api = computersApi({ image: async () => ({ image: IMAGE, copies: [copy], projects: [] }) } as Partial<Api>, setupOf({ keys: { solari: false } })).api;
    useStore.setState({ places: [here, { ...solari, buildsImages: true }], workspaces: [atSolari("ws_y")] });
    await mountComputers(api, { kind: "computer", id: "solari" });
    expect(document.querySelector("[data-k='image-state']")).toBeNull();
    expect(document.querySelector("[data-grid='agents']")).toBeNull();
    const remove = document.querySelector<HTMLElement>("[data-settings-page] [data-k='remove']")!;
    expect(remove.className).not.toMatch(/warning/);
    expect(remove.className).toContain("[:hover,[data-pressed]]:text-destructive-foreground");
    fireEvent.click(remove);
    expect(document.querySelector<HTMLElement>("[data-k='remove-confirm']")!.className).toContain("bg-destructive");
  });

  it("draws your image before a build with no press that opens the recipe", async () => {
    const api = computersApi({ image: async () => ({ image: null, copies: [], projects: [] }), initStart: async () => ({}) as InitJob } as Partial<Api>, setupOf({ keys: { solari: true } })).api;
    useStore.setState({ places: [here, { ...solari, buildsImages: true }] });
    await mountComputers(api, { kind: "computer", id: "solari" });
    expect(document.querySelector("[data-k='image-state']")?.getAttribute("data-state")).toBe("none");
    expect(document.querySelector("[data-k='image-press']")).toBeNull();
  });

  it("says a build running on another cloud nowhere on this cloud's page", async () => {
    const job = { id: "init_1", road: "manual", phase: "building", keys: {}, step: 0, stoppable: true, screens: [], rows: [], progress: { done: 1, total: 5 }, log: [], place: { id: "box", name: "box" } } as unknown as InitJob;
    const api = computersApi({ image: async () => ({ image: IMAGE, copies: [copy], projects: [] }) } as Partial<Api>, setupOf({ keys: { solari: true, box: true } })).api;
    useStore.setState({ places: [here, { ...solari, buildsImages: true }, { ...ascii, buildsImages: true }], initJob: job });
    await mountComputers(api, { kind: "computer", id: "solari" });
    expect(document.querySelector("[data-settings-page]")?.textContent).not.toContain("building on");
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "box" }));
    await settle();
    expect(document.querySelector("[data-k='image-state']")?.getAttribute("data-state")).toBe("building");
    expect(document.querySelector("[data-k='image-state'] [data-grid-note]")?.textContent).toBe("1 of 5 steps done; Claude Code");
  });
});

describe("Add a computer on the page", () => {
  const open = async (road: "ssh" | "cloud" | "code" | null, over: Partial<Api> = {}, setup: InitSetup | null = null) => {
    const fake = settingsApi(over);
    useStore.setState({ api: fake.api, places: [here] });
    render(<AddComputer setup={setup} now={() => NOW} />);
    if (road !== null) fireEvent.click(document.querySelector(`[data-add-road='${road}']`)!);
    return fake;
  };
  /** An installer that never answers on its own: the case answers or refuses it, and the steps ride the store's
   * events under the stream the sheet minted, as the host's do. */
  const pending = () => {
    const at: { login?: SshLogin; addId?: string; answer: (p: PlaceView) => void; refuse: (e: Error) => void } = { answer: () => {}, refuse: () => {} };
    const api = {
      addComputerOverSsh: (login: SshLogin, addId: string) =>
        new Promise<PlaceView>((ok, no) => {
          Object.assign(at, { login, addId, answer: ok, refuse: no });
        }),
    } as unknown as Partial<Api>;
    return { at, api };
  };
  const stage = (addId: string, step: PlaceAddStep, state: "running" | "done" | "failed", note?: string): void =>
    act(() => useStore.getState().applyEvent({ type: "place.stage", addId, step, state, ...(note === undefined ? {} : { note }) } as EventUnion));
  const refuseWith = async (at: { refuse: (e: Error) => void }, e: Error): Promise<void> => {
    await act(async () => {
      at.refuse(e);
      await Promise.resolve();
    });
  };
  const host = (): HTMLInputElement => document.querySelector<HTMLInputElement>("[data-k='road-ssh'] [data-k='login']")!;
  const user = (): HTMLInputElement => document.querySelector<HTMLInputElement>("[data-k='ssh-user']")!;
  const slot = (): string => document.querySelector("[data-k='ssh-refusal']")?.textContent ?? "";
  const plan = (): [string | null, string | null][] => [...document.querySelectorAll("[data-k='plan'] li")].map(l => [l.textContent, l.getAttribute("data-state")]);
  const job = (over: Partial<PlaceAddJob>): PlaceAddJob => ({ addId: "a_host", address: "root@spoo", startedAt: "2026-09-12T11:59:00.000Z", state: "running", steps: [], ...over });

  it("offers the three roads as pictures with none picked, and draws no flow until one is", async () => {
    await open(null, {}, setupOf());
    const roads = [...document.querySelectorAll("[data-add-road]")];
    expect(roads.map(r => r.getAttribute("data-add-road"))).toEqual(["ssh", "cloud", "code"]);
    expect(roads.every(r => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(document.querySelector("[data-k^='road-']")).toBeNull();
  });

  it("offers no cloud where the host registered none, and names none", async () => {
    await open(null, {}, setupOf({ keys: {} }));
    expect([...document.querySelectorAll("[data-add-road]")].map(r => r.getAttribute("data-add-road"))).toEqual(["ssh", "code"]);
    for (const words of Object.values(PROVIDER_KEY_WORDS)) expect(document.body.textContent).not.toContain(words.name);
  });

  it("asks for user, host and port over ssh, focuses the host, and lists what happens before Add", async () => {
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    expect(document.activeElement).toBe(host());
    expect(document.querySelectorAll("[data-k='road-ssh'] input")).toHaveLength(3);
    expect(plan()).toHaveLength(PlaceAddStep.options.length);
    expect(plan().every(([, state]) => state === "waiting")).toBe(true);
    expect(document.querySelector("[data-k='road-ssh'] header")?.textContent).toBe(document.querySelector("[data-add-road='ssh'] span.text-\\[13px\\]")?.textContent);
  });

  it("holds Add until a host is typed, and on a wsp whose host cannot log in over ssh at all", async () => {
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    const add = (): Element => document.querySelector("[data-k='ssh-add']")!;
    expect(add().hasAttribute("data-held")).toBe(true);
    fireEvent.change(host(), { target: { value: "65.21.4.12" } });
    expect(add().hasAttribute("data-held")).toBe(false);
    cleanup();
    await open("ssh");
    fireEvent.change(host(), { target: { value: "65.21.4.12" } });
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("data-held")).toBe(true);
    expect(slot()).toBe(ADD_COMPUTER_WORDS.noRoad);
  });

  it("sends user@host and a port other than 22, and fills the lines in as the host's steps arrive", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(user(), { target: { value: "root" } });
    fireEvent.change(host(), { target: { value: "65.21.4.12" } });
    fireEvent.change(document.querySelector("[data-k='ssh-port']")!, { target: { value: "2222" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(host().disabled).toBe(true));
    expect(at.login).toEqual({ address: "root@65.21.4.12", port: 2222 });
    stage(at.addId!, "connect", "done", "Ubuntu 24.04");
    stage(at.addId!, "wsp", "running", "x86_64");
    expect(plan()[0]).toEqual([`${placeAddSheetWord("connect", "done")}Ubuntu 24.04`, "done"]);
    const wsp = PlaceAddStep.options.indexOf("wsp");
    expect(plan()[wsp]).toEqual([`${wsp + 1}${placeAddSheetWord("wsp", "running")}x86_64`, "running"]);
    // A stream this sheet did not mint is not its own.
    stage("a_else", "reach", "done");
    expect(plan()[PlaceAddStep.options.indexOf("reach")]![1]).toBe("waiting");
  });

  it("shows the spinner inside the Adding button while an add runs, and not before or after", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    const spinner = (): Element | null => document.querySelector("[data-k='ssh-add'] [data-k='adding-spinner']");
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    expect(spinner()).toBeNull();
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(spinner()).not.toBeNull());
    expect(document.querySelector("[data-k='ssh-add']")?.textContent).toBe(ADD_COMPUTER_WORDS.adding);
    await refuseWith(at, new RequestError("root@65.21.4.12 did not answer on port 22"));
    expect(spinner()).toBeNull();
  });

  it("on a failed add keeps the finished steps ticked, marks the step the host failed, and leaves the rest waiting", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(host(), { target: { value: "root@spoo" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    stage(at.addId!, "connect", "done");
    stage(at.addId!, "host-key", "done");
    stage(at.addId!, "reach", "running");
    stage(at.addId!, "reach", "failed", "spoo cannot reach this computer at any of its addresses");
    await refuseWith(at, new RequestError("spoo cannot reach this computer at any of its addresses"));
    const states = plan().map(([, state]) => state);
    expect(states).toEqual(["done", "done", "failed", ...PlaceAddStep.options.slice(3).map(() => "waiting")]);
    const failed = document.querySelector("[data-k='plan'] li[data-state='failed']")!;
    expect(failed.querySelector("[data-k='step-failed']")?.className).toContain("destructive");
    expect(document.querySelectorAll("[data-k='plan'] li[data-state='done'] svg")).toHaveLength(2);
    expect(host().disabled).toBe(false);
  });

  it("marks the first step failed when the add is refused before the host kept any step", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await refuseWith(at, new RequestError("wsp add refuses a loopback address"));
    expect(plan().map(([, state]) => state)).toEqual(["failed", ...PlaceAddStep.options.slice(1).map(() => "waiting")]);
    expect(slot()).toBe("wsp add refuses a loopback address");
  });

  it("draws an add the host is running when the page opens after a reload: its address in the fields, its steps, Add held", async () => {
    useAdds.setState({ jobs: { a_host: job({ address: "maya@spoo", sshPort: 2222, steps: [{ step: "connect", state: "done", note: "Debian 12" }, { step: "wsp", state: "running" }] }) } });
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    expect(user().value).toBe("maya");
    expect(host().value).toBe("spoo");
    expect(document.querySelector<HTMLInputElement>("[data-k='ssh-port']")!.value).toBe("2222");
    expect(plan()[0]).toEqual([`${placeAddSheetWord("connect", "done")}Debian 12`, "done"]);
    expect(plan()[PlaceAddStep.options.indexOf("wsp")]![1]).toBe("running");
    expect(document.querySelector("[data-k='ssh-add'] [data-k='adding-spinner']")).not.toBeNull();
    expect(host().disabled).toBe(true);
  });

  it("draws the refusal the host kept, in its two halves, when the page opens after the add failed", async () => {
    useAdds.setState({ jobs: { a_host: job({ state: "failed", steps: [{ step: "connect", state: "done" }, { step: "wsp", state: "failed", note: "spoo has no curl" }], said: "spoo has no curl or wget on its PATH.", fix: "Install one of them there, then add again." }) } });
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    const refusal = document.querySelector("[data-k='ssh-refusal']")!;
    expect(refusal.textContent).toBe("spoo has no curl or wget on its PATH. Install one of them there, then add again.");
    expect(refusal.querySelector("span.text-foreground")?.textContent?.trim()).toBe("Install one of them there, then add again.");
    expect(plan()[PlaceAddStep.options.indexOf("wsp")]![1]).toBe("failed");
    expect(host().value).toBe("spoo");
  });

  it("draws the add asked here over one the host kept, whatever the two clocks stamped them", async () => {
    useAdds.setState({ jobs: { a_host: job({ state: "failed", startedAt: "2099-01-01T00:00:00.000Z", said: "an old refusal" }) } });
    const { at, api } = pending();
    await open("ssh", api);
    expect(slot()).toBe("an old refusal");
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(host().disabled).toBe(true));
    stage(at.addId!, "connect", "done");
    expect(slot()).toBe("");
    expect(plan()[0]![1]).toBe("done");
  });

  it("gives the login fix to a login the host refused, and to nothing else", async () => {
    useAdds.setState({ jobs: { a_host: job({ state: "failed", steps: [{ step: "connect", state: "failed" }], said: "maya@spoo: Permission denied (publickey).", kind: PLACE_LOGIN_REFUSED_KIND }) } });
    await open("ssh");
    expect(slot()).toBe(`maya@spoo: Permission denied (publickey). ${ADD_COMPUTER_WORDS.refusedFix}`);
    cleanup();
    useAdds.setState({ jobs: { a_host: job({ state: "failed", steps: [{ step: "connect", state: "failed" }], said: "root@spoo runs zsh as root's shell" }) } });
    await open("ssh");
    expect(slot()).toBe("root@spoo runs zsh as root's shell");
  });

  it("clears a refusal the moment the person changes what they typed", async () => {
    useAdds.setState({ jobs: { a_host: job({ state: "failed", steps: [{ step: "connect", state: "failed" }], said: "root@spoo did not answer on port 22" }) } });
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    expect(slot()).toBe("root@spoo did not answer on port 22");
    expect(host().getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(document.querySelector("[data-k='ssh-port']")!, { target: { value: "2222" } });
    expect(slot()).toBe("");
    expect(host().hasAttribute("aria-invalid")).toBe(false);
    expect(host().value).toBe("spoo");
  });

  it("keeps what was typed and not sent in this window when the person leaves the page, and through another window's add, and never sends it", async () => {
    const asked: SshLogin[] = [];
    await open("ssh", { addComputerOverSsh: async (login: SshLogin) => (asked.push(login), box) } as unknown as Partial<Api>);
    fireEvent.change(user(), { target: { value: "maya" } });
    fireEvent.change(host(), { target: { value: "hetzner" } });
    fireEvent.change(document.querySelector("[data-k='ssh-port']")!, { target: { value: "2200" } });
    cleanup();
    render(<AddComputer setup={null} now={() => NOW} />);
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    expect([user().value, host().value, document.querySelector<HTMLInputElement>("[data-k='ssh-port']")!.value]).toEqual(["maya", "hetzner", "2200"]);
    // Another window's add takes the form while it runs, and hands it back as it ends.
    act(() => useAdds.setState(s => ({ jobs: { ...s.jobs, a_other: job({ addId: "a_other", address: "root@elsewhere" }) } })));
    stage("a_other", "connect", "running");
    expect([host().value, host().disabled]).toEqual(["elsewhere", true]);
    stage("a_other", "connect", "failed", "root@elsewhere did not answer on port 22");
    expect([user().value, host().value, document.querySelector<HTMLInputElement>("[data-k='ssh-port']")!.value]).toEqual(["maya", "hetzner", "2200"]);
    expect(asked).toEqual([]);
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await settle();
    expect(asked).toEqual([{ address: "maya@hetzner", port: 2200 }]);
    expect(useAdds.getState().draft).toBeNull();
  });

  it("keeps the run when the person switches roads or leaves the page and comes back, since the host keeps installing", async () => {
    const { at, api } = pending();
    await open("ssh", api, setupOf());
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    stage(at.addId!, "connect", "done", "Ubuntu 24.04");
    fireEvent.click(document.querySelector("[data-add-road='cloud']")!);
    expect(document.querySelector("[data-k='road-ssh']")).toBeNull();
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    expect(user().value).toBe("root");
    expect(host().value).toBe("65.21.4.12");
    expect(plan()[0]![1]).toBe("done");
    cleanup();
    render(<AddComputer setup={null} now={() => NOW} />);
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    await refuseWith(at, new RequestError("root@65.21.4.12 did not answer on port 22"));
    expect(slot()).toBe("root@65.21.4.12 did not answer on port 22");
  });

  it("reads the box as joined once the host says it joined, drawing its computer row, and Add another clears it", async () => {
    await open("ssh", { addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    useStore.setState({ places: [here, box] });
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(document.querySelector("[data-k='joined'] [data-place-row='p_2']")).toBeTruthy());
    expect(document.querySelector("[data-k='joined'] [data-grid-name]")?.textContent).toBe("hetzner");
    fireEvent.click(screen.getByRole("button", { name: ADD_COMPUTER_WORDS.another }));
    expect(document.querySelector("[data-k='joined']")).toBeNull();
    expect(host().value).toBe("");
  });

  it("runs the whole road on the client this app builds: Add sends places.add and the stages that ride it draw", async () => {
    ScriptedSocket.instances.length = 0;
    ScriptedSocket.reply = (f: Frame) => (f["op"] === "places.add" || f["op"] === "places.sshHosts" ? undefined : { id: f["id"], ok: true });
    const client = (live = new ProtocolClient({ url: "ws://test", token: "tok", WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket }));
    await client.connect();
    const sock = ScriptedSocket.instances[0]!;
    const api = makeApi(client);
    api.subscribe(e => useStore.getState().applyEvent(e));
    useStore.setState({ api, places: [here] });
    render(<AddComputer setup={null} now={() => NOW} />);
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    fireEvent.change(host(), { target: { value: "root@65.21.4.12" } });
    fireEvent.keyDown(host(), { key: "Enter" });
    await waitFor(() => expect(sock.frames("places.add").length).toBe(1));
    const asked = sock.frames("places.add")[0]!;
    expect(asked).toMatchObject({ address: "root@65.21.4.12", addId: expect.any(String) });
    const addId = String(asked["addId"]);
    await act(async () => {
      sock.onmessage?.({ data: JSON.stringify({ type: "place.stage", addId, step: "connect", state: "done", note: "Ubuntu 24.04" }) });
      await Promise.resolve();
    });
    expect(plan()[0]![1]).toBe("done");
    await act(async () => {
      sock.onmessage?.({ data: JSON.stringify({ type: "place.joined", place: box, from: "65.21.4.12" }) });
      sock.onmessage?.({ data: JSON.stringify({ type: "place.stage", addId, step: "join", state: "done", placeId: "p_2" }) });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector("[data-k='joined']")?.textContent).toContain("hetzner"));
  });

  it("carries the host's fix off the wire into the slot, and the login fix off the refusal's own kind", async () => {
    ScriptedSocket.instances.length = 0;
    ScriptedSocket.reply = (f: Frame) => (f["op"] === "places.add" || f["op"] === "places.sshHosts" ? undefined : { id: f["id"], ok: true });
    const client = (live = new ProtocolClient({ url: "ws://test", token: "tok", WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket }));
    await client.connect();
    const sock = ScriptedSocket.instances[0]!;
    useStore.setState({ api: makeApi(client), places: [here] });
    render(<AddComputer setup={null} now={() => NOW} />);
    fireEvent.click(document.querySelector("[data-add-road='ssh']")!);
    const refuse = async (reply: Record<string, unknown>): Promise<string> => {
      const before = sock.frames("places.add").length;
      fireEvent.change(host(), { target: { value: "spoo" } });
      fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
      await waitFor(() => expect(sock.frames("places.add").length).toBe(before + 1));
      const asked = sock.frames("places.add").at(-1)!;
      await act(async () => {
        sock.onmessage?.({ data: JSON.stringify({ id: asked["id"], ok: false, ...reply }) });
        await Promise.resolve();
      });
      await waitFor(() => expect(slot()).not.toBe(""));
      return slot();
    };
    expect(await refuse({ error: "spoo is neither a login like root@host nor an alias your ssh config gives a HostName", kind: PLACE_LOGIN_REFUSED_KIND })).toContain(ADD_COMPUTER_WORDS.refusedFix);
    expect(await refuse({ error: "wsp add refuses a loopback address" })).toBe("wsp add refuses a loopback address");
    expect(await refuse({ error: "spoo has no curl or wget on its PATH. Install one of them there, then add again.", fix: "Install one of them there, then add again." })).toBe("spoo has no curl or wget on its PATH. Install one of them there, then add again.");
    expect(document.querySelector("[data-k='ssh-refusal'] span.text-foreground")?.textContent?.trim()).toBe("Install one of them there, then add again.");
  });

  // Each is thrown with the connect step still running, as the host throws them: the login stood and the box said no.
  it.each([
    ["the box already in another wsp", "root@spoo already belongs to the wsp on studio at http://10.0.0.2:4640; wsp leave on it frees it"],
    ["root's shell", "root@spoo runs zsh as root's shell, and wsp runs only under bash or sh there"],
    ["the chip", "root@spoo runs on riscv64, and wsp builds no daemon for that chip"],
    ["the host key mismatch", "root@spoo answered with a key other than the one you pinned"],
  ])("says a refusal after the login stood (%s) with no login fix", async (_what, sentence) => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(host(), { target: { value: "root@spoo" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    stage(at.addId!, "connect", "running");
    stage(at.addId!, "host-key", "done");
    stage(at.addId!, "connect", "failed", sentence);
    await refuseWith(at, new RequestError(sentence));
    expect(slot()).toBe(sentence);
  });

  it("says a box that took wsp and did not connect back in the box's one sentence, with no ssh login fix and no script", async () => {
    const { at, api } = pending();
    await open("ssh", api);
    fireEvent.change(host(), { target: { value: "root@178.156.161.168" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    const sentence = "spoo took wsp but could not connect back: the host at http://100.129.166.28:4640 did not answer in 20s";
    stage(at.addId!, "connect", "done", "Ubuntu 24.04");
    stage(at.addId!, "wsp", "done");
    stage(at.addId!, "service", "running");
    await refuseWith(at, new Error(sentence));
    // The login stood and the bytes landed, so a fix about the user, the address or a key would send them the wrong way.
    expect(slot()).toBe(sentence);
    expect(slot()).not.toContain('case "$(uname -m)"');
  });

  it("lists every provider with its own key field, saves each on its own, and says key saved once the host lists that cloud", async () => {
    const asked: { provider?: string; key?: string }[] = [];
    let places: PlaceView[] = [here];
    await open(
      "cloud",
      {
        initKeys: async (k: { provider?: string; key?: string }) => {
          asked.push(k);
          places = [here, ascii];
          return setupOf({ keys: { solari: false, box: k.provider === "box" } });
        },
        placesList: async () => ({ places, adds: [] }),
      } as unknown as Partial<Api>,
      setupOf({ keys: { solari: false, box: false } }),
    );
    const blocks = [...document.querySelectorAll("[data-k='road-cloud'] [data-provider]")];
    expect(blocks.map(b => b.getAttribute("data-provider"))).toEqual(["box", "solari"]);
    // Each provider by the name the protocol gives it, and the picker's line names the same ones.
    expect(blocks.map(b => b.querySelector("span.text-\\[14px\\]")?.textContent)).toEqual([PROVIDER_KEY_WORDS["box"]!.name, PROVIDER_KEY_WORDS["solari"]!.name]);
    expect(document.querySelector("[data-add-road='cloud']")?.textContent).toContain(`${PROVIDER_KEY_WORDS["box"]!.name} or ${PROVIDER_KEY_WORDS["solari"]!.name}`);
    expect(document.body.textContent).not.toContain("no key");
    const boxKey = blocks[0]!;
    fireEvent.change(boxKey.querySelector("[data-k='cloud-key']")!, { target: { value: "k-123" } });
    fireEvent.click(boxKey.querySelector("[data-k='cloud-save']")!);
    await waitFor(() => expect(boxKey.querySelector("[data-k='key-state']")?.textContent).toBe(ADD_COMPUTER_WORDS.keySaved));
    expect(asked).toEqual([{ provider: "box", key: "k-123" }]);
    expect(blocks[1]!.querySelector("[data-k='key-state']")).toBeNull();
  });

  it("says a key the host kept with no cloud row as kept and no computer yet, never as saved", async () => {
    await open(
      "cloud",
      { initKeys: async () => setupOf({ keys: { solari: false, box: true } }), placesList: async () => ({ places: [here], adds: [] }) } as unknown as Partial<Api>,
      setupOf({ keys: { solari: false, box: false } }),
    );
    const boxKey = document.querySelector("[data-k='road-cloud'] [data-provider='box']")!;
    fireEvent.change(boxKey.querySelector("[data-k='cloud-key']")!, { target: { value: "k-123" } });
    fireEvent.click(boxKey.querySelector("[data-k='cloud-save']")!);
    await waitFor(() => expect(boxKey.querySelector("[data-k='key-state']")?.textContent).toBe(ADD_COMPUTER_WORDS.keyKept));
    await settle();
    expect(boxKey.querySelector("[data-k='key-state']")?.textContent).toBe(ADD_COMPUTER_WORDS.keyKept);
  });

  it("says a key the host did not take as that cloud refusing it, with where to check it, and a refused save in the host's two halves", async () => {
    let refuse: Error | undefined;
    await open(
      "cloud",
      { initKeys: async () => (refuse !== undefined ? Promise.reject(refuse) : setupOf({ keys: { solari: false, box: false } })), placesList: async () => ({ places: [here], adds: [] }) } as unknown as Partial<Api>,
      setupOf({ keys: { solari: false, box: false } }),
    );
    const boxKey = document.querySelector("[data-k='road-cloud'] [data-provider='box']")!;
    const save = async (): Promise<string> => {
      fireEvent.change(boxKey.querySelector("[data-k='cloud-key']")!, { target: { value: "k-123" } });
      fireEvent.click(boxKey.querySelector("[data-k='cloud-save']")!);
      await settle();
      return boxKey.querySelector("[data-k='cloud-refusal']")?.textContent ?? "";
    };
    const words = ADD_COMPUTER_WORDS.keyRefused(PROVIDER_KEY_WORDS["box"]!);
    expect(await save()).toBe(`${words.said} ${words.fix}`);
    expect(words.said).toBe(`${PROVIDER_KEY_WORDS["box"]!.name} refused that key.`);
    expect(words.fix).toBe(`Check it at ${PROVIDER_KEY_WORDS["box"]!.keyConsole} and paste it again.`);
    expect(boxKey.querySelector("[data-k='key-state']")).toBeNull();
    refuse = new RequestError("Boat refused. Check it and paste it again.", "auth", "Check it and paste it again.");
    expect(await save()).toBe("Boat refused. Check it and paste it again.");
    expect(boxKey.querySelector("[data-k='cloud-refusal'] span.text-foreground")?.textContent?.trim()).toBe("Check it and paste it again.");
  });

  it("draws the ssh hosts the host suggests as it answered them, and asks again once the computers change", async () => {
    let asked = 0;
    await open("ssh", { addComputerOverSsh: async () => box, sshHosts: async () => (asked++, [{ alias: "hetzner", hostName: "65.21.4.12", from: "config" }]) } as unknown as Partial<Api>);
    useStore.setState({ places: [here, box] });
    await waitFor(() => expect(asked).toBe(2));
    // The host is the one that leaves out the computers already added; a row it names stands, even under a computer's name.
    await waitFor(() => expect([...document.querySelectorAll("[data-ssh-host]")].map(b => b.getAttribute("data-ssh-host"))).toEqual(["hetzner"]));
  });

  it("says the ssh config was not read where its hosts would be, and says nothing for a socket that may not ask", async () => {
    await open("ssh", { addComputerOverSsh: async () => box, sshHosts: async () => Promise.reject(new RequestError("~/.ssh/config: permission denied", undefined, undefined)) } as unknown as Partial<Api>);
    await settle();
    expect(document.querySelector("[data-k='ssh-hosts-refused']")?.textContent).toBe(ADD_COMPUTER_WORDS.hostsNotRead("~/.ssh/config: permission denied"));
    expect(document.querySelector("[data-k='ssh-hosts']")).toBeNull();
    cleanup();
    await open("ssh", { addComputerOverSsh: async () => box, sshHosts: async () => Promise.reject(new RequestError(PLACES_TICKET_REFUSAL, "ticket")) } as unknown as Partial<Api>);
    await settle();
    expect(document.querySelector("[data-k='ssh-hosts-refused']")).toBeNull();
  });

  it("mints the join line, counts the code down, and holds New code where this wsp mints none", async () => {
    await open("code", { mintJoin: async () => ({ joins: [{ url: "http://10.0.0.2:4640", line: "wsp join http://10.0.0.2:4640 --code AB12-CD34.fp" }], expiresAt: new Date(NOW + 600_000).toISOString() }) } as unknown as Partial<Api>);
    await waitFor(() => expect(document.querySelector("[data-k='join-line'] code")?.textContent).toBe("wsp join http://10.0.0.2:4640 --code AB12-CD34.fp"));
    expect(document.querySelector("[data-k='code-left']")?.textContent).toBe(ADD_COMPUTER_WORDS.codeLeft(600_000));
    expect(document.querySelector("[data-k='install-line'] code")?.textContent).toBe(PLACES_WORDS.sheet.install);
    cleanup();
    await open("code");
    expect(document.querySelector("[data-k='code-left']")?.textContent).toBe(ADD_COMPUTER_WORDS.noMint);
  });

  it("says not copied beside a line the clipboard refused, for a moment", async () => {
    const write = navigator.clipboard?.writeText;
    Object.assign(navigator, { clipboard: { writeText: () => Promise.reject(new Error("Document is not focused.")) } });
    try {
      await open("code", { mintJoin: async () => ({ joins: [], expiresAt: new Date(NOW + 600_000).toISOString() }) } as unknown as Partial<Api>);
      const line = document.querySelector("[data-k='install-line']")!;
      fireEvent.click(line.querySelector("button")!);
      await waitFor(() => expect(line.querySelector("[data-k='not-copied']")?.textContent).toBe(ADD_COMPUTER_WORDS.notCopied));
      expect(line.querySelector("button")?.getAttribute("aria-label")).toBe(ADD_COMPUTER_WORDS.notCopied);
      await waitFor(() => expect(line.querySelector("[data-k='not-copied']")).toBeNull(), { timeout: 2500 });
    } finally {
      Object.assign(navigator, { clipboard: { writeText: write } });
    }
  });
});

describe("the list the four place events keep", () => {
  it("appends a computer that joined, moves it as its link comes and goes, and drops it when it is removed", () => {
    useStore.setState({ places: [here] });
    const apply = useStore.getState().applyEvent;
    apply({ type: "place.joined", place: { ...laptop, present: false }, from: "192.168.1.34" });
    expect(useStore.getState().places.map(p => p.id)).toEqual(["here", "p_1"]);
    apply({ type: "place.present", placeId: "p_1", from: "192.168.1.34" });
    expect(useStore.getState().places.find(p => p.id === "p_1")?.present).toBe(true);
    apply({ type: "place.absent", placeId: "p_1" });
    expect(useStore.getState().places.find(p => p.id === "p_1")?.present).toBe(false);
    apply({ type: "place.removed", placeId: "p_1" });
    expect(useStore.getState().places.map(p => p.id)).toEqual(["here"]);
  });
});

describe("the road to the page", () => {
  it("reads the host's setup once for the whole page, whatever the page draws from it", async () => {
    let reads = 0;
    const api = settingsApi({
      initGet: async () => {
        reads += 1;
        return setupOf({ keys: { solari: true } });
      },
    } as Partial<Api>).api;
    useStore.setState({ places: [here, solari] });
    await mountComputers(api);
    expect(reads).toBe(1);
    expect(listIds()).toEqual(["here", "solari"]);
  });

  it("stands in the sidebar's bottom-left corner as an icon button named Settings, its chord on the tooltip, in a row that takes more buttons", async () => {
    render(
      <TooltipProvider>
        <SidebarCorner />
      </TooltipProvider>,
    );
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg.lucide-settings")).not.toBeNull();
    const corner = button.closest<HTMLElement>("[data-sidebar-corner]")!;
    expect(corner.className).toMatch(/(^|\s)flex(\s|$)/);
    expect(corner.className).toContain("items-center");
    fireEvent.focus(button);
    // The chord as this platform writes it, read off the same rules the tooltip reads.
    const chord = shortcutLabelForCommand(currentKeybindings(), "settings.toggle")!;
    await waitFor(() => expect(document.querySelector("[data-slot=tooltip-popup], [data-slot=tooltip-content]")?.textContent).toBe(`Settings${chord}`));
    fireEvent.click(button);
    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it("opens the page on its Add a computer section when a road asks for it", async () => {
    useStore.getState().openAddComputer();
    expect(useStore.getState().settingsOpen).toBe(true);
    mountSettings({ api: settingsApi().api });
    await settle();
    expect(document.querySelector("[data-k='add-computer']")).toBeTruthy();
    expect(pageAt()).toBe("computers");
  });
});
