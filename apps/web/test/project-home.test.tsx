// SPDX-License-Identifier: AGPL-3.0-only
// A project's home sending one message to several models: the computer's free
// room is read first, a send it has no room for is refused before any copy is
// made, and otherwise each model gets its own copy and the same message, the
// same images and one attempt id.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type PlaceView, type ProjectView, type WorkspaceView } from "@wsp/protocol";
import type { Api, StartSessionOptions } from "../src/protocol/client.js";
import { projectHomeKey, useStore } from "../src/protocol/store.js";
import { ProjectHome, noRoomLine } from "../src/shell/ProjectHome.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerFilesStore } from "../src/components/chat/composerFiles.js";
import { useMultiPickStore, type ModelPick } from "../src/components/chat/composerMultiPick.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { installFakeLayout } from "./fake-layout.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

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
  useComposerFilesStore.setState({ pending: {}, sent: {} });
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

  it("refuses in one sentence before any copy is made when the computer has room for fewer threads than the picks, and keeps the draft and the picks", async () => {
    const { api, created, started } = fakeApi(4);
    await mount(api);
    const editor = composerEditor();
    await typeInto(editor, "fix the flaky login test");
    await press(editor, "Enter");
    const line = noRoomLine(HERE_NAME, 2, "thread", 3);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(line));
    expect(created).toEqual([]);
    expect(started).toEqual([]);
    expect(useStore.getState().creations).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[HOME]?.prompt).toBe("fix the flaky login test");
    expect(useMultiPickStore.getState().byKey[HOME]).toEqual(PICKS);
  });
});
