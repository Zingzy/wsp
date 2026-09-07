// SPDX-License-Identifier: AGPL-3.0-only
// The export dialog over a fake api: the folder on the machine opens as the
// thread's folder with the Mac destination mirroring it until edited or
// picked, the workspace's threads give the agent rows and their ticks the
// request, the export's events fill the step rows, the landed line names the
// folder and each row what became of its sessions, an existing destination prints the
// runtime's words as the one loud line with Replace and export as the one
// follow-up, and any other refusal prints its words and leaves Export as it was.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventUnion, HostFolderListing, ProjectExportEvent, ProjectExportResult, SessionView, WorkspaceView } from "@wsp/protocol";
import { useRootStore } from "../src/files/root.js";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ExportProjectDialog } from "../src/sidebar/ExportProjectDialog.js";

const workspace: WorkspaceView = { id: "ws_a", name: "api", machineId: "m_a", phase: "running", golden: "snap_g", createdAt: "2026-09-05T11:00:00Z" };
const SOURCE = "/root/proj";

const session = (id: string, harness: string): SessionView => ({ id, workspaceId: "ws_a", harness, status: "completed", threadId: `t_${id}` });

const LANDED: ProjectExportResult = {
  dest: SOURCE,
  files: 11,
  bytes: 2_900,
  excluded: ["node_modules"],
  agents: [
    { agent: "claude", files: 2, bytes: 400, outcome: "moved", sessions: 2 },
    { agent: "codex", files: 1, bytes: 200, outcome: "transcript-only", sessions: 1, skipped: 1 },
  ],
};

const event = (over: Partial<ProjectExportEvent>): EventUnion => ({
  type: "project.export",
  workspaceId: "ws_a",
  source: SOURCE,
  dest: SOURCE,
  stage: "packing",
  message: "Packing /root/proj on the machine.",
  elapsedMs: 10,
  ...over,
});

const THREADS = [session("s1", "claude"), session("s2", "codex"), session("s3", "claude")];

/** This Mac's folders as the host lists them, home the only root. */
const LEVELS: Record<string, string[]> = { "/Users/me": ["/Users/me/code"], "/Users/me/code": ["/Users/me/code/archive"], "/Users/me/code/archive": [] };
function fakeFolders() {
  const asked: (string | undefined)[] = [];
  const hostFolders = async (dir?: string): Promise<HostFolderListing> => {
    asked.push(dir);
    const at = dir ?? "/Users/me";
    return { dir: at, roots: ["/Users/me"], folders: LEVELS[at]!.map(path => ({ path, repo: false })), hidden: 0 };
  };
  return { hostFolders, asked };
}

function fakeApi(sessions: SessionView[] = THREADS) {
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
    listSessions: vi.fn(async () => sessions),
    getGolden: async () => undefined,
    exportProject: vi.fn(async () => LANDED),
    subscribe: vi.fn((fn: (e: EventUnion) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
  } satisfies Api;
  const emit = (e: EventUnion): void => act(() => listeners.forEach(fn => fn(e)));
  return { api, emit };
}

beforeEach(() => {
  useStore.setState({ api: null, workspaces: [workspace], conn: "live", sessions: {} });
  useRootStore.setState({ byWorkspaceId: {} });
  useRootStore.getState().follow("ws_a", SOURCE);
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
const step = (root: HTMLElement, stage: string): HTMLElement => root.querySelector<HTMLElement>(`[data-step="${stage}"]`)!;
const field = (root: HTMLElement, label: string): HTMLInputElement => within(root).getByLabelText(label) as HTMLInputElement;
const button = (root: HTMLElement, name: string): HTMLButtonElement => within(root).getByRole("button", { name }) as HTMLButtonElement;
const outcomes = (root: HTMLElement): string[] => Array.from(root.querySelectorAll<HTMLElement>("[data-k=outcome]")).map(el => el.textContent ?? "");
/** The dialog once the store has the workspace's threads, which arrive after bind. */
const codexRow = (root: HTMLElement): Promise<HTMLElement> => within(root).findByRole("checkbox", { name: "Codex" });

describe("export project dialog", () => {
  it("opens on the thread's folder with the Mac destination mirroring it, one ticked row per agent with a thread named as the catalog names it, empty summary rows, four muted steps, the path inputs alone in a browser tab", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ExportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    expect(within(root).getByText("Export a project")).toBeDefined();
    expect(within(root).getByText(/From api\./)).toBeDefined();
    expect(field(root, "Folder on the machine").value).toBe(SOURCE);
    expect(field(root, "Folder on this Mac").value).toBe(SOURCE);
    await codexRow(root);
    const rows = within(root.querySelector<HTMLElement>("[data-k=agents]")!).getAllByRole("checkbox");
    expect(rows.map(r => r.getAttribute("aria-label"))).toEqual(["Claude Code", "Codex"]);
    expect(rows.map(r => r.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(outcomes(root)).toEqual(["", ""]);
    for (const k of ["files", "caches"]) expect(value(root, k)).toBe("");
    expect(Array.from(root.querySelectorAll("[data-step]")).map(el => el.getAttribute("data-step"))).toEqual(["packing", "downloading", "landing", "done"]);
    expect(button(root, "Export").disabled).toBe(false);
    expect(within(root).queryByRole("button", { name: /folder/ })).toBeNull();
  });

  it("without a thread folder or a daemon root the inputs open empty and Export waits for a folder", async () => {
    useRootStore.setState({ byWorkspaceId: {} });
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ExportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    expect(field(root, "Folder on the machine").value).toBe("");
    expect(button(root, "Export").disabled).toBe(true);
    fireEvent.change(field(root, "Folder on the machine"), { target: { value: "/root/other" } });
    expect(field(root, "Folder on this Mac").value).toBe("/root/other");
    expect(button(root, "Export").disabled).toBe(false);
  });

  it("with no threads the agents box says every agent with sessions comes along and the request names none", async () => {
    const { api } = fakeApi([]);
    useStore.getState().bind(api);
    render(<ExportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await waitFor(() => expect(api.listSessions).toHaveBeenCalled());
    expect(root.querySelectorAll("[data-k=agents] [role=checkbox]")).toHaveLength(0);
    expect(within(root).getByText(/No threads here/)).toBeDefined();
    fireEvent.click(button(root, "Export"));
    expect(api.exportProject).toHaveBeenCalledWith({ workspaceId: "ws_a", source: SOURCE, dest: SOURCE });
  });

  it("the destination follows the machine folder until it is edited; the picker lands the folder inside the picked one under its own name", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    const pickFolder = vi.fn(async () => "/Users/me/code");
    (window as { wsp?: unknown }).wsp = { pickFolder };
    render(<ExportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    fireEvent.change(field(root, "Folder on the machine"), { target: { value: "/root/work/spoo" } });
    expect(field(root, "Folder on this Mac").value).toBe("/root/work/spoo");
    fireEvent.click(button(root, "Choose folder"));
    await waitFor(() => expect(field(root, "Folder on this Mac").value).toBe("/Users/me/code/spoo"));
    fireEvent.change(field(root, "Folder on the machine"), { target: { value: "/root/work/other" } });
    expect(field(root, "Folder on this Mac").value).toBe("/Users/me/code/spoo");
    pickFolder.mockResolvedValueOnce(undefined as unknown as string);
    fireEvent.click(button(root, "Choose folder"));
    await waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(2));
    expect(field(root, "Folder on this Mac").value).toBe("/Users/me/code/spoo");
    fireEvent.change(field(root, "Folder on this Mac"), { target: { value: "/Users/me/other" } });
    fireEvent.click(button(root, "Export"));
    expect(api.exportProject).toHaveBeenCalledWith({ workspaceId: "ws_a", source: "/root/work/other", dest: "/Users/me/other" });
  });

  it("in a browser tab the destination is browsed instead of picked: the folder lands inside the folder shown, under its own name", async () => {
    const { api } = fakeApi();
    const { hostFolders, asked } = fakeFolders();
    useStore.getState().bind({ ...api, hostFolders });
    render(<ExportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    const rows = (): string[] => Array.from(root.querySelectorAll<HTMLElement>("[data-k=browse-folder]")).map(el => el.textContent ?? "");
    await waitFor(() => expect(rows()).toEqual(["code"]));
    expect(asked).toEqual([undefined]);
    expect(value(root, "browse-state")).toBe("1 folder in /Users/me.");
    fireEvent.change(field(root, "Folder on the machine"), { target: { value: "/root/work/spoo" } });
    fireEvent.click(root.querySelector<HTMLElement>('[data-folder="/Users/me/code"]')!);
    await waitFor(() => expect(rows()).toEqual(["archive"]));
    // Walking does not name a destination; the one action does.
    expect(field(root, "Folder on this Mac").value).toBe("/root/work/spoo");
    fireEvent.click(button(root, "Use this folder"));
    expect(field(root, "Folder on this Mac").value).toBe("/Users/me/code/spoo");
    fireEvent.click(button(root, "Export"));
    expect(api.exportProject).toHaveBeenCalledWith({ workspaceId: "ws_a", source: "/root/work/spoo", dest: "/Users/me/code/spoo" });
  });

  it("with the desktop shell's bridge the system picker stands where it did and no browser is drawn", async () => {
    const { api } = fakeApi();
    const { hostFolders, asked } = fakeFolders();
    (window as { wsp?: unknown }).wsp = { pickFolder: async () => "/Users/me/code" };
    useStore.getState().bind({ ...api, hostFolders });
    render(<ExportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    expect(root.querySelector("[data-k=browse]")).toBeNull();
    expect(asked).toEqual([]);
    fireEvent.click(button(root, "Choose folder"));
    await waitFor(() => expect(field(root, "Folder on this Mac").value).toBe("/Users/me/code/proj"));
  });

  it("an unticked agent narrows the request to the ticked ones; ticking every row again asks for none", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ExportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    const codex = await codexRow(root);
    fireEvent.click(codex);
    expect(codex.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(button(root, "Export"));
    expect(api.exportProject).toHaveBeenLastCalledWith({ workspaceId: "ws_a", source: SOURCE, dest: SOURCE, agents: ["claude"] });
  });

  it("Export fills the steps from its own events, then the summary, each row's outcome and the landed line name what came home, and Done closes", async () => {
    const { api, emit } = fakeApi();
    useStore.getState().bind(api);
    const onClose = vi.fn();
    render(<ExportProjectDialog workspace={workspace} onClose={onClose} />);
    const root = await dialog();
    await codexRow(root);
    let finish!: () => void;
    api.exportProject.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(LANDED); }));
    fireEvent.click(button(root, "Export"));
    expect(api.exportProject).toHaveBeenCalledWith({ workspaceId: "ws_a", source: SOURCE, dest: SOURCE });
    expect(button(root, "Export").disabled).toBe(true);
    expect(button(root, "Cancel").disabled).toBe(true);
    expect(field(root, "Folder on this Mac").disabled).toBe(true);
    const codex = within(root).getByRole("checkbox", { name: "Codex" });
    expect(codex.hasAttribute("disabled") || codex.getAttribute("aria-disabled") === "true").toBe(true);
    expect(within(root).getByRole("status").textContent).toBe("Exporting. This stays open until it lands; closing it would not stop the export.");
    fireEvent.keyDown(root, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    emit(event({}));
    emit(event({ stage: "downloading", message: "The folder: 1.4 KB of 2.8 KB.", elapsedMs: 50, bytes: 1_400, total: 2_800 }));
    emit(event({ dest: "/Users/me/other", stage: "landing", message: "Landing at /Users/me/other.", elapsedMs: 60 }));
    expect(step(root, "packing").textContent).toContain("Packing /root/proj on the machine.");
    expect(step(root, "downloading").textContent).toContain("1.4 KB of 2.8 KB");
    expect(step(root, "downloading").querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("50");
    expect(step(root, "landing").textContent).not.toContain("/Users/me/other");

    emit(event({ stage: "landing", message: "Landing at /root/proj.", elapsedMs: 70 }));
    emit(event({ stage: "done", message: "11 files, 2.8 KB, landed at /root/proj; 1 cache left behind; sessions: Claude Code (2 sessions) moved.", elapsedMs: 80 }));
    await act(async () => finish());
    await waitFor(() => expect(within(root).getByRole("status").textContent).toBe("proj is at /root/proj on this Mac."));
    expect(value(root, "files")).toBe("11 files · 2.8 KB");
    expect(value(root, "caches")).toBe("node_modules");
    expect(outcomes(root)).toEqual(["moved", "transcripts landed, not yet listed, 1 rollout skipped"]);
    expect(within(root).queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(button(root, "Done"));
    expect(onClose).toHaveBeenCalled();
  });

  it("an existing destination prints the runtime's words as the one loud line, the action becomes Replace and export, and editing the destination drops the refusal", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ExportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    const words = "/root/proj already exists on this computer with 12 files; export with replace to overwrite it";
    api.exportProject.mockRejectedValueOnce(new RequestError(words, "exists"));
    fireEvent.click(button(root, "Export"));
    await waitFor(() => expect(within(root).getByRole("status").textContent).toBe(words));
    expect(within(root).getByRole("status").className).toContain("text-warning-foreground");
    const replace = button(root, "Replace and export");
    expect(replace.disabled).toBe(false);
    expect(within(root).queryByRole("button", { name: "Export" })).toBeNull();
    fireEvent.change(field(root, "Folder on this Mac"), { target: { value: "/Users/me/elsewhere" } });
    expect(within(root).getByRole("status").textContent).toBe("");
    expect(button(root, "Export").disabled).toBe(false);
    api.exportProject.mockRejectedValueOnce(new RequestError(words, "exists"));
    fireEvent.click(button(root, "Export"));
    await waitFor(() => expect(within(root).queryByRole("button", { name: "Replace and export" })).not.toBeNull());
    fireEvent.click(button(root, "Replace and export"));
    expect(api.exportProject).toHaveBeenLastCalledWith({ workspaceId: "ws_a", source: SOURCE, dest: "/Users/me/elsewhere", replace: true });
  });

  it("any other refusal prints its words in the error colour and Export stays Export", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ExportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    api.exportProject.mockRejectedValueOnce(new RequestError("/root/proj is not a folder on the machine"));
    fireEvent.click(button(root, "Export"));
    await waitFor(() => expect(within(root).getByRole("status").textContent).toBe("/root/proj is not a folder on the machine"));
    expect(within(root).getByRole("status").className).toContain("text-destructive-foreground");
    expect(button(root, "Export").disabled).toBe(false);
    expect(step(root, "packing").textContent?.trim()).toBe("packing");
  });
});
