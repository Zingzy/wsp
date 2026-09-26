// SPDX-License-Identifier: AGPL-3.0-only
import { act, render } from "@testing-library/react";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadStateWord } from "@wsp/protocol";
import { Crab, drawCrab } from "../src/components/status/Crab.js";
import { THREAD_STATUS_KINDS, type ThreadStatusInput } from "../src/components/status/kinds/index.js";
import { ThreadStatus } from "../src/components/status/ThreadStatus.js";
import { threadStatusOf } from "../src/components/status/threadStatusOf.js";
import { WorkingSince } from "../src/components/status/WorkingSince.js";

const thread = (over: Partial<ThreadStatusInput> = {}): ThreadStatusInput => ({ status: "completed", asking: null, startedAt: null, ...over });
const slot = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>("[data-thread-status]")!;

describe("threadStatusOf", () => {
  it("a question outranks a running turn, a running turn is working, a failed one failed, and everything else rests", () => {
    expect(threadStatusOf(thread({ status: "running", asking: "Bash: rm -rf dist" })).id).toBe("needs-you");
    expect(threadStatusOf(thread({ asking: "the other thread's prompt needs an answer" })).id).toBe("needs-you");
    expect(threadStatusOf(thread({ status: "running" })).id).toBe("working");
    expect(threadStatusOf(thread({ status: "failed" })).id).toBe("failed");
    expect(threadStatusOf(thread({ status: "completed" })).id).toBe("resting");
    expect(threadStatusOf(thread({ status: "interrupted" })).id).toBe("resting");
  });

  it("the registry ends on the kind every thread reads as, so no thread falls through it", () => {
    expect(THREAD_STATUS_KINDS.map(k => k.id)).toEqual(["needs-you", "working", "failed", "resting"]);
    expect(THREAD_STATUS_KINDS.at(-1)!.is(thread({ status: "failed", asking: "x" }))).toBe(true);
  });
});

describe("ThreadStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("a thread waiting on the person shows the question glyph and the protocol's word in the input ink", () => {
    const { container } = render(<ThreadStatus thread={thread({ asking: "Bash: ls" })} age="3m" />);
    const s = slot(container);
    expect(s.dataset.tone).toBe("input");
    expect(s.classList).toContain("text-status-input");
    expect(s.getAttribute("style")).toBeNull();
    expect(s.querySelector("svg")!.getAttribute("class")).toContain("lucide-message-circle-question");
    expect(s.textContent).toBe(threadStateWord("waiting"));
    expect(s.textContent).toBe("Needs you");
  });

  it("a working thread shows its elapsed time in the working ink, ticking each second, its word for screen readers alone", () => {
    const { container } = render(<ThreadStatus thread={thread({ status: "running", startedAt: "2026-09-26T11:57:58Z" })} age="3m" />);
    const s = slot(container);
    expect(s.dataset.tone).toBe("working");
    expect(s.classList).toContain("text-status-working");
    expect(s.getAttribute("style")).toBeNull();
    expect(s.querySelector("svg")).toBeNull();
    expect(s.querySelector(".sr-only")!.textContent).toBe("Working");
    const time = s.querySelector("[aria-hidden]")!;
    expect(time.textContent).toBe("2m");
    act(() => vi.advanceTimersByTime(60_000));
    expect(time.textContent).toBe("3m");
    expect(s.querySelector("canvas")).toBeNull();
  });

  it("the crab joins a working slot only where the caller asks for it, and never a slot at rest", () => {
    const working = render(<ThreadStatus thread={thread({ status: "running" })} crab />);
    expect(slot(working.container).querySelector("canvas[data-crab]")).not.toBeNull();
    const resting = render(<ThreadStatus thread={thread()} age="1h" crab />);
    expect(slot(resting.container).querySelector("canvas")).toBeNull();
  });

  it("a failed thread shows the alert glyph and Failed in the failed ink", () => {
    const { container } = render(<ThreadStatus thread={thread({ status: "failed" })} age="3m" />);
    const s = slot(container);
    expect(s.dataset.tone).toBe("failed");
    expect(s.classList).toContain("text-status-failed");
    expect(s.getAttribute("style")).toBeNull();
    expect(s.querySelector("svg")!.getAttribute("class")).toContain("lucide-circle-alert");
    expect(s.textContent).toBe("Failed");
  });

  it("a resting thread shows its age alone, with no tone, so it keeps the row's ink", () => {
    const { container } = render(<ThreadStatus thread={thread()} age="4h" className="text-[var(--top-row-meta)]" />);
    const s = slot(container);
    expect(s.dataset.tone).toBeUndefined();
    expect([...s.classList].filter(c => c.startsWith("text-status-"))).toEqual([]);
    expect(s.textContent).toBe("4h");
    expect(s.className).toContain("text-[var(--top-row-meta)]");
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
