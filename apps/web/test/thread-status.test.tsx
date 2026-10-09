// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render } from "@testing-library/react";
import { Profiler } from "react";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadStateWord } from "@wsp/protocol";
import { Crab, drawCrab } from "../src/components/status/Crab.js";
import { THREAD_STATUS_KINDS, type ThreadStatusInput } from "../src/components/status/kinds/index.js";
import { FINISHED } from "../src/components/status/kinds/finished.js";
import { StatusLine } from "../src/components/status/StatusLine.js";
import { LINE_SLOT_CLASS, ThreadStatus } from "../src/components/status/ThreadStatus.js";
import { threadStatusOf } from "../src/components/status/threadStatusOf.js";
import { WorkingSince } from "../src/components/status/WorkingSince.js";

const thread = (over: Partial<ThreadStatusInput> = {}): ThreadStatusInput => ({ status: "completed", asking: null, startedAt: null, unread: false, limit: null, resumeAt: null, ...over });
const slot = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>("[data-thread-status]")!;

describe("threadStatusOf", () => {
  it("a question outranks a running turn, a running turn is working, a failed one failed, and everything else rests", () => {
    expect(threadStatusOf(thread({ status: "running", asking: "Bash: rm -rf dist" })).id).toBe("needs-you");
    expect(threadStatusOf(thread({ asking: "the other thread's prompt needs an answer" })).id).toBe("needs-you");
    expect(threadStatusOf(thread({ status: "running" })).id).toBe("working");
    expect(threadStatusOf(thread({ status: "failed" })).id).toBe("failed");
    expect(threadStatusOf(thread({ status: "completed" })).id).toBe("resting");
    expect(threadStatusOf(thread({ status: "interrupted" })).id).toBe("stopped");
  });

  it("a turn a stop ended reads Stopped once nothing else is news, even before a window has opened it", () => {
    expect(threadStatusOf(thread({ status: "interrupted", unread: true })).id).toBe("stopped");
    expect(threadStatusOf(thread({ status: "interrupted", asking: "Bash: ls" })).id).toBe("needs-you");
    expect(threadStatusOf(thread({ status: "completed", unread: true })).id).toBe("done");
  });

  it("a running turn its computer's threads at once holds back reads Waiting, below a question", () => {
    const capped = { placeId: "p_hetzner", place: "hetzner", running: 2, atOnce: 2 };
    expect(threadStatusOf(thread({ status: "running", capped })).id).toBe("waiting");
    expect(threadStatusOf(thread({ status: "running", capped, asking: "Bash: ls" })).id).toBe("needs-you");
  });

  it("a finish nobody has seen reads Done, below a question, a running turn and a failure", () => {
    expect(threadStatusOf(thread({ unread: true })).id).toBe("done");
    expect(threadStatusOf(thread({ unread: true, asking: "Bash: ls" })).id).toBe("needs-you");
    expect(threadStatusOf(thread({ unread: true, status: "running" })).id).toBe("working");
    expect(threadStatusOf(thread({ unread: true, status: "failed" })).id).toBe("failed");
  });

  it("the registry ends on the kind every thread reads as, so no thread falls through it", () => {
    expect(THREAD_STATUS_KINDS.map(k => k.id)).toEqual(["needs-you", "waiting", "working", "limited", "resuming", "failed", "stopped", "done", "resting"]);
    expect(threadStatusOf(thread({ status: "failed", limit: { resetsAt: 1 } })).id).toBe("limited");
    expect(threadStatusOf(thread({ status: "failed", limit: { resetsAt: 1 }, resumeAt: 1 })).id).toBe("resuming");
    expect(THREAD_STATUS_KINDS.at(-1)!.is(thread({ status: "failed", asking: "x" }))).toBe(true);
  });
});

describe("ThreadStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  /** What the slot's tooltip says once the pointer rests on it. */
  const hover = async (s: HTMLElement): Promise<string> => {
    fireEvent.pointerEnter(s, { pointerType: "mouse" });
    fireEvent.mouseEnter(s);
    fireEvent.mouseMove(s);
    await act(async () => void vi.advanceTimersByTime(1_000));
    return document.querySelector("[data-slot=tooltip-popup]")?.textContent ?? "";
  };

  it("a thread waiting on the person is the question glyph alone in the input ink, its word on its label", () => {
    const { container } = render(<ThreadStatus thread={thread({ asking: "Bash: ls" })} age="3m" />);
    const s = slot(container);
    expect(s.dataset.tone).toBe("input");
    expect(s.classList).toContain("text-status-input");
    expect(s.querySelector("svg")!.getAttribute("class")).toContain("lucide-message-circle-question");
    expect(s.getAttribute("role")).toBe("img");
    expect(s.getAttribute("aria-label")).toBe(threadStateWord("waiting"));
    expect(s.getAttribute("aria-label")).toBe("Needs you");
    expect(s.textContent).toBe("");
  });

  it("a working thread is the crab alone in the working ink, and its tooltip says Working and the time, ticking", async () => {
    const { container } = render(<ThreadStatus thread={thread({ status: "running", startedAt: "2026-09-26T11:58:38Z" })} age="3m" />);
    const s = slot(container);
    expect(s.dataset.tone).toBe("working");
    expect(s.classList).toContain("text-status-working");
    expect(s.querySelector("canvas[data-crab]")).not.toBeNull();
    expect(s.querySelector("svg")).toBeNull();
    expect(s.getAttribute("aria-label")).toBe("Working");
    expect(s.textContent).toBe("");
    expect(await hover(s)).toBe("Working 1m 22s");
    await act(async () => void vi.advanceTimersByTime(2_000));
    expect(document.querySelector("[data-slot=tooltip-popup]")!.textContent).toBe("Working 1m 24s");
  });

  it("a failed thread is the alert glyph alone in the failed ink, and its tooltip adds how long ago", async () => {
    const { container } = render(<ThreadStatus thread={thread({ status: "failed" })} age="6m" />);
    const s = slot(container);
    expect(s.dataset.tone).toBe("failed");
    expect(s.classList).toContain("text-status-failed");
    expect(s.querySelector("svg")!.getAttribute("class")).toContain("lucide-circle-alert");
    expect(s.getAttribute("aria-label")).toBe("Failed");
    expect(s.textContent).toBe("");
    expect(await hover(s)).toBe("Failed 6m");
  });

  it("a finish nobody has seen is the check glyph alone in the done ink, and no age in the slot", () => {
    const { container } = render(<ThreadStatus thread={thread({ unread: true })} age="5m" />);
    const s = slot(container);
    expect(s.dataset.tone).toBe("done");
    expect(s.dataset.threadStatus).toBe("done");
    expect(s.classList).toContain("text-status-done");
    expect(s.querySelector("svg")!.getAttribute("class")).toContain("lucide-circle-check");
    expect(s.getAttribute("aria-label")).toBe(threadStateWord("done"));
    expect(s.textContent).toBe("");
  });

  it("a thread a stop ended reads Stopped, muted, not Done, whether or not a window has opened it", async () => {
    for (const unread of [true, false]) {
      const { container, unmount } = render(<ThreadStatus thread={thread({ status: "interrupted", unread })} age="2h" />);
      const s = slot(container);
      expect(s.dataset.threadStatus).toBe("stopped");
      expect(s.dataset.tone).toBeUndefined();
      expect([...s.classList].filter(c => c.startsWith("text-status-"))).toEqual([]);
      expect(s.classList).not.toContain("font-medium");
      expect(s.querySelector("svg")!.getAttribute("class")).toContain("lucide-circle-stop");
      expect(s.getAttribute("aria-label")).toBe("Stopped");
      expect(s.textContent).toBe("");
      expect(await hover(s)).toBe("Stopped 2h");
      unmount();
    }
  });

  it("the seen check is Done's glyph in the row's own ink, its word Done", () => {
    const { container } = render(<ThreadStatus thread={thread()} kind={FINISHED} age="1h" />);
    const s = slot(container);
    expect(s.dataset.threadStatus).toBe("finished");
    expect(s.dataset.tone).toBeUndefined();
    expect([...s.classList].filter(c => c.startsWith("text-status-"))).toEqual([]);
    expect(s.querySelector("svg")!.getAttribute("class")).toContain("lucide-circle-check");
    expect(s.getAttribute("aria-label")).toBe("Done");
  });

  it("a thread its computer holds back is the hourglass alone, no time and no crab", () => {
    const { container } = render(<ThreadStatus thread={thread({ status: "running", capped: { placeId: "p_h", place: "hetzner", running: 2, atOnce: 2 } })} age="1m" />);
    const s = slot(container);
    expect(s.querySelector("svg")!.getAttribute("class")).toContain("lucide-hourglass");
    expect(s.getAttribute("aria-label")).toBe("Waiting");
    expect(s.textContent).toBe("");
    expect(s.querySelector("canvas")).toBeNull();
  });

  it("a resting thread shows its age alone, with no tone, so it keeps the row's ink", () => {
    const { container } = render(<ThreadStatus thread={thread()} age="4h" className="text-[var(--top-row-meta)]" />);
    const s = slot(container);
    expect(s.dataset.tone).toBeUndefined();
    expect([...s.classList].filter(c => c.startsWith("text-status-"))).toEqual([]);
    expect(s.textContent).toBe("4h");
    expect(s.querySelector("svg, canvas")).toBeNull();
    expect(s.className).toContain("text-[var(--top-row-meta)]");
  });

  it("the one-line slot narrows to the icon and grows only for an age", () => {
    expect(LINE_SLOT_CLASS).not.toContain("w-22");
    expect(LINE_SLOT_CLASS).toContain("min-w-4");
  });
});

describe("StatusLine", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("a failed thread: the glyph, Failed in its ink at 500, the age at the right, and the reason under the word, up to three lines", () => {
    const { container } = render(<StatusLine thread={thread({ status: "failed" })} age="6m" reason="the build ran out of memory" />);
    const line = container.querySelector<HTMLElement>("[data-status-line]")!;
    expect(line.querySelector("svg")!.getAttribute("class")).toContain("lucide-circle-alert");
    const word = line.querySelector<HTMLElement>("[data-status-line-word]")!;
    expect(word.textContent).toBe("Failed");
    expect(word.classList).toContain("text-status-failed");
    expect(word.classList).toContain("font-medium");
    expect(line.querySelector("[data-status-line-time]")!.textContent).toBe("6m");
    const reason = line.querySelector<HTMLElement>("[data-status-reason]")!;
    expect(reason.textContent).toBe("the build ran out of memory");
    expect(reason.classList).toContain("line-clamp-3");
  });

  it("a working thread: the crab, Working, and the time it has run at the right, ticking", () => {
    const { container } = render(<StatusLine thread={thread({ status: "running", startedAt: "2026-09-26T11:58:38Z" })} age="1m" />);
    const line = container.querySelector<HTMLElement>("[data-status-line]")!;
    expect(line.querySelector("canvas[data-crab]")).not.toBeNull();
    expect(line.querySelector("[data-status-line-word]")!.textContent).toBe("Working");
    const time = line.querySelector("[data-status-line-time]")!;
    expect(time.textContent).toBe("1m 22s");
    act(() => vi.advanceTimersByTime(3_000));
    expect(time.textContent).toBe("1m 25s");
    expect(line.querySelector("[data-status-reason]")).toBeNull();
  });

  it("a stopped thread: the stop glyph and Stopped in the row's ink, at its own weight", () => {
    const { container } = render(<StatusLine thread={thread({ status: "interrupted" })} age="2h" />);
    const word = container.querySelector<HTMLElement>("[data-status-line-word]")!;
    expect(word.textContent).toBe("Stopped");
    expect(word.classList).not.toContain("font-medium");
    expect(container.querySelector("svg")!.getAttribute("class")).toContain("lucide-circle-stop");
  });
});

describe("WorkingSince", () => {
  afterEach(() => vi.useRealTimers());

  it("counts from the moment it was drawn when the turn carries no start yet", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { container } = render(<WorkingSince since={null} />);
    expect(container.textContent).toBe("0s");
    act(() => vi.advanceTimersByTime(5_000));
    expect(container.textContent).toBe("5s");
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });

  it("writes its text to its node each second and commits nothing to React while it ticks", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
    const commits = vi.fn();
    const { container } = render(
      <Profiler id="since" onRender={commits}>
        <WorkingSince since="2026-09-26T11:59:00Z" />
      </Profiler>,
    );
    const before = commits.mock.calls.length;
    for (const want of ["1m 1s", "1m 2s", "1m 3s"]) {
      act(() => vi.advanceTimersByTime(1_000));
      expect(container.textContent).toBe(want);
    }
    expect(commits.mock.calls.length).toBe(before);
  });
});

describe("Crab", () => {
  let frames: FrameRequestCallback[];
  let reduce: boolean;
  const draws = vi.fn();

  beforeEach(() => {
    frames = [];
    reduce = false;
    draws.mockClear();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(cb => frames.push(cb));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: query.includes("reduced-motion") && reduce, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return { clearRect: () => draws(this), fillRect: () => {}, scale: () => {}, fillStyle: "" } as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  });
  afterEach(() => vi.restoreAllMocks());

  const step = () => {
    const due = frames;
    frames = [];
    for (const cb of due) cb(0);
  };

  it("every crab on the page is drawn by one animation frame loop, which stops when the last one goes", () => {
    const a = render(<Crab />);
    const b = render(<Crab />);
    expect(frames).toHaveLength(1);
    draws.mockClear();
    step();
    expect(frames).toHaveLength(1);
    expect(new Set(draws.mock.calls.map(([canvas]) => canvas)).size).toBe(2);
    a.unmount();
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
    b.unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("reads a crab's tint once, not on every frame, and again when the theme on the root changes", async () => {
    const colour = vi.spyOn(window, "getComputedStyle");
    const a = render(<Crab />);
    step();
    step();
    expect(colour).toHaveBeenCalledTimes(1);
    document.documentElement.classList.add("dark");
    await act(async () => {});
    expect(colour).toHaveBeenCalledTimes(2);
    document.documentElement.classList.remove("dark");
    a.unmount();
  });

  it("under reduced motion each crab draws one still frame and no loop starts", () => {
    reduce = true;
    const { container } = render(
      <>
        <Crab />
        <Crab />
      </>,
    );
    expect(frames).toHaveLength(0);
    expect(draws).toHaveBeenCalled();
    const canvas = container.querySelector("canvas")!;
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.getAttribute("class")).toContain("h-[14px] w-4");
  });

  it("draws the site's pixel tables and timings unchanged: the fill sequence at these moments is the export's", () => {
    const calls: unknown[][] = [];
    const ctx = {
      fillStyle: "",
      clearRect: (...a: number[]) => calls.push(["clear", ...a]),
      fillRect: (...a: number[]) => calls.push([ctx.fillStyle, ...a]),
    };
    for (const t of [0, 400, 1234, 2800 * 6 + 100, 5000]) drawCrab(ctx as unknown as CanvasRenderingContext2D, 16, 14, t, "1,2,3");
    for (const t of [0, 777]) drawCrab(ctx as unknown as CanvasRenderingContext2D, 32, 28, t, "1,2,3");
    expect(calls).toHaveLength(625);
    expect(createHash("sha256").update(JSON.stringify(calls)).digest("hex")).toBe("7115eb743634a08163039ac0bb7cde333fe0c530c422a08720df93443180a1ac");
  });
});
