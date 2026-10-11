// SPDX-License-Identifier: AGPL-3.0-only
// A project's home sending one message to several models: the computer's free
// room is read first, a send it has no room for is refused before any copy is
// made, and otherwise each model gets its own copy and the same message, the
// same images and one attempt id.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type PlaceView, type ProjectBranch, type ProjectView, type WorkspaceView } from "@wsp/protocol";
import type { Api, StartSessionOptions } from "../src/protocol/client.js";
import { projectHomeKey, useStore } from "../src/protocol/store.js";
import { ProjectHome, noRoomLine } from "../src/shell/ProjectHome.js";
import { BRANCH_REREAD_MS } from "../src/components/chat/ComposerCheckoutRow.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerFilesStore } from "../src/components/chat/composerFiles.js";
import { useMultiPickStore, type ModelPick } from "../src/components/chat/composerMultiPick.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { installFakeLayout } from "./fake-layout.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices, lastNotice } from "./notice-text.js";

const PROJECT: ProjectView = { id: "pr_1", name: "the-project", computer: "here", source: { kind: "folder", path: "/root" }, path: "/root", remote: "https://github.com/dev/the-project.git", defaultBranch: "main", memoryKey: "-root", memoryDir: "/root/.claude-cfg/projects/-root/memory", createdAt: "t" };
const HOME = projectHomeKey(PROJECT.id);
const HERE_NAME = "zingzy's MacBook Pro";

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.257",
  models: [
    { value: "claude-opus-5", label: "Opus 5", isDefault: true },
    { value: "claude-sonnet-5", label: "Sonnet 5" },
  ],
  efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High", isDefault: true }],
  contextWindows: [],
  permissionModes: [],
  steers: true,
  renames: true,
  images: true,
};
const CODEX: HarnessCatalog = { harness: "codex", label: "Codex", source: "table", version: null, models: [{ value: "gpt-6-astra", label: "GPT-6 Astra" }], efforts: [{ value: "high", label: "High" }], contextWindows: [], permissionModes: [], steers: false, renames: false, images: true };

const PICKS: ModelPick[] = [
  { harness: "claude", model: "claude-opus-5", label: "Opus 5" },
  { harness: "claude", model: "claude-sonnet-5", label: "Sonnet 5" },
  { harness: "codex", model: "gpt-6-astra", label: "GPT-6 Astra" },
];

/** This computer with its cap of six threads and `running` of them running. */
const here = (running: number): PlaceView => ({ id: "here", kind: "computer", name: "here", label: HERE_NAME, default: true, cap: { threads: 6 }, running });

function fakeApi(running: number) {
  const created: string[] = [];
  const started: StartSessionOptions[] = [];
  const workspace = (id: string, name: string): WorkspaceView => ({ id, name, machineId: "local", project: { id: PROJECT.id, name: PROJECT.name, path: "/root", computer: "here" }, phase: "running", golden: "", createdAt: "2026-09-27T00:00:00Z" });
  const api: Api = {
    preferences: async () => DEFAULT_PREFERENCES,
    listHarnesses: async () => [CLAUDE, CODEX],
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [],
    getWorkspace: async id => workspace(id, id),
    createWorkspace: async (_project, name) => {
      created.push(name);
      return workspace(`ws_${created.length}`, name);
    },
    nap: async id => workspace(id, id),
    wake: async id => workspace(id, id),
    capabilities: async () => caps(),
    listSessions: async () => [],
    watchStatuses: async () => [],
    subscribe: () => () => {},
    getGolden: async () => undefined,
    workspacesLanding: async () => ({ name: HERE_NAME, capabilities: caps() }),
    placesList: async () => ({ places: [here(running)], adds: [] }),
    startSession: async o => {
      started.push(o);
      return { id: `s_${started.length}`, workspaceId: o.workspaceId, harness: o.harness ?? "claude", status: "running" };
    },
  };
  return { api, created, started };
}

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} });
  useComposerFilesStore.setState({ pending: {}, refused: {}, queued: {}, sent: {} });
  useMultiPickStore.setState({ byKey: { [HOME]: PICKS } });
});
afterEach(cleanup);

async function mount(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], creations: [], statuses: {}, sessions: {}, harnesses: [], harnessesByWorkspace: {}, preferences: DEFAULT_PREFERENCES, projects: [PROJECT] });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  render(<ProjectHome projectId={PROJECT.id} />);
  await waitFor(() => expect(document.querySelector('[data-composer-picker="model"][data-value]')).not.toBeNull());
}

describe("a project's home sending to several models", () => {
  it("makes one copy per model, named by the task and the model, and starts the same message and images in each under one attempt", async () => {
    const { api, created, started } = fakeApi(3);
    const image = { id: "img_1", mediaType: "image/png", name: "shot.png", bytes: "iVBORw0KGgo=", url: "blob:shot", size: 8 };
    useComposerFilesStore.setState({ pending: { [HOME]: [image] }, sent: {} });
    useComposerOptionsStore.setState({ byWorkspaceId: { [HOME]: { effort: "low" } }, pickedOn: {} });
    await mount(api);
    expect(screen.getByRole("button", { name: "Send to 3" })).toBeTruthy();
    const editor = composerEditor();
    await typeInto(editor, "fix the flaky login test");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(3));
    expect([...created].sort()).toEqual(["fix the flaky login test (GPT-6 Astra)", "fix the flaky login test (Opus 5)", "fix the flaky login test (Sonnet 5)"]);
    const byModel = Object.fromEntries(started.map(s => [s.model, s]));
    expect(Object.keys(byModel).sort()).toEqual(["claude-opus-5", "claude-sonnet-5", "gpt-6-astra"]);
    expect(byModel["gpt-6-astra"]).toMatchObject({ harness: "codex", prompt: "fix the flaky login test" });
    expect(byModel["claude-sonnet-5"]).toMatchObject({ harness: "claude", prompt: "fix the flaky login test", effort: "low" });
    // Each start carries the home's picks as that agent's own list takes them: Codex lists no low effort.
    expect(byModel["gpt-6-astra"]).not.toHaveProperty("effort");
    const attempts = new Set(started.map(s => s.attempt));
    expect(attempts.size).toBe(1);
    expect([...attempts][0]).toEqual(expect.any(String));
    expect(new Set(started.map(s => s.requestId)).size).toBe(3);
    expect(new Set(started.map(s => s.workspaceId)).size).toBe(3);
    for (const s of started) expect(s.attachments).toEqual([{ mediaType: "image/png", bytes: "iVBORw0KGgo=", name: "shot.png" }]);
    // The list and the images went with the send, so the home is empty again.
    expect(useMultiPickStore.getState().byKey[HOME]).toBeUndefined();
    expect(useComposerFilesStore.getState().pending[HOME]).toBeUndefined();
  });

  it("refuses in one flyout before any copy is made when the computer has room for fewer threads than the picks, and keeps the draft and the picks", async () => {
    const { api, created, started } = fakeApi(4);
    await mount(api);
    clearNotices();
    const editor = composerEditor();
    await typeInto(editor, "fix the flaky login test");
    await press(editor, "Enter");
    const line = noRoomLine(HERE_NAME, 2, "thread", 3);
    // A flyout, since the composer has no line above its box.
    await waitFor(() => expect(lastNotice()).toBe(line));
    expect(document.querySelector("[data-composer-refusal]")).toBeNull();
    expect(created).toEqual([]);
    expect(started).toEqual([]);
    expect(useStore.getState().creations).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[HOME]?.prompt).toBe("fix the flaky login test");
    expect(useMultiPickStore.getState().byKey[HOME]).toEqual(PICKS);
  });
});

describe("the branch under a project home's composer", () => {
  const OTHER: ProjectView = { ...PROJECT, id: "pr_2", name: "the-other", path: "/srv/other", source: { kind: "folder", path: "/srv/other" } };
  const branchOf = () => document.querySelector<HTMLElement>("[data-composer-branch]")?.dataset["composerBranch"];

  /** A host whose folders are on the branches `on` names, by project id; an id held back answers once let go. */
  function branchApi(on: Record<string, ProjectBranch>) {
    const asked: string[] = [];
    const held = new Map<string, () => void>();
    const hold = new Set<string>();
    const api: Api = {
      ...fakeApi(0).api,
      projectBranch: async id => {
        asked.push(id);
        if (hold.has(id)) await new Promise<void>(go => held.set(id, go));
        return on[id]!;
      },
    };
    return { api, asked, hold, release: (id: string) => (hold.delete(id), held.get(id)?.()) };
  }

  async function home(api: Api, projectId: string) {
    useMultiPickStore.setState({ byKey: {} });
    useStore.setState({ conn: "connecting", workspaces: [], creations: [], statuses: {}, sessions: {}, harnesses: [], harnessesByWorkspace: {}, preferences: DEFAULT_PREFERENCES, projects: [PROJECT, OTHER] });
    useStore.getState().bind(api);
    useStore.getState().setConn("live");
    return render(<ProjectHome projectId={projectId} />);
  }

  it("names the branch the project's folder is on, not the remote's default the record keeps", async () => {
    const { api } = branchApi({ [PROJECT.id]: { branch: "feature-x", folder: true } });
    await home(api, PROJECT.id);
    await waitFor(() => expect(branchOf()).toBe("feature-x"));
    expect(PROJECT.defaultBranch).toBe("main");
  });

  it("names the new project's own branch on a switch, and nothing of the last one's while its read is out", async () => {
    const on = { [PROJECT.id]: { branch: "feature-x", folder: true }, [OTHER.id]: { branch: "wt-branch", folder: true } };
    const { api, hold, release } = branchApi(on);
    const shown = await home(api, PROJECT.id);
    await waitFor(() => expect(branchOf()).toBe("feature-x"));
    hold.add(OTHER.id);
    shown.rerender(<ProjectHome projectId={OTHER.id} />);
    await waitFor(() => expect(document.querySelector("[data-composer-folder]")?.getAttribute("data-composer-folder")).toBe("/srv/other"));
    expect(branchOf()).toBe("");
    release(OTHER.id);
    await waitFor(() => expect(branchOf()).toBe("wt-branch"));
    shown.rerender(<ProjectHome projectId={PROJECT.id} />);
    await waitFor(() => expect(branchOf()).toBe("feature-x"));
  });

  it("reads the folder's branch again every few seconds and when the window comes back, so a checkout made in a terminal shows", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const on = { [PROJECT.id]: { branch: "feature-x", folder: true } };
      const { api, asked } = branchApi(on);
      await home(api, PROJECT.id);
      await waitFor(() => expect(branchOf()).toBe("feature-x"));
      on[PROJECT.id] = { branch: "main", folder: true };
      const before = asked.length;
      await act(async () => void vi.advanceTimersByTime(BRANCH_REREAD_MS));
      await waitFor(() => expect(branchOf()).toBe("main"));
      expect(asked.length).toBe(before + 1);
      on[PROJECT.id] = { branch: "hotfix", folder: true };
      act(() => void window.dispatchEvent(new Event("focus")));
      await waitFor(() => expect(branchOf()).toBe("hotfix"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes empty when a read fails, rather than keep a branch the folder may have left", async () => {
    const on: Record<string, ProjectBranch> = { [PROJECT.id]: { branch: "feature-x", folder: true } };
    const { api } = branchApi(on);
    await home(api, PROJECT.id);
    await waitFor(() => expect(branchOf()).toBe("feature-x"));
    api.projectBranch = async () => {
      throw new Error("the box did not answer");
    };
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(branchOf()).toBe(""));
  });

  it("says on hover that a project on a computer that copies it starts its copy on that branch, read once", async () => {
    const { api, asked } = branchApi({ [PROJECT.id]: { branch: "release", folder: false } });
    await home(api, PROJECT.id);
    await waitFor(() => expect(branchOf()).toBe("release"));
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(asked).toEqual([PROJECT.id]);
    fireEvent.focus(document.querySelector<HTMLElement>("[data-composer-branch]")!);
    await waitFor(() => expect(screen.getByText("The branch a new copy of the project starts from.")).toBeTruthy());
  });
});
