// SPDX-License-Identifier: AGPL-3.0-only
// The Settings section that lists where a person's agents run, and the sheet
// that adds a computer to it: the table off the host's own list, the door and
// the code the sheet opens with, and the join it follows on the runtime's
// event stream.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_EXPIRED_LINE, CODE_GOOD_LINE, DEFAULT_PREFERENCES, PLACES_WORDS, doorPortHeldLine, type EventUnion, type PlaceDoorView, type PlaceView } from "@wsp/protocol";
import type { Api, InstallStage, SshLogin } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AddComputerSheet } from "../src/settings/AddComputerSheet.js";
import { ADD_COMPUTER_WORDS, CONNECT_PROVIDER_WORDS } from "../src/settings/format.js";
import { SettingsPage } from "../src/settings/SettingsPage.js";
import { WhereAgentsRun } from "../src/settings/WhereAgentsRun.js";
import { SettingsRow } from "../src/sidebar/SettingsRow.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const DOOR: PlaceDoorView = { port: 4420, addresses: ["http://192.168.1.20:4420"] };

/** A Linux box the ssh installer hands back: it runs Docker, so it can hold copies of the image. */
const box: PlaceView = {
  id: "p_2",
  kind: "computer",
  name: "hetzner",
  default: false,
  present: true,
  docker: true,
  os: "Ubuntu 24.04",
  shape: { cpu: 2, memMb: 4096 },
  diskFreeBytes: 38 * 1024 ** 3,
  joinedAt: "2026-09-12T11:00:00.000Z",
  lastSeenAt: "2026-09-12T11:59:00.000Z",
  workspaceId: "ws_c",
};

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
  useStore.setState({ api: null, places: [], workspaces: [], sessions: {}, addComputerOpen: false, settingsOpen: false, preferences: { ...DEFAULT_PREFERENCES, labs: false } });
});

afterEach(() => {
  cleanup();
});

/** The four facts of a row; a row that can be acted on carries a fifth cell for its menu. */
const cells = (row: HTMLElement): string[] => within(row).getAllByRole("cell").slice(0, 4).map(c => c.textContent ?? "");

describe("Where agents run", () => {
  it("lists this computer first with its size and disk, and says how long a computer that is not answering has been away", () => {
    useStore.setState({ places: [here, laptop] });
    render(<WhereAgentsRun now={NOW} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(cells(rows[0]!)[0]).toContain("This Mac");
    expect(cells(rows[0]!)[0]).not.toContain("zingzy-mbp");
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
    expect(cells(row).slice(1).every(cell => cell === "")).toBe(true);
  });

  it("opens each sheet from its own button", () => {
    useStore.setState({ places: [here] });
    render(<WhereAgentsRun now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: PLACES_WORDS.addComputer }));
    expect(useStore.getState().addComputerOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: PLACES_WORDS.connectProvider }));
    expect(screen.getByText(CONNECT_PROVIDER_WORDS.description)).toBeTruthy();
  });
});

describe("the Add a computer sheet", () => {
  it("opens the door, mints a code, shows the first address and the code, and names both in the terminal road", async () => {
    const fake = fakeApi();
    useStore.setState({ api: fake.api, places: [here] });
    render(<AddComputerSheet onClose={() => {}} now={() => NOW} />);
    await waitFor(() => expect(document.querySelector("[data-k='copy-address']")?.textContent).toBe("192.168.1.20:4420"));
    expect(document.querySelector("[data-k='copy-code']")?.textContent).toBe("QW4K-7PZ1");
    expect(screen.getByText(CODE_GOOD_LINE)).toBeTruthy();
    fireEvent.click(screen.getByText(PLACES_WORDS.sheet.noApp));
    await waitFor(() => expect(screen.getByText(PLACES_WORDS.sheet.install)).toBeTruthy());
    expect(screen.getByText("wsp join 192.168.1.20:4420 --code QW4K-7PZ1")).toBeTruthy();
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

describe("a computer's own row", () => {
  const withWorkspaces = (): void => {
    useStore.setState({
      places: [here, laptop],
      workspaces: [{ id: "ws_b", name: "spoo-fix", kind: "place", machineId: "place:p_1", phase: "running", golden: "", createdAt: "2026-09-11T00:00:00.000Z", home: "/home/dev" }] as never,
      sessions: { ws_b: [{ id: "s1" }, { id: "s2" }] } as never,
    });
  };

  it("opens its detail under it, and leaves this computer without one", () => {
    withWorkspaces();
    render(<WhereAgentsRun now={NOW} />);
    expect(document.querySelector("[data-k='place-detail']")).toBeNull();
    fireEvent.click(document.querySelector("[data-place-row='here']")!);
    expect(document.querySelector("[data-k='place-detail']")).toBeNull();
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    const detail = document.querySelector("[data-k='place-detail']")!;
    expect(detail.getAttribute("data-place")).toBe("p_1");
    expect(detail.textContent).toContain("macOS 15.6");
    expect(detail.textContent).toContain("claude, codex");
    expect(detail.textContent).toContain("spoo-fix · Running · 2 threads");
    expect(document.querySelector("[data-place-row='p_1']")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("computes the Remove sentence from what that computer holds", () => {
    withWorkspaces();
    render(<WhereAgentsRun now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    fireEvent.click(document.querySelector("[data-k='place-detail'] [data-k='remove']")!);
    expect(screen.getByText("Remove old-macbook?")).toBeTruthy();
    expect(screen.getByText("wsp, your image and its workspace come off old-macbook, which is otherwise left as it is. The workspace's record and 2 threads leave this Mac. It is offline; what is on it is swept the next time it connects.")).toBeTruthy();
  });

  it("says nothing of a record leaving for a computer that holds none, and takes it out on the host's own road", async () => {
    const removed: string[] = [];
    useStore.setState({ places: [here, laptop], workspaces: [], sessions: {}, api: { subscribe: () => () => {}, removePlace: async (id: string) => (removed.push(id), { removed: true, swept: [], dropped: [] }) } as unknown as Api });
    render(<WhereAgentsRun now={NOW} />);
    fireEvent.click(document.querySelector("[data-place-row='p_1']")!);
    fireEvent.click(document.querySelector("[data-k='place-detail'] [data-k='remove']")!);
    expect(screen.getByText("wsp and your image come off old-macbook, which is otherwise left as it is. It is offline; what is on it is swept the next time it connects.")).toBeTruthy();
    fireEvent.click(document.querySelector("[data-k='remove-confirm']")!);
    await waitFor(() => expect(removed).toEqual(["p_1"]));
  });
});

describe("the ssh road of the sheet", () => {
  // The road is moved with the arrow the radio group answers to: jsdom builds no PointerEvent, so a click on a
  // segment never reaches base-ui's own handler.
  const toSsh = async (): Promise<void> => {
    fireEvent.keyDown(document.querySelector("[data-segment='app']")!, { key: "ArrowRight" });
    await waitFor(() => expect(document.querySelector("[data-k='login-field']")).toBeTruthy());
  };

  const openSheet = async (over: Partial<Api> = {}) => {
    const fake = fakeApi(over);
    useStore.setState({ api: fake.api, places: [here] });
    render(<AddComputerSheet onClose={() => {}} now={() => NOW} />);
    await waitFor(() => expect(screen.getByText(PLACES_WORDS.sheet.waiting)).toBeTruthy());
    await toSsh();
    return fake;
  };

  it("holds Add until a login is typed", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("disabled")).toBe(true);
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("disabled")).toBe(false);
  });

  it("holds Add on a wsp whose host cannot log in over ssh at all", async () => {
    await openSheet();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("disabled")).toBe(true);
  });

  it("shows the installer's own stages while it runs, and the roads go", async () => {
    let report: ((stage: InstallStage) => void) | undefined;
    await openSheet({ addComputerOverSsh: (_login: SshLogin, onStage: (stage: InstallStage) => void) => new Promise<PlaceView>(() => (report = onStage)) } as unknown as Partial<Api>);
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(document.querySelector("[data-k='ssh-login']")).toBeTruthy());
    act(() => {
      report?.({ word: "connected · Ubuntu 24.04", state: "done" });
      report?.({ word: "installing node 22", state: "done", fact: "18 s" });
      report?.({ word: "installing wsp 0.2.0", state: "running" });
    });
    expect(document.querySelector("[data-slot='segmented-control']")).toBeNull();
    expect(document.querySelector("[data-k='ssh-login']")?.textContent).toBe("root@65.21.4.12");
    expect([...document.querySelectorAll("[data-k='lines'] [data-k='line']")].map(l => [l.textContent, l.getAttribute("data-state")])).toEqual([
      ["connected · Ubuntu 24.04", "done"],
      ["installing node 2218 s", "done"],
      ["installing wsp 0.2.0", "running"],
    ]);
  });

  it("reads the box as joined once the installer answers with it, and says it can run copies", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(document.querySelector("[data-k='title']")?.textContent).toBe("hetzner joined"));
    expect(document.querySelector("[data-k='description']")?.textContent).toBe(ADD_COMPUTER_WORDS.joinedWithDocker);
    expect(document.querySelector("[data-k='joined-table']")?.textContent).toContain("38 GB");
  });

  it("puts what ssh refused under both fields and leaves the fields as they were", async () => {
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
    expect(document.querySelector("[data-k='ssh-refusal']")?.textContent).toContain(ADD_COMPUTER_WORDS.ssh.refusedFix);
    expect(document.querySelector("[data-k='pick-key']")).toBeNull();
    expect((document.querySelector("#add-computer-login") as HTMLInputElement).value).toBe("root@65.21.4.12");
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
