// SPDX-License-Identifier: AGPL-3.0-only
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type SessionView } from "@wsp/protocol";
import { useStore } from "../../protocol/store";
import { useAccessPick, useComposerPicks } from "./ComposerOptionPickers";
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
  efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High", isDefault: true }],
  contextWindows: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }],
  permissionModes: [{ value: "plan", label: "Plan" }, { value: "bypassPermissions", label: "Bypass", isDefault: true }],
  steers: true,
  renames: true,
  images: true,
};

const WORKSPACE = "ws_a";

const ROW: SessionView = { id: "s1", workspaceId: WORKSPACE, harness: "claude", status: "completed", model: "claude-fable-5-1", threadId: "t1" };
/** The same thread's row as the runtime writes it for a turn that opened one: the marks it filled in are recorded. */
const OPENED: SessionView = { ...ROW, effort: "high", permissionMode: "plan" };

const view = (model: string | null, running = false): ChatThreadView => ({
  entries: [{ id: "e1" } as unknown as ChatThreadView["entries"][number]],
  turns: [],
  latestTurn: null,
  running,
  activeTurnStartedAt: null,
  settled: null,
  cwd: null,
  shellCwd: null,
  harness: null,
  model,
});

const handle = (model: string | null, threadKey = "t1", running = false): ChatThreadHandle =>
  ({ view: view(model, running), hydrated: true, busy: false, sending: false, fresh: false, resume: "sess", thread: threadKey, threadKey, named: null }) as unknown as ChatThreadHandle;

/** The store as the composer meets it once this workspace's own machine has answered. Its catalog is what says which
 * access modes the workspace takes: a workspace still waiting for one is lent the host-wide lists with none, so the
 * access picker does not exist there and no pick against it can have been made. */
const seed = (rows: SessionView[]) => useStore.setState({ harnesses: [CLAUDE], harnessesByWorkspace: { [WORKSPACE]: [CLAUDE] }, sessions: { [WORKSPACE]: rows } });

function Picks({ thread }: { thread: ChatThreadHandle }) {
  const picks = useComposerPicks(WORKSPACE, thread);
  return <output data-testid="picks">{JSON.stringify({ model: picks.model, start: picks.startOptions, shows: picks.picks })}</output>;
}

/** What the composer shows on its buttons and what ChatComposer spreads into api.startSession for the send. */
const readAll = (model: string | null, threadKey = "t1", running = false) => {
  const view = render(<Picks thread={handle(model, threadKey, running)} />);
  const out = JSON.parse(view.getByTestId("picks").textContent!) as {
    model: { value: string; label: string } | null;
    start: Record<string, string>;
    shows: Record<string, string | null>;
  };
  view.unmount();
  return out;
};

const read = (model: string | null, threadKey = "t1") => {
  const { model: resolved, start } = readAll(model, threadKey);
  return { model: resolved, start };
};

/** Picks an access the way the picker does, through the hook the composer hands the access menu. */
function pickAccess(mode: string, threadKey: string): void {
  function Access() {
    const access = useAccessPick(WORKSPACE, null, threadKey, true);
    return <button type="button" onClick={() => access.pick(mode)} />;
  }
  const view = render(<Access />);
  act(() => view.getByRole("button").click());
  view.unmount();
}

describe("the composer's picks on a thread the catalog's list does not know", () => {
  afterEach(() => {
    act(() => useStore.setState({ harnesses: [], harnessesByWorkspace: {}, sessions: {}, preferences: DEFAULT_PREFERENCES }));
    act(() => useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} }));
  });

  it("names the thread's recorded model and sends it, where nothing was picked", () => {
    act(() => seed([ROW]));
    // What the composer shows, and what ChatComposer spreads into api.startSession for the send.
    expect(read("claude-fable-5-1")).toEqual({ model: { value: "claude-fable-5-1", label: "Fable 5.1", contextWindows: ["200k", "1m"] }, start: { model: "claude-fable-5-1" } });
    // A model this machine's list has no row for is named on the button by its id, and rides nothing: sessions.start
    // would refuse it, and the resume keeps that harness session on it anyway.
    expect(read("claude-ghost-9")).toEqual({ model: { value: "claude-ghost-9", label: "claude-ghost-9" }, start: {} });
    // A thread with no start behind it is a new one: the runtime fills the catalog's default, so nothing rides.
    expect(read(null)).toEqual({ model: { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] }, start: {} });
  });

  it("a model picked on this thread still wins over the thread's own", () => {
    act(() => seed([ROW]));
    act(() => useComposerOptionsStore.getState().pick(WORKSPACE, "model", "claude-opus-5", "t1"));
    expect(read("claude-fable-5-1").start).toEqual({ model: "claude-opus-5" });
  });

  it("a model picked on another thread of this workspace paints neither this thread's button nor its send", () => {
    act(() => seed([ROW]));
    act(() => useComposerOptionsStore.getState().pick(WORKSPACE, "model", "claude-fable-5-1", "t9"));
    expect(read("claude-opus-5")).toEqual({ model: { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] }, start: { model: "claude-opus-5" } });
    // A thread with no start behind it is the one that pick is for.
    expect(read(null).start).toEqual({ model: "claude-fable-5-1" });
  });

  it("a window picked here does not bring in a model picked on another thread, nor the other way round", () => {
    act(() => seed([ROW]));
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

  it("an effort picked on another thread of this workspace paints neither this thread's button nor its send", () => {
    act(() => seed([OPENED]));
    act(() => useComposerOptionsStore.getState().pick(WORKSPACE, "effort", "low", "t9"));
    // This thread opened at high and nobody touched its picker: it reads high and its next send runs at high.
    const ran = readAll("claude-fable-5-1");
    expect(ran.shows["effort"]).toBe("high");
    expect(ran.start).toEqual({ model: "claude-fable-5-1", effort: "high", permissionMode: "plan" });
    // A thread with no turn behind it is the one that pick was made for.
    expect(readAll(null).shows["effort"]).toBe("low");
    expect(readAll(null).start).toEqual({ effort: "low" });
  });

  it("an access picked on another thread of this workspace paints neither this thread's button nor its send", () => {
    act(() => seed([OPENED]));
    // The access goes onto the host's record for the whole workspace, so the thread it was picked on is the only
    // thing that keeps it off this one.
    pickAccess("bypassPermissions", "t9");
    expect(useStore.getState().preferences.access[WORKSPACE]).toBe("bypassPermissions");
    const ran = readAll("claude-fable-5-1");
    expect(ran.shows["permissionMode"]).toBe("plan");
    expect(ran.start).toEqual({ model: "claude-fable-5-1", effort: "high", permissionMode: "plan" });
    expect(readAll(null).shows["permissionMode"]).toBe("bypassPermissions");
    expect(readAll(null).start).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("an effort or an access picked on this thread still wins over what it ran at", () => {
    act(() => seed([OPENED]));
    act(() => useComposerOptionsStore.getState().pick(WORKSPACE, "effort", "low", "t1"));
    pickAccess("bypassPermissions", "t1");
    const ran = readAll("claude-fable-5-1");
    expect(ran.shows).toMatchObject({ effort: "low", permissionMode: "bypassPermissions" });
    expect(ran.start).toEqual({ model: "claude-fable-5-1", effort: "low", permissionMode: "bypassPermissions" });
  });

  it("each pick is read against its own thread, so one picked here brings in none picked elsewhere", () => {
    act(() => seed([OPENED]));
    const pick = useComposerOptionsStore.getState().pick;
    // An effort picked on another thread, then a window picked here: the window stands and the effort stays away.
    act(() => pick(WORKSPACE, "effort", "low", "t9"));
    act(() => pick(WORKSPACE, "contextWindow", "200k", "t1"));
    expect(readAll("claude-fable-5-1").start).toEqual({ model: "claude-fable-5-1", contextWindow: "200k", effort: "high", permissionMode: "plan" });
    // And an access picked here does not bring the effort picked on that other thread either.
    pickAccess("bypassPermissions", "t1");
    expect(readAll("claude-fable-5-1").start).toEqual({ model: "claude-fable-5-1", contextWindow: "200k", effort: "high", permissionMode: "bypassPermissions" });
  });
  it("a second thread running in this workspace paints neither this thread's pickers nor its send", () => {
    // Two turns running at once in one workspace, which is what a person watching several threads has. The row the
    // pickers stand for is this thread's own, so the newer thread's values stay on the newer thread.
    const onA: SessionView = { id: "sA", workspaceId: WORKSPACE, harness: "claude", status: "running", threadId: "tA", model: "claude-opus-5", effort: "low", permissionMode: "plan" };
    const onB: SessionView = { id: "sB", workspaceId: WORKSPACE, harness: "claude", status: "running", threadId: "tB", model: "claude-sonnet-5", effort: "high", permissionMode: "bypassPermissions" };
    act(() => seed([onA, onB]));
    const a = readAll("claude-opus-5", "tA", true);
    expect(a.shows).toMatchObject({ model: "claude-opus-5", effort: "low", permissionMode: "plan" });
    expect(a.start).toEqual({ model: "claude-opus-5", effort: "low", permissionMode: "plan" });
    const b = readAll("claude-sonnet-5", "tB", true);
    expect(b.shows).toMatchObject({ model: "claude-sonnet-5", effort: "high", permissionMode: "bypassPermissions" });
  });
  it("a thread's own access stands while this workspace's catalog is still on the way, and no default paints", () => {
    // The host-wide lists are lent to a workspace whose machine has not answered, with no access modes in them,
    // since which mode a thread starts at is that machine's to decide. A thread that has run carries that machine's
    // word on its own row, so it reads and sends what it runs at rather than nothing.
    act(() => useStore.setState({ harnesses: [{ ...CLAUDE, permissionModes: [] }], harnessesByWorkspace: {}, sessions: { [WORKSPACE]: [OPENED] } }));
    const ran = readAll("claude-fable-5-1");
    expect(ran.shows["permissionMode"]).toBe("plan");
    expect(ran.start).toMatchObject({ permissionMode: "plan" });
    // A thread with no turn behind it has no word of its own, and the lists withhold their default, so it shows
    // none and sends none: the runtime decides it on the machine when the thread opens.
    const fresh = readAll(null);
    expect(fresh.shows["permissionMode"]).toBeNull();
    expect(fresh.start["permissionMode"]).toBeUndefined();
  });
});
