// SPDX-License-Identifier: AGPL-3.0-only
// The import dialog over a fake api: a folder is read into one summary, the
// agents with sessions for it are ticked rows whose ids the request names,
// the secret-shaped rows are quiet and only there when the plan found one,
// ticks become carry and rewrite, the import's events fill the one progress
// line, the landed line names the folder on the machine and what was left
// out, editing the path after a read drops the plan and its ticks, and a
// refusal prints the runtime's words with replace as the one follow-up.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSIONS_NOTE, secretsNote, type EventUnion, type HostFolder, type HostFolderListing, type ProjectAgent, type ProjectImportEvent, type ProjectPlan, type WorkspaceView } from "@wsp/protocol";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ImportProjectDialog } from "../src/sidebar/ImportProjectDialog.js";
import { useLastFolderStore } from "../src/sidebar/lastFolderStore.js";

const workspace: WorkspaceView = { id: "ws_a", name: "api", machineId: "m_a", phase: "running", golden: "snap_g", createdAt: "2026-09-05T11:00:00Z" };

const PLAN: ProjectPlan = {
  source: "/private/var/proj",
  repo: true,
  files: 12,
  bytes: 3_072,
  secrets: [
    { path: ".env", bytes: 120, signals: ["name", "keys"] },
    { path: ".git/config", bytes: 300, signals: ["url"], rewrite: { urls: ["https://github.com/o/r"], drop: [] } },
  ],
  excluded: ["node_modules", "dist"],
  skipped: [{ path: "link-out", note: "points outside the folder; not followed" }],
  agents: [],
};

const AGENTS: ProjectAgent[] = [
  { agent: "claude", name: "Claude Code", sessions: 46, bytes: 9_400_000, carry: "moves" },
  { agent: "codex", name: "Codex", sessions: 1, bytes: 12_000, carry: "transcript-only" },
];

/** This Mac's folders as the host lists them: the home folder and an imported project as the roots, one dot-named
 * folder held back inside code, and nothing outside the roots. */
const ROOTS = ["/Users/dev", "/Volumes/work/api"];
const LEVELS: Record<string, HostFolder[]> = {
  "/Users/dev": [{ path: "/Users/dev/code", repo: false }, { path: "/Users/dev/notes", repo: false }],
  "/Users/dev/code": [{ path: "/Users/dev/code/spoo", repo: true }],
  "/Users/dev/code/spoo": [],
  "/Volumes/work/api": [{ path: "/Volumes/work/api/src", repo: false }],
};
const HELD: Record<string, HostFolder[]> = { "/Users/dev/code": [{ path: "/Users/dev/code/.cache", repo: false }] };
/** A folder this Mac will not let the host read: with no Files and Folders grant readdir comes back EACCES, which is
 * what a clicked Documents, Desktop or Downloads gives on a real Mac. */
const REFUSED: Record<string, string> = { "/Users/dev/notes": "EACCES: permission denied, scandir '/Users/dev/notes'" };

function fakeFolders() {
  const asked: { dir?: string; hidden?: boolean }[] = [];
  const hostFolders = async (dir?: string, hidden?: boolean): Promise<HostFolderListing> => {
    asked.push({ dir, hidden });
    const at = dir ?? ROOTS[0]!;
    const refusal = REFUSED[at];
    if (refusal !== undefined) throw new Error(refusal);
    const level = LEVELS[at];
    if (level === undefined) throw new Error(`${at} is outside the folders wsp browses on this computer: ${ROOTS.join(", ")}`);
    const held = HELD[at] ?? [];
    const folders = [...level, ...(hidden === true ? held : [])].sort((a, b) => a.path.localeCompare(b.path));
    return { dir: at, roots: ROOTS, folders, hidden: held.length };
  };
  return { hostFolders, asked };
}

const event = (over: Partial<ProjectImportEvent>): EventUnion => ({
  type: "project.import",
  workspaceId: "ws_a",
  source: "/private/var/proj",
  dest: "/private/var/proj",
  stage: "planned",
  message: "12 files, 3.0 KB and the repository; 2 secret-shaped files; 2 caches left behind.",
  elapsedMs: 10,
  ...over,
});

function fakeApi(plan: ProjectPlan = PLAN) {
  const listeners = new Set<(e: EventUnion) => void>();
  const api = {
    listWorkspaces: vi.fn(async () => [workspace]),
    getWorkspace: vi.fn(async () => workspace),
    createWorkspace: vi.fn(async () => workspace),
    createFromGoldenHead: vi.fn(async () => workspace),
    watchStatuses: vi.fn(async () => []),
    nap: vi.fn(async () => workspace),
    wake: vi.fn(async () => workspace),
    upgrade: vi.fn(async () => workspace),
    capabilities: vi.fn(async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, sizes: [] })),
    startSession: vi.fn(async () => ({ id: "s1", workspaceId: "ws_a", harness: "claude", status: "running" as const })),
    portReach: vi.fn(async () => ({ url: "https://x", expiresAt: 0 })),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    sessionHistory: vi.fn(async () => []),
    listSnapshots: vi.fn(async () => ({ name: "default", head: null, versions: [] })),
    snapshotStorage: async () => null,
    rollbackSnapshot: vi.fn(async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const })),
    listSessions: vi.fn(async () => []),
    getGolden: async () => undefined,
    planProject: vi.fn(async (_source: string) => plan),
    importProject: vi.fn(async () => ({ dest: plan.source, files: 11, bytes: 2_900, parts: 1, cut: [] as string[], rewritten: [".git/config"], agents: [] })),
    subscribe: vi.fn((fn: (e: EventUnion) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
  } satisfies Api;
  const emit = (e: EventUnion): void => act(() => listeners.forEach(fn => fn(e)));
  return { api, emit };
}

beforeEach(() => {
  useStore.setState({ api: null, workspaces: [workspace], conn: "live" });
  useLastFolderStore.setState({ folder: null });
  delete (window as { wsp?: unknown }).wsp;
  // Base UI's checkbox re-dispatches a click as a PointerEvent, which jsdom does not have.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const dialog = async (): Promise<HTMLElement> => screen.findByRole("dialog");
const value = (root: HTMLElement, k: string): string => root.querySelector<HTMLElement>(`[data-k="${k}"]`)!.textContent ?? "";
/** The one slot above the footer: its words, which are also the dialog's status, and the bar's percent when the bar is drawn. */
const progress = (root: HTMLElement): { line: string; percent: string | null } => {
  const box = root.querySelector<HTMLElement>("[data-k=progress]")!;
  const line = box.querySelector<HTMLElement>("[data-k=progress-line]")!;
  expect(line).toBe(within(root).getByRole("status"));
  return { line: line.textContent ?? "", percent: box.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow") ?? null };
};

const browseRows = (root: HTMLElement): string[] => Array.from(root.querySelectorAll<HTMLElement>("[data-k=browse-folder]")).map(el => el.textContent ?? "");
const repoMarks = (root: HTMLElement): boolean[] =>
  Array.from(root.querySelectorAll<HTMLElement>("[data-k=browse-folder]")).map(el => (el.querySelector("svg")?.getAttribute("class") ?? "").includes("folder-git"));
const crumbs = (root: HTMLElement): string[] => Array.from(root.querySelectorAll<HTMLElement>("[data-folder-crumb]")).map(el => el.textContent ?? "");
const folderRow = (root: HTMLElement, path: string): HTMLElement => root.querySelector<HTMLElement>(`[data-folder="${path}"]`)!;
const usePicked = (root: HTMLElement): boolean => fireEvent.click(within(root).getByRole("button", { name: "Use this folder" }));

async function readFolder(root: HTMLElement, path = "/var/proj"): Promise<void> {
  const input = within(root).getByLabelText("Folder on this Mac") as HTMLInputElement;
  fireEvent.change(input, { target: { value: path } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(value(root, "files")).not.toBe(""));
}

describe("import project dialog", () => {
  it("opens with one short line under the title, empty summary rows, an empty progress line and no ledger, the path input alone in a browser tab, and no way to import yet", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    expect(within(root).getByText("Import a project")).toBeDefined();
    expect(within(root).getByText("Into api, at the same path.")).toBeDefined();
    for (const k of ["repository", "files", "caches", "skipped", "dest"]) expect(value(root, k)).toBe("");
    expect(root.querySelectorAll("[data-step]")).toHaveLength(0);
    expect(progress(root)).toEqual({ line: "", percent: null });
    expect(root.querySelector("[data-k=secrets]")).toBeNull();
    const importButton = within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
    // The accent sits on Import alone; Cancel is a bordered neutral key.
    expect(importButton.className).toContain("bg-primary");
    expect(within(root).getByRole("button", { name: "Cancel" }).className).not.toContain("bg-primary");
    expect(within(root).queryByRole("button", { name: /folder/ })).toBeNull();
  });

  it("in a browser tab a folder browser follows the field: a row goes into its folder, a crumb comes back out, the repository is marked, and Use this folder is what reads the plan", async () => {
    const { api } = fakeApi();
    const { hostFolders, asked } = fakeFolders();
    useStore.getState().bind({ ...api, hostFolders });
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await waitFor(() => expect(browseRows(root)).toEqual(["code", "notes"]));
    expect(asked).toEqual([{ dir: undefined, hidden: false }]);
    expect(crumbs(root)).toEqual(["/Users/dev"]);
    expect(value(root, "browse-state")).toBe("2 folders in /Users/dev.");

    fireEvent.click(folderRow(root, "/Users/dev/code"));
    await waitFor(() => expect(browseRows(root)).toEqual(["spoo"]));
    expect(crumbs(root)).toEqual(["/Users/dev", "code"]);
    expect(repoMarks(root)).toEqual([true]);
    expect(value(root, "browse-state")).toBe("1 folder in /Users/dev/code, 1 hidden.");

    // Walking costs nothing: the folder is read only when it is named.
    fireEvent.click(within(root).getByRole("button", { name: "/Users/dev" }));
    await waitFor(() => expect(browseRows(root)).toEqual(["code", "notes"]));
    expect(api.planProject).not.toHaveBeenCalled();

    fireEvent.click(folderRow(root, "/Users/dev/code"));
    await waitFor(() => expect(crumbs(root)).toEqual(["/Users/dev", "code"]));
    usePicked(root);
    await waitFor(() => expect(value(root, "files")).not.toBe(""));
    expect(api.planProject).toHaveBeenCalledWith("/Users/dev/code");
    expect((within(root).getByLabelText("Folder on this Mac") as HTMLInputElement).value).toBe("/Users/dev/code");
    expect((within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("counts the dot-named folders in the state words and lists them only while they are asked for", async () => {
    const { api } = fakeApi();
    const { hostFolders, asked } = fakeFolders();
    useStore.getState().bind({ ...api, hostFolders });
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await waitFor(() => expect(browseRows(root)).toEqual(["code", "notes"]));
    // The home folder holds none, so there is nothing to offer there.
    expect(root.querySelector("[data-k=browse-hidden]")).toBeNull();
    fireEvent.click(folderRow(root, "/Users/dev/code"));
    await waitFor(() => expect(browseRows(root)).toEqual(["spoo"]));
    const toggle = (): HTMLElement => root.querySelector<HTMLElement>("[data-k=browse-hidden]")!;
    expect(toggle().textContent).toBe("show hidden");
    fireEvent.click(toggle());
    await waitFor(() => expect(browseRows(root)).toEqual([".cache", "spoo"]));
    expect(asked.at(-1)).toEqual({ dir: "/Users/dev/code", hidden: true });
    expect(toggle().textContent).toBe("hide hidden");
    fireEvent.click(toggle());
    await waitFor(() => expect(browseRows(root)).toEqual(["spoo"]));
  });

  it("a folder this Mac will not let the host read says so in the state slot and leaves the list on the level it was on", async () => {
    const { api } = fakeApi();
    const { hostFolders, asked } = fakeFolders();
    useStore.getState().bind({ ...api, hostFolders });
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await waitFor(() => expect(browseRows(root)).toEqual(["code", "notes"]));

    fireEvent.click(folderRow(root, "/Users/dev/notes"));
    await waitFor(() => expect(value(root, "browse-state")).toBe("No folders read. EACCES: permission denied, scandir '/Users/dev/notes'"));
    expect(browseRows(root)).toEqual(["code", "notes"]);
    expect(crumbs(root)).toEqual(["/Users/dev"]);
    // Read, not walked away from: nothing re-asks the first root behind the person's back.
    expect(asked).toEqual([{ dir: undefined, hidden: false }, { dir: "/Users/dev/notes", hidden: false }]);
  });

  it("opens above the folder the last import was read from, and one the roots no longer hold opens at the first root instead", async () => {
    const { api } = fakeApi();
    const { hostFolders, asked } = fakeFolders();
    useLastFolderStore.setState({ folder: "/Users/dev/code/spoo" });
    useStore.getState().bind({ ...api, hostFolders });
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await waitFor(() => expect(browseRows(root)).toEqual(["spoo"]));
    expect(asked).toEqual([{ dir: "/Users/dev/code", hidden: false }]);
    cleanup();

    useLastFolderStore.setState({ folder: "/elsewhere/old/proj" });
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const again = await dialog();
    await waitFor(() => expect(browseRows(again)).toEqual(["code", "notes"]));
    expect(asked.slice(1)).toEqual([{ dir: "/elsewhere/old", hidden: false }, { dir: undefined, hidden: false }]);
    expect(value(again, "browse-state")).toBe("2 folders in /Users/dev.");
  });

  it("remembers the folder an import landed from, so the next open browses beside it", async () => {
    const { api } = fakeApi();
    const { hostFolders, asked } = fakeFolders();
    useStore.getState().bind({ ...api, hostFolders });
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root, "/Users/dev/code/spoo");
    fireEvent.click(within(root).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(useLastFolderStore.getState().folder).toBe("/Users/dev/code/spoo"));
    cleanup();

    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const again = await dialog();
    await waitFor(() => expect(browseRows(again)).toEqual(["spoo"]));
    expect(asked.at(-1)).toEqual({ dir: "/Users/dev/code", hidden: false });
  });

  it("with the desktop shell's bridge the system picker stands where it did and no browser is drawn", async () => {
    (window as { wsp?: { pickFolder: () => Promise<string | undefined> } }).wsp = { pickFolder: async () => "/Users/dev/code/spoo" };
    const { api } = fakeApi();
    const { hostFolders, asked } = fakeFolders();
    useStore.getState().bind({ ...api, hostFolders });
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    expect(root.querySelector("[data-k=browse]")).toBeNull();
    expect(asked).toEqual([]);
    fireEvent.click(within(root).getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(value(root, "files")).not.toBe(""));
    expect(api.planProject).toHaveBeenCalledWith("/Users/dev/code/spoo");
  });

  it("reads the typed folder on Enter into the summary, keeps the path as typed, and lands at the plan's realpath", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    expect(api.planProject).toHaveBeenCalledWith("/var/proj");
    expect((within(root).getByLabelText("Folder on this Mac") as HTMLInputElement).value).toBe("/var/proj");
    expect(value(root, "repository")).toBe("Git repository, history travels");
    expect(root.querySelector<HTMLElement>("[data-k=repository]")!.className).not.toContain("font-mono");
    expect(value(root, "files")).toBe("12 files · 3.0 KB");
    expect(root.querySelector<HTMLElement>("[data-k=files]")!.className).toContain("font-mono");
    expect(value(root, "caches")).toBe("2 folders");
    expect(root.querySelector("[data-k=cache-list]")).toBeNull();
    fireEvent.click(within(root).getByRole("button", { name: "2 folders" }));
    expect(value(root, "cache-list")).toBe("node_modules, dist");
    expect(value(root, "skipped")).toBe("1 path");
    expect(root.querySelector<HTMLElement>("[data-k=skipped]")!.title).toBe("link-out: points outside the folder; not followed");
    expect(value(root, "dest")).toBe("/private/var/proj");
    expect((within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the secret-shaped rows only when the plan found one, as plain rows with no fill or border colour, the rewrite ticked and the plain file not, each row's words following its tick", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    const box = root.querySelector<HTMLElement>("[data-k=secrets]")!;
    // Information, not a failure: the section carries no tint of its own and is dressed as every other section.
    expect(box.className).not.toMatch(/warning|bg-/);
    expect(box.className).toBe(root.querySelector<HTMLElement>("[data-k=summary]")!.className);
    expect(within(box).getByText(secretsNote(2))).toBeDefined();
    expect(within(box).getByRole("checkbox", { name: /\.env/ }).closest("li")!.title).toBe(".env: name, keys, 120 B");
    const env = within(box).getByRole("checkbox", { name: /\.env/ });
    const config = within(box).getByRole("checkbox", { name: /\.git\/config/ });
    expect(env.getAttribute("aria-checked")).toBe("false");
    expect(config.getAttribute("aria-checked")).toBe("true");
    for (const tick of within(root).getAllByRole("checkbox")) expect(tick.getAttribute("data-tone")).toBe("neutral");
    const offers = (): string[] => Array.from(box.querySelectorAll<HTMLElement>("[data-k=offer]")).map(el => el.textContent ?? "");
    expect(offers()).toEqual(["left out", "rewritten without keys"]);
    expect(box.querySelectorAll<HTMLElement>("[data-k=offer]")[1]!.title).toBe("rewritten without keys; the remote reads https://github.com/o/r");
    expect(within(box).queryByText(/name, keys/)).toBeNull();
    fireEvent.click(env);
    fireEvent.click(config);
    expect(offers()).toEqual(["travels as is", "left out"]);
  });

  it("editing the path after a read drops the plan and the ticks, and Import waits for the folder to be read again", async () => {
    const { api } = fakeApi();
    api.planProject.mockImplementation(async (source: string) => ({ ...PLAN, source: `/private${source}` }));
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    fireEvent.click(within(root).getByRole("checkbox", { name: /\.env/ }));
    const input = within(root).getByLabelText("Folder on this Mac");
    fireEvent.change(input, { target: { value: "/var/other" } });
    expect((within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
    expect(value(root, "files")).toBe("");
    expect(value(root, "dest")).toBe("");
    expect(root.querySelector("[data-k=secrets]")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(value(root, "dest")).toBe("/private/var/other"));
    expect(within(root).getByRole("checkbox", { name: /\.env/ }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(root).getByRole("button", { name: "Import" }));
    expect(api.importProject).toHaveBeenCalledWith({ workspaceId: "ws_a", source: "/var/other", dest: "/private/var/other", carry: [], rewrite: [".git/config"] });
  });

  it("one ticked row per agent with sessions, named as the plan names it with its count in muted mono, and Import names both ids", async () => {
    const { api } = fakeApi({ ...PLAN, agents: AGENTS });
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    const box = root.querySelector<HTMLElement>("[data-k=agents]")!;
    expect(within(box).getByText(SESSIONS_NOTE)).toBeDefined();
    expect(within(box).queryByText(/on this Mac/)).toBeNull();
    const rows = within(box).getAllByRole("checkbox");
    expect(rows.map(r => r.getAttribute("aria-label"))).toEqual(["Claude Code", "Codex"]);
    expect(rows.map(r => r.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(Array.from(box.querySelectorAll<HTMLElement>("[data-k=state]")).map(el => el.textContent)).toEqual(["46 sessions", "1 session"]);
    fireEvent.click(within(root).getByRole("button", { name: "Import" }));
    expect(api.importProject).toHaveBeenCalledWith({ workspaceId: "ws_a", source: "/var/proj", dest: "/private/var/proj", carry: [], rewrite: [".git/config"], agents: ["claude", "codex"] });
  });

  it("unticking an agent drops it from the request, and unticking every one sends no agents at all", async () => {
    const { api } = fakeApi({ ...PLAN, agents: AGENTS });
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    const codex = within(root).getByRole("checkbox", { name: "Codex" });
    fireEvent.click(codex);
    expect(codex.getAttribute("aria-checked")).toBe("false");
    api.importProject.mockRejectedValueOnce(new RequestError("/private/var/proj exists on the machine", "exists"));
    fireEvent.click(within(root).getByRole("button", { name: "Import" }));
    expect(api.importProject).toHaveBeenLastCalledWith({ workspaceId: "ws_a", source: "/var/proj", dest: "/private/var/proj", carry: [], rewrite: [".git/config"], agents: ["claude"] });
    await waitFor(() => expect(within(root).getByRole("button", { name: "Replace and import" })).toBeDefined());
    fireEvent.click(within(root).getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.click(within(root).getByRole("button", { name: "Replace and import" }));
    expect(api.importProject).toHaveBeenLastCalledWith({ workspaceId: "ws_a", source: "/var/proj", dest: "/private/var/proj", carry: [], rewrite: [".git/config"], replace: true });
  });

  it("an agent whose store could not be read renders unticked with the error as its words and cannot be ticked", async () => {
    const { api } = fakeApi({ ...PLAN, agents: [AGENTS[0]!, { agent: "opencode", name: "OpenCode", sessions: 0, bytes: 0, carry: "moves", error: "state.db is locked by another process" }] });
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    const box = root.querySelector<HTMLElement>("[data-k=agents]")!;
    const opencode = within(box).getByRole("checkbox", { name: "OpenCode" });
    expect(opencode.getAttribute("aria-checked")).toBe("false");
    expect(opencode.hasAttribute("disabled") || opencode.getAttribute("aria-disabled") === "true").toBe(true);
    expect(Array.from(box.querySelectorAll<HTMLElement>("[data-k=state]")).map(el => el.textContent)).toEqual(["46 sessions", "state.db is locked by another process"]);
    fireEvent.click(opencode);
    expect(opencode.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(root).getByRole("button", { name: "Import" }));
    expect(api.importProject).toHaveBeenCalledWith({ workspaceId: "ws_a", source: "/var/proj", dest: "/private/var/proj", carry: [], rewrite: [".git/config"], agents: ["claude"] });
  });

  it("with no agent the rows are not rendered, and editing the path after a read drops the agent ticks with the plan", async () => {
    const { api } = fakeApi({ ...PLAN, agents: AGENTS });
    api.planProject.mockImplementation(async (source: string) => ({ ...PLAN, agents: AGENTS, source: `/private${source}` }));
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    expect(root.querySelector("[data-k=agents]")).toBeNull();
    await readFolder(root);
    fireEvent.click(within(root).getByRole("checkbox", { name: "Codex" }));
    const input = within(root).getByLabelText("Folder on this Mac");
    fireEvent.change(input, { target: { value: "/var/other" } });
    expect(root.querySelector("[data-k=agents]")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(value(root, "dest")).toBe("/private/var/other"));
    expect(within(root).getByRole("checkbox", { name: "Codex" }).getAttribute("aria-checked")).toBe("true");
  });

  it("with no secret-shaped file the section is not rendered, and a repository-less folder says so in words", async () => {
    const { api } = fakeApi({ ...PLAN, secrets: [], repo: false, excluded: [] });
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    expect(root.querySelector("[data-k=secrets]")).toBeNull();
    expect(value(root, "repository")).toBe("No repository");
    expect(value(root, "caches")).toBe("none");
    expect(within(root).queryByRole("button", { name: "none" })).toBeNull();
  });

  it("Import sends the ticks as carry and rewrite with dest at the realpath, reads each event as the one progress line, and names what landed and what was left out", async () => {
    const { api, emit } = fakeApi();
    useStore.getState().bind(api);
    const onClose = vi.fn();
    render(<ImportProjectDialog workspace={workspace} onClose={onClose} />);
    const root = await dialog();
    await readFolder(root);
    fireEvent.click(within(root).getByRole("checkbox", { name: /\.env/ }));
    let finish!: () => void;
    api.importProject.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ dest: "/private/var/proj", files: 11, bytes: 2_900, parts: 1, cut: ["keys/id_ed25519"], rewritten: [".git/config"], agents: [] }); }));
    fireEvent.click(within(root).getByRole("button", { name: "Import" }));
    expect(api.importProject).toHaveBeenCalledWith({ workspaceId: "ws_a", source: "/var/proj", dest: "/private/var/proj", carry: [".env"], rewrite: [".git/config"] });
    expect((within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
    // The import runs on the runtime whatever this dialog does, so it cannot be dismissed while it runs, and the status line says so.
    expect((within(root).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(root).getByRole("status").textContent).toBe("");
    fireEvent.keyDown(root, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(progress(root)).toEqual({ line: "", percent: null });

    emit(event({}));
    expect(progress(root)).toEqual({ line: "Starting", percent: "0" });
    emit(event({ stage: "consented", message: "Carrying .env; rewriting .git/config to https://github.com/o/r; nothing cut.", elapsedMs: 20 }));
    expect(progress(root)).toEqual({ line: "Starting", percent: "0" });
    emit(event({ stage: "packing", message: "Packing 11 files.", elapsedMs: 30 }));
    expect(progress(root)).toEqual({ line: "Packing 11 files", percent: "0" });
    emit(event({ stage: "uploading", message: "Part 1 of 2, 1.4 KB of 2.8 KB.", elapsedMs: 50, bytes: 1_400, total: 2_800 }));
    expect(progress(root)).toEqual({ line: "Uploading 2.7 KB", percent: "50" });
    emit(event({ source: "/var/other", stage: "landing", message: "Landing at /var/other.", elapsedMs: 60 }));
    expect(progress(root)).toEqual({ line: "Uploading 2.7 KB", percent: "50" });

    emit(event({ stage: "landing", message: "Landing at /private/var/proj.", elapsedMs: 70 }));
    expect(progress(root)).toEqual({ line: "Landing on api", percent: "100" });
    emit(event({ stage: "done", message: "11 files, 2.8 KB, landed at /private/var/proj.", elapsedMs: 80 }));
    expect(progress(root)).toEqual({ line: "Done", percent: "100" });
    await act(async () => finish());
    // At done the slot says one thing, the landed line, over the full bar; the Done key is the only other word.
    await waitFor(() => expect(progress(root)).toEqual({ line: "proj is at /private/var/proj on api; 1 file left out, listed above.", percent: "100" }));
    expect(within(root).queryByRole("button", { name: "Cancel" })).toBeNull();
    const done = within(root).getByRole("button", { name: "Done" });
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalled();
  });

  it("a refusal prints the runtime's words in one line and clears the progress line, and an existing destination offers replace", async () => {
    const { api, emit } = fakeApi();
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    let refuse!: () => void;
    api.importProject.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = () => reject(new RequestError("/private/var/proj exists on the machine", "exists")); }));
    fireEvent.click(within(root).getByRole("button", { name: "Import" }));
    emit(event({ stage: "packing", message: "Packing 11 files.", elapsedMs: 30 }));
    expect(progress(root)).toEqual({ line: "Packing 11 files", percent: "0" });
    await act(async () => refuse());
    await waitFor(() => expect(within(root).getByRole("status").textContent).toBe("/private/var/proj exists on the machine"));
    expect(progress(root)).toEqual({ line: "/private/var/proj exists on the machine", percent: null });
    // A replace is a caution to confirm, not a failure: the confirm colour, as the export dialog's.
    expect(within(root).getByRole("status").className).toContain("text-warning-foreground");
    const replace = within(root).getByRole("button", { name: "Replace and import" }) as HTMLButtonElement;
    expect(replace.disabled).toBe(false);
    fireEvent.click(replace);
    expect(api.importProject).toHaveBeenLastCalledWith({ workspaceId: "ws_a", source: "/var/proj", dest: "/private/var/proj", carry: [], rewrite: [".git/config"], replace: true });
  });

  it("a folder the runtime cannot plan prints its words and leaves the summary empty", async () => {
    const { api } = fakeApi();
    api.planProject.mockRejectedValueOnce(new RequestError("git ls-files failed in /var/proj: not a git repository"));
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    const input = within(root).getByLabelText("Folder on this Mac");
    fireEvent.change(input, { target: { value: "/var/proj" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(root).getByRole("status").textContent).toBe("Reading the folder.");
    await waitFor(() => expect(within(root).getByRole("status").textContent).toBe("git ls-files failed in /var/proj: not a git repository"));
    expect(within(root).getByRole("status").className).toContain("text-destructive-foreground");
    expect(value(root, "files")).toBe("");
    expect((within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("with the desktop bridge the folder is a picker row, no typed field: the key opens the system picker, the path it returns reads in mono and the key becomes Change", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    const pickFolder = vi.fn(async () => "/Users/me/code/proj");
    (window as { wsp?: unknown }).wsp = { pickFolder };
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    expect(within(root).queryByLabelText("Folder on this Mac")).toBeNull();
    expect(root.querySelector("input")).toBeNull();
    expect(value(root, "path")).toBe("/Users/you/code/project");
    fireEvent.click(within(root).getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(api.planProject).toHaveBeenCalledWith("/Users/me/code/proj"));
    const folder = root.querySelector<HTMLElement>("[data-k=path]")!;
    expect(folder.textContent).toBe("/Users/me/code/proj");
    expect(folder.className).toContain("font-mono");
    expect(within(root).queryByRole("button", { name: "Choose folder" })).toBeNull();
    pickFolder.mockResolvedValueOnce(undefined as unknown as string);
    fireEvent.click(within(root).getByRole("button", { name: "Change" }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(2));
    expect(api.planProject).toHaveBeenCalledTimes(1);
    expect(folder.textContent).toBe("/Users/me/code/proj");
  });

  it("a folder handed in opens already read", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} initialSource="/var/proj" onClose={() => {}} />);
    const root = await dialog();
    await waitFor(() => expect(value(root, "files")).toBe("12 files · 3.0 KB"));
    expect(api.planProject).toHaveBeenCalledWith("/var/proj");
  });
});
