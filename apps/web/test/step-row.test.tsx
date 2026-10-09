// SPDX-License-Identifier: AGPL-3.0-only
// A step's time, wherever StepRow draws it (the Add a computer dialog, the
// setup card, the composer's Tasks bar): an ended step reads fmtDuration, a
// running one whole seconds that its own node takes once a second, so the
// list is never drawn again for a clock.
import { act, cleanup, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { StepRow } from "../src/settings/add/StepRow.js";
import type { StepLine } from "../src/settings/add/setup.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function list(rows: StepLine[]) {
  const commits = { n: 0 };
  const view = render(
    <TooltipProvider>
      <Profiler id="steps" onRender={() => commits.n++}>
        {rows.map(row => (
          <StepRow key={row.id} row={row} />
        ))}
      </Profiler>
    </TooltipProvider>,
  );
  const time = (id: string) => view.container.querySelector<HTMLElement>(`[data-step-row="${id}"] [data-step-time]`)!;
  return { commits, time };
}

describe("a step's time", () => {
  it("reads 1m 14s and 31s for steps that ended, in the mono", () => {
    const { time } = list([
      { id: "a", name: "Read the open tickets", state: "done", ms: 74_000 },
      { id: "b", name: "Start a builder per ticket", state: "done", ms: 31_000 },
    ]);
    expect([time("a").textContent, time("b").textContent]).toEqual(["1m 14s", "31s"]);
    expect(time("a").className).toContain("font-mono");
    expect(time("a").className).toContain("tabular-nums");
  });

  it("climbs in whole seconds while the step runs, written to its node, with no row drawn again over 3 s", () => {
    vi.useFakeTimers({ now: 1_790_000_000_000 });
    const { commits, time } = list([
      { id: "a", name: "Read the open tickets", state: "done", ms: 74_000 },
      { id: "run", name: "Start a reviewer per pull request", state: "working", since: Date.now() - 12_400 },
      { id: "long", name: "Copy the skills", state: "working", since: Date.now() - 299_000 },
    ]);
    expect([time("run").textContent, time("long").textContent]).toEqual(["12s", "4m 59s"]);
    const drawn = commits.n;
    act(() => vi.advanceTimersByTime(1_000));
    expect([time("run").textContent, time("long").textContent]).toEqual(["13s", "5m"]);
    act(() => vi.advanceTimersByTime(2_000));
    expect([time("run").textContent, time("long").textContent]).toEqual(["15s", "5m 2s"]);
    expect(commits.n).toBe(drawn);
    expect(time("run").className).toContain("font-mono");
  });

  it("runs one interval for every running step on the page, and none once they end", () => {
    vi.useFakeTimers({ now: 1_790_000_000_000 });
    const every = vi.spyOn(window, "setInterval");
    const view = render(
      <TooltipProvider>
        <StepRow row={{ id: "x", name: "One", state: "working", since: Date.now() }} />
        <StepRow row={{ id: "y", name: "Two", state: "working", since: Date.now() }} />
      </TooltipProvider>,
    );
    expect(every.mock.calls.filter(call => call[1] === 1000)).toHaveLength(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
