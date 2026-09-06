// SPDX-License-Identifier: AGPL-3.0-only
// The import dialog over a fake api: a folder is read into one summary, the
// secrets box is the only loud element and only when the plan found one,
// ticks become carry and rewrite, the import's events fill the step rows,
// the landed line names the folder on the machine and what was cut, editing
// the path after a read drops the plan and its ticks, and a refusal prints the
// runtime's words with replace as the one follow-up.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventUnion, ProjectImportEvent, ProjectPlan, WorkspaceView } from "@wsp/protocol";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ImportProjectDialog } from "../src/sidebar/ImportProjectDialog.js";

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
};

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
    capabilities: vi.fn(async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true })),
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
    importProject: vi.fn(async () => ({ dest: plan.source, files: 11, bytes: 2_900, parts: 1, cut: [] as string[], rewritten: [".git/config"] })),
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

async function readFolder(root: HTMLElement, path = "/var/proj"): Promise<void> {
  const input = within(root).getByLabelText("Folder on this Mac") as HTMLInputElement;
  fireEvent.change(input, { target: { value: path } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(value(root, "files")).not.toBe(""));
}

describe("import project dialog", () => {
  it("opens with the workspace named, empty summary rows, six muted steps, the path input alone in a browser tab, and no way to import yet", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    expect(within(root).getByText("Import a project")).toBeDefined();
    expect(within(root).getByText(/Into api\./)).toBeDefined();
    for (const k of ["repository", "files", "caches", "skipped", "dest"]) expect(value(root, k)).toBe("");
    expect(root.querySelectorAll("[data-step]")).toHaveLength(6);
    expect(Array.from(root.querySelectorAll("[data-step]")).map(el => el.getAttribute("data-step"))).toEqual(["planned", "consented", "packing", "uploading", "landing", "done"]);
    expect(root.querySelector("[data-k=secrets]")).toBeNull();
    expect((within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(root).queryByRole("button", { name: /folder/ })).toBeNull();
  });

  it("reads the typed folder on Enter into the summary, keeps the path as typed, and lands at the plan's realpath", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    expect(api.planProject).toHaveBeenCalledWith("/var/proj");
    expect((within(root).getByLabelText("Folder on this Mac") as HTMLInputElement).value).toBe("/var/proj");
    expect(value(root, "repository")).toBe("git, .git travels whole");
    expect(value(root, "files")).toBe("12 files · 3.0 KB");
    expect(value(root, "caches")).toBe("node_modules, dist");
    expect(value(root, "skipped")).toBe("1 path");
    expect(root.querySelector<HTMLElement>("[data-k=skipped]")!.title).toBe("link-out: points outside the folder; not followed");
    expect(value(root, "dest")).toBe("/private/var/proj");
    expect((within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the secrets box only when the plan found one, with the rewrite ticked and the plain file not, each row's words following its tick", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    const box = root.querySelector<HTMLElement>("[data-k=secrets]")!;
    expect(within(box).getByText("2 secret-shaped files")).toBeDefined();
    const env = within(box).getByRole("checkbox", { name: /\.env/ });
    const config = within(box).getByRole("checkbox", { name: /\.git\/config/ });
    expect(env.getAttribute("aria-checked")).toBe("false");
    expect(config.getAttribute("aria-checked")).toBe("true");
    const offers = (): string[] => Array.from(box.querySelectorAll<HTMLElement>("[data-k=offer]")).map(el => el.textContent ?? "");
    expect(offers()).toEqual(["cut", "lands bare at github.com"]);
    expect(box.querySelectorAll<HTMLElement>("[data-k=offer]")[1]!.title).toBe("lands bare at https://github.com/o/r");
    expect(within(box).getByText("name, keys · 120 B")).toBeDefined();
    fireEvent.click(env);
    fireEvent.click(config);
    expect(offers()).toEqual(["travels as it is", "cut"]);
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

  it("with no secret-shaped file the box is not rendered", async () => {
    const { api } = fakeApi({ ...PLAN, secrets: [] });
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    expect(root.querySelector("[data-k=secrets]")).toBeNull();
    expect(root.querySelectorAll("[data-step]")).toHaveLength(6);
  });

  it("Import sends the ticks as carry and rewrite with dest at the realpath, fills the steps from events, and names what landed and what was cut", async () => {
    const { api, emit } = fakeApi();
    useStore.getState().bind(api);
    const onClose = vi.fn();
    render(<ImportProjectDialog workspace={workspace} onClose={onClose} />);
    const root = await dialog();
    await readFolder(root);
    fireEvent.click(within(root).getByRole("checkbox", { name: /\.env/ }));
    let finish!: () => void;
    api.importProject.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ dest: "/private/var/proj", files: 11, bytes: 2_900, parts: 1, cut: ["keys/id_ed25519"], rewritten: [".git/config"] }); }));
    fireEvent.click(within(root).getByRole("button", { name: "Import" }));
    expect(api.importProject).toHaveBeenCalledWith({ workspaceId: "ws_a", source: "/var/proj", dest: "/private/var/proj", carry: [".env"], rewrite: [".git/config"] });
    expect((within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
    // The import runs on the runtime whatever this dialog does, so it cannot be dismissed while it runs, and the status line says so.
    expect((within(root).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(root).getByRole("status").textContent).toBe("Importing. This stays open until it lands; closing it would not stop the import.");
    fireEvent.keyDown(root, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    emit(event({}));
    emit(event({ stage: "consented", message: "Carrying .env; rewriting .git/config to https://github.com/o/r; nothing cut.", elapsedMs: 20 }));
    emit(event({ stage: "uploading", message: "Part 1 of 2, 1.4 KB of 2.8 KB.", elapsedMs: 50, bytes: 1_400, total: 2_800 }));
    emit(event({ source: "/var/other", stage: "landing", message: "Landing at /var/other.", elapsedMs: 60 }));
    expect(step(root, "planned").textContent).toContain("12 files, 3.0 KB and the repository");
    expect(step(root, "consented").textContent).toContain("Carrying .env; rewriting .git/config");
    expect(step(root, "uploading").textContent).toContain("Part 1 of 2");
    expect(step(root, "uploading").querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("50");
    expect(step(root, "landing").textContent).not.toContain("/var/other");

    emit(event({ stage: "landing", message: "Landing at /private/var/proj.", elapsedMs: 70 }));
    emit(event({ stage: "done", message: "11 files, 2.8 KB, landed at /private/var/proj.", elapsedMs: 80 }));
    await act(async () => finish());
    await waitFor(() => expect(within(root).getByRole("status").textContent).toBe("proj is at /private/var/proj on api; cut keys/id_ed25519."));
    expect(within(root).queryByRole("button", { name: "Cancel" })).toBeNull();
    const done = within(root).getByRole("button", { name: "Done" });
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalled();
  });

  it("a refusal prints the runtime's words in one line, and an existing destination offers replace", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    await readFolder(root);
    api.importProject.mockRejectedValueOnce(new RequestError("/private/var/proj exists on the machine", "exists"));
    fireEvent.click(within(root).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(within(root).getByRole("status").textContent).toBe("/private/var/proj exists on the machine"));
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
    expect(value(root, "files")).toBe("");
    expect((within(root).getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("with the desktop bridge the button opens the system picker and reads what it returns", async () => {
    const { api } = fakeApi();
    useStore.getState().bind(api);
    const pickFolder = vi.fn(async () => "/Users/me/code/proj");
    (window as { wsp?: unknown }).wsp = { pickFolder };
    render(<ImportProjectDialog workspace={workspace} onClose={() => {}} />);
    const root = await dialog();
    fireEvent.click(within(root).getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(api.planProject).toHaveBeenCalledWith("/Users/me/code/proj"));
    expect((within(root).getByLabelText("Folder on this Mac") as HTMLInputElement).value).toBe("/Users/me/code/proj");
    pickFolder.mockResolvedValueOnce(undefined as unknown as string);
    fireEvent.click(within(root).getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(2));
    expect(api.planProject).toHaveBeenCalledTimes(1);
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
