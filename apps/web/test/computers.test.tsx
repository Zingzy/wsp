// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Computers: the list off the host's own rows, which it draws and
// which it leaves out, each row's facts and state word; a computer's own page
// with its lines, its connection, the row to its agents, the workspaces
// standing on it and the two acts; the Agents page with a computer picked;
// the cloud's page with the image behind its row; and the one-field sheet
// that adds another computer.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InitJob, COPY_CURRENT, DAEMON_VERSION, DEFAULT_PREFERENCES, PLACES_TICKET_REFUSAL, PLACES_WORDS, PLACE_CONNECTS, PLACE_LOGIN_REFUSED_KIND, PlaceAddStep, absentRoad, fmtBytes, fmtMemGb, fmtSize, imageCopyStaysLine, placeAddSheetWord, placeDaemonBehind, placeNoDialLine, setupWord, type AgentsReport, type AgentsTarget, type EventUnion, type InitSetup, type PlaceAddJob, type PlaceApplied, type PlaceSetup, type PlaceView, type SealedImage, type SessionView, type WorkspaceStatus, type WorkspaceView, PLACE_INSTALL, PROVIDER_KEY_WORDS } from "@wsp/protocol";
import { render } from "@testing-library/react";
import { makeApi, ProtocolClient, RequestError, type Api, type SshLogin } from "../src/protocol/client.js";
import { useContextMenuStore } from "../src/actions/contextMenu.js";
import { useStore } from "../src/protocol/store.js";
import { AddComputer } from "../src/settings/AddComputer.js";
import { closeAdd, useAddFlow } from "../src/settings/add/addFlow.js";
import { useAdds } from "../src/settings/adds.js";
import { AGENTS_LIST_WORDS } from "../src/components/agents/agentsRows.js";
import { ADD_COMPUTER_WORDS, AGENTS_PAGE_WORDS, COMPUTER_PAGE_WORDS, WHERE_WORDS, capitalised } from "../src/settings/format.js";
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
/** The state a row's cell draws as a mark, or nothing where it draws none. */
const markOf = (id: string): string | null => listRow(id).querySelector("[data-state-cell] [data-state-mark]")?.getAttribute("data-state-mark") ?? null;
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
    // Ready draws nothing; a computer not answering is the offline mark, its whole sentence on the hover.
    expect([stateOf("here"), markOf("here")]).toEqual(["", null]);
    expect(markOf("p_1")).toBe("offline");
    expect(listRow("p_1").getAttribute("title")).toBe(absentOf(laptop, Date.now())?.sentence);
    // No chip, no middle dot, no rule: facts are cells on the template.
    expect(document.querySelector("[data-settings-page] [data-chip]")).toBeNull();
    expect(document.querySelector("[data-settings-page]")?.textContent).not.toContain("\u00b7");
    expect(listRow("here").className).toContain("min-h-15");
  });

  it("says this computer's own daemon is not running in the slot, rather than listing this Mac as perfectly fine", async () => {
    const silent = { id: mine.id, phase: "running", machineState: "running", reach: { state: "unreachable" }, machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, kind: "local", size: { cpu: 8, memMb: 16384 }, name: mine.name, golden: "", createdAt: mine.createdAt } as unknown as WorkspaceStatus;
    useStore.setState({ places: [here], workspaces: [mine], statuses: { [mine.id]: silent } });
    await mountComputers(computersApi().api);
    expect(markOf("here")).toBe("offline");
    expect(listRow("here").textContent).not.toContain("Unreachable");
  });

  it("leaves a fact a computer has not reported blank, never a dash, and keeps the row's height", async () => {
    useStore.setState({ places: [{ id: "p_2", kind: "computer", name: "attic", default: false, present: true }] });
    await mountComputers(computersApi().api);
    expect(cellOf("p_2", "cores")).toBe("");
    expect(cellOf("p_2", "memory")).toBe("");
    expect(listRow("p_2").textContent).not.toMatch(/[-\u2014]/);
    expect(listRow("p_2").className).toContain("min-h-15");
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
      // A phone's list keeps the state: nothing on the cell or on the row's template hides it below a width.
      expect(cell.className, id).not.toMatch(/max-\w+:hidden|(^|\s)hidden(\s|$)/);
      expect(listRow(id).className, id).toMatch(/max-md:grid-cols-\[minmax\(0,1fr\)_auto_72px_14px\]/);
    }
    expect(stateOf("p_2")).toBe(WHERE_WORDS.update);
  });

  it("draws the clouds as their own list on the same template, and no machines column while the host reads none", async () => {
    const withRoom: PlaceView = { ...solari, forks: { running: 1, room: 1 } };
    useStore.setState({ places: [here, withRoom, ascii], workspaces: [] });
    await mountComputers(computersApi().api);
    const grids = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-grid]")];
    expect(grids.map(g => g.dataset["grid"])).toEqual(["computers", "clouds"]);
    expect(grids.map(g => [...g.querySelectorAll("[data-grid-head] span")].map(c => c.textContent))).toEqual([["Computer", "Cores", "Memory", "Threads"], ["Cloud", "", "", "Threads"]]);
    // The two lists share one column template, so the state column is one line down the page.
    expect(new Set(grids.map(g => g.querySelector("[data-grid-row]")?.className.match(/grid-cols-\[[^\s]+\]/)?.[0])).size).toBe(1);
    expect(nameOf("solari")).toBe("Solari");
    expect(markOf("solari")).toBeNull();
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

  it("reads the state cell in one order, each a mark with its sentence on the hover: blocked, a setup that failed or waits on the person, not answering, the setup running, the daemon behind, a sign-in, then Ready", async () => {
    const running: PlaceSetup = { state: "running", addId: "a_1", startedAt: AT, steps: [{ step: "clis", state: "running" }], waiting: [] };
    const failed: PlaceSetup = { state: "failed", addId: "a_1", startedAt: AT, finishedAt: AT, steps: [{ step: "floor", state: "failed" }], waiting: [], said: "the base tools did not install: curl" };
    const stuck = { ...box, id: "p_stuck", name: "stuck", blocked: "its login cannot run docker", setup: running };
    const busy = { ...box, id: "p_busy", name: "busy", setup: running };
    const broke = { ...box, id: "p_broke", name: "broke", setup: failed };
    const gone = { ...laptop, id: "p_gone", name: "gone", setup: running };
    const behind = { ...box, id: "p_old", name: "old", daemonVersion: 1 };
    const unsigned = { ...box, id: "p_sign", name: "sign", signIns: { claude: "signed-in", codex: "none" } } as PlaceView;
    useStore.setState({ places: [here, stuck, busy, broke, gone, behind, unsigned, box] });
    await mountComputers(computersApi().api);
    expect(markOf("p_stuck")).toBe("failed");
    expect(listRow("p_stuck").getAttribute("title")).toBe("its login cannot run docker");
    expect(markOf("p_busy")).toBe("working");
    expect(listRow("p_busy").getAttribute("title")).toBe(setupWord(running));
    expect(markOf("p_broke")).toBe("failed");
    expect(listRow("p_broke").getAttribute("title")).toBe("the base tools did not install: curl");
    expect(markOf("p_gone")).toBe("offline");
    // Behind with no road to update reads the word; the button stands only where a press can go.
    expect(stateOf("p_old")).toBe("Behind");
    expect(listRow("p_old").getAttribute("title")).toBe(placeDaemonBehind(behind));
    expect(listRow("p_sign").querySelector("[data-k='sign-in']")?.textContent).toBe("Sign in");
    expect(listRow("p_sign").getAttribute("title")).toBe("needs a sign-in: Codex");
    expect([stateOf("p_2"), markOf("p_2")]).toEqual(["", null]);
    // Sign in goes to the computer's page, whose agent rows carry each one's own.
    fireEvent.click(listRow("p_sign").querySelector("[data-k='sign-in']")!);
    expect(pageAt()).toBe("computer:p_sign");
  });

  it("offers Update in the cell of a computer behind this wsp's daemon, puts it there on a press, and reads the job in the cell after", async () => {
    const asked: string[] = [];
    const setup: PlaceSetup = { state: "running", addId: "a_2", startedAt: AT, steps: [{ step: "floor", state: "running" }], waiting: [] };
    const behind: PlaceView = { ...box, daemonVersion: 1 };
    const api = computersApi({ placesUpdate: async (placeId: string) => (asked.push(placeId), { name: "hetzner", setup }) } as unknown as Partial<Api>).api;
    useStore.setState({ places: [here, behind] });
    await mountComputers(api);
    const update = listRow("p_2").querySelector<HTMLElement>("[data-k='update']")!;
    expect(update.textContent).toBe(WHERE_WORDS.update);
    fireEvent.click(update);
    await waitFor(() => expect(asked).toEqual(["p_2"]));
    // The press is the button's own: the row does not open the page under it.
    expect(pageAt()).toBe("computers");
    await waitFor(() => expect(useStore.getState().places.find(place => place.id === "p_2")?.setup).toEqual(setup));
  });

  it("draws Add a computer under the computers, opening its dialog, and Add a cloud under the clouds, opening the cloud's panel, and a row opens its page", async () => {
    useStore.setState({ places: [here, box, solari] });
    await mountComputers(computersApi().api);
    expect([...document.querySelectorAll("[data-settings-card='computers'] [data-place-row]")].map(r => r.getAttribute("data-place-row"))).toEqual(["here", "p_2"]);
    expect([...document.querySelectorAll("[data-settings-card='computers'] [data-add-button]")].map(b => b.textContent)).toEqual([ADD_COMPUTER_WORDS.title]);
    expect([...document.querySelectorAll("[data-settings-card='clouds'] [data-add-button]")].map(b => b.textContent)).toEqual([ADD_COMPUTER_WORDS.addCloud]);
    expect(document.querySelector("[data-k='add-computer']")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ADD_COMPUTER_WORDS.addCloud }));
    expect(document.querySelector("[data-k='road-cloud']")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: ADD_COMPUTER_WORDS.title }));
    expect(useAddFlow.getState()).toMatchObject({ open: true, step: "where" });
    act(() => closeAdd());
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
  it("sets threads at once, the nap window and the agents switch through the host, takes a set one back, and offers an older daemon its update", async () => {
    const asked: Array<[string, unknown, readonly string[]]> = [];
    const updated: string[] = [];
    const agents = { spawn: true, maxMachines: 3, maxDepth: 1 };
    const row: PlaceView = { ...box, cap: { threads: 2 }, capDefault: { threads: 2 }, settings: { napMs: 30 * 60_000 }, napMs: 30 * 60_000, napDefault: 20 * 60_000, spawn: agents, spawnDefault: agents, daemonVersion: 1, behind: { word: "daemon 1", fix: "wsp add hetzner --update", act: "update" } };
    useStore.setState({ places: [here, row] });
    const api = computersApi({
      agentsRead: async () => AGENTS_REPORT,
      placesSet: async (placeId, ask, reset = []) => {
        asked.push([placeId, ask, reset]);
        return { ...row, ...(ask.threads === undefined ? {} : { cap: { threads: ask.threads }, settings: { ...row.settings, threads: ask.threads } }) };
      },
      placesUpdate: async placeId => {
        updated.push(placeId);
        return {} as never;
      },
    }).api;
    await mountComputers(api, { kind: "computer", id: "p_2" });
    const page = document.querySelector("[data-settings-page]")!;
    const behind = page.querySelector("[data-k=computer-behind]")!;
    expect(behind.querySelector("[data-settings-title]")?.textContent).toBe(COMPUTER_PAGE_WORDS.behindTitle(MAC));
    expect(document.querySelector("[data-k='place-state']")).toBeNull();
    await act(async () => fireEvent.click(behind.querySelector("[data-k=update-wsp]")!));
    expect(updated).toEqual(["p_2"]);

    const threads = page.querySelector("[data-settings-row=threads-at-once]")!;
    expect(threads.querySelector("[data-k=threads-at-once-value]")?.textContent).toBe("2");
    expect(threads.querySelector("[data-settings-description]")?.textContent).toBe(COMPUTER_PAGE_WORDS.threadsLine(2, "hetzner", fmtMemGb(4096)));
    expect(threads.querySelector("[data-k=row-reset]")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: COMPUTER_PAGE_WORDS.more })));
    await settle();
    expect(asked.at(-1)).toEqual(["p_2", { threads: 3 }, []]);
    expect(page.querySelector("[data-k=threads-at-once-value]")?.textContent).toBe("3");
    expect(page.querySelector("[data-settings-row=threads-at-once] [data-k=row-reset]")).not.toBeNull();

    await act(async () => fireEvent.click(page.querySelector("[data-settings-row=nap-after] [data-k=row-reset]")!));
    expect(asked.at(-1)).toEqual(["p_2", {}, ["nap"]]);
    await act(async () => fireEvent.click(page.querySelector("[data-k=agents-start-agents]")!));
    expect(asked.at(-1)).toEqual(["p_2", { spawn: { spawn: false } }, []]);
  });

  it("steps threads at once off the number it last sent while the host has not answered, so two quick presses land two up", async () => {
    const asked: number[] = [];
    const answers: Array<() => void> = [];
    const row: PlaceView = { ...box, cap: { threads: 2 }, capDefault: { threads: 2 } };
    useStore.setState({ places: [here, row] });
    const api = computersApi({
      agentsRead: async () => AGENTS_REPORT,
      placesSet: (_placeId, ask) => {
        asked.push(ask.threads!);
        return new Promise(done => answers.push(() => done({ ...row, cap: { threads: ask.threads! }, settings: { threads: ask.threads! } })));
      },
    }).api;
    await mountComputers(api, { kind: "computer", id: "p_2" });
    const more = screen.getByRole("button", { name: COMPUTER_PAGE_WORDS.more });
    await act(async () => fireEvent.click(more));
    await act(async () => fireEvent.click(more));
    expect(asked).toEqual([3, 4]);
    expect(document.querySelector("[data-k=threads-at-once-value]")?.textContent).toBe("4");
    await act(async () => answers.shift()!());
    expect(document.querySelector("[data-k=threads-at-once-value]")?.textContent).toBe("4");
    await act(async () => answers.shift()!());
    await settle();
    expect(document.querySelector("[data-k=threads-at-once-value]")?.textContent).toBe("4");
  });

  const withWorkspaces = (): void => {
    useStore.setState({
      places: [here, laptop],
      workspaces: [{ id: "ws_b", name: "spoo-fix", kind: "cloud", machineId: "ctr_9f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, place: "p_1", phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z", home: "/home/dev" }] as never,
      sessions: { ws_b: [session("s1", "ws_b"), session("s2", "ws_b")] },
    });
  };

  it("opens the page on the computer itself, its facts of one kind on one line and its daemon, its state under it, and no crumbs of its own", async () => {
    useStore.setState({ places: [here, { ...box, os: "Ubuntu 24.04", joinedAt: AT, copies: "reflink", daemonVersion: DAEMON_VERSION }] });
    await mountComputers(computersApi({ agentsRead: async () => AGENTS_REPORT }).api, { kind: "computer", id: "p_2" });
    const head = document.querySelector("[data-settings-page] [data-k=computer-head]")!;
    expect(head.querySelector("[data-settings-title]")?.textContent).toBe("hetzner");
    expect(head.querySelector("[data-settings-description]")?.textContent).toBe(`Ubuntu 24.04, ${box.shape!.cpu} cores, ${fmtMemGb(box.shape!.memMb)}`);
    // The app never says an internal word: the daemon's version is the doctor's to say, not the page's head.
    expect(head.textContent).not.toMatch(/daemon/i);
    // Ready draws no mark and has nothing to say.
    expect(document.querySelector("[data-k='place-state']")?.textContent).toBe("");
    expect(document.querySelector("[data-k='place-state'] [data-state-mark]")).toBeNull();
    expect(document.querySelector("[data-k='page-crumbs']")).toBeNull();
    expect(document.querySelector("[data-settings-page] h1")).toBeNull();
    for (const k of ["system", "size", "disk-free", "joined", "address", "answered", "copies", "ports", "computer-icon", "workspace-line"]) expect(document.querySelector(`[data-settings-page] [data-k='${k}']`)).toBeNull();
  });

  it("says a computer that is not answering in the state line with the dial beside it, whose answer takes the sentence's place", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said } };
    const line = "root@65.21.4.12 answered over ssh in 412 ms, so the computer is on; the agent on it is not dialling this host.";
    useStore.setState({ places: [here, vps] });
    await mountComputers(computersApi(dialling(line)).api, { kind: "computer", id: "p_3" });
    const state = document.querySelector("[data-k='place-state']")!;
    expect(state.querySelector("[data-state-cell] [data-state-mark]")?.getAttribute("data-state-mark")).toBe("offline");
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

  it("lists no threads on a computer's page: what runs there is the sidebar's to say", async () => {
    const running = { ...session("s1", "ws_b"), status: "running" as const, threadId: "t_1" };
    useStore.setState({ places: [here, laptop], workspaces: [{ ...onLaptop, name: "spoo-fix" }], sessions: { ws_b: [running] } });
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

describe("the Agents page on a computer", () => {
  const rowKeys = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-kind-row]")].map(r => r.dataset["kindRow"] ?? "");
  const agentRow = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-settings-page] [data-agent-row="${id}"]`)!;
  const agentIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-agent-row]")].map(r => r.dataset["agentRow"] ?? "");
  const stateLine = (key: string): string | undefined => document.querySelector(`[data-settings-page] [data-kind-row="${key}"] [data-settings-slot]`)?.textContent ?? undefined;
  const topBarTab = (tab: "agents" | "servers" | "skills"): void => void fireEvent.click(document.querySelector(`[data-k=agents-tabs] [data-segment=${tab}]`)!);
  const picked = (): string | undefined => document.querySelector("[data-k=agents-tabs] [data-checked]")?.getAttribute("data-segment") ?? undefined;
  const computerPick = (): HTMLElement => document.querySelector<HTMLElement>("[data-k=agents-picker]")!;
  const mountAgents = async (api: Api, placeId: string | null): Promise<void> => {
    useSettingsStore.getState().pickAgentsPlace(placeId);
    await mountComputers(api, { kind: "group", group: "agents" });
  };

  it("lists the agents with their version and sign-in, installed first, and the MCP servers with their state, off the picked computer's own report", async () => {
    const asked: AgentsTarget[] = [];
    useStore.setState({ places: [here, box] });
    await mountAgents(computersApi({ agentsRead: async (target: AgentsTarget) => (asked.push(target), AGENTS_REPORT) }).api, "p_2");
    expect(asked).toEqual([{ placeId: "p_2" }]);
    expect(computerPick().textContent).toBe("hetzner");
    const installed = AGENTS_REPORT.agents.filter(a => a.installed);
    expect(agentIds()).toEqual([...installed, ...AGENTS_REPORT.agents.filter(a => !a.installed)].map(a => a.id));
    const claude = installed.find(a => a.id === "claude")!;
    expect(agentRow("claude").querySelector("[data-settings-title]")?.textContent).toBe(claude.name);
    expect(agentRow("claude").querySelector("svg")).not.toBeNull();
    expect(agentRow("claude").querySelector("[data-settings-description]")?.textContent).toBe(`v${claude.version}`);
    expect(agentRow("claude").querySelector("[data-k=agent-status]")?.textContent).toBe(capitalised(AGENTS_LIST_WORDS.signedIn));
    topBarTab("servers");
    expect(picked()).toBe("servers");
    expect(rowKeys().length).toBeGreaterThan(0);
    expect(rowKeys().every(k => k.startsWith("server-"))).toBe(true);
    expect(stateLine(rowKeys()[0]!)).not.toBe("");
    for (const k of ["remove", "update", "dial"]) expect(document.querySelector(`[data-settings-page] [data-k='${k}']`)).toBeNull();
  });

  it("offers Sign in on an agent that needs one there, and draws its flow under the row once it starts", async () => {
    const report: AgentsReport = { ...EMPTY_REPORT, agents: [{ id: "claude", name: "Claude Code", installed: true, version: "2.1.283", road: "wsp", signIn: "none", signInRoad: "device", wspTools: false }] };
    const started: [AgentsTarget, string][] = [];
    const agentsSignIn = async (target: AgentsTarget, agent: string, _server: unknown, step: (e: { state: string; url?: string }) => void) => {
      started.push([target, agent]);
      step({ state: "waiting", url: "https://example.test/login" });
      return { stop: () => {} };
    };
    useStore.setState({ places: [here, box] });
    await mountAgents(computersApi({ agentsRead: async () => report, agentsSignIn } as unknown as Partial<Api>).api, "p_2");
    const state = (): string | undefined => agentRow("claude").querySelector("[data-k=agent-status]")?.textContent ?? undefined;
    // The Sign in button is the word; no status stands beside it.
    expect(state()).toBeUndefined();
    const signIn = agentRow("claude").querySelector<HTMLElement>("[data-settings-slot] [data-k='act-sign-in']")!;
    expect(signIn.textContent).toBe("Sign in");
    fireEvent.click(signIn);
    await settle();
    expect(started).toEqual([[{ placeId: "p_2" }, "claude"]]);
    expect(document.querySelector("[data-settings-page] [data-k='sign-in-flow']")).not.toBeNull();
    // While the flow waits on the person its own controls are the step, and the row says so.
    expect(agentRow("claude").querySelector("[data-k='act-sign-in']")).toBeNull();
    expect(state()).toBe(capitalised(AGENTS_LIST_WORDS.waitingOnYou));
  });

  it("puts the report's refusals in a Not read card under the list, one row each", async () => {
    const applied: PlaceApplied = {
      hash: "h",
      at: AT,
      rows: [
        { id: "agents/claude", label: "Claude Code", outcome: "installed" },
        { id: "agents/codex", label: "Codex", outcome: "failed", note: "npm exited 1" },
        { id: "tools/gh", label: "GitHub CLI", outcome: "failed" },
        { id: "agents/mcp/linear", label: "linear", outcome: "skipped", kind: "server", note: "waited on GitHub CLI" },
      ],
    };
    useStore.setState({ places: [here, { ...laptop, present: true, name: "spoo", applied }] });
    await mountAgents(computersApi({ agentsRead: async () => ({ ...EMPTY_REPORT, refused: ["skills: the folder is not readable"] }) }).api, "p_1");
    // The report's refusals, then the recipe's rows that did not land there, a row each in a card of their own.
    expect(document.querySelector("[data-settings-card=not-read] [data-settings-head]")?.textContent).toBe(AGENTS_PAGE_WORDS.notRead);
    expect([...document.querySelectorAll("[data-settings-page] [data-settings-card=not-read] [data-refused-line]")].map(l => [l.querySelector("[data-settings-title]")?.textContent, l.querySelector("[data-settings-description]")?.textContent])).toEqual([
      ["Skills", "The folder is not readable"],
      ["Codex", "Failed: npm exited 1"],
      ["linear", "Set aside: waited on GitHub CLI"],
    ]);
  });

  it("opens from a computer's own page with that computer picked, and the top bar's tabs switch the one kind the page lists", async () => {
    const asked: AgentsTarget[] = [];
    useStore.setState({ places: [here, box] });
    await mountComputers(computersApi({ agentsRead: async (target: AgentsTarget) => (asked.push(target), AGENTS_REPORT) }).api, { kind: "computer", id: "p_2" });
    // The computer's page draws no list of its own: one row hands it to the Agents page; its sign-ins read that report.
    expect(document.querySelector("[data-settings-page] [data-grid='agents']")).toBeNull();
    const row = document.querySelector<HTMLElement>("[data-settings-page] [data-k=agents-on]")!;
    expect(row.querySelector("[data-settings-title]")?.textContent).toBe("Agents, tool servers and skills on hetzner");
    fireEvent.click(row);
    await settle();
    expect(useSettingsStore.getState().agentsPlace).toBe("p_2");
    expect(pageAt()).toBe("agents");
    expect(computerPick().textContent).toBe("hetzner");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(target => "placeId" in target && target.placeId === "p_2")).toBe(true);
    expect(picked()).toBe("agents");
    expect(agentIds().length).toBeGreaterThan(0);
    topBarTab("servers");
    expect(useSettingsStore.getState().agentsTab).toBe("servers");
    expect(rowKeys().length).toBeGreaterThan(0);
    expect(rowKeys().every(k => k.startsWith("server-"))).toBe(true);
    topBarTab("skills");
    expect(picked()).toBe("skills");
    expect(rowKeys().length).toBeGreaterThan(0);
    expect(rowKeys().every(k => k.startsWith("skill-"))).toBe(true);
  });
});

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

  it("a joined Mac draws the model it is off its own report, and a joined computer that names none a server", async () => {
    useStore.setState({ places: [{ ...here, mac: "mac-mini" }, { ...box, mac: "macbook" }, { ...box, id: "p_3", name: "vps" }], workspaces: [] });
    await mountComputers(computersApi().api);
    expect(listRow("p_2").querySelector("[data-computer-glyph]")?.classList.contains("lucide-laptop")).toBe(true);
    expect(listRow("p_3").querySelector("[data-computer-glyph]")?.classList.contains("lucide-server")).toBe(true);
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
    expect(image.querySelector("[data-grid-note]")?.textContent).toMatch(/^built .*\. On your image: Claude Code\.$/);
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
    expect(document.querySelector("[data-k='image-state'] [data-grid-note]")?.textContent).toBe("1 of 5 steps done. On your image: Claude Code.");
  });
});

describe("Add a cloud on the page", () => {
  const open = async (_road: "cloud", over: Partial<Api> = {}, setup: InitSetup | null = null) => {
    const fake = settingsApi(over);
    useStore.setState({ api: fake.api, places: [here] });
    render(<AddComputer setup={setup} />);
    return fake;
  };
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
    // Each provider by the name the protocol gives it.
    expect(blocks.map(b => b.querySelector("span.text-\\[14px\\]")?.textContent)).toEqual([PROVIDER_KEY_WORDS["box"]!.name, PROVIDER_KEY_WORDS["solari"]!.name]);
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

  it("opens Add a computer over the Computers page when a road asks for it", async () => {
    useStore.getState().openAddComputer();
    expect(useStore.getState().settingsOpen).toBe(true);
    mountSettings({ api: settingsApi().api });
    await settle();
    expect(useAddFlow.getState()).toMatchObject({ open: true, step: "where" });
    expect(pageAt()).toBe("computers");
  });
});
