// SPDX-License-Identifier: AGPL-3.0-only
// ChatView against a fixture event stream built in the @wsp/protocol
// vocabulary (shapes mirror packages/adapter-claude/test/fixtures/
// stream-session.jsonl). No live daemon; the fixture api replays history and
// pushes live events through the store's subscription.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeLayout } from "./fake-layout.js";
import type { EventUnion, SessionEvent, WorkspaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { ChatView } from "../src/components/chat/ChatView.js";
import { CHAT_STREAM, CHAT_T0, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());

const WS = CHAT_WS;
const scope = { workspaceId: WS, sessionId: "sess_0001", turnId: CHAT_TURN };
const T0 = CHAT_T0;

const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};

// The shared stream plus one fenced code block in the closing text, so the highlighter has work.
const FIXTURE: EventUnion[] = [
  ...CHAT_STREAM.slice(0, 6),
  { type: "session.delta", ...scope, at: T0 + 9_300, kind: "text", text: "Server is live at :3000.\n\n```ts\nconst port: number = 3000;\n```\n" },
  ...CHAT_STREAM.slice(7),
];

function fixtureApi(workspaces: WorkspaceView[], history: Record<string, SessionEvent[]> = {}) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    builderReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true }),
    listSessions: async () => [],
    watchStatuses: async () => [],
    createFromGoldenHead: async () => workspaces[0]!,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
    startSession: async opts => ({ id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running" }),
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit };
}

async function setup(api: Api, workspaceId = WS) {
  useStore.getState().bind(api);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<ChatView workspaceId={workspaceId} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const settledTurn = (ws: string, prompt: string, text: string, n = 1): SessionEvent[] => {
  const sc = { workspaceId: ws, sessionId: `sess_${ws}`, turnId: `turn_${ws}_${n}` };
  const start = T0 + n * 60_000;
  return [
    { type: "session.start", ...sc, at: start, model: "claude-sonnet-4-5", prompt },
    { type: "session.delta", ...sc, at: start + 300, kind: "text", text },
    { type: "session.done", ...sc, at: start + 900, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
    { type: "session.end", ...sc, at: start + 950, exitCode: 0, sawResult: true },
  ];
};

describe("ChatView", () => {
  it("shows the empty-thread headline with the workspace name before any turn", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("What should we build in api?");
    expect(screen.queryByTestId("settled-footer")).toBeNull();
  });

  it("replays the persisted transcript on mount and shows the settled footer", async () => {
    const { api } = fixtureApi([workspace], { [WS]: settledTurn(WS, "add a health route", "Added GET /health.") });
    await setup(api);
    await screen.findByText("Added GET /health.");
    expect(screen.getByText("add a health route")).toBeDefined();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const footer = screen.getByTestId("settled-footer");
    expect(footer.textContent).toContain("completed");
    expect(footer.textContent).toContain("Worked for 900ms");
    expect(footer.textContent).toContain("$0.0010");
  });

  it("renders the live fixture stream: grouped tool calls, collapsed thinking, highlighted code", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    // Up to and including the thinking delta: the turn is live.
    for (const e of FIXTURE.slice(0, 6)) emit(e);
    emit({ type: "session.delta", workspaceId: "ws_other", sessionId: "s2", kind: "text", text: "alien text" });
    await screen.findByText(/Creating the server file, then starting it\./);
    expect(screen.queryByText("alien text")).toBeNull();
    // The live row names the latest activity: the command, or the reasoning that followed it.
    expect(screen.getByText(/Working for/)).toBeDefined();
    expect(screen.getAllByText(/Ran node|Thinking|curl returned the greeting/).length).toBeGreaterThan(0);

    for (const e of FIXTURE.slice(6)) emit(e);
    // Assistant text is markdown; the fenced block is highlighted by shiki once the highlighter resolves.
    await screen.findByText(/Server is live at :3000\./);
    await waitFor(() => {
      const shiki = document.querySelector(".chat-markdown-shiki");
      expect(shiki?.innerHTML ?? "").toContain('<span style="color:');
    });
    expect(screen.queryByText(/Working for/)).toBeNull();

    // A settled turn folds its work behind one line; the fold opens onto the grouped tool calls.
    const fold = screen.getByRole("button", { name: /Worked for 10s/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Ran 1 command/ })).toBeNull();
    fireEvent.click(fold);
    const toggle = screen.getByRole("button", { name: /Ran 1 command/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Hello, World!")).toBeNull();
    await act(async () => { fireEvent.click(toggle); });
    const group = await screen.findByRole("region", { name: "Tool calls" });
    const bashRow = within(group).getByRole("button", { name: /node \/root\/server\.js/ });
    expect(bashRow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(bashRow);
    expect(within(group).getByText(/Hello, World!/)).toBeDefined();
    // Reasoning survives the settle as a row of its own; this one fits its preview, so there is nothing more to open.
    expect(within(group).getAllByText(/curl returned the greeting/)).toHaveLength(1);
    expect(within(group).queryByRole("button", { name: /curl returned the greeting/ })).toBeNull();

    const footer = screen.getByTestId("settled-footer");
    expect(footer.textContent).toContain("Worked for 10s");
    expect(footer.textContent).toContain("$0.02");
  });

  it("shows the working row while a turn runs and an error when it exits without a result", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "hi" });
    expect(screen.getByText(/Working/)).toBeDefined();
    emit({ type: "session.end", ...scope, exitCode: 137, sawResult: false });
    expect(screen.queryByText(/Working for/)).toBeNull();
    expect(screen.getByTestId("settled-footer").textContent).toContain("failed");
    expect(screen.getByText(/session exited without a result \(exit code 137\)/i)).toBeDefined();
  });

  it("virtualizes a long transcript instead of mounting every row", async () => {
    const turns = 300;
    const history = Array.from({ length: turns }, (_, i) => settledTurn(WS, `prompt ${i}`, `answer ${i}`, i)).flat();
    const { api } = fixtureApi([workspace], { [WS]: history });
    await setup(api);
    await screen.findByText("answer 299");
    const mounted = document.querySelectorAll("[data-timeline-root]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(turns);
  });
});
