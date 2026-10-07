// SPDX-License-Identifier: AGPL-3.0-only
// The row over the composer for a turn a usage limit stopped: the reset and
// Resume at reset where the agent named one, Cancel once armed, and a bare
// row where it named none. An armed thread waits on nobody, so it leaves
// Needs you. Both say the reset off one clock that moves each minute.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMIT_WORDS, resetsWord } from "@wsp/protocol";
import { LimitStrip } from "../src/components/chat/LimitStrip.js";
import { ThreadStatus } from "../src/components/status/ThreadStatus.js";
import { threadSection } from "../src/sidebar/Sidebar.logic.js";

afterEach(cleanup);

const RESET = Date.now() + 2 * 3_600_000;

function strip(o: { resetsAt?: number; resumeAt?: number | null } = {}) {
  const onResume = vi.fn();
  const onCancel = vi.fn();
  const { container } = render(
    <LimitStrip agent="claude" limit={o.resetsAt === undefined ? {} : { resetsAt: o.resetsAt }} resumeAt={o.resumeAt ?? null} onResume={onResume} onCancel={onCancel} />,
  );
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  return { onResume, onCancel, q, state: q("[data-limit-strip]")!.dataset["limitStrip"] };
}

describe("the limit strip", () => {
  it("names the agent and its reset in the Usage page's word, and Resume at reset arms", () => {
    const s = strip({ resetsAt: RESET });
    expect(s.state).toBe("hit");
    expect(s.q("[data-limit-title]")!.textContent).toBe(LIMIT_WORDS.reached);
    expect(s.q("[data-limit-note]")!.textContent).toBe("Claude Code stopped this turn until its plan resets.");
    expect(s.q("[data-limit-reset]")!.textContent).toBe(resetsWord(RESET, Date.now()));
    fireEvent.click(s.q('[data-limit-act="resume"]')!);
    expect(s.onResume).toHaveBeenCalledOnce();
    expect(s.onCancel).not.toHaveBeenCalled();
  });

  it("armed, says it goes on at the reset and its one button cancels", () => {
    const s = strip({ resetsAt: RESET, resumeAt: RESET });
    expect(s.state).toBe("armed");
    expect(s.q("[data-limit-title]")!.textContent).toBe(LIMIT_WORDS.resuming);
    expect(s.q('[data-limit-act="resume"]')).toBeNull();
    fireEvent.click(s.q('[data-limit-act="cancel"]')!);
    expect(s.onCancel).toHaveBeenCalledOnce();
  });

  it("stands bare where the agent named no reset: no fact and nothing to press", () => {
    const s = strip();
    expect(s.state).toBe("unknown");
    expect(s.q("[data-limit-note]")!.textContent).toBe("Claude Code stopped this turn and did not say when its plan resets.");
    expect(s.q("[data-limit-slot]")).toBeNull();
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

  it("move on the strip and the armed tile as the minutes pass, with nothing else drawn again", () => {
    vi.useFakeTimers({ now: 1_790_000_000_000 });
    const at = Date.now() + 14 * 60_000 + 10_000;
    const s = strip({ resetsAt: at, resumeAt: at });
    const { container } = render(<ThreadStatus thread={{ status: "failed", asking: null, startedAt: null, unread: false, limit: { resetsAt: at }, resumeAt: at }} />);
    const tile = () => container.querySelector("[data-thread-status]")!.textContent;
    expect([s.q("[data-limit-reset]")!.textContent, tile()]).toEqual(["resets in 14 min", "resets in 14 min"]);
    act(() => vi.advanceTimersByTime(59_000));
    expect(s.q("[data-limit-reset]")!.textContent).toBe("resets in 14 min");
    act(() => vi.advanceTimersByTime(1_000));
    expect([s.q("[data-limit-reset]")!.textContent, tile()]).toEqual(["resets in 13 min", "resets in 13 min"]);
  });
});
