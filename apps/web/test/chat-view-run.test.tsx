// SPDX-License-Identifier: AGPL-3.0-only
// A reply's shell block run from the thread view: the run goes to the thread's own folder, the one the transcript's
// start named, and the workspace's thread folder where no start named one yet.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionEvent, WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { ChatView } from "../src/components/chat/ChatView.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const started = vi.hoisted(() => [] as { cwd?: string }[]);
vi.mock("../src/components/chat/replyRun.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/components/chat/replyRun.js")>()),
  startRun: async (_api: unknown, target: { cwd?: string }) => {
    started.push(target);
    return "run-1";
  },
}));

let restoreLayout: () => void = () => {};
beforeAll(() => {
  restoreLayout = installFakeLayout();
});
afterAll(() => restoreLayout());

const WS = "ws_run";
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  project: { id: "pr_1", name: "the-project", path: "/root/app", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};

const turn = (cwd: string | undefined): SessionEvent[] => {
  const sc = { workspaceId: WS, sessionId: "sess_run", turnId: "turn_run", threadId: "thr_run" };
  return [
    { type: "session.start", ...sc, at: 1, model: "claude-sonnet-4-5", prompt: "stop them", ...(cwd !== undefined ? { cwd } : {}) },
    { type: "session.delta", ...sc, at: 2, kind: "text", text: "Stop them:\n\n```sh\nkill 60082 60083\n```\n" },
    { type: "session.done", ...sc, at: 3, result: { status: "completed", durationMs: 1, costUsd: 0 } },
    { type: "session.end", ...sc, at: 4, exitCode: 0, sawResult: true },
  ];
};

function fixtureApi(history: SessionEvent[]): Api {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  return {
    daemon: noDaemonApi,
    sessionHistory: async () => history,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    capabilities: async () => caps(),
    listSessions: async () => [],
    watchStatuses: async () => [],
    subscribe: (fn: (e: ProtocolEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getGolden: async () => undefined,
    recordRun: async () => ({}) as never,
    startSession: async (opts: { workspaceId: string }) => ({ id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running" }),
  } as unknown as Api;
}

async function runFirstBlock(history: SessionEvent[]): Promise<{ cwd?: string }> {
  started.length = 0;
  useStore.getState().bind(fixtureApi(history));
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<ChatView workspaceId={WS} threadId="thr_run" />);
  await screen.findByText("Stop them:");
  const button = await waitFor(() => {
    const found = document.querySelector<HTMLElement>("[data-reply-run-button]");
    expect(found).not.toBeNull();
    return found!;
  });
  fireEvent.click(button);
  await waitFor(() => expect(started).toHaveLength(1));
  view.unmount();
  return started[0]!;
}

describe("Run from the thread view", () => {
  it("runs in the folder the thread's start named", async () => {
    expect((await runFirstBlock(turn("/root/app-copy"))).cwd).toBe("/root/app-copy");
  });

  it("runs in the workspace's thread folder where no start named one, never in the daemon's own default", async () => {
    expect((await runFirstBlock(turn(undefined))).cwd).toBe("/root/app");
  });
});
