// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { TurnSummary } from "../../adapt";

import { contextFigure, contextMissing, contextPercent, contextSnapshot, contextTitle } from "./contextMeter.logic";

const turn = (turnId: string, tokens: TurnSummary["tokens"], more: Partial<Pick<TurnSummary, "held" | "state">> = {}): Pick<TurnSummary, "turnId" | "tokens" | "held" | "state"> => ({ turnId, tokens, state: "completed", ...more });

describe("the context meter's reading of a thread", () => {
  it("reads the latest turn that says what the model held, rising turn over turn", () => {
    const one = contextSnapshot([turn("t1", { input: 9_000, output: 100, context: 4_269, window: 200_000 })]);
    const two = contextSnapshot([turn("t1", { input: 9_000, output: 100, context: 4_269, window: 200_000 }), turn("t2", { input: 30_000, output: 400, context: 12_400, window: 200_000 })]);
    expect(one).toEqual({ used: 4_269, max: 200_000, share: 4_269 / 200_000 });
    expect(two).toEqual({ used: 12_400, max: 200_000, share: 0.062 });
    expect(contextFigure(two!)).toBe("12.4k / 200k");
    expect(contextTitle(two!, null)).toBe("Context: 6.2% used, 12.4k of 200k tokens");
  });

  it("drops to what a compaction left, and skips a turn that reported nothing", () => {
    const after = contextSnapshot([turn("t1", { input: 1, output: 1, context: 181_046, window: 200_000 }), turn("t2", { input: 1, output: 1, context: 31_250, window: 200_000 }), turn("t3", null)]);
    expect(after?.used).toBe(31_250);
  });

  it("has no fill where the agent reports no window, and names the agent that does not", () => {
    const codex = contextSnapshot([turn("t1", { input: 24_763, output: 122, context: 24_763 })]);
    expect(codex).toEqual({ used: 24_763, max: null, share: null });
    expect(contextFigure(codex!)).toBe("24.8k");
    expect(contextTitle(codex!, contextMissing([turn("t1", { input: 24_763, output: 122, context: 24_763 })], "Codex"))).toBe("Context: 24.8k tokens. Codex does not report its limit");
  });

  it("is nothing on a thread no turn of which said", () => {
    expect(contextSnapshot([])).toBeNull();
    expect(contextSnapshot([turn("t1", { input: 1, output: 1 })])).toBeNull();
  });

  it("says the share as a percentage, one decimal under ten, and none where there is no window", () => {
    const at = (context: number) => contextPercent(contextSnapshot([turn("t1", { input: 1, output: 1, context, window: 200_000 })])!);
    expect([at(4_269), at(10_000), at(68_250), at(250_000)]).toEqual(["2.1%", "5%", "34%", "100%"]);
    expect(contextPercent(contextSnapshot([turn("t1", { input: 1, output: 1, context: 24_763 })])!)).toBeNull();
    expect(contextTitle(contextSnapshot([turn("t1", { input: 1, output: 1, context: 4_269, window: 200_000 })])!, null)).toBe("Context: 2.1% used, 4.27k of 200k tokens");
  });

  it("reads a running or stopped turn's last call, out of the newest window an earlier turn named", () => {
    const running = [turn("t1", { input: 1, output: 1, context: 20_000, window: 1_000_000 }), turn("t2", null, { held: { context: 60_000 }, state: "running" })];
    expect(contextSnapshot(running)).toEqual({ used: 60_000, max: 1_000_000, share: 0.06 });
    expect(contextMissing(running, "Claude Code")).toBeNull();
    const first = [turn("t1", null, { held: { context: 28_514 }, state: "running" })];
    expect(contextSnapshot(first)).toEqual({ used: 28_514, max: null, share: null });
    expect(contextMissing(first, "Claude Code")).toBe("The limit shows once a turn finishes");
  });

  it("says why there is no reading on a thread that ran a turn, and nothing on one that never did", () => {
    expect(contextMissing([], "Claude Code")).toBeNull();
    expect(contextMissing([turn("t1", null, { state: "error" })], "Claude Code")).toBe("The agent reported nothing before the turn failed");
    expect(contextMissing([turn("t1", null, { state: "running" })], "Claude Code")).toBe("Shows once the agent reports what it holds");
    expect(contextMissing([turn("t1", { input: 900, output: 4 })], "Cursor")).toBe("Cursor does not report how much context it holds");
  });

  it("never fills past full", () => {
    expect(contextSnapshot([turn("t1", { input: 1, output: 1, context: 250_000, window: 200_000 })])?.share).toBe(1);
  });
});
