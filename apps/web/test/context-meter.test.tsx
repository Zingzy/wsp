// SPDX-License-Identifier: AGPL-3.0-only
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TurnSummary } from "../src/adapt";
import { ContextRing, usePublishContext } from "../src/components/chat/ContextMeter.js";

const WS = "ws_ring";
const ring = () => document.querySelector<HTMLElement>("[data-context-ring]");
const used = () => ring()!.querySelector<SVGCircleElement>("circle[data-context-used]")!;

function Thread({ turns, agentLabel }: { turns: ReadonlyArray<Pick<TurnSummary, "tokens">>; agentLabel: string }) {
  usePublishContext(WS, turns, agentLabel);
  return null;
}

describe("the context ring in the thread's top bar", () => {
  it("fills with the share of the window the thread's view published, and says the numbers and the percentage", () => {
    render(
      <>
        <Thread turns={[{ tokens: { input: 1, output: 1, context: 50_000, window: 200_000 } }]} agentLabel="Claude Code" />
        <ContextRing workspaceId={WS} />
      </>,
    );
    expect(ring()!.getAttribute("aria-label")).toBe("Context: 25% used, 50k of 200k tokens");
    const circumference = 2 * Math.PI * 9.75;
    expect(Number(used().getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference * 0.75);
  });

  it("draws an empty ring and the count alone where the agent reports no limit", () => {
    render(
      <>
        <Thread turns={[{ tokens: { input: 1, output: 1, context: 24_763 } }]} agentLabel="Codex" />
        <ContextRing workspaceId={WS} />
      </>,
    );
    expect(ring()!.getAttribute("aria-label")).toBe("Context: 24.8k tokens; Codex does not report its limit");
    expect(Number(used().getAttribute("stroke-dashoffset"))).toBeCloseTo(2 * Math.PI * 9.75);
  });

  it("draws nothing on a thread no turn of which said, and goes as the thread leaves", () => {
    const { rerender } = render(
      <>
        <Thread turns={[{ tokens: null }]} agentLabel="Claude Code" />
        <ContextRing workspaceId={WS} />
      </>,
    );
    expect(ring()).toBeNull();
    rerender(
      <>
        <Thread turns={[{ tokens: { input: 1, output: 1, context: 50_000, window: 200_000 } }]} agentLabel="Claude Code" />
        <ContextRing workspaceId={WS} />
      </>,
    );
    expect(ring()).not.toBeNull();
    rerender(<ContextRing workspaceId={WS} />);
    expect(ring()).toBeNull();
  });
});
