// SPDX-License-Identifier: AGPL-3.0-only
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessCatalog, SessionView } from "@wsp/protocol";
import { useStore } from "../../protocol/store";
import { useComposerPicks } from "./ComposerOptionPickers";
import { useComposerOptionsStore } from "./composerOptionsStore";
import type { ChatThreadHandle, ChatThreadView } from "./useChatThread";

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.257",
  models: [
    { value: "claude-fable-5-1", label: "Fable 5.1", contextWindows: ["200k", "1m"] },
    { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] },
    { value: "claude-sonnet-5", label: "Sonnet 5", contextWindows: ["200k", "1m"] },
  ],
  efforts: [{ value: "high", label: "High", isDefault: true }],
  contextWindows: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }],
  permissionModes: [{ value: "bypassPermissions", label: "Bypass", isDefault: true }],
  steers: true,
  renames: true,
  images: true,
};

const WORKSPACE = "ws_a";

const ROW: SessionView = { id: "s1", workspaceId: WORKSPACE, harness: "claude", status: "completed", model: "claude-fable-5-1", threadId: "t1" };

const view = (model: string | null): ChatThreadView => ({
  entries: [{ id: "e1" } as unknown as ChatThreadView["entries"][number]],
  turns: [],
  latestTurn: null,
  running: false,
  activeTurnStartedAt: null,
  settled: null,
  cwd: null,
  shellCwd: null,
  harness: null,
  model,
});

const handle = (model: string | null, threadKey = "t1"): ChatThreadHandle =>
  ({ view: view(model), hydrated: true, busy: false, sending: false, fresh: false, resume: "sess", thread: threadKey, threadKey, named: null }) as unknown as ChatThreadHandle;

function Picks({ thread }: { thread: ChatThreadHandle }) {
  const picks = useComposerPicks(WORKSPACE, thread);
  return <output data-testid="picks">{JSON.stringify({ model: picks.model, start: picks.startOptions })}</output>;
}

const read = (model: string | null, threadKey = "t1") => {
  const view = render(<Picks thread={handle(model, threadKey)} />);
  const out = JSON.parse(view.getByTestId("picks").textContent!) as { model: { value: string; label: string } | null; start: Record<string, string> };
  view.unmount();
  return out;
};

describe("the composer's picks on a thread the catalog's list does not know", () => {
  afterEach(() => {
    act(() => useStore.setState({ harnesses: [], harnessesByWorkspace: {}, sessions: {} }));
    act(() => useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} }));
  });

  it("names the thread's recorded model and sends it, where nothing was picked", () => {
    act(() => useStore.setState({ harnesses: [CLAUDE], sessions: { [WORKSPACE]: [ROW] } }));
    // What the composer shows, and what ChatComposer spreads into api.startSession for the send.
    expect(read("claude-fable-5-1")).toEqual({ model: { value: "claude-fable-5-1", label: "Fable 5.1", contextWindows: ["200k", "1m"] }, start: { model: "claude-fable-5-1" } });
    // A model this machine's list has no row for is named on the button by its id, and rides nothing: sessions.start
    // would refuse it, and the resume keeps that harness session on it anyway.
    expect(read("claude-ghost-9")).toEqual({ model: { value: "claude-ghost-9", label: "claude-ghost-9" }, start: {} });
    // A thread with no start behind it is a new one: the runtime fills the catalog's default, so nothing rides.
    expect(read(null)).toEqual({ model: { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] }, start: {} });
  });

  it("a model picked on this thread still wins over the thread's own", () => {
    act(() => useStore.setState({ harnesses: [CLAUDE], sessions: { [WORKSPACE]: [ROW] } }));
    act(() => useComposerOptionsStore.getState().pick(WORKSPACE, "model", "claude-opus-5", "t1"));
    expect(read("claude-fable-5-1").start).toEqual({ model: "claude-opus-5" });
  });

  it("a model picked on another thread of this workspace paints neither this thread's button nor its send", () => {
    act(() => useStore.setState({ harnesses: [CLAUDE], sessions: { [WORKSPACE]: [ROW] } }));
    act(() => useComposerOptionsStore.getState().pick(WORKSPACE, "model", "claude-fable-5-1", "t9"));
    expect(read("claude-opus-5")).toEqual({ model: { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] }, start: { model: "claude-opus-5" } });
    // A thread with no start behind it is the one that pick is for.
    expect(read(null).start).toEqual({ model: "claude-fable-5-1" });
  });

  it("a window picked here does not bring in a model picked on another thread, nor the other way round", () => {
    act(() => useStore.setState({ harnesses: [CLAUDE], sessions: { [WORKSPACE]: [ROW] } }));
    const pick = useComposerOptionsStore.getState().pick;
    // Thread A ran on opus and had Fable picked on it; thread B ran on sonnet at 1M and has been touched by nobody.
    act(() => pick(WORKSPACE, "model", "claude-fable-5-1", "tA"));
    expect(read("claude-sonnet-5[1m]", "tB")).toMatchObject({ model: { value: "claude-sonnet-5" }, start: { model: "claude-sonnet-5", contextWindow: "1m" } });
    // Picking 200k on B is a pick of the window and of nothing else: it must not adopt A's model.
    act(() => pick(WORKSPACE, "contextWindow", "200k", "tB"));
    expect(read("claude-sonnet-5[1m]", "tB")).toMatchObject({ model: { value: "claude-sonnet-5" }, start: { model: "claude-sonnet-5", contextWindow: "200k" } });
    // And A keeps the model it was picked on, at the window A itself runs.
    expect(read("claude-opus-5[1m]", "tA").start).toEqual({ model: "claude-fable-5-1", contextWindow: "1m" });
    // The reverse door: a model picked on B does not bring the window picked on A.
    act(() => pick(WORKSPACE, "contextWindow", "200k", "tA"));
    act(() => pick(WORKSPACE, "model", "claude-opus-5", "tB"));
    expect(read("claude-sonnet-5[1m]", "tB").start).toEqual({ model: "claude-opus-5", contextWindow: "1m" });
  });
});
