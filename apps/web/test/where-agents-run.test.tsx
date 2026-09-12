// SPDX-License-Identifier: AGPL-3.0-only
// The Settings section that lists where a person's agents run, and the sheet
// that adds a computer to it: the table off the host's own list, the door and
// the code the sheet opens with, and the join it follows on the runtime's
// event stream.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_EXPIRED_LINE, CODE_GOOD_LINE, DEFAULT_PREFERENCES, PLACES_WORDS, doorPortHeldLine, type EventUnion, type PlaceDoorView, type PlaceView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AddComputerSheet } from "../src/settings/AddComputerSheet.js";
import { SettingsPage } from "../src/settings/SettingsPage.js";
import { WhereAgentsRun } from "../src/settings/WhereAgentsRun.js";
import { SettingsRow } from "../src/sidebar/SettingsRow.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const DOOR: PlaceDoorView = { port: 4420, addresses: ["http://192.168.1.20:4420"] };

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, docker: false, shape: { cpu: 8, memMb: 16384 }, diskFreeBytes: 210 * 1024 ** 3, workspaceId: "ws_a" };
const laptop: PlaceView = {
  id: "p_1",
  kind: "computer",
  name: "old-macbook",
  default: false,
  present: false,
  docker: false,
  os: "macOS 15.6",
  agents: ["claude", "codex"],
  shape: { cpu: 4, memMb: 8192 },
  diskFreeBytes: 91 * 1024 ** 3,
  lastSeenAt: "2026-09-12T10:00:00.000Z",
  workspaceId: "ws_b",
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
    placesDoor: async () => DOOR,
    pairIssue: async () => {
      state.issued += 1;
      return { code: `QW4K7PZ${state.issued}`, expiresAt: NOW + 600_000 };
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
  useStore.setState({ api: null, places: [], addComputerOpen: false, settingsOpen: false, preferences: { ...DEFAULT_PREFERENCES, labs: false } });
});

afterEach(() => {
  cleanup();
});

const cells = (row: HTMLElement): string[] => within(row).getAllByRole("cell").map(c => c.textContent ?? "");

describe("Where agents run", () => {
  it("lists this computer first with its size and disk, and says how long a computer that is not answering has been away", () => {
    useStore.setState({ places: [here, laptop] });
    render(<WhereAgentsRun now={NOW} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(cells(rows[0]!)[0]).toContain("zingzy-mbp");
    expect(cells(rows[0]!)[0]).toContain("default");
    expect(cells(rows[0]!).slice(1)).toEqual(["8 cores · 16 GB".replace(/ /g, " "), "210 GB", "1 · agents only"]);
    expect(cells(rows[1]!)[0]).toContain("offline · 2 h");
    expect(cells(rows[1]!).slice(1)).toEqual(["4 cores · 8 GB".replace(/ /g, " "), "91 GB", "1 · not answering"]);
  });

  it("keeps the default mark beside the name and the state word in the slot, so a default that is away says both", () => {
    useStore.setState({ places: [{ ...laptop, default: true }] });
    render(<WhereAgentsRun now={NOW} />);
    const row = screen.getAllByRole("row")[1]!;
    expect(row.querySelector("[data-k='place-default']")?.textContent).toBe("default");
    expect(row.querySelector("[data-k='place-state']")?.textContent).toBe("offline · 2 h");
  });

  it("stands a bar in each cell a computer has not reported yet, so nothing moves when it does", () => {
    useStore.setState({ places: [{ id: "p_2", kind: "computer", name: "attic", default: false, present: true }] });
    render(<WhereAgentsRun now={NOW} />);
    const row = screen.getAllByRole("row")[1]!;
    expect(within(row).getAllByRole("cell").slice(1).every(cell => cell.textContent === "")).toBe(true);
  });

  it("opens the sheet from its own button, and draws the provider road held with why", () => {
    useStore.setState({ places: [here] });
    render(<WhereAgentsRun now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: PLACES_WORDS.addComputer }));
    expect(useStore.getState().addComputerOpen).toBe(true);
    const provider = screen.getByRole("button", { name: PLACES_WORDS.connectProvider });
    expect(provider.hasAttribute("disabled")).toBe(true);
    expect(provider.getAttribute("title")).toBe(PLACES_WORDS.connectProviderHeld);
  });
});

describe("the Add a computer sheet", () => {
  it("opens the door, mints a code, shows the first address and the code, and names both in the terminal road", async () => {
    const fake = fakeApi();
    useStore.setState({ api: fake.api, places: [here] });
    render(<AddComputerSheet onClose={() => {}} now={() => NOW} />);
    await waitFor(() => expect(document.querySelector("[data-k='copy-address']")?.textContent).toBe("http://192.168.1.20:4420"));
    expect(document.querySelector("[data-k='copy-code']")?.textContent).toBe("QW4K-7PZ1");
    expect(screen.getByText(CODE_GOOD_LINE)).toBeTruthy();
    fireEvent.click(screen.getByText(PLACES_WORDS.sheet.noApp));
    await waitFor(() => expect(screen.getByText(PLACES_WORDS.sheet.install)).toBeTruthy());
    expect(screen.getByText("wsp join http://192.168.1.20:4420 --code QW4K-7PZ1")).toBeTruthy();
  });

  it("moves to the lines the join writes, then to the joined title and the row, and opens the workspace it made", async () => {
    const fake = fakeApi();
    const opened: string[] = [];
    useStore.setState({ api: fake.api, places: [here], select: (id: string | null) => opened.push(String(id)) } as never);
    let closed = false;
    render(<AddComputerSheet onClose={() => (closed = true)} now={() => NOW} />);
    await waitFor(() => expect(screen.getByText(PLACES_WORDS.sheet.waiting)).toBeTruthy());
    const joining: PlaceView = { ...laptop, present: false };
    fake.push({ type: "place.joined", place: joining, from: "192.168.1.34" });
    useStore.setState({ places: [here, joining] });
    await waitFor(() => expect(screen.getByText(PLACES_WORDS.sheet.connected("192.168.1.34"))).toBeTruthy());
    expect(screen.getByText(PLACES_WORDS.sheet.reading)).toBeTruthy();
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    await waitFor(() => expect(screen.getByText(PLACES_WORDS.sheet.joinedTitle("old-macbook"))).toBeTruthy());
    expect(screen.getByText(PLACES_WORDS.sheet.joined("macOS 15.6", ["claude", "codex"]))).toBeTruthy();
    expect(screen.getByText(PLACES_WORDS.sheet.dockerOptional)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: PLACES_WORDS.sheet.open("old-macbook") }));
    expect(opened).toEqual(["ws_b"]);
    expect(closed).toBe(true);
  });

  it("says the code expired at its own moment and mints another, and moves nothing else", async () => {
    const fake = fakeApi();
    useStore.setState({ api: fake.api, places: [here] });
    render(<AddComputerSheet onClose={() => {}} now={() => NOW + 700_000} />);
    await waitFor(() => expect(screen.getByText(CODE_EXPIRED_LINE)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: PLACES_WORDS.sheet.newCode }));
    await waitFor(() => expect(document.querySelector("[data-k='copy-code']")?.textContent).toBe("QW4K-7PZ2"));
  });

  it("lands a door this host could not open in the slot, and asks for no code behind it", async () => {
    const fake = fakeApi({ placesDoor: async () => Promise.reject(new Error(doorPortHeldLine(4420))) });
    useStore.setState({ api: fake.api, places: [here] });
    render(<AddComputerSheet onClose={() => {}} now={() => NOW} />);
    await waitFor(() => expect(screen.getByText(doorPortHeldLine(4420))).toBeTruthy());
    expect(fake.issued).toBe(0);
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
  it("opens for a person with no labs flag, and draws the theme picks only behind it", () => {
    useStore.getState().openSettings();
    expect(useStore.getState().settingsOpen).toBe(true);
    render(<SettingsPage />);
    expect(screen.queryByText("Appearance")).toBeNull();
    expect(screen.getByText(PLACES_WORDS.section)).toBeTruthy();
    cleanup();
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true } });
    render(<SettingsPage />);
    expect(screen.getByText("Appearance")).toBeTruthy();
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
