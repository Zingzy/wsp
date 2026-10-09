// SPDX-License-Identifier: AGPL-3.0-only
// A turn a usage limit stopped, as the composer's drawer row and the bar it
// opens: Resume at reset arms the host and Cancel takes that back, each folding
// the bar to the composer; where the agent named no reset there is nothing to
// press. An armed thread waits on nobody, so it leaves Needs you. The row says
// the clock time the agent resumes at, and the tile how long until the reset,
// each off one clock that moves each minute.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMIT_WORDS } from "@wsp/protocol";
import { ComposerDrawer, DRAWER_WORDS } from "../src/components/chat/ComposerDrawer.js";
import { UsageBar } from "../src/components/chat/bars/UsageBar.js";
import { useComposerBarStore } from "../src/components/chat/composerBar.js";
import { ThreadStatus } from "../src/components/status/ThreadStatus.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { threadSection } from "../src/sidebar/Sidebar.logic.js";

afterEach(cleanup);

const RESET = Date.now() + 2 * 3_600_000;
const KEY = "thr_lim";
let marks: Array<{ ids: readonly string[]; resumeAtReset: boolean | undefined }> = [];
beforeEach(() => {
  marks = [];
  useStore.setState({ api: { markThreads: async (ids, m) => void marks.push({ ids, resumeAtReset: m.resumeAtReset }) } as Partial<Api> as Api });
  useComposerBarStore.setState({ open: { [KEY]: "usage" }, folded: {} });
});

function bar(o: { resetsAt?: number; resumeAt?: number | null } = {}) {
  const { container } = render(<UsageBar agent="claude" limit={o.resetsAt === undefined ? {} : { resetsAt: o.resetsAt }} resumeAt={o.resumeAt ?? null} threadKey={KEY} workspaceId="ws_m" />);
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  return { q, state: q("[data-limit-strip]")!.dataset["limitStrip"] };
}

const row = (resetsAt: number | null, armed = false) => {
  const { container } = render(<ComposerDrawer threadKey={KEY} rows={{ question: null, usage: { name: armed ? LIMIT_WORDS.resuming : LIMIT_WORDS.reached, agent: "claude", resetsAt }, tasks: null, queue: null }} />);
  return container.querySelector<HTMLElement>('[data-drawer-row="usage"]')!;
};

describe("the usage limit's row in the drawer", () => {
  afterEach(() => vi.useRealTimers());

  it("says the limit and the clock time the agent resumes at, and opens its bar", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 9, 19, 12).getTime() });
    useComposerBarStore.setState({ open: {} });
    const r = row(new Date(2026, 9, 9, 21, 0).getTime());
    expect(r.querySelector("[data-drawer-name]")!.textContent).toBe(LIMIT_WORDS.reached);
    expect(r.querySelector("[data-drawer-line]")!.textContent).toBe("Claude Code resumes at 21:00");
    fireEvent.click(r);
    expect(useComposerBarStore.getState().open[KEY]).toBe("usage");
  });

  it("names the day where the reset falls on another", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 9, 23, 30).getTime() });
    expect(row(new Date(2026, 9, 10, 3, 0).getTime()).querySelector("[data-drawer-line]")!.textContent).toBe("Claude Code resumes at Sat 03:00");
  });

  it("says the agent named no reset where it did not", () => {
    expect(row(null).querySelector("[data-drawer-line]")!.textContent).toBe("Claude Code stopped this turn and did not say when its plan resets.");
  });
});

describe("the usage bar", () => {
  it("names the agent in the title's sentence, and Resume at reset arms and folds the bar", () => {
    const s = bar({ resetsAt: RESET });
    expect(s.state).toBe("hit");
    expect(s.q("[data-limit-title]")!.textContent).toBe(LIMIT_WORDS.reached);
    expect(s.q("[data-limit-note]")!.textContent).toBe("Claude Code stopped this turn until its plan resets.");
    expect([...document.querySelectorAll("[data-dock-foot] button")].map(b => b.textContent)).toEqual([DRAWER_WORDS.write, LIMIT_WORDS.cancel, LIMIT_WORDS.resume]);
    fireEvent.click(s.q('[data-limit-act="resume"]')!);
    expect(marks).toEqual([{ ids: [KEY], resumeAtReset: true }]);
    expect(useComposerBarStore.getState().open[KEY]).toBeUndefined();
  });

  it("armed, says it goes on at the reset, holds Resume at reset, and Cancel takes it back", () => {
    const s = bar({ resetsAt: RESET, resumeAt: RESET });
    expect(s.state).toBe("armed");
    expect(s.q("[data-limit-title]")!.textContent).toBe(LIMIT_WORDS.resuming);
    expect(s.q('[data-limit-act="resume"]')!.hasAttribute("data-held")).toBe(true);
    fireEvent.click(s.q('[data-limit-act="cancel"]')!);
    expect(marks).toEqual([{ ids: [KEY], resumeAtReset: false }]);
    expect(useComposerBarStore.getState().open[KEY]).toBeUndefined();
  });

  it("not armed, Cancel folds the bar and tells the host nothing", () => {
    const s = bar({ resetsAt: RESET });
    fireEvent.click(s.q('[data-limit-act="cancel"]')!);
    expect(marks).toEqual([]);
    expect(useComposerBarStore.getState().open[KEY]).toBeUndefined();
  });

  it("stands with its words alone where the agent named no reset: nothing to press but the way back", () => {
    const s = bar();
    expect(s.state).toBe("unknown");
    expect(s.q("[data-limit-note]")!.textContent).toBe("Claude Code stopped this turn and did not say when its plan resets.");
    expect(s.q("[data-limit-act]")).toBeNull();
  });
});

describe("the section a limited thread files under", () => {
  it("Needs you while it stands stopped, and out of it once Resume at reset is armed", () => {
    expect(threadSection({ status: "failed", asking: null, unread: true, resumeAt: null })).toBe("needs-you");
    expect(threadSection({ status: "failed", asking: null, unread: true, resumeAt: RESET })).toBe("done");
    expect(threadSection({ status: "failed", asking: null, unread: false, resumeAt: RESET })).toBe("idle");
  });
});

describe("a reset's words on the minute clock", () => {
  afterEach(() => vi.useRealTimers());

  it("move on the drawer's row and the armed tile as the minutes pass, the row dropping the day at midnight", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 9, 23, 59, 0).getTime() });
    const at = new Date(2026, 9, 10, 0, 13, 10).getTime();
    const line = row(at, true).querySelector("[data-drawer-line]")!;
    const { container } = render(<ThreadStatus thread={{ status: "failed", asking: null, startedAt: null, unread: false, limit: { resetsAt: at }, resumeAt: at }} />);
    const tile = () => container.querySelector("[data-thread-status]")!.getAttribute("aria-label");
    expect([line.textContent, tile()]).toEqual(["Claude Code resumes at Sat 00:13", "resets in 14 min"]);
    act(() => vi.advanceTimersByTime(59_000));
    expect(line.textContent).toBe("Claude Code resumes at Sat 00:13");
    act(() => vi.advanceTimersByTime(1_000));
    expect([line.textContent, tile()]).toEqual(["Claude Code resumes at 00:13", "resets in 13 min"]);
  });
});
