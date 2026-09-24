// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Computers: the list off the host's own rows, which it draws and
// which it leaves out, each row's facts and state word; a computer's own page
// with its lines, its connection, the agents on it and what the recipe put
// beside them, the workspaces standing on it and the two acts; the cloud's
// page with the image behind its row; and the one-field sheet that adds
// another computer.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COPY_CURRENT, DEFAULT_PREFERENCES, PLACES_TICKET_REFUSAL, PLACES_WORDS, PLACE_CONNECTS, PlaceAddStep, absentRoad, fmtBytes, fmtSize, imageCopyStaysLine, placeAddSheetWord, placeDaemonBehind, placeNoDialLine, provisionWord, type EventUnion, type InitSetup, type PlaceProvision, type PlaceView, type SealedImage, type SessionView, type WorkspaceStatus, type WorkspaceView, PLACE_INSTALL } from "@wsp/protocol";
import { render } from "@testing-library/react";
import { makeApi, ProtocolClient, type Api, type InstallStage, type SshLogin } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AddComputerSheet } from "../src/settings/AddComputerSheet.js";
import { ADD_COMPUTER_WORDS, AGENTS_WORDS, WHERE_WORDS } from "../src/settings/format.js";
import { IMAGE_WORDS } from "../src/settings/image.js";
import { useSettingsStore, type SettingsAt } from "../src/settings/settingsStore.js";
import { SettingsRow } from "../src/sidebar/SettingsRow.js";
import { ScriptedSocket, type Frame } from "./scripted-socket.js";
import { descriptionOf, lineLabels, lineOf, mountSettings, pageAt, resetSettings, rowOf, settingsApi, settle, wordOf } from "./settings-harness.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

/** What the host says about its own setup: which keys it holds, which is the rule a cloud row stands under, and
 * the agents on this computer, which are this computer's own rows. */
const setupOf = (over: Partial<InitSetup> = {}): InitSetup => ({ keys: { solari: false }, home: "/Users/dev", agents: [], pricing: null, job: null, ...over }) as InitSetup;

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
const listIds = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-place-row]")].map(row => row.dataset["placeRow"] ?? "");
const listRow = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-settings-page] [data-place-row='${id}']`)!;
const stateOf = (id: string): string | undefined => listRow(id).querySelector("[data-settings-word]")?.textContent ?? undefined;
const factsOf = (id: string): string => listRow(id).querySelector("[data-settings-description]")?.textContent ?? "";
const openPage = (id: string): void => {
  fireEvent.click(listRow(id));
};

/** Every agent row of the open page: which agent, the name a person reads, the words under it and the one action. */
const agentRows = (): { agent: string | null; name: string | undefined; state: string | undefined; action: string | undefined }[] =>
  [...document.querySelectorAll("[data-settings-page] [data-k='agent']")].map(row => ({
    agent: row.getAttribute("data-agent"),
    name: row.querySelector("[data-settings-title]")?.textContent ?? undefined,
    state: row.querySelector("[data-settings-description]")?.textContent ?? undefined,
    action: row.querySelector("[data-k='agent-add'], [data-k='agent-sign-in']")?.textContent ?? undefined,
  }));
const lineValue = (k: string): string | undefined => document.querySelector(`[data-settings-page] [data-k='${k}'] [data-settings-word]`)?.textContent ?? undefined;

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
  it("lists this computer first with its default mark and facts, and a computer that is not answering with its word in the slot", async () => {
    useStore.setState({ places: [here, laptop], workspaces: [mine, onLaptop] });
    await mountComputers(computersApi().api);
    expect(listIds()).toEqual(["here", "p_1"]);
    expect(listRow("here").querySelector("[data-settings-title]")?.textContent).toBe("This Mac");
    expect(listRow("here").textContent).not.toContain("zingzy-mbp");
    expect(listRow("here").querySelector("[data-settings-mark]")?.textContent).toBe("default");
    expect(factsOf("here")).toBe(`${fmtSize(here.shape!, "cores")} · 210 GB · 1 workspace`);
    expect(stateOf("here")).toBeUndefined();
    // The slot holds the one word for the silence, in the words every other surface says it in.
    expect(stateOf("p_1")).toBe("no answer");
    expect(factsOf("p_1")).toBe(`${fmtSize(laptop.shape!, "cores")} · 91 GB · 1 workspace`);
    // Machine words wear the mono fact class, whole on hover.
    expect(listRow("p_1").querySelector("[data-settings-description]")?.className).toContain("font-mono");
    expect(listRow("p_1").querySelector("[data-settings-description]")?.getAttribute("title")).toBe(factsOf("p_1"));
  });

  it("says this computer's own daemon is not running in the slot, rather than listing this Mac as perfectly fine", async () => {
    const silent = { id: mine.id, phase: "running", machineState: "running", reach: { state: "unreachable" }, machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, kind: "local", size: { cpu: 8, memMb: 16384 }, name: mine.name, golden: "", createdAt: mine.createdAt } as unknown as WorkspaceStatus;
    useStore.setState({ places: [here], workspaces: [mine], statuses: { [mine.id]: silent } });
    await mountComputers(computersApi().api);
    expect(stateOf("here")).toBe("no daemon");
    expect(listRow("here").textContent).not.toContain("Unreachable");
  });

  it("leaves out a fact a computer has not reported, so a row that has said nothing carries its name alone and keeps its height", async () => {
    useStore.setState({ places: [{ id: "p_2", kind: "computer", name: "attic", default: false, present: true }] });
    await mountComputers(computersApi().api);
    expect(factsOf("p_2")).toBe("");
    expect(listRow("p_2").textContent).not.toMatch(/[-\u2014]/);
    expect(listRow("p_2").querySelector("[data-slot=skeleton]")).toBeNull();
    expect(listRow("p_2").className).toContain("h-16");
  });

  it("counts the workspaces standing on each row off the list the sidebar shows, and a fresh state is this computer's row alone with no cloud and no price", async () => {
    useStore.setState({ places: [here, ascii, solari], workspaces: [mine, fork("ws_x"), fork("ws_y")] });
    await mountComputers(computersApi().api);
    expect(listIds()).toEqual(["here", "box"]);
    expect(factsOf("here")).toContain("1 task");
    // The cloud a workspace stands on is drawn even with no key held, so a machine is never orphaned.
    expect(factsOf("box")).toBe("cloud · $0.018/hr · 2 tasks");
    expect(document.body.textContent).not.toContain("Solari");
    expect(screen.queryByText("Where agents run")).toBeNull();
  });

  it("draws a cloud row once this host holds its key, named as a person reads it, with what it took this month in its own row and no foot under the card", async () => {
    const api = computersApi({ spend: async () => [{ place: "solari", monthUsd: 1.23, rateUsdPerHour: 0.11 }] } as Partial<Api>, setupOf({ keys: { solari: true } })).api;
    useStore.setState({ places: [here, ascii, solari], workspaces: [atSolari("ws_s")] });
    await mountComputers(api);
    expect(listIds()).toEqual(["here", "solari"]);
    expect(listRow("solari").querySelector("[data-settings-title]")?.textContent).toBe("Solari");
    expect(factsOf("solari")).toBe("cloud · $0.11/hr · 1 task · $1.23 this month");
    expect(document.querySelector("[data-k='places-spend']")).toBeNull();
    expect(document.body.textContent?.match(/this month/g)?.length).toBe(1);
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
    const busy = { ...box, id: "p_busy", name: "busy", provision: running };
    const broke = { ...box, id: "p_broke", name: "broke", provision: failed };
    const gone = { ...laptop, id: "p_gone", name: "gone", provision: running };
    const behind = { ...box, id: "p_old", name: "old", daemonVersion: 1 };
    useStore.setState({ places: [here, busy, broke, gone, behind] });
    await mountComputers(computersApi().api);
    expect(stateOf("p_busy")).toBe(provisionWord(running));
    expect(stateOf("p_broke")).toBe("2 of 7 failed: GitHub CLI, uv");
    expect(stateOf("p_gone")).toBe("no answer");
    expect(stateOf("p_old")).toBe(placeDaemonBehind(behind));
  });

  it("opens the sheet from the one button under the card, offers no cloud to connect, and a row opens the computer's page", async () => {
    useStore.setState({ places: [here, box] });
    await mountComputers(computersApi().api);
    fireEvent.click(screen.getByRole("button", { name: PLACES_WORDS.addComputer }));
    expect(useStore.getState().addComputerOpen).toBe(true);
    expect(document.querySelector("[data-k='connect-provider']")).toBeNull();
    act(() => useStore.getState().closeAddComputer());
    await settle();
    openPage("p_2");
    expect(pageAt()).toBe("computer:p_2");
  });

  it("asks the host once for the month and follows the meter, and says no money at all on a window that may not read it", async () => {
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
    expect(factsOf("box")).not.toContain("this month");
    act(() => fake.push({ type: "workspace.cost", workspaceId: "ws_x", phase: "running", rateUsdPerHour: 0.16, awakeMs: 60_000, accruedUsd: 0.41, at: AT, seq: 1 } as EventUnion));
    await settle();
    expect(asks).toBe(1);
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

  it("says its facts as lines, the login it dials and how long the last dial took as rows, and the workspaces on it as lines", async () => {
    // Stamps against the clock the page reads, so the words hold whatever day the suite runs.
    // A minute past the hour, since the page reads a clock quantised to the minute.
    const seen = new Date(Date.now() - 2 * 3_600_000 - 60_000).toISOString();
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", lastSeenAt: seen, road: { ssh: "root@65.21.4.12" }, dialled: { at: seen, answered: true, roundTripMs: 14 }, joinedAt: new Date(Date.now() - 3_600_000 - 60_000).toISOString() };
    useStore.setState({ places: [here, vps], workspaces: [{ ...onLaptop, place: "p_3", name: "spoo-fix" }], sessions: { ws_b: [session("s1", "ws_b"), session("s2", "ws_b")] } });
    await mountComputers(computersApi(dialling()).api, { kind: "computer", id: "p_3" });
    // The facts are lines with the value at the right and no sentence under them; the whole is on hover.
    expect(lineLabels()).toEqual([WHERE_WORDS.system, WHERE_WORDS.size, WHERE_WORDS.diskFree, WHERE_WORDS.joined, "spoo-fix"]);
    expect(lineValue("system")).toBe("Ubuntu 24.04 · last seen 2 h ago");
    expect(lineOf("system")?.getAttribute("title")).toBe(WHERE_WORDS.systemHover);
    expect(lineValue("size")).toBe(fmtSize(vps.shape!, "cores"));
    expect(lineValue("disk-free")).toBe(fmtBytes(vps.diskFreeBytes!));
    expect(lineValue("joined")).toBe("1 h ago");
    expect(lineOf("system")?.querySelector("[data-settings-description]")).toBeNull();
    // The connection card: the address and when it last answered with how long the frame took, beside Try.
    expect(wordOf("address")).toBe("root@65.21.4.12 · ssh");
    expect(wordOf("answered")).toBe(`${absentRoad({ name: "vps", awayMs: 2 * 3_600_000 + 60_000 }).answered} · 14 ms`);
    expect(descriptionOf("answered")).toBe(WHERE_WORDS.answeredDescription);
    expect(document.querySelector("[data-settings-page] [data-k='workspace-line'] [data-settings-word]")?.textContent).toBe("Running · 2 threads");
    // The rows and the lines stand at their own two heights.
    expect(rowOf("address")?.className).toContain("h-16");
    expect(lineOf("system")?.className).toContain("h-11");
  });

  it("this Mac's page has no Connection card and no acts, opens on the agents found here with the one held action and no title on it", async () => {
    const agents = [
      { id: "claude", name: "Claude Code", configured: true, takesTools: true },
      { id: "codex", name: "Codex", configured: false, takesTools: true },
      { id: "cursor", name: "Cursor", configured: false, takesTools: false },
    ];
    useStore.setState({ places: [here] });
    await mountComputers(computersApi({}, setupOf({ agents })).api, { kind: "computer", id: "here" });
    for (const k of ["remove", "update", "dial", "address", "answered", "joined"]) expect(document.querySelector(`[data-settings-page] [data-k='${k}']`)).toBeNull();
    expect(agentRows()).toEqual([
      { agent: "claude", name: "Claude Code", state: AGENTS_WORDS.added, action: undefined },
      { agent: "codex", name: "Codex", state: `${AGENTS_WORDS.notAdded} · ${WHERE_WORDS.notFromApp}`, action: AGENTS_WORDS.add },
      { agent: "cursor", name: "Cursor", state: AGENTS_WORDS.noTools, action: undefined },
    ]);
    const add = document.querySelector("[data-k='agent-add']")!;
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(add.hasAttribute("title")).toBe(false);
    expect(document.querySelector("[data-k='agent-sign-in']")).toBeNull();
  });

  it("says so when a computer reported no agent at all, naming that computer", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true, agents: [] }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "here" });
    expect(document.querySelector("[data-k='no-agents']")?.textContent).toBe("No agents found on this Mac.");
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "p_1" }));
    await settle();
    expect(document.querySelector("[data-k='no-agents']")?.textContent).toBe("No agents found on old-macbook.");
  });

  it("lists a joined computer's agents with the version and the sign-in word, Sign in held with why as the last clause and no title, and nothing beside the one signed in", async () => {
    const spoo: PlaceView = {
      ...laptop,
      present: true,
      name: "spoo",
      agents: ["claude", "codex"],
      agentVersions: { claude: "2.1.270 (Claude Code)", codex: "codex-cli 0.153.0" },
      signIns: { claude: "vault-key", codex: "none" },
    };
    useStore.setState({ places: [here, spoo] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    expect(agentRows()).toEqual([
      { agent: "claude", name: "Claude Code", state: "2.1.270 · your key", action: undefined },
      { agent: "codex", name: "Codex", state: `0.153.0 · not signed in · ${WHERE_WORDS.notFromApp}`, action: AGENTS_WORDS.signIn },
    ]);
    const signIn = document.querySelector("[data-agent='codex'] [data-k='agent-sign-in']")!;
    expect(signIn.hasAttribute("data-held")).toBe(true);
    expect(signIn.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain("wsp add");
  });

  it("draws what the recipe put there beside the agents as lines, and the recipe's outcome on the agent it could not put on", async () => {
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
    useStore.setState({ places: [here, { ...laptop, present: true, name: "spoo", provision }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    expect(agentRows().map(row => [row.agent, row.state])).toEqual([
      ["claude", `installed · ${WHERE_WORDS.notFromApp}`],
      ["codex", `failed: npm exited 1 · ${WHERE_WORDS.notFromApp}`],
    ]);
    expect([...document.querySelectorAll("[data-k='recipe-row']")].map(row => [row.getAttribute("data-kind"), row.querySelector("[data-settings-label]")?.textContent, row.querySelector("[data-settings-word]")?.textContent])).toEqual([
      ["file", "code-review", "file · installed"],
      ["server", "linear", "MCP server · installed"],
    ]);
    expect(document.querySelector("[data-settings-card='recipe']")?.textContent).not.toContain("GitHub CLI");
  });

  it("reads found on a joined computer no recipe has run on, and one muted line where a recipe put no skill or server", async () => {
    const provision: PlaceProvision = { state: "done", addId: "a_1", recipeAt: AT, startedAt: AT, finishedAt: AT, rows: [{ id: "agents/claude", label: "Claude Code", outcome: "installed" }] };
    useStore.setState({ places: [here, { ...laptop, present: true }, { ...box, provision }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    expect(agentRows().map(row => row.state)).toEqual([`${AGENTS_WORDS.found} · ${WHERE_WORDS.notFromApp}`, `${AGENTS_WORDS.found} · ${WHERE_WORDS.notFromApp}`]);
    expect(document.querySelector("[data-settings-card='recipe']")).toBeNull();
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "p_2" }));
    await settle();
    expect(document.querySelector("[data-k='no-recipe']")?.textContent).toBe(WHERE_WORDS.recipeNone);
  });

  it("says how a copy is made there and what it has for a network as rows, off the row and off the landing's own flags", async () => {
    const project = { id: "pr_box", name: "spoo", computer: "p_1", source: { kind: "folder", path: "/root/spoo" }, path: "/root/spoo", createdAt: AT } as never;
    const mac = { id: "pr_here", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/dev/wsp" }, path: "/Users/dev/wsp", createdAt: AT } as never;
    useStore.setState({
      places: [here, { ...laptop, present: true, copies: "reflink" }],
      projects: [mac, project],
      landings: {
        pr_here: { name: "here", capabilities: { copies: true, ownNetwork: false } as never },
        pr_box: { place: "p_1", name: "old-macbook", capabilities: { copies: true, ownNetwork: true } as never },
      },
    });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    expect(wordOf("copies")).toBe("reflink");
    expect(wordOf("ports")).toBe("own network");
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "here" }));
    await settle();
    expect(wordOf("ports")).toBe("shares this Mac's ports");
    expect(rowOf("copies")).toBeNull();
  });

  it("says a computer that copies nothing does, rather than leaving the row out", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true, takesForks: false }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    expect(wordOf("copies")).toBe(WHERE_WORDS.copiesNothing);
  });

  it("puts this wsp's daemon and the recipe on a computer from Update, holds it at its word while it runs, and reads the job in the list's slot", async () => {
    const asked: string[] = [];
    let answer: (() => void) | undefined;
    const provision: PlaceProvision = { state: "running", addId: "a_2", recipeAt: AT, startedAt: AT, rows: [], at: { label: "uv", index: 3, of: 7 } };
    const api = computersApi({
      placesUpdate: (placeId: string) => {
        asked.push(placeId);
        return new Promise(ok => (answer = () => ok({ name: "old-macbook", provision })));
      },
    } as unknown as Partial<Api>).api;
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    await mountComputers(api, { kind: "computer", id: "p_1" });
    const update = (): Element => document.querySelector("[data-settings-page] [data-k='update']")!;
    expect(rowOf("update")?.querySelector("[data-settings-title]")?.textContent).toBe("Update wsp on old-macbook");
    expect(descriptionOf("update")).toBe(WHERE_WORDS.updateDescription);
    fireEvent.click(update());
    await waitFor(() => expect(asked).toEqual(["p_1"]));
    await waitFor(() => expect(update().hasAttribute("disabled")).toBe(true));
    expect(update().textContent).toBe(WHERE_WORDS.update);
    await act(async () => {
      answer?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(update().hasAttribute("disabled")).toBe(false));
    expect(useStore.getState().places.find(place => place.id === "p_1")?.provision).toEqual(provision);
    act(() => useSettingsStore.getState().go({ kind: "group", group: "computers" }));
    await settle();
    expect(stateOf("p_1")).toBe("setting up 3/7: uv");
  });

  it("holds Update with no title on a wsp whose client cannot ask for one, and the description ends with why", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    const update = document.querySelector("[data-settings-page] [data-k='update']")!;
    expect(update.hasAttribute("disabled")).toBe(true);
    expect(update.hasAttribute("title")).toBe(false);
    expect(descriptionOf("update")).toBe(`${WHERE_WORDS.updateDescription} ${WHERE_WORDS.updateHeld}`);
  });

  /** A client that can dial, so a button drawn beside a row is held for the row's own reason and never the app's. */
  const dialling = (line = "vps answered in 12 ms."): Partial<Api> =>
    ({ dialPlace: async (placeId: string) => ({ dialled: { at: "2026-09-12T12:00:00.000Z", answered: true, roundTripMs: 12 }, line, place: { ...laptop, id: placeId } }) }) as Partial<Api>;

  it("says a computer that never answered so, reads a computer that is answering plain, and says nothing about reaching a cloud", async () => {
    const fresh: PlaceView = { ...laptop, id: "p_4", name: "vps", lastSeenAt: undefined };
    const alive: PlaceView = { ...laptop, id: "p_5", name: "vps2", present: true, lastSeenAt: "2026-09-12T11:59:00.000Z" };
    useStore.setState({ places: [here, fresh, alive, ascii] });
    await mountComputers(computersApi({}, setupOf({ keys: { box: true } })).api, { kind: "computer", id: "p_4" });
    expect(wordOf("answered")).toBe("not since it joined");
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "p_5" }));
    await settle();
    expect(lineValue("system")).toBe("Ubuntu 24.04");
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "box" }));
    await settle();
    // A cloud's machines are at the other end of a key: no address, nothing that last answered, no dial, no agents.
    for (const k of ["answered", "address", "dial", "agent"]) expect(document.querySelector(`[data-settings-page] [data-k='${k}']`)).toBeNull();
    expect(document.querySelector("[data-settings-card='agents']")).toBeNull();
  });

  it("keeps the last refusal in the Answered row's description and replaces it with what a press of Try now got, one line whole on hover", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said } };
    const line = "root@65.21.4.12 answered over ssh in 412 ms, so the computer is on; the agent on it is not dialling this host.";
    useStore.setState({ places: [here, vps] });
    await mountComputers(computersApi(dialling(line)).api, { kind: "computer", id: "p_3" });
    expect(descriptionOf("answered")).toBe(said);
    expect(document.querySelector("[data-k='dial']")?.textContent).toBe("Try over ssh");
    fireEvent.click(document.querySelector("[data-k='dial']")!);
    await waitFor(() => expect(descriptionOf("answered")).toBe(line));
    expect(rowOf("answered")?.querySelector("[data-settings-description]")?.getAttribute("title")).toBe(line);
    expect(rowOf("answered")?.querySelector("[data-settings-description]")?.className).toContain("truncate");
  });

  it("offers no dial where there is no road to dial over, says why in the description, and words the button for the road there is", async () => {
    const said = placeNoDialLine("old-macbook");
    const byCode: PlaceView = { ...laptop, road: { from: "192.168.1.34" }, dialled: { at: "2026-09-12T11:59:00.000Z", answered: false, said } };
    const linked: PlaceView = { ...laptop, id: "p_6", name: "linked", present: true };
    useStore.setState({ places: [here, byCode, linked] });
    await mountComputers(computersApi(dialling()).api, { kind: "computer", id: "p_1" });
    expect(descriptionOf("answered")).toBe(said);
    expect(document.querySelector("[data-k='dial']")).toBeNull();
    act(() => useSettingsStore.getState().go({ kind: "computer", id: "p_6" }));
    await settle();
    expect(document.querySelector("[data-k='dial']")?.textContent).toBe("Try now");
  });

  it("says in the description that this wsp cannot dial, and draws no button, where the client has no dial road", async () => {
    const vps: PlaceView = { ...laptop, id: "p_3", name: "vps", road: { ssh: "root@65.21.4.12" } };
    useStore.setState({ places: [here, vps] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_3" });
    expect(descriptionOf("answered")).toBe(WHERE_WORDS.cannotDial);
    expect(document.querySelector("[data-k='dial']")).toBeNull();
  });

  it("computes the Remove sentence from what that computer holds, hands an offline one the line to run by hand, and takes it out on the host's own road", async () => {
    const removed: string[] = [];
    withWorkspaces();
    await mountComputers(computersApi({ removePlace: async (id: string) => (removed.push(id), { removed: true, swept: [] }) } as unknown as Partial<Api>).api, { kind: "computer", id: "p_1" });
    expect(rowOf("remove")?.querySelector("[data-settings-title]")?.textContent).toBe("Remove old-macbook");
    expect(descriptionOf("remove")).toBe(WHERE_WORDS.removeDescription("old-macbook"));
    fireEvent.click(document.querySelector("[data-settings-page] [data-k='remove']")!);
    expect(screen.getByText("Remove old-macbook?")).toBeTruthy();
    expect(document.querySelector("[data-k='remove-sentence']")?.textContent).toBe("wsp and its task come off old-macbook, which is otherwise left as it is, and the copy of your image stays where it is. The task's record and 2 threads leave this Mac. It is offline; what is on it is swept the next time it connects.");
    expect(document.querySelector("[data-k='leave-line']")?.textContent).toBe(PLACES_WORDS.remove.leaveLine);
    expect(document.querySelector("[data-remove-place-dialog]")?.textContent).toContain(imageCopyStaysLine());
    fireEvent.click(document.querySelector("[data-k='remove-confirm']")!);
    await waitFor(() => expect(removed).toEqual(["p_1"]));
    // The page that was about the removed computer goes back to the list.
    await waitFor(() => expect(pageAt()).toBe("computers"));
  });

  it("gives a computer that is answering no line to run by hand: the host sweeps it over the link", async () => {
    useStore.setState({ places: [here, { ...laptop, present: true }] });
    await mountComputers(computersApi().api, { kind: "computer", id: "p_1" });
    fireEvent.click(document.querySelector("[data-settings-page] [data-k='remove']")!);
    expect(screen.getByText("Remove old-macbook?")).toBeTruthy();
    expect(document.querySelector("[data-k='leave-line']")).toBeNull();
  });
});

describe("the cloud's page", () => {
  const HASH = "a".repeat(63) + "1";
  const IMAGE: SealedImage = {
    name: "default",
    version: 2,
    hash: HASH,
    recipeHash: "recipe-1",
    logins: [{ name: "claude", state: "copied" }, { name: "gh", state: "signed-in" }],
    sealedAt: "2026-09-12T09:12:00.000Z",
    sealedFrom: "this Mac",
    vault: { sha256: "c".repeat(64), bytes: 4_200, paths: 7, takenAt: AT },
    usedBytes: 4.2 * 1024 ** 3,
  };
  const copy = { place: "hetzner", version: 1, hash: HASH, snapshotId: "snap_h", builtAt: "2026-09-12T10:00:00.000Z", sizeBytes: 4.2 * 1024 ** 3 };

  it("carries the spend, the image and Built as lines, Edit image under them, the copies as lines and Remove saying the key is forgotten, while the key is held", async () => {
    const api = computersApi(
      { image: async () => ({ image: IMAGE, copies: [copy], projects: [] }), spend: async () => [{ place: "solari", monthUsd: 4.12, rateUsdPerHour: 0.16 }] } as Partial<Api>,
      setupOf({ keys: { solari: true } }),
    ).api;
    useStore.setState({ places: [here, solari], workspaces: [atSolari("ws_y"), atSolari("ws_z")] });
    await mountComputers(api, { kind: "computer", id: "solari" });
    // The rate is what is running there, so the count of workspaces it is spread over is not said again: the
    // clause wrapped the value onto a second line at a phone's width to add nothing.
    expect(lineValue("spend")).toBe("$4.12 this month · $0.16/hr");
    expect(lineValue("image-facts")).toBe("v2 · 4.2 GB · 2 sign-ins");
    expect(lineValue("image-built")).toMatch(/^Sep 12 \d\d:\d\d · from this Mac$/);
    expect(document.querySelector("[data-k='edit-image']")?.textContent).toBe(IMAGE_WORDS.edit);
    expect([...document.querySelectorAll("[data-k='image-copy']")].map(row => [row.getAttribute("data-place"), row.querySelector("[data-settings-word]")?.textContent])).toEqual([["hetzner", expect.stringMatching(new RegExp(`^v1 · ${COPY_CURRENT} · 4.2 GB · `))]]);
    expect(descriptionOf("remove")).toBe(WHERE_WORDS.removeCloudDescription);
    fireEvent.click(document.querySelector("[data-k='edit-image']")!);
    expect(useStore.getState().setupOpen).toBe(true);
    await settle();
    expect(document.querySelector("[data-cloud-setup-dialog]")).not.toBeNull();
    act(() => useStore.getState().closeSetup());
    await settle();
  });

  it("says nothing about the image on a cloud whose key this host does not hold, and draws no card with nothing in it", async () => {
    // A cloud row stands on a workspace alone; the image is what this host's own key builds, so a page with no key
    // has no image line, no Edit image and no copies, and the card those would have stood in is not drawn.
    const api = computersApi({ image: async () => ({ image: IMAGE, copies: [copy], projects: [] }) } as Partial<Api>, setupOf({ keys: { solari: false } })).api;
    useStore.setState({ places: [here, solari], workspaces: [atSolari("ws_y")] });
    await mountComputers(api, { kind: "computer", id: "solari" });
    expect(document.querySelector("[data-k='image-facts']")).toBeNull();
    expect(document.querySelector("[data-k='image-built']")).toBeNull();
    expect(document.querySelector("[data-k='edit-image']")).toBeNull();
    expect(document.querySelector("[data-settings-card='copies']")).toBeNull();
    expect(document.querySelector("[data-settings-card='cloud']")).toBeNull();
    // Its one act stands, and the card that holds it is the only one on the page.
    expect([...document.querySelectorAll("[data-settings-page] [data-settings-card]")].map(card => card.getAttribute("data-settings-card"))).toEqual(["acts"]);
    // Remove is the neutral door, red only under the pointer, and the dialog's own button is the red one.
    const remove = document.querySelector<HTMLElement>("[data-settings-page] [data-k='remove']")!;
    expect(remove.className).not.toMatch(/warning/);
    expect(remove.className).toContain("[:hover,[data-pressed]]:text-destructive-foreground");
    fireEvent.click(remove);
    expect(document.querySelector<HTMLElement>("[data-k='remove-confirm']")!.className).toContain("bg-destructive");
  });

  it("says the image is not built with what will build it on hover, and draws no Built line and no copies before a build", async () => {
    const api = computersApi({ image: async () => ({ image: null, copies: [], projects: [] }) } as Partial<Api>, setupOf({ keys: { solari: true } })).api;
    useStore.setState({ places: [here, solari] });
    await mountComputers(api, { kind: "computer", id: "solari" });
    expect(lineValue("image-facts")).toBe(IMAGE_WORDS.notBuilt);
    expect(lineOf("image")?.getAttribute("title")).toBe(IMAGE_WORDS.firstBuild);
    expect(document.querySelector("[data-k='image-built']")).toBeNull();
    expect(document.querySelector("[data-settings-card='copies']")).toBeNull();
  });
});

describe("the Add a computer sheet", () => {
  const openSheet = async (over: Partial<Api> = {}) => {
    const fake = settingsApi(over);
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
    expect(document.activeElement).toBe(field);
    expect(document.querySelectorAll("[data-k='add-computer'] input")).toHaveLength(1);
    expect(document.querySelector("[data-slot='segmented-control']")).toBeNull();
    for (const said of [PLACES_WORDS.sheet.code, PLACES_WORDS.sheet.address, PLACES_WORDS.sheet.appRoad, "Get a box"]) {
      expect(document.body.textContent).not.toContain(said);
    }
  });

  it("says what a computer you own runs and what a closed lid does to the work already on it", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    const said = document.querySelector("[data-k='description']")?.textContent ?? "";
    expect(said).toBe(`${PLACES_WORDS.sheet.description} ${PLACES_WORDS.sheet.whileAsleep}`);
    expect(said).toContain(PLACE_CONNECTS);
    expect(document.querySelectorAll("[data-slot='sheet-description']").length).toBe(1);
  });

  it("holds Add until a login is typed, drawn as the outline with its reason in the field's own slot", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    const add = (): Element => document.querySelector("[data-k='ssh-add']")!;
    expect(add().hasAttribute("data-held")).toBe(true);
    expect(document.querySelector("[data-k='ssh-refusal']")?.textContent).toBe(ADD_COMPUTER_WORDS.loginFirst);
    expect(document.querySelector("[data-slot='tooltip-trigger']")).toBeNull();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    expect(add().hasAttribute("data-held")).toBe(false);
  });

  it("holds Add on a wsp whose host cannot log in over ssh at all", async () => {
    await openSheet();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("data-held")).toBe(true);
    expect(document.querySelector("[data-k='ssh-refusal']")?.textContent).toBe(ADD_COMPUTER_WORDS.noRoad);
  });

  const plan = (): [string | null, string | null][] => [...document.querySelectorAll("[data-k='plan'] [data-k='line']")].map(l => [l.textContent, l.getAttribute("data-state")]);
  const WAITING: [string, string][] = [
    [placeAddSheetWord("connect", "running"), "waiting"],
    [placeAddSheetWord("host-key", "running"), "waiting"],
    [`${placeAddSheetWord("wsp", "running")}${PLACE_INSTALL.weight}`, "waiting"],
    [placeAddSheetWord("service", "running"), "waiting"],
    [placeAddSheetWord("join", "running"), "waiting"],
    [placeAddSheetWord("provision", "running"), "waiting"],
  ];

  it("stands the plan under the field before Add is pressed and fills the same lines in as the installer reports them", async () => {
    let report: ((stage: InstallStage) => void) | undefined;
    await openSheet({ addComputerOverSsh: (_login: SshLogin, onStage: (stage: InstallStage) => void) => new Promise<PlaceView>(() => (report = onStage)) } as unknown as Partial<Api>);
    expect(plan()).toEqual(WAITING);
    expect(document.body.textContent).not.toContain("systemd");
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(document.querySelector<HTMLInputElement>("#add-computer-login")!.disabled).toBe(true));
    expect(document.querySelector<HTMLInputElement>("#add-computer-login")!.value).toBe("root@65.21.4.12");
    act(() => {
      report?.({ step: "connect", word: "connected · Ubuntu 24.04", state: "done" });
      report?.({ step: "wsp", word: "installing wsp 0.2.0", state: "running" });
    });
    expect(plan()[0]).toEqual(["connected · Ubuntu 24.04", "done"]);
    expect(plan()[2]).toEqual([`installing wsp 0.2.0${PLACE_INSTALL.weight}`, "running"]);
    act(() => report?.({ step: "wsp", word: "installing wsp 0.2.0", state: "done", fact: "9 s" }));
    expect(plan()[2]).toEqual(["installing wsp 0.2.09 s", "done"]);
    expect(plan()).toHaveLength(PlaceAddStep.options.length);
  });

  it("reads the box as joined once the installer answers with it, drawing its computer row and no table", async () => {
    await openSheet({ addComputerOverSsh: async () => box } as unknown as Partial<Api>);
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(document.querySelector("[data-k='title']")?.textContent).toBe("hetzner joined"));
    expect(document.querySelector("[data-k='description']")?.textContent).toBe(`${ADD_COMPUTER_WORDS.runsWorkspaces} ${PLACES_WORDS.sheet.whileAsleep}`);
    const row = document.querySelector("[data-k='joined-row'] [data-place-row='p_2']")!;
    expect(row.querySelector("[data-settings-title]")?.textContent).toBe("hetzner");
    expect(row.querySelector("[data-settings-description]")?.textContent).toBe(`${fmtSize(box.shape!, "cores")} · 38 GB`);
    expect(document.querySelector("[data-k='joined-row'] table")).toBeNull();
    expect(document.body.textContent).toContain(ADD_COMPUTER_WORDS.named);
  });

  it("runs the whole road on the client this app builds: Add sends places.add and the stages that ride it draw, ending on the row that says the box is in", async () => {
    ScriptedSocket.instances.length = 0;
    ScriptedSocket.reply = (f: Frame) => (f["op"] === "places.add" ? undefined : { id: f["id"], ok: true });
    const client = (live = new ProtocolClient({ url: "ws://test", token: "tok", WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket }));
    await client.connect();
    const sock = ScriptedSocket.instances[0]!;
    useStore.setState({ api: makeApi(client), places: [here] });
    render(<AddComputerSheet onClose={() => {}} now={() => NOW} />);
    await waitFor(() => expect(document.querySelector("[data-k='login-field']")).toBeTruthy());
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.keyDown(document.querySelector("#add-computer-login")!, { key: "Enter" });
    await waitFor(() => expect(sock.frames("places.add").length).toBe(1));
    const asked = sock.frames("places.add")[0]!;
    expect(asked).toMatchObject({ address: "root@65.21.4.12", addId: expect.any(String) });
    const addId = String(asked["addId"]);
    const stage = (step: string, state: string, note?: string): void => {
      sock.onmessage?.({ data: JSON.stringify({ type: "place.stage", addId, step, state, ...(note === undefined ? {} : { note }) }) });
    };
    await act(async () => {
      stage("connect", "done", "Ubuntu 24.04");
      stage("join", "running");
      await Promise.resolve();
    });
    expect(plan()[0]).toEqual([`${placeAddSheetWord("connect", "done")}Ubuntu 24.04`, "done"]);
    expect(plan()[4]).toEqual([placeAddSheetWord("join", "running"), "running"]);
    await act(async () => {
      stage("join", "done", "workspaces yes · engine none");
      sock.onmessage?.({ data: JSON.stringify({ id: asked["id"], ok: true, addId, place: box }) });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector("[data-k='title']")?.textContent).toBe(PLACES_WORDS.sheet.joinedTitle("hetzner")));
    expect(document.querySelector("[data-k='joined-row']")?.textContent).toContain("38 GB");
  });

  it("puts what ssh refused under the field and leaves it as it was", async () => {
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

  it("says Close on the button beside Add in both states and keeps every part it had once Add is pressed", async () => {
    let report: ((stage: InstallStage) => void) | undefined;
    await openSheet({ addComputerOverSsh: (_login: SshLogin, onStage: (stage: InstallStage) => void) => new Promise<PlaceView>(() => (report = onStage)) } as unknown as Partial<Api>);
    const parts = (): (string | null)[] => [...document.querySelectorAll("[data-slot='sheet-footer'] > *")].map(part => part.textContent);
    expect(parts()).toHaveLength(3);
    expect(parts()[1]).toBe(PLACES_WORDS.sheet.close);
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector("[data-k='ssh-add']")!);
    await waitFor(() => expect(document.querySelector<HTMLInputElement>("#add-computer-login")!.disabled).toBe(true));
    act(() => report?.({ step: "connect", word: "connected · Ubuntu 24.04", state: "done" }));
    expect(parts()).toHaveLength(3);
    expect(parts()[1]).toBe(PLACES_WORDS.sheet.close);
    expect(document.querySelector("[data-k='ssh-add']")?.hasAttribute("data-held")).toBe(true);
  });

  it("keeps what ssh said and the fix under it inside the slot's two lines, so the note under them does not move", () => {
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

  it("stands in the sidebar's foot with its chord, so Settings is never reachable only by a chord", () => {
    render(<SettingsRow />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("Settings");
    expect(row.textContent).toContain("⌘,");
    fireEvent.click(row);
    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it("opens the page with the sheet over it when a road asks for the sheet itself", async () => {
    useStore.getState().openAddComputer();
    expect(useStore.getState().settingsOpen).toBe(true);
    mountSettings({ api: settingsApi().api });
    await settle();
    expect(document.querySelector("[data-k='add-computer']")).toBeTruthy();
    expect(pageAt()).toBe("computers");
  });
});
