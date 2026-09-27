// SPDX-License-Identifier: AGPL-3.0-only
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextMeter } from "../src/components/chat/ContextMeter.js";

const meter = () => document.querySelector<HTMLElement>("[data-context-meter]");

describe("the context meter", () => {
  it("draws the meter grammar: a 56 by 4 track, its fill at the share held, and the figure beside it in mono", () => {
    render(<ContextMeter turns={[{ tokens: { input: 1, output: 1, context: 50_000, window: 200_000 } }]} agentLabel="Claude Code" />);
    const root = meter()!;
    expect(root.getAttribute("title")).toBe("Context: 50k of 200k tokens");
    const track = root.querySelector<HTMLElement>("[data-context-track]")!;
    expect(track.className).toContain("w-14");
    expect(track.className).toContain("h-1");
    expect(root.querySelector<HTMLElement>("[data-context-fill]")!.style.width).toBe("25%");
    const figure = root.querySelector<HTMLElement>("[data-context-figure]")!;
    expect(figure.textContent).toBe("50k / 200k");
    expect(figure.className).toContain("font-mono");
  });

  it("draws the figure with no track where the agent reports no limit, and in the strip hides the track when the strip is narrow", () => {
    const { unmount } = render(<ContextMeter turns={[{ tokens: { input: 1, output: 1, context: 24_763 } }]} agentLabel="Codex" />);
    expect(meter()!.querySelector("[data-context-track]")).toBeNull();
    expect(meter()!.textContent).toBe("24.8k");
    expect(meter()!.getAttribute("title")).toBe("Context: 24.8k tokens; Codex does not report its limit");
    unmount();
    render(<ContextMeter turns={[{ tokens: { input: 1, output: 1, context: 50_000, window: 200_000 } }]} agentLabel="Claude Code" tight />);
    expect(meter()!.querySelector("[data-context-track]")!.className).toContain("@max-lg/strip:hidden");
    expect(meter()!.textContent).toBe("50k / 200k");
  });

  it("draws nothing on a thread no turn of which said", () => {
    render(<ContextMeter turns={[{ tokens: null }]} agentLabel="Claude Code" />);
    expect(meter()).toBeNull();
  });
});
