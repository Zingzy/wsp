// SPDX-License-Identifier: AGPL-3.0-only
// The Slate pane's Ask for one inside the right panel as the shell draws it: beside the thread in a wide window, and
// as a sheet over the thread in a narrow one, for a thread in a project folder and a thread on a box.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, WorkspaceView } from "@wsp/protocol";

vi.mock("../src/components/DiffWorkerPoolProvider.js", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { MountedComposer } from "../src/components/chat/testing.js";
import { requestComposerFocus } from "../src/shell/shellRequests.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { useSlateStore } from "../src/slate/store.js";
import type { SlateApi } from "../src/slate/wire.js";
import { resetSurfaces, view } from "./surface-harness.js";

const ASK = "Build a slate for this thread that shows ";

const FOLDER: WorkspaceView = { ...view, id: "ws_lab", name: "lab" };
const BOX: WorkspaceView = { ...view, id: "ws_box", name: "lab", place: "pl_box", provider: "box" };

const slates = {
  get: vi.fn(async () => ({ record: null })),
  subscribe: vi.fn(async () => {}),
  unsubscribe: vi.fn(async () => {}),
} as unknown as SlateApi;

function Panel({ workspaceId, mode, hidden = false }: { workspaceId: string; mode: "inline" | "sheet"; hidden?: boolean }) {
  const state = useRightPanelStore(s => s.byWorkspaceId[workspaceId]);
  return state?.isOpen === true ? <RightPanel workspaceId={workspaceId} state={state} mode={mode} hidden={hidden} /> : null;
}

function onThread(workspace: WorkspaceView, threadId: string) {
  const row: SessionView = { id: `s_${threadId}`, workspaceId: workspace.id, harness: "claude", status: "completed", threadId };
  useStore.setState({
    api: { slates, subscribe: () => () => {} } as unknown as Api,
    workspaces: [FOLDER, BOX],
    selectedId: workspace.id,
    selectedThreadId: threadId,
    sessions: { [workspace.id]: [row] },
  });
  act(() => useRightPanelStore.getState().open(workspace.id, "slate"));
}

beforeEach(() => {
  resetSurfaces();
  useSlateStore.setState({ byThread: {}, asking: {}, seen: {}, lastTurn: {}, linking: {} });
  useComposerDraftStore.setState({ drafts: {}, queues: {} });
});
afterEach(cleanup);

describe("Ask for one", () => {
  for (const workspace of [FOLDER, BOX]) {
    const where = workspace === FOLDER ? "a project folder" : "a box";

    it(`on a thread in ${where}, puts its words in that thread's composer, the caret at their end and focused, the panel kept open beside it`, async () => {
      onThread(workspace, "t1");
      render(
        <>
          <MountedComposer workspaceId={workspace.id} />
          <Panel workspaceId={workspace.id} mode="inline" />
        </>,
      );
      await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Ask for one" })));
      expect(useComposerDraftStore.getState().drafts[workspace.id]).toEqual({ prompt: ASK, cursor: ASK.length });
      expect(screen.getByTestId("composer-editor").textContent).toBe(ASK);
      expect(document.activeElement).toBe(screen.getByTestId("composer-editor"));
      expect(useRightPanelStore.getState().byWorkspaceId[workspace.id]?.isOpen).toBe(true);
    });

    it(`on a thread in ${where} in a narrow window, shuts the sheet that covers the composer and leaves the words and the focus there`, async () => {
      onThread(workspace, "t1");
      render(
        <>
          <MountedComposer workspaceId={workspace.id} />
          <Panel workspaceId={workspace.id} mode="sheet" />
        </>,
      );
      await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Ask for one" })));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(useRightPanelStore.getState().byWorkspaceId[workspace.id]?.isOpen).toBe(false);
      expect(screen.getByTestId("composer-editor").textContent).toBe(ASK);
      expect(document.activeElement).toBe(screen.getByTestId("composer-editor"));
    });
  }

  it("leaves the sheet open when another workspace's composer is asked for", async () => {
    onThread(FOLDER, "t1");
    render(<Panel workspaceId={FOLDER.id} mode="sheet" />);
    await screen.findByRole("button", { name: "Ask for one" });
    act(() => requestComposerFocus(BOX.id));
    expect(useRightPanelStore.getState().byWorkspaceId[FOLDER.id]?.isOpen).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("leaves a sheet hidden under a subagent's page open when Back asks for the lead's composer", () => {
    onThread(FOLDER, "t1");
    render(<Panel workspaceId={FOLDER.id} mode="sheet" hidden />);
    act(() => requestComposerFocus(FOLDER.id));
    expect(useRightPanelStore.getState().byWorkspaceId[FOLDER.id]?.isOpen).toBe(true);
  });
});
