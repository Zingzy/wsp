// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Computers: the table off the host's own list, which rows it draws
// and which it leaves out, each row's detail with the agents on that computer
// and what the recipe put there beside them, and the one-field sheet that adds
// another.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, PLACES_TICKET_REFUSAL, PLACES_WORDS, PLACE_CONNECTS, PlaceAddStep, fmtBytes, fmtSize, imageCopyStaysLine, placeAddSheetWord, placeDaemonBehind, placeNoDialLine, provisionWord, type EventUnion, type InitSetup, type PlaceProvision, type PlaceSpend, type PlaceView, type WorkspaceStatus, type WorkspaceView, PLACE_INSTALL, absentRoad } from "@wsp/protocol";
import { makeApi, ProtocolClient, type Api, type InstallStage, type SshLogin } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AddComputerSheet } from "../src/settings/AddComputerSheet.js";
import { Computers } from "../src/settings/Computers.js";
import { ADD_COMPUTER_WORDS, AGENTS_WORDS, SETTINGS_WORDS, WHERE_WORDS } from "../src/settings/format.js";
import { SettingsPage } from "../src/settings/SettingsPage.js";
import { SettingsRow } from "../src/sidebar/SettingsRow.js";
import { ScriptedSocket, type Frame } from "./scripted-socket.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

/** What the host says about its own setup: which keys it holds, which is the rule a cloud row stands under, and
 * the agents on this computer, which are this computer's own block. */
const setupOf = (over: Partial<InitSetup> = {}): InitSetup =>
  ({ keys: { solari: false }, home: "/Users/dev", agents: [], pricing: null, job: null, ...over }) as InitSetup;
/** The record the page reads once and hands this section: a host holding no cloud key and reporting no agent. */
const SETUP = setupOf();

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

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 210 * 1024 ** 3 };
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

/** Only what these two draw asks the host for anything; the rest of the Api is never reached here. */
function fakeApi(over: Partial<Api> = {}): { api: Api; push(event: EventUnion): void; issued: number } {
  const listeners: ((e: EventUnion) => void)[] = [];
  const state = { issued: 0 };
  const api = {
    subscribe: (fn: (e: EventUnion) => void) => {
      listeners.push(fn);
      return () => {};
    },
    ...over,
  } as unknown as Api;
  return {
    api,
    push: event => {
      for (const fn of listeners) fn(event);
    },
    get issued() {
      return state.issued;
    },
  };
}

beforeEach(() => {
  useStore.setState({ api: null, places: [], projects: [], landings: {}, workspaces: [], statuses: {}, sessions: {}, addComputerOpen: false, settingsOpen: false, preferences: { ...DEFAULT_PREFERENCES, labs: false } });
});

/** The client a test built the app's own api from. Closed here however that test ended: one left behind redials
 * for the rest of the file and answers frames a later test never asked for. */
let live: ProtocolClient | undefined;

afterEach(() => {
  live?.close();
  live = undefined;
  cleanup();
});

const ascii: PlaceView = { id: "box", kind: "provider", name: "box", default: false, shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.018, takesForks: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true };

const AT = "2026-09-12T11:00:00.000Z";

/** The reads the section makes after it is drawn, let through: the keys the host holds, the money and the image. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
  });
};

/** The workspaces the app holds, as the sidebar lists them: this computer's own, and the forks, whether they stand
 * at a provider or on a computer somebody joined. */
const workspace = (id: string, kind: WorkspaceView["kind"], machineId: string): WorkspaceView => ({ id, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, name: id, kind, machineId, phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z" });
const mine = workspace("ws_a", "local", "local");
const onLaptop: WorkspaceView = { ...workspace("ws_b", "cloud", "ctr_9f"), place: "p_1" };
const fork = (id: string): WorkspaceView => workspace(id, "cloud", `fk_${id}`);
/** A fork stamped with the cloud it was made at, which is what stands its row on that cloud's row. */
const atSolari = (id: string): WorkspaceView => ({ ...fork(id), provider: "solari" });

/** The four facts of a row; a row that can be acted on carries a fifth cell for its menu. */
const cells = (row: HTMLElement): string[] => within(row).getAllByRole("cell").slice(0, 4).map(c => c.textContent ?? "");

/** What the Workspaces cell says, as its two lines: the count a person reads and, under it, the clause about the
 * month. Read apart because they are two lines in the cell, which is what keeps the money from being cut. */
const workspacesCell = (row: HTMLElement): { count: string; note: string | undefined } => {
  const cell = within(row).getAllByRole("cell")[3]!;
  const note = cell.querySelector("[data-k='workspaces-note']");
  return { count: (cell.textContent ?? "").replace(note?.textContent ?? "\u0000", ""), ...(note === null ? { note: undefined } : { note: note.textContent ?? "" }) };
};

describe("the Computers table", () => {
  it("lists this computer first with its size and disk, and says how long a computer that is not answering has been away, once", () => {
    useStore.setState({ places: [here, laptop], workspaces: [mine, onLaptop] });
    render(<Computers setup={SETUP} now={NOW} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(cells(rows[0]!)[0]).toContain("This Mac");
    expect(cells(rows[0]!)[0]).not.toContain("zingzy-mbp");
    expect(cells(rows[0]!)[0]).toContain("default");
    expect(cells(rows[0]!).slice(1)).toEqual(["8 cores · 16 GB".replace(/ /g, " "), "210 GB", "1"]);
    // The table's slot holds the one word for the silence, in the words every other surface says it in; how long
    // it has been away is on the row's title and in its detail.
    expect(cells(rows[1]!)[0]).toContain("no answer");
    expect(cells(rows[1]!)[0]).not.toContain("offline");
    expect(cells(rows[1]!)[0]).not.toContain("2 h");
    expect(cells(rows[1]!).slice(1)).toEqual(["4 cores · 8 GB".replace(/ /g, " "), "91 GB", "1"]);
    // The whole sentence rides the row's title, so the table and the sidebar row say one thing.
    expect(rows[1]!.getAttribute("title")).toBe("old-macbook is not answering; it connects on its own when it is on");
  });

  it("says this computer's own daemon is not running in the slot, rather than listing this Mac as perfectly fine", () => {
    // This Mac holds no link of its own, so the table read it as present and said nothing while every pane on it
    // said unreachable: the app was telling a person two different things in two rooms.
    const silent = { id: mine.id, phase: "running", machineState: "running", reach: { state: "unreachable" }, machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, kind: "local", size: { cpu: 8, memMb: 16384 }, name: mine.name, golden: "", createdAt: mine.createdAt } as unknown as WorkspaceStatus;
    useStore.setState({ places: [here], workspaces: [mine], statuses: { [mine.id]: silent } });
    render(<Computers setup={SETUP} now={NOW} />);
    const row = screen.getAllByRole("row")[1]!;
    expect(row.querySelector("[data-k='place-state']")?.textContent).toBe("no daemon");
    expect(row.getAttribute("title")).toContain("this Mac's daemon is not running");
    expect(row.textContent).not.toContain("Unreachable");
  });

  it("counts the workspaces standing on each row off the list the sidebar shows, not off the row", () => {
    // This Mac's own workspace and the forks at a provider are recorded on no row at all, so a cell read off the
    // row said 0 under Workspaces while the sidebar showed three.
    useStore.setState({ places: [here, ascii], workspaces: [mine, fork("ws_x"), fork("ws_y")] });
    render(<Computers setup={SETUP} now={NOW} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(cells(rows[0]!)[3]).toBe("1");
    expect(cells(rows[1]!)[3]).toBe("2");
  });

  it("keeps the default mark beside the name and the state word in the slot, so a default that is away says both", () => {
    // Read by the id the wire keys this computer by, never by the row's place in the list: a list that did not
    // hold this computer called its first row This Mac.
    useStore.setState({ places: [{ ...laptop, default: true }] });
    render(<Computers setup={SETUP} now={NOW} />);
    const row = screen.getAllByRole("row")[1]!;
    expect(row.querySelector("[data-k='place-default']")?.textContent).toBe("default");
    expect(row.querySelector("[data-k='place-state']")?.textContent).toBe("no answer");
    expect(row.getAttribute("title")).toBe("old-macbook is not answering; it connects on its own when it is on default");
  });

  it("gives the name column what the fact columns leave and cuts the name there, so the table never scrolls sideways", () => {
    useStore.setState({ places: [here, laptop] });
    render(<Computers setup={SETUP} now={NOW} />);
    const head = screen.getAllByRole("columnheader");
    const classes = (el: Element): string[] => el.className.split(" ");
    expect(classes(head[0]!)).toEqual(expect.arrayContaining(["w-full", "max-w-0"]));
    // The three fact columns stand at their content's width and never wrap.
    for (const at of [1, 2, 3]) expect(classes(head[at]!)).not.toEqual(expect.arrayContaining(["w-full"]));
    const row = screen.getAllByRole("row")[1]!;
    const cell = within(row).getAllByRole("cell")[0]!;
    expect(classes(cell)).toEqual(expect.arrayContaining(["w-full", "max-w-0"]));
    expect(classes(cell.querySelector("span > span")!)).toContain("truncate");
    for (const at of [1, 2, 3]) expect(classes(within(row).getAllByRole("cell")[at]!)).toContain("whitespace-nowrap");
  });

  it("stands a bar in each cell a computer has not reported yet, so nothing moves when it does", () => {
    useStore.setState({ places: [{ id: "p_2", kind: "computer", name: "attic", default: false, present: true }] });
    render(<Computers setup={SETUP} now={NOW} />);
    const row = screen.getAllByRole("row")[1]!;
    expect(cells(row).slice(1).every(cell => cell === "")).toBe(true);
  });

  it("opens the sheet from the one button under the table, and offers no cloud to connect", () => {
    useStore.setState({ places: [here] });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: PLACES_WORDS.addComputer }));
    expect(useStore.getState().addComputerOpen).toBe(true);
    expect(screen.queryByRole("button", { name: PLACES_WORDS.connectProvider })).toBeNull();
    expect(document.querySelector("[data-k='connect-provider']")).toBeNull();
  });

  it("is titled Computers, and a fresh state is this computer's row alone with no cloud row and no price", async () => {
    // A fresh state listed every cloud this wsp can hold, each with an hourly rate, under a heading about where
    // agents run: a table of what a person had not bought, which read as a bill.
    useStore.setState({ api: fakeApi().api, places: [here, ascii, solari] });
    render(
      <>
        <h2>{PLACES_WORDS.section}</h2>
        <Computers setup={SETUP} now={NOW} />
      </>,
    );
    await settle();
    expect(screen.getByText("Computers")).toBeTruthy();
    expect(screen.queryByText("Where agents run")).toBeNull();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(cells(rows[0]!)[0]).toContain("This Mac");
    expect(document.body.textContent).not.toContain("ASCII");
    expect(document.body.textContent).not.toContain("Solari");
    expect(document.body.textContent).not.toContain("$");
  });

  it("draws a cloud row once this host holds its key, named as a person reads it, with what it took this month in the Workspaces cell", async () => {
    const api = fakeApi({ spend: async () => [{ place: "solari", monthUsd: 1.23, rateUsdPerHour: 0.11 }] } as Partial<Api>).api;
    useStore.setState({ api, places: [here, ascii, solari], workspaces: [atSolari("ws_s")] });
    render(<Computers setup={setupOf({ keys: { solari: true } })} now={NOW} />);
    await settle();
    const names = screen.getAllByRole("row").slice(1).map(row => cells(row)[0] ?? "");
    // The one whose key is held, and the one a workspace stands on; the third cloud is not on the table at all.
    expect(names).toHaveLength(2);
    expect(names[1]).toContain("Solari");
    expect(names.join(" ")).not.toContain("ASCII");
    const row = document.querySelector("[data-place-row='solari']")!;
    // What that account has taken this month rides the Workspaces cell, in the protocol's own clause, on its own
    // line under the count: a cell as wide as one line of both would take the width the state word reads in.
    expect(workspacesCell(row as HTMLElement)).toEqual({ count: "1", note: "$1.23 this month" });
  });

  it("draws a cloud row for an account a workspace stands on even with no key held, so a machine is never orphaned", async () => {
    useStore.setState({ api: fakeApi().api, places: [here, solari], workspaces: [atSolari("ws_s")] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    expect(document.querySelector("[data-place-row='solari']")).toBeTruthy();
  });

  it("reads the state slot in one order: the computer that is not answering, then the recipe on it, then the daemon behind", async () => {
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
    const state = (place: PlaceView): string | undefined => document.querySelector(`[data-place-row='${place.id}'] [data-k='place-state']`)?.textContent ?? undefined;
    const busy = { ...box, id: "p_busy", name: "busy", provision: running };
    const broke = { ...box, id: "p_broke", name: "broke", provision: failed };
    // A computer that is not answering says that first, whatever the recipe on it was doing: nothing can be put on
    // a computer that is off.
    const gone = { ...laptop, id: "p_gone", name: "gone", provision: running };
    const behind = { ...box, id: "p_old", name: "old", daemonVersion: 1 };
    useStore.setState({ api: fakeApi().api, places: [here, busy, broke, gone, behind] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    expect(state(busy)).toBe("setting up 3/7: uv");
    expect(state(busy)).toBe(provisionWord(running));
    // The failed rows by name, which is what a person can act on.
    expect(state(broke)).toBe("2 of 7 failed: GitHub CLI, uv");
    expect(state(gone)).toBe("no answer");
    expect(state(behind)).toBe(placeDaemonBehind(behind));
  });

  it("gives the state word its own line under the name, in a slot read off that line, so a long word is not cut beside the fact columns", async () => {
    const running: PlaceProvision = { state: "running", addId: "a_1", recipeAt: AT, startedAt: AT, rows: [], at: { label: "uv", index: 3, of: 7 } };
    useStore.setState({ api: fakeApi().api, places: [here, { ...box, provision: running }] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    for (const id of ["here", "p_2"]) {
      const slot = document.querySelector(`[data-place-row='${id}'] [data-k='place-state']`)!;
      // Its own line under the name, never beside it, in a slot as many of that line high as the window's width
      // takes: a word this screen exists for read as `7 tools, 1 file, 1 MCP serv…` beside three fact columns,
      // with hover as the only road to the rest.
      // line-clamp is what makes the slot a block of its own, so nothing here asks for `block` beside it.
      expect(slot.className).toContain("min-h-[3lh]");
      expect(slot.className).toContain("line-clamp-3");
      expect(slot.className).toContain("sm:min-h-[2lh]");
      // The cell is nowrap for its fact columns, so the slot says its own wrap: a clamp that cannot wrap is a cut.
      expect(slot.className).toContain("whitespace-normal");
      expect(slot.previousElementSibling?.textContent).toContain(id === "here" ? "This Mac" : "hetzner");
    }
  });

  it("holds the three fact columns to their own widths, so no header moves between a table of one computer and a table of five", async () => {
    const widths = (): (string | null)[] => screen.getAllByRole("columnheader").map(head => head.className.match(/min-w-\[\d+px\]/)?.[0] ?? null);
    useStore.setState({ api: fakeApi().api, places: [here] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    const alone = widths();
    expect(alone.slice(1, 4)).toEqual(["min-w-[132px]", "min-w-[76px]", "min-w-[112px]"]);
    cleanup();
    useStore.setState({ api: fakeApi().api, places: [here, box, laptop, solari], workspaces: [mine, atSolari("ws_s")] });
    render(<Computers setup={setupOf({ keys: { solari: true } })} now={NOW} />);
    await settle();
    expect(widths()).toEqual(alone);
  });

  it("stands a hairline where a fact is not a cloud account's to have, never a blank beside loaded rows", async () => {
    useStore.setState({ api: fakeApi().api, places: [here, solari] });
    render(<Computers setup={setupOf({ keys: { solari: true } })} now={NOW} />);
    await settle();
    const row = document.querySelector("[data-place-row='solari']")!;
    const cellsOf = within(row as HTMLElement).getAllByRole("cell");
    for (const at of [1, 2]) {
      expect(cellsOf[at]!.querySelector("[data-k='no-fact']")).toBeTruthy();
      // Why, on the one row it is about, rather than a word in every cell or a dash that would read as zero.
      expect(cellsOf[at]!.querySelector("[data-k='no-fact']")?.getAttribute("title")).toBe(WHERE_WORDS.noFactOfACloud);
    }
    // A computer that reported its own facts says them, and one that has not reported yet still stands a bar.
    expect(cells(document.querySelector("[data-place-row='here']") as HTMLElement)[1]).toBe(fmtSize(here.shape!, "cores"));
  });
});

describe("what the places cost this month", () => {
  const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.11, takesForks: true };
  const atProvider = (id: string, provider: string): WorkspaceView => ({ ...workspace(id, "cloud", `fk_${id}`), provider });
  /** One tick off the runtime's meter, which is what sends the section back for the month again. */
  const COST_TICK = { type: "workspace.cost", workspaceId: "ws_x", phase: "running", rateUsdPerHour: 0.16, awakeMs: 60_000, accruedUsd: 0.41, at: "2026-09-12T12:00:00.000Z", seq: 1 } as EventUnion;

  /** A host that answers the month read, and says how many times it was asked. */
  const withSpend = (rows: PlaceSpend[]): { api: Api; asks: () => number; push(event: EventUnion): void } => {
    const state = { asks: 0 };
    const fake = fakeApi({
      spend: async () => {
        state.asks += 1;
        return rows;
      },
    });
    return { api: fake.api, asks: () => state.asks, push: fake.push };
  };

  it("puts what a provider took this month in its Workspaces cell, and leaves a computer of the person's own alone", async () => {
    const { api } = withSpend([{ place: "box", monthUsd: 0.41, rateUsdPerHour: 0.16 }]);
    useStore.setState({ api, places: [here, laptop, ascii], workspaces: [mine, onLaptop, fork("ws_x"), fork("ws_y")] });
    render(<Computers setup={SETUP} now={NOW} />);
    const rows = () => screen.getAllByRole("row").slice(1);
    await waitFor(() => expect(workspacesCell(rows()[2]!)).toEqual({ count: "2", note: "$0.41 this month" }));
    expect(cells(rows()[0]!)[3]).toBe("1");
    expect(cells(rows()[1]!)[3]).toBe("1");
  });

  it("gives each provider its own total, off the provider each fork was stamped with", async () => {
    const { api } = withSpend([
      { place: "box", monthUsd: 0.41, rateUsdPerHour: 0.018 },
      { place: "solari", monthUsd: 4.12, rateUsdPerHour: 0.16 },
    ]);
    useStore.setState({ api, places: [here, ascii, solari], workspaces: [atProvider("ws_x", "box"), atProvider("ws_y", "solari"), atProvider("ws_z", "solari")] });
    render(<Computers setup={SETUP} now={NOW} />);
    await waitFor(() => expect(workspacesCell(screen.getAllByRole("row")[2]!)).toEqual({ count: "1", note: "$0.41 this month" }));
    expect(workspacesCell(screen.getAllByRole("row")[3]!)).toEqual({ count: "2", note: "$4.12 this month" });
    // The foot adds up every provider on the list and says how many that is.
    expect(document.querySelector("[data-k='places-spend']")?.textContent).toBe("$4.53 this month across 2 providers");
  });

  it("says the month, the burn now and how many workspaces that is in the row's own detail", async () => {
    const { api } = withSpend([{ place: "solari", monthUsd: 4.12, rateUsdPerHour: 0.16 }]);
    useStore.setState({ api, places: [here, solari], workspaces: [atProvider("ws_y", "solari"), atProvider("ws_z", "solari")] });
    render(<Computers setup={SETUP} now={NOW} />);
    await waitFor(() => expect(document.querySelector("[data-place-row='solari']")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-place-row='solari']")!);
    expect(document.querySelector("[data-k='place-detail'] [data-k='spend']")?.textContent).toBe("Spend$4.12 this month · $0.16/hr now across 2 workspaces");
  });

  it("leaves a computer of the person's own without a Spend row, and says nothing at the foot with no provider on the list", async () => {
    const { api } = withSpend([{ place: "p_1", monthUsd: 0.41, rateUsdPerHour: 0 }]);
    useStore.setState({ api, places: [here, laptop], workspaces: [mine, onLaptop] });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    await waitFor(() => expect(document.querySelector("[data-k='place-detail']")).toBeTruthy());
    expect(document.querySelector("[data-k='place-detail'] [data-k='spend']")).toBeNull();
    expect(document.querySelector("[data-k='places-spend']")).toBeNull();
  });

  it("follows the meter: every cost tick reads the month again, and a read in flight is not asked twice", async () => {
    const { api, asks, push } = withSpend([{ place: "box", monthUsd: 0.41, rateUsdPerHour: 0.16 }]);
    useStore.setState({ api, places: [here, ascii], workspaces: [fork("ws_x")] });
    render(<Computers setup={SETUP} now={NOW} />);
    await waitFor(() => expect(asks()).toBe(1));
    act(() => {
      push(COST_TICK);
      push(COST_TICK);
    });
    await waitFor(() => expect(asks()).toBe(2));
    act(() => push(COST_TICK));
    await waitFor(() => expect(asks()).toBe(3));
  });

  it("says no money at all on a window that may not read it, and asks that window once", async () => {
    let asks = 0;
    const fake = fakeApi({
      spend: async () => {
        asks += 1;
        return Promise.reject(new Error(PLACES_TICKET_REFUSAL));
      },
    });
    useStore.setState({ api: fake.api, places: [here, ascii], workspaces: [fork("ws_x")] });
    render(<Computers setup={SETUP} now={NOW} />);
    await waitFor(() => expect(cells(screen.getAllByRole("row")[2]!)[3]).toBe("1"));
    expect(document.querySelector("[data-k='places-spend']")).toBeNull();
    await waitFor(() => expect(asks).toBe(1));
    act(() => fake.push(COST_TICK));
    await waitFor(() => expect(asks).toBe(1));
  });

  it("asks again after a read that failed on the way, since a dropped request is not a refusal", async () => {
    let asks = 0;
    const fake = fakeApi({
      spend: async () => {
        asks += 1;
        return asks === 1 ? Promise.reject(new Error("disconnected")) : [{ place: "box", monthUsd: 0.41, rateUsdPerHour: 0.018 }];
      },
    });
    useStore.setState({ api: fake.api, places: [here, ascii], workspaces: [fork("ws_x")] });
    render(<Computers setup={SETUP} now={NOW} />);
    await waitFor(() => expect(asks).toBe(1));
    act(() => fake.push(COST_TICK));
    await waitFor(() => expect(workspacesCell(screen.getAllByRole("row")[2]!)).toEqual({ count: "1", note: "$0.41 this month" }));
  });

  it("leaves a provider that took nothing this month out of the foot's count", async () => {
    const solariRow: PlaceView = { ...ascii, id: "solari", name: "solari" };
    const { api } = withSpend([
      { place: "box", monthUsd: 0.41, rateUsdPerHour: 0.018 },
      // Metered, and asleep since last month: a row with a figure of zero is not a provider that charged.
      { place: "solari", monthUsd: 0, rateUsdPerHour: 0 },
    ]);
    useStore.setState({ api, places: [here, ascii, solariRow], workspaces: [atProvider("ws_x", "box"), atProvider("ws_y", "solari")] });
    render(<Computers setup={SETUP} now={NOW} />);
    await waitFor(() => expect(document.querySelector("[data-k='places-spend']")?.textContent).toBe("$0.41 this month across 1 provider"));
    // The row that took nothing still says so in its own cell; it is the count of who charged that leaves it out.
    expect(workspacesCell(screen.getAllByRole("row")[3]!)).toEqual({ count: "1", note: "$0.00 this month" });
  });

  it("leaves a provider nothing was metered on out of the foot's count, and a computer that runs Docker out of the money", async () => {
    const docker: PlaceView = { ...ascii, id: "docker", name: "docker" };
    const runsDocker: PlaceView = { ...here, engine: "docker" };
    const { api } = withSpend([
      { place: "here", monthUsd: 0, rateUsdPerHour: 0 },
      { place: "box", monthUsd: 0.41, rateUsdPerHour: 0.018 },
    ]);
    useStore.setState({ api, places: [runsDocker, ascii, docker], workspaces: [mine, atProvider("ws_x", "box")] });
    render(<Computers setup={SETUP} now={NOW} />);
    await waitFor(() => expect(document.querySelector("[data-k='places-spend']")?.textContent).toBe("$0.41 this month across 1 provider"));
    // This Mac runs Docker and still charges its owner nothing, so its cell says what may go there and no money.
    expect(cells(screen.getAllByRole("row")[1]!)[3]).toBe("1");
  });
});

describe("a computer's own row", () => {
  const withWorkspaces = (): void => {
    useStore.setState({
      places: [here, laptop],
      workspaces: [{ id: "ws_b", name: "spoo-fix", kind: "cloud", machineId: "ctr_9f", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, place: "p_1", phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z", home: "/home/dev" }] as never,
      sessions: { ws_b: [{ id: "s1" }, { id: "s2" }] } as never,
    });
  };

  it("opens its detail under it, this computer's own included, since the agents here are read there", () => {
    withWorkspaces();
    render(<Computers setup={SETUP} now={NOW} />);
    expect(document.querySelector("[data-k='place-detail']")).toBeNull();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    const detail = document.querySelector("[data-k='place-detail']")!;
    expect(detail.getAttribute("data-place")).toBe("p_1");
    expect(detail.textContent).toContain("Ubuntu 24.04");
    expect(detail.textContent).toContain("spoo-fix · Running · 2 threads");
    expect(document.querySelector("[data-place-row='p_1']")?.getAttribute("aria-expanded")).toBe("true");
    // This computer's own row opens too, and carries nothing that could be done to the computer the host runs on.
    fireEvent.click(document.querySelector("[data-place-row='here']")!);
    const own = document.querySelector("[data-k='place-detail']")!;
    expect(own.getAttribute("data-place")).toBe("here");
    expect(own.querySelector("[data-k='agents-block']")).toBeTruthy();
    for (const k of ["remove", "update", "rename", "dial", "address", "answered"]) expect(own.querySelector(`[data-k='${k}']`)).toBeNull();
  });

  it("says how a copy is made there and what it has for a network, off the row and off the landing's own flags", async () => {
    const project = { id: "pr_box", name: "spoo", computer: "p_1", source: { kind: "folder", path: "/root/spoo" }, path: "/root/spoo", createdAt: AT } as never;
    const mac = { id: "pr_here", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/dev/wsp" }, path: "/Users/dev/wsp", createdAt: AT } as never;
    useStore.setState({
      api: fakeApi().api,
      places: [here, { ...laptop, present: true, copies: "reflink" }],
      projects: [mac, project],
      landings: {
        pr_here: { name: "here", capabilities: { copies: true, ownNetwork: false } as never },
        pr_box: { place: "p_1", name: "old-macbook", capabilities: { copies: true, ownNetwork: true } as never },
      },
      workspaces: [],
      sessions: {},
    });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    // The word the computer itself reported, and the network word off the two flags a create there is answered
    // with: one home for both, so this row and a workspace row cannot say two things.
    expect(detailValue("copies")).toBe("reflink");
    expect(detailValue("ports")).toBe("own network");
    fireEvent.click(document.querySelector("[data-place-row='here']")!);
    expect(detailValue("ports")).toBe("shares this Mac's ports");
  });

  it("drops the two columns a phone does not hold and says them in the open row instead, so the name has its width back", async () => {
    useStore.setState({ api: fakeApi().api, places: [here, box], workspaces: [], sessions: {} });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    // One rule for both: the header and its cells carry the same narrow-width class, so a column cannot leave in
    // one row and stay in another.
    const heads = screen.getAllByRole("columnheader");
    expect(heads[1]!.className).toContain("hidden sm:table-cell");
    expect(heads[2]!.className).toContain("hidden sm:table-cell");
    for (const at of [0, 3]) expect(heads[at]!.className).not.toContain("hidden");
    const row = document.querySelector("[data-place-row='p_2']")!;
    const cellsOf = within(row as HTMLElement).getAllByRole("cell");
    expect(cellsOf[1]!.className).toContain("hidden sm:table-cell");
    expect(cellsOf[2]!.className).toContain("hidden sm:table-cell");
    fireEvent.click(row);
    // The same two facts in the detail, in the table's own words for them, drawn below 640 px alone.
    expect(detailValue("size")).toBe(fmtSize(box.shape!, "cores"));
    expect(detailValue("disk-free")).toBe(fmtBytes(box.diskFreeBytes!));
    for (const k of ["size", "disk-free"]) expect(document.querySelector(`[data-k='place-detail'] [data-k='${k}']`)?.className).toContain("sm:hidden");
  });

  it("says a computer that copies nothing does, rather than leaving the row blank", () => {
    useStore.setState({ api: fakeApi().api, places: [here, { ...laptop, present: true, takesForks: false }] });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    expect(detailValue("copies")).toBe(WHERE_WORDS.copiesNothing);
  });

  it("lists the agents on this computer by their own names, with the tools word and the one held action", async () => {
    const agents = [
      { id: "claude", name: "Claude Code", configured: true, takesTools: true },
      { id: "codex", name: "Codex", configured: false, takesTools: true },
      { id: "cursor", name: "Cursor", configured: false, takesTools: false },
    ];
    useStore.setState({ api: fakeApi().api, places: [here] });
    render(<Computers setup={setupOf({ agents })} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='here']")!);
    expect(agentRows()).toEqual([
      { agent: "claude", name: "Claude Code", state: AGENTS_WORDS.added, action: undefined },
      // The one action this computer's rows carry, held: handing an agent the wsp tools has no road from the app.
      { agent: "codex", name: "Codex", state: "", action: AGENTS_WORDS.add },
      { agent: "cursor", name: "Cursor", state: AGENTS_WORDS.noTools, action: undefined },
    ]);
    // No sign-in here: an agent on the computer the app runs on is signed in where it is installed.
    expect(document.querySelector("[data-k='agent-sign-in']")).toBeNull();
  });

  it("says so when a computer reported no agent at all, naming that computer", async () => {
    useStore.setState({ api: fakeApi().api, places: [here, { ...laptop, present: true, agents: [] }] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='here']")!);
    expect(document.querySelector("[data-k='no-agents']")?.textContent).toBe("No agents found on this Mac.");
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    expect(document.querySelector("[data-k='no-agents']")?.textContent).toBe("No agents found on old-macbook.");
  });

  it("lists a joined computer's agents by catalog name with what the recipe came to, the skills and servers beside them, and a held sign-in naming the line that runs one", async () => {
    const provision: PlaceProvision = {
      state: "done",
      addId: "a_1",
      recipeAt: AT,
      startedAt: AT,
      finishedAt: AT,
      rows: [
        { id: "agents/claude", label: "Claude Code", outcome: "installed" },
        { id: "agents/codex", label: "Codex", outcome: "failed", note: "npm exited 1" },
        { id: "tools/gh", label: "GitHub CLI", outcome: "present" },
        { id: "agents/files/skills", label: "code-review", outcome: "installed", kind: "file" },
        { id: "agents/mcp/linear", label: "linear", outcome: "installed", kind: "server" },
      ],
    };
    useStore.setState({ api: fakeApi().api, places: [here, { ...laptop, present: true, name: "spoo", provision }] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    // The catalog's own names, never the ids the wire carries, and the word for what the job came to for each.
    expect(agentRows()).toEqual([
      { agent: "claude", name: "Claude Code", state: "installed", action: AGENTS_WORDS.signIn },
      { agent: "codex", name: "Codex", state: "failed: npm exited 1", action: AGENTS_WORDS.signIn },
    ]);
    // The sign-in is held with the command line that runs one, built from this row's own two names.
    expect(document.querySelector("[data-agent='codex'] [data-k='agent-sign-in']")?.getAttribute("title")).toBe("Sign in from a terminal for now: wsp add spoo --sign-in codex");
    expect(document.querySelector("[data-agent='codex'] [data-k='agent-sign-in']")?.hasAttribute("data-held")).toBe(true);
    // What the recipe put there beside the agents: the person's own files in their agents' homes, and the servers
    // written into those configs. A tool row is not one of them; the row's own state slot counts those.
    expect([...document.querySelectorAll("[data-k='recipe-row']")].map(row => [row.getAttribute("data-kind"), row.firstElementChild?.textContent, row.querySelector("[data-k='recipe-state']")?.textContent])).toEqual([
      ["file", "code-review", "file · installed"],
      ["server", "linear", "MCP server · installed"],
    ]);
    expect(document.querySelector("[data-k='agents-block']")?.textContent).not.toContain("GitHub CLI");
  });

  it("reads found on a joined computer no recipe has run on, since that is all the computer said", async () => {
    useStore.setState({ api: fakeApi().api, places: [here, { ...laptop, present: true }] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    expect(agentRows().map(row => row.state)).toEqual([AGENTS_WORDS.found, AGENTS_WORDS.found]);
  });

  it("puts this wsp's daemon and the recipe on a computer from Update, and reads the job it answers with in the row's state slot", async () => {
    const asked: string[] = [];
    const provision: PlaceProvision = { state: "running", addId: "a_2", recipeAt: AT, startedAt: AT, rows: [], at: { label: "uv", index: 3, of: 7 } };
    const api = fakeApi({
      placesUpdate: async (placeId: string) => {
        asked.push(placeId);
        return { name: "old-macbook", provision };
      },
    } as unknown as Partial<Api>).api;
    useStore.setState({ api, places: [here, { ...laptop, present: true }] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    fireEvent.click(document.querySelector("[data-k='place-detail'] [data-k='update']")!);
    await waitFor(() => expect(asked).toEqual(["p_1"]));
    // The job the reply carried, on the row the word is read off.
    await waitFor(() => expect(document.querySelector("[data-place-row='p_1'] [data-k='place-state']")?.textContent).toBe("setting up 3/7: uv"));
    expect(useStore.getState().places.find(place => place.id === "p_1")?.provision).toEqual(provision);
  });

  it("draws no agents block on a cloud row, which reports no agent and would otherwise say it has none", async () => {
    useStore.setState({ api: fakeApi().api, places: [here, solari], workspaces: [], sessions: {} });
    render(<Computers setup={setupOf({ keys: { solari: true } })} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='solari']")!);
    const detail = document.querySelector("[data-k='place-detail']")!;
    expect(detail).toBeTruthy();
    // The agents at a cloud are in the image built there, so the host holds no list of them: the block goes with
    // the Address and Answered rows rather than stating a fact nobody here has.
    expect(detail.querySelector("[data-k='agents-block']")).toBeNull();
    expect(detail.textContent).not.toContain("No agents found");
    // The rows the host does carry still stand, so the guard took the block and nothing beside it.
    expect(detailValue("workspaces")).toBe(WHERE_WORDS.none);
  });

  it("says one line per workspace in the detail, so the third is not cut out of a sentence", async () => {
    const on = (id: string, name: string): WorkspaceView => ({ ...workspace(id, "cloud", `ctr_${id}`), name, place: "p_1" });
    useStore.setState({
      api: fakeApi().api,
      places: [here, laptop],
      workspaces: [on("ws_1", "spoo-fix"), on("ws_2", "webhook retries"), on("ws_3", "pricing table")],
      sessions: { ws_1: [{ id: "s1" }, { id: "s2" }] } as never,
    });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    const lines = [...document.querySelectorAll("[data-k='place-detail'] [data-k='workspaces'] span span")].map(line => line.textContent);
    expect(lines).toEqual(["spoo-fix · Running · 2 threads", "webhook retries · Running · 0 threads", "pricing table · Running · 0 threads"]);
  });

  it("stands every line of the agents block at the height of the button one of them carries", async () => {
    const provision: PlaceProvision = {
      state: "done",
      addId: "a_1",
      recipeAt: AT,
      startedAt: AT,
      rows: [
        { id: "agents/claude", label: "Claude Code", outcome: "installed" },
        { id: "agents/files/skills", label: "code-review", outcome: "installed", kind: "file" },
      ],
    };
    useStore.setState({ api: fakeApi().api, places: [here, { ...laptop, present: true, provision }] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    // A line carrying a word, a line carrying a button and a line carrying neither all stand the one height: the
    // block read as three lists when the button's line was seven pixels taller than its neighbours.
    const lines = [...document.querySelectorAll("[data-k='place-detail'] [data-k='agent'], [data-k='place-detail'] [data-k='recipe-row']")];
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(line.className).toContain("min-h-7");
      expect(line.className).toContain("sm:min-h-6");
      expect(line.className).toContain("items-center");
    }
  });

  it("holds Update at its own word while it runs rather than swapping the label, which moved the button", async () => {
    let answer: (() => void) | undefined;
    const api = fakeApi({ placesUpdate: () => new Promise(ok => (answer = () => ok({ name: "old-macbook" }))) } as unknown as Partial<Api>).api;
    useStore.setState({ api, places: [here, { ...laptop, present: true }] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    const update = (): Element => document.querySelector("[data-k='place-detail'] [data-k='update']")!;
    expect(update().textContent).toBe(WHERE_WORDS.update);
    fireEvent.click(update());
    await waitFor(() => expect(update().hasAttribute("disabled")).toBe(true));
    // One word in both states: the reason it is dimmed is that it is running, which the press itself said.
    expect(update().textContent).toBe(WHERE_WORDS.update);
    await act(async () => {
      answer?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(update().hasAttribute("disabled")).toBe(false));
    expect(update().textContent).toBe(WHERE_WORDS.update);
  });

  it("holds Update on a wsp whose client cannot ask for one", async () => {
    useStore.setState({ api: fakeApi().api, places: [here, { ...laptop, present: true }] });
    render(<Computers setup={SETUP} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    const update = document.querySelector("[data-k='place-detail'] [data-k='update']")!;
    expect(update.hasAttribute("disabled")).toBe(true);
    expect(update.getAttribute("title")).toBe(WHERE_WORDS.notYet);
  });

  /** A client that can dial, so a button drawn beside a row is held for the row's own reason and never the app's. */
  const dialling = (): { api: Api } =>
    fakeApi({ dialPlace: async (placeId: string) => ({ dialled: { at: "2026-09-12T12:00:00.000Z", answered: true, roundTripMs: 12 }, line: "vps answered in 12 ms.", place: { ...laptop, id: placeId } }) } as Partial<Api>);

  /** One row of the open detail, its value alone: the row's own element holds the label first. */
  const detailValue = (k: string): string | undefined => document.querySelector(`[data-k='place-detail'] [data-k='${k}']`)?.lastElementChild?.textContent ?? undefined;

  /** Every line of the open row's agents block: which agent it is, the name a person reads, the word for what
   * stands there and the one action beside it. */
  const agentRows = (): { agent: string | null; name: string | undefined; state: string | undefined; action: string | undefined }[] =>
    [...document.querySelectorAll("[data-k='agents-block'] [data-k='agent']")].map(row => ({
      agent: row.getAttribute("data-agent"),
      name: row.firstElementChild?.textContent ?? undefined,
      state: row.querySelector("[data-k='agent-state']")?.textContent ?? undefined,
      action: row.querySelector("[data-k='agent-add'], [data-k='agent-sign-in']")?.textContent ?? undefined,
    }));

  it("names the login the host dials and how long the last dial took, so a row says which machine it is", () => {
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: true, roundTripMs: 14 } };
    useStore.setState({ places: [here, vps], workspaces: [], sessions: {} });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_3']")!);
    const detail = document.querySelector("[data-k='place-detail']")!;
    expect(detailValue("address")).toBe("root@65.21.4.12 · ssh");
    // The spec's `Answered 3 s ago · 14 ms`: when it last spoke and how long the last frame took. The span is the
    // road reading's own, so this row and the pane's sentence cannot date one silence differently.
    expect(detailValue("answered")).toBe(`${absentRoad({ name: "vps", awayMs: NOW - Date.parse(laptop.lastSeenAt!) }).answered} · 14 ms`);
    // And what it is, marked as last known, the way the pane's OS row is: a person who cannot tell which of two
    // screens is stale is what this ticket was filed for.
    expect(detailValue("system")).toBe("Ubuntu 24.04 · last seen 2 h ago");
  });

  it("says nothing about reaching a cloud, which is a key and not a computer this host dials", async () => {
    useStore.setState({ api: fakeApi().api, places: [here, ascii], workspaces: [], sessions: {} });
    render(<Computers setup={setupOf({ keys: { box: true } })} now={NOW} />);
    await settle();
    fireEvent.click(document.querySelector("[data-place-row='box']")!);
    const detail = document.querySelector("[data-k='place-detail']")!;
    expect(detail).toBeTruthy();
    // A cloud's machines are at the other end of a key: there is no address to name, nothing that last answered,
    // no dial to report and no button to press.
    expect(detailValue("answered")).toBeUndefined();
    expect(detailValue("address")).toBeUndefined();
    expect(detail.querySelector("[data-k='dialled']")).toBeNull();
    expect(detail.querySelector("[data-k='dial']")).toBeNull();
    // The rows it does carry are still there, so the guard took the road reading and nothing beside it.
    expect(detailValue("workspaces")).toBe("none");
  });

  it("says a computer that never answered so, rather than leaving the row out", () => {
    const fresh: PlaceView = { ...laptop, id: "p_4", name: "vps", lastSeenAt: undefined };
    useStore.setState({ places: [here, fresh], workspaces: [], sessions: {} });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_4']")!);
    expect(detailValue("answered")).toBe("not since it joined");
  });

  it("reads a computer that is answering plain, with nothing marked as stale", () => {
    const live: PlaceView = { ...laptop, id: "p_5", name: "vps", present: true, lastSeenAt: "2026-09-12T11:59:00.000Z" };
    useStore.setState({ places: [here, live], workspaces: [], sessions: {} });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_5']")!);
    expect(detailValue("system")).toBe("Ubuntu 24.04");
  });

  it("keeps the last refusal under the rows and replaces it with what a press of Try now got", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said } };
    const line = "root@65.21.4.12 answered over ssh in 412 ms, so the computer is on; the agent on it is not dialling this host.";
    const fake = fakeApi({ dialPlace: async (placeId: string) => ({ dialled: { at: "2026-09-12T12:00:00.000Z", answered: true, roundTripMs: 412 }, line, place: { ...vps, id: placeId } }) } as Partial<Api>);
    useStore.setState({ api: fake.api, places: [here, vps], workspaces: [], sessions: {} });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_3']")!);
    expect(document.querySelector("[data-k='place-detail'] [data-k='dialled']")?.textContent).toBe(said);
    fireEvent.click(document.querySelector("[data-k='place-detail'] [data-k='dial']")!);
    await waitFor(() => expect(document.querySelector("[data-k='place-detail'] [data-k='dialled']")?.textContent).toBe(line));
  });

  it("computes the Remove sentence from what that computer holds", () => {
    withWorkspaces();
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    fireEvent.click(document.querySelector("[data-k='place-detail'] [data-k='remove']")!);
    expect(screen.getByText("Remove old-macbook?")).toBeTruthy();
    expect(screen.getByText("wsp and its workspace come off old-macbook, which is otherwise left as it is, and the copy of your image stays where it is. The workspace's record and 2 threads leave this Mac. It is offline; what is on it is swept the next time it connects.")).toBeTruthy();
  });

  it("hands a computer that is offline the one line to run on it by hand, and names what that line takes off", () => {
    withWorkspaces();
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    fireEvent.click(document.querySelector("[data-k='place-detail'] [data-k='remove']")!);
    expect(document.querySelector("[data-k='leave-line']")?.textContent).toBe(PLACES_WORDS.remove.leaveLine);
    expect(screen.getByText(PLACES_WORDS.remove.leaveTakes)).toBeTruthy();
  });

  it("gives a computer that is answering no line to run by hand: the host sweeps it over the link", () => {
    useStore.setState({ places: [here, { ...laptop, present: true }], workspaces: [], sessions: {} });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    fireEvent.click(document.querySelector("[data-k='place-detail'] [data-k='remove']")!);
    expect(screen.getByText("Remove old-macbook?")).toBeTruthy();
    expect(document.querySelector("[data-k='leave-line']")).toBeNull();
    expect(screen.queryByText(PLACES_WORDS.remove.leaveTakes)).toBeNull();
  });

  it("offers no dial where there is no road to dial over, and words the button for the road there is", () => {
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said: "ssh: Connection refused" } };
    const said = placeNoDialLine("old-macbook");
    const byCode: PlaceView = { ...laptop, road: { from: "192.168.1.34" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said } };
    useStore.setState({ api: dialling().api, places: [here, byCode, vps], workspaces: [], sessions: {} });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    // It joined by typing a code and is not answering: the sentence is the whole answer, and a button whose only
    // reply is that same sentence is not drawn beside it.
    expect(document.querySelector("[data-k='place-detail'] [data-k='dialled']")?.textContent).toBe(said);
    expect(document.querySelector("[data-k='place-detail'] [data-k='dial']")).toBeNull();
    // A box wsp logs in to has a road, and the button says which one it would take.
    fireEvent.click(document.querySelector("[data-place-row='p_3']")!);
    expect(document.querySelector("[data-k='place-detail'] [data-k='dial']")?.textContent).toBe("Try over ssh");
  });

  it("dials a computer that is holding its link over the link, and says so on the button", () => {
    useStore.setState({ api: dialling().api, places: [here, { ...laptop, present: true }], workspaces: [], sessions: {} });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    expect(document.querySelector("[data-k='place-detail'] [data-k='dial']")?.textContent).toBe("Try now");
  });

  it("says the same thing about the copy of the image as the sheet that added the computer said", () => {
    const holding: PlaceView = { ...laptop, engine: "docker" };
    useStore.setState({ places: [here, holding], workspaces: [], sessions: {} });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    fireEvent.click(document.querySelector("[data-k='place-detail'] [data-k='remove']")!);
    // Both sentences of the dialog, against the note the Add sheet shows before any of this: the copy stays, and
    // neither screen says the other one takes it off.
    const dialog = document.querySelector("[data-remove-place-dialog]")!;
    expect(dialog.textContent).toContain(imageCopyStaysLine());
    expect(PLACES_WORDS.remove.leaveTakes).toContain(imageCopyStaysLine());
    expect(PLACE_INSTALL.imageCopy("4.2 GB")).toContain(imageCopyStaysLine());
    expect(dialog.textContent).not.toContain("your image come off");
  });

  it("says nothing of a record leaving for a computer that holds none, and takes it out on the host's own road", async () => {
    const removed: string[] = [];
    useStore.setState({ places: [here, laptop], workspaces: [], sessions: {}, api: { subscribe: () => () => {}, removePlace: async (id: string) => (removed.push(id), { removed: true, swept: [] }) } as unknown as Api });
    render(<Computers setup={SETUP} now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    fireEvent.click(document.querySelector("[data-k='place-detail'] [data-k='remove']")!);
    expect(screen.getByText("wsp comes off old-macbook, which is otherwise left as it is, and the copy of your image stays where it is. It is offline; what is on it is swept the next time it connects.")).toBeTruthy();
    fireEvent.click(document.querySelector("[data-k='remove-confirm']")!);
    await waitFor(() => expect(removed).toEqual(["p_1"]));
  });
});

describe("the Add a computer sheet", () => {
  const openSheet = async (over: Partial<Api> = {}) => {
    const fake = fakeApi(over);
    useStore.setState({ api: fake.api, places: [here] });
    render(<AddComputerSheet onClose={() => {}} now={() => NOW} />);
    await waitFor(() => expect(document.querySelector("[data-k='login-field']")).toBeTruthy());
    return fake;
  };

  it("asks one thing: an ssh login, focused, with no second road, no code and no address to type anywhere", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    const field = document.querySelector<HTMLInputElement>("#add-computer-login")!;
    expect(field.getAttribute("placeholder")).toBe("root@host");
    expect(document.querySelector("[data-k='login-field'] label")?.textContent).toBe(ADD_COMPUTER_WORDS.login);
    // The hand lands in the field: the sheet is opened to type a login and nothing else.
    expect(document.activeElement).toBe(field);
    // One field, and one road to a computer: no port, no pick of roads, no code and no address for somebody to
    // type on the other computer, and nothing about a box to buy.
    expect(document.querySelectorAll("[data-k='add-computer'] input")).toHaveLength(1);
    expect(document.querySelector("[data-k='port-field']")).toBeNull();
    expect(document.querySelector("[data-slot='segmented-control']")).toBeNull();
    expect(document.querySelector("[data-k='copy-code']")).toBeNull();
    expect(document.querySelector("[data-k='copy-address']")).toBeNull();
    expect(document.querySelector("[data-k='no-app']")).toBeNull();
    for (const said of [PLACES_WORDS.sheet.code, PLACES_WORDS.sheet.address, PLACES_WORDS.sheet.appRoad, "Get a box"]) {
      expect(document.body.textContent).not.toContain(said);
    }
  });

  it("says what a computer you own runs and what a closed lid does to the work already on it", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    const said = document.querySelector("[data-k='description']")?.textContent ?? "";
    expect(said).toBe(`${PLACES_WORDS.sheet.description} ${PLACES_WORDS.sheet.whileAsleep}`);
    // The noun on this sheet is the workspace, which is what a computer you own is added to run.
    expect(said).toContain("runs workspaces for your wsp");
    expect(said).toContain(PLACE_CONNECTS);
    // One description, and the only one the popup is described by.
    expect(document.querySelectorAll("[data-slot='sheet-description']").length).toBe(1);
  });

  it("stands at the top right, 448 px wide, as tall as what it holds and capped at the window less its inset", async () => {
    await openSheet();
    const popup = document.querySelector("[data-k='add-computer']")!;
    // self-start is what stops the popup stretching to the window's height; max-h-full is the cap it grows to.
    expect(popup.className.split(" ")).toEqual(expect.arrayContaining(["self-start", "max-h-full", "max-w-md", "flex-col"]));
    // The 16 px inset comes from the viewport's own padding, which is also what makes the cap the window less 32 px.
    expect(popup.closest("[data-slot='sheet-viewport']")?.className.split(" ")).toEqual(expect.arrayContaining(["sm:p-4"]));
    // The body scrolls inside that cap, and the footer sits directly under it with no spacer between.
    const panel = popup.querySelector("[data-slot='sheet-panel']")!;
    const scroller = panel.closest("[data-slot='scroll-area-viewport']")!.parentElement!;
    expect(scroller.nextElementSibling).toBe(popup.querySelector("[data-slot='sheet-footer']"));
  });

  it("holds Add until a login is typed, drawn as the outline with its reason in the field's own slot", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    const add = (): Element => document.querySelector("[data-k='ssh-add']")!;
    expect(add().hasAttribute("disabled")).toBe(true);
    expect(add().hasAttribute("data-held")).toBe(true);
    expect(document.querySelector("[data-k='ssh-refusal']")?.textContent).toBe(ADD_COMPUTER_WORDS.loginFirst);
    // Nothing hovers in a driven browser, so no reason rides a tooltip.
    expect(document.querySelector("[data-slot='tooltip-trigger']")).toBeNull();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    expect(add().hasAttribute("disabled")).toBe(false);
    expect(add().hasAttribute("data-held")).toBe(false);
    expect(document.querySelector("[data-k='ssh-refusal']")?.textContent).toBe("");
  });

  it("holds Add on a wsp whose host cannot log in over ssh at all", async () => {
    await openSheet();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("data-held")).toBe(true);
    expect(document.querySelector("[data-k='ssh-refusal']")?.textContent).toBe(ADD_COMPUTER_WORDS.noRoad);
  });

  /** The lines of the plan, as they read at this moment: the words with the fact slot after them, and the state
   * each line is in. */
  const plan = (): [string | null, string | null][] => [...document.querySelectorAll("[data-k='plan'] [data-k='line']")].map(l => [l.textContent, l.getAttribute("data-state")]);
  const WAITING: [string, string][] = [
    [placeAddSheetWord("connect", "running"), "waiting"],
    [placeAddSheetWord("host-key", "running"), "waiting"],
    [`${placeAddSheetWord("wsp", "running")}${PLACE_INSTALL.weight}`, "waiting"],
    [placeAddSheetWord("service", "running"), "waiting"],
    [placeAddSheetWord("join", "running"), "waiting"],
    // The recipe's own step, last: the agents and tools go on once the computer is a place at all.
    [placeAddSheetWord("provision", "running"), "waiting"],
  ];

  it("stands the plan under the field before Add is pressed, in the sheet's own words with the weight in its slot", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    expect(plan()).toEqual(WAITING);
    const lines = plan().map(([word]) => word ?? "");
    // The one line that is about this computer rather than the box, in the file's own name.
    expect(lines[1]).toBe("keeps the box's host key in ~/.ssh/known_hosts here");
    expect(lines[2]).toBe(`installing wsp under ~/.wsp${PLACE_INSTALL.weight}`);
    expect(lines[3]).toBe("starting the agent as a user service");
    // The one word Lena could not read on the way out is on neither screen.
    expect(document.body.textContent).not.toContain("shim");
    expect(document.body.textContent).not.toContain("systemd");
  });

  it("fills the same lines in as the installer reports them, and the ones it has not reached stand waiting", async () => {
    let report: ((stage: InstallStage) => void) | undefined;
    await openSheet({ addComputerOverSsh: (_login: SshLogin, onStage: (stage: InstallStage) => void) => new Promise<PlaceView>(() => (report = onStage)) } as unknown as Partial<Api>);
    const list = (): Element | null => document.querySelector("[data-k='plan']");
    const before = list();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(document.querySelector<HTMLInputElement>("#add-computer-login")!.disabled).toBe(true));
    // The press leaves every part where it was: the same list, and the field still holding what was typed in it.
    expect(list()).toBe(before);
    expect(document.querySelector<HTMLInputElement>("#add-computer-login")!.value).toBe("root@65.21.4.12");
    expect(plan()).toEqual(WAITING);
    act(() => {
      report?.({ step: "connect", word: "connected · Ubuntu 24.04", state: "done" });
      report?.({ step: "host-key", word: placeAddSheetWord("host-key", "done"), state: "done", fact: "ssh-ed25519 SHA256:abc" });
      report?.({ step: "wsp", word: "installing wsp 0.2.0", state: "running" });
    });
    expect(plan()).toEqual([
      ["connected · Ubuntu 24.04", "done"],
      // The key the dial kept is the step's own fact, so a person can check it against the box's own.
      [`${placeAddSheetWord("host-key", "done")}ssh-ed25519 SHA256:abc`, "done"],
      // The weight stands in the slot while the step runs: the installer reports no note of its own for it, and
      // what wsp takes on the box is what a person pressed Add without knowing.
      [`installing wsp 0.2.0${PLACE_INSTALL.weight}`, "running"],
      [placeAddSheetWord("service", "running"), "waiting"],
      [placeAddSheetWord("join", "running"), "waiting"],
      [placeAddSheetWord("provision", "running"), "waiting"],
    ]);
    // A step reported again is that line moving on, never a second line for the same step.
    act(() => report?.({ step: "wsp", word: "installing wsp 0.2.0", state: "done", fact: "9 s" }));
    expect(plan()[2]).toEqual(["installing wsp 0.2.09 s", "done"]);
    expect(plan()).toHaveLength(PlaceAddStep.options.length);
  });

  it("reads the box as joined once the installer answers with it, and says it runs workspaces", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(document.querySelector("[data-k='title']")?.textContent).toBe("hetzner joined"));
    // The joined screen says what that box is, and the lid line rides every road's sentence including this one.
    expect(document.querySelector("[data-k='description']")?.textContent).toBe(`${ADD_COMPUTER_WORDS.runsWorkspaces} ${PLACES_WORDS.sheet.whileAsleep}`);
    expect(document.querySelector("[data-k='joined-table']")?.textContent).toContain("38 GB");
  });

  it("runs the whole road on the client this app builds: Add sends places.add and the stages that ride it draw, ending on the line that says the box is in", async () => {
    ScriptedSocket.instances.length = 0;
    ScriptedSocket.reply = (f: Frame) => (f["op"] === "places.add" ? undefined : { id: f["id"], ok: true });
    const client = (live = new ProtocolClient({ url: "ws://test", token: "tok", WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket }));
    await client.connect();
    const sock = ScriptedSocket.instances[0]!;
    useStore.setState({ api: makeApi(client), places: [here] });
    render(<AddComputerSheet onClose={() => {}} now={() => NOW} />);
    await waitFor(() => expect(document.querySelector("[data-k='login-field']")).toBeTruthy());
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(document.querySelector("#add-computer-login")!, { key: "Enter" });

    await waitFor(() => expect(sock.frames("places.add").length).toBe(1));
    const asked = sock.frames("places.add")[0]!;
    // One field, so one thing is sent: the login, with no port beside it.
    expect(asked).toMatchObject({ address: "root@65.21.4.12", addId: expect.any(String) });
    expect(asked["sshPort"]).toBeUndefined();
    const addId = String(asked["addId"]);
    const stage = (step: string, state: string, note?: string): void => {
      sock.onmessage?.({ data: JSON.stringify({ type: "place.stage", addId, step, state, ...(note === undefined ? {} : { note }) }) });
    };
    await act(async () => {
      stage("connect", "done", "Ubuntu 24.04");
      stage("host-key", "done", "ssh-ed25519 SHA256:abc");
      stage("wsp", "done", "0.2.0");
      stage("service", "done");
      stage("join", "running");
      await Promise.resolve();
    });
    expect(document.querySelector<HTMLInputElement>("#add-computer-login")!.value).toBe("root@65.21.4.12");
    // The plan's own lines, the ones the installer has reached filled in and the one it has not standing.
    expect(plan()).toEqual([
      [`${placeAddSheetWord("connect", "done")}Ubuntu 24.04`, "done"],
      [`${placeAddSheetWord("host-key", "done")}ssh-ed25519 SHA256:abc`, "done"],
      [`${placeAddSheetWord("wsp", "done")}0.2.0`, "done"],
      [placeAddSheetWord("service", "done"), "done"],
      [placeAddSheetWord("join", "running"), "running"],
      [placeAddSheetWord("provision", "running"), "waiting"],
    ]);

    await act(async () => {
      // The note the runtime really sends with a done join: the box's size is in the row above, and a line that
      // carried it too would be cut from the right under its own check.
      stage("join", "done", "workspaces yes · engine none");
      sock.onmessage?.({ data: JSON.stringify({ id: asked["id"], ok: true, addId, place: box }) });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector("[data-k='title']")?.textContent).toBe(PLACES_WORDS.sheet.joinedTitle("hetzner")));
    // Still the lines the plan stands at: the join step wears different words once it is over, and the line it
    // was already on is the one that moves on rather than a second line arriving under it.
    expect(plan()).toEqual([
      [`${placeAddSheetWord("connect", "done")}Ubuntu 24.04`, "done"],
      [`${placeAddSheetWord("host-key", "done")}ssh-ed25519 SHA256:abc`, "done"],
      [`${placeAddSheetWord("wsp", "done")}0.2.0`, "done"],
      [placeAddSheetWord("service", "done"), "done"],
      [`${placeAddSheetWord("join", "done")}workspaces yes · engine none`, "done"],
      [placeAddSheetWord("provision", "running"), "waiting"],
    ]);
    expect(document.querySelector("[data-k='joined-table']")?.textContent).toContain("38 GB");
  });

  it("puts what ssh refused under the field and leaves it as it was", async () => {
    // The refusal settles after the click, so the press and what it settles are one act: the slot is read only
    // once React has drawn what the rejection put in it.
    let refuse: ((e: Error) => void) | undefined;
    await openSheet({ addComputerOverSsh: () => new Promise<PlaceView>((_ok, no) => (refuse = no)) } as unknown as Partial<Api>);
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await act(async () => {
      refuse?.(new Error("ssh refused the login (publickey)."));
      await Promise.resolve();
    });
    expect(document.querySelector("[data-k='ssh-refusal']")?.textContent).toContain("ssh refused the login (publickey).");
    expect(document.querySelector("[data-k='ssh-refusal']")?.textContent).toContain(ADD_COMPUTER_WORDS.refusedFix);
    expect((document.querySelector("#add-computer-login") as HTMLInputElement).value).toBe("root@65.21.4.12");
  });

  it("keeps every part it had once Add is pressed: the field with what was typed in it, dimmed, and three parts in the footer", async () => {
    let report: ((stage: InstallStage) => void) | undefined;
    await openSheet({ addComputerOverSsh: (_login: SshLogin, onStage: (stage: InstallStage) => void) => new Promise<PlaceView>(() => (report = onStage)) } as unknown as Partial<Api>);
    const parts = (): (string | null)[] => [...document.querySelectorAll("[data-slot='sheet-footer'] > *")].map(part => part.textContent);
    const field = (): HTMLInputElement => document.querySelector<HTMLInputElement>("#add-computer-login")!;
    fireEvent.change(field(), { target: { value: "root@65.21.4.12" } });
    const before = parts();
    expect(before).toHaveLength(3);
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(field().disabled).toBe(true));
    act(() => report?.({ step: "connect", word: "connected · Ubuntu 24.04", state: "done" }));
    // The same field, holding the same login, and the same three parts in the footer: the focus cannot leave with
    // a field that is still there, and the button beside Add cannot move if Add is still beside it.
    expect(field().value).toBe("root@65.21.4.12");
    expect(document.querySelector("[data-k='login-field']")).toBeTruthy();
    expect(parts()).toHaveLength(3);
    expect(parts()[1]).toBe(before[1]);
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("data-held")).toBe(true);
  });

  it("keeps what ssh said and the fix under it inside the slot's two lines, so the note under them does not move", () => {
    // Two lines of 51 characters at 12 px mono, which is what the 448 px sheet holds; the slot stands 36 px empty
    // and a third line pushes everything under it down.
    expect(`ssh refused the login (publickey). ${ADD_COMPUTER_WORDS.refusedFix}`.length).toBeLessThanOrEqual(102);
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
  it("opens whole for a person with no labs flag: every section drawn, and no side of the stylesheet to pick", async () => {
    useStore.setState({ api: fakeApi().api, preferences: { ...DEFAULT_PREFERENCES, labs: false } });
    useStore.getState().openSettings();
    expect(useStore.getState().settingsOpen).toBe(true);
    render(<SettingsPage />);
    await settle();
    for (const said of [SETTINGS_WORDS.appearance, SETTINGS_WORDS.terminal, PLACES_WORDS.section, SETTINGS_WORDS.about]) {
      expect(screen.getByText(said)).toBeTruthy();
    }
    // The width and the text size are the two picks left: the app draws the side the computer is set to, and the
    // sidebar has one body.
    expect(screen.getByText(SETTINGS_WORDS.sidebarWidth)).toBeTruthy();
    expect(screen.getByText(SETTINGS_WORDS.textSize)).toBeTruthy();
    expect(screen.queryByText("Theme")).toBeNull();
    expect(screen.queryByText("Sidebar", { exact: true })).toBeNull();
    for (const said of ["System", "Light", "Dark"]) expect(screen.queryByText(said)).toBeNull();
    // The agents on this computer are read under that computer's own row now, so the page has no second list.
    expect(screen.queryByText(AGENTS_WORDS.title, { selector: "h2" })).toBeNull();
  });

  it("reads the host's setup once for the whole page, whatever the page draws from it", async () => {
    let reads = 0;
    const api = fakeApi({
      initGet: async () => {
        reads += 1;
        return setupOf({ keys: { solari: true } });
      },
    } as Partial<Api>).api;
    useStore.setState({ api, places: [here] });
    render(<SettingsPage />);
    await settle();
    // One record, one read: the page asks and hands it to the section that draws its keys and its agents.
    expect(reads).toBe(1);
    expect(screen.getByText("Solari", { selector: "h2" })).toBeTruthy();
  });

  it("draws the section about one cloud only while this host holds that cloud's key, the rule its row stands under", async () => {
    useStore.setState({ api: fakeApi().api });
    render(<SettingsPage />);
    await settle();
    expect(screen.queryByText("Solari")).toBeNull();
    expect(screen.queryByText("Image")).toBeNull();
    cleanup();
    useStore.setState({ api: fakeApi({ initGet: async () => setupOf({ keys: { solari: true } }) } as Partial<Api>).api });
    render(<SettingsPage />);
    await settle();
    // Titled by the cloud it belongs to: image is not a word a person meets by the four nouns.
    expect(screen.getByText("Solari", { selector: "h2" })).toBeTruthy();
  });

  it("stands in the sidebar's foot with its chord, so Settings is never reachable only by a chord", () => {
    render(<SettingsRow />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("Settings");
    expect(row.textContent).toContain("⌘,");
    fireEvent.click(row);
    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it("opens the page with the sheet over it when a road asks for the sheet itself", () => {
    useStore.setState({ api: fakeApi().api });
    useStore.getState().openAddComputer();
    expect(useStore.getState().settingsOpen).toBe(true);
    render(<SettingsPage />);
    expect(document.querySelector("[data-k='add-computer']")).toBeTruthy();
  });
});
