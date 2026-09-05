// SPDX-License-Identifier: AGPL-3.0-only
// The creation screen's layout: everything centred on one column, the stage
// log in a box of fixed height that keeps its size from two lines to twenty,
// and the newest line last. Geometry that needs a layout engine is measured in
// creation-layout.browser.test.ts; this file checks the structure jsdom can see.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useStore, type Creation, type CreationLine } from "../src/protocol/store.js";
import { WorkspaceCreation } from "../src/shell/WorkspaceCreation.js";

afterEach(cleanup);

function lines(count: number): CreationLine[] {
  return Array.from({ length: count }, (_, i) => ({
    stage: i === count - 1 ? "failed" : "machine-booting",
    message: i === count - 1 ? "Sandbox limit reached (2)" : `Stage ${i + 1} of the create ran and reported its progress here.`,
    at: new Date(Date.UTC(2026, 8, 5, 12, 31, i)).toISOString(),
    elapsedMs: 800 * (i + 1),
  }));
}

function failed(count: number): Creation {
  return {
    key: "creating:beta",
    name: "beta",
    workspaceId: "ws_beta",
    lines: lines(count),
    failed: { title: "The provider refused: machine cap reached", detail: "Every slot is taken; pause or delete a workspace to free one, then try again." },
  };
}

// Base UI's scroll area measures itself after mount; the act lets that settle.
const mount = async (creation: Creation) => {
  await act(async () => { render(<WorkspaceCreation creation={creation} />); });
  return screen.getByTestId("workspace-creation");
};

describe("workspace creation layout", () => {
  it("centres the eyebrow, the name, the refusal sentence and the buttons on one column", async () => {
    const view = await mount(failed(2));
    const column = view.firstElementChild!;
    expect(column.className).toContain("text-center");
    expect(within(view).getByRole("heading", { level: 1 }).textContent).toBe("beta");
    const buttons = within(view).getByRole("button", { name: "Retry" }).parentElement!;
    expect(buttons.className).toContain("justify-center");
    expect(within(buttons).getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("keeps the refusal's lead red and the rest muted, Retry tactile and Dismiss as text", async () => {
    const view = await mount(failed(2));
    const lead = within(view).getByText("The provider refused: machine cap reached");
    expect(lead.className).toContain("text-destructive-foreground");
    expect(lead.nextElementSibling!.className).toContain("text-muted-foreground");
    expect(within(view).getByRole("button", { name: "Retry" }).className).toContain("bg-popover");
    expect(within(view).getByRole("button", { name: "Dismiss" }).className).toContain("border-transparent");
  });

  it("puts the log in a box whose classes, and so its height, are the same with two lines and with twenty", async () => {
    const two = await mount(failed(2));
    const twoBox = within(two).getByTestId("creation-log");
    expect(twoBox.className).toMatch(/\bh-\d+\b/);
    expect(twoBox.className).not.toMatch(/\b(?:max|min)-h-/);
    expect(within(twoBox).getAllByRole("listitem")).toHaveLength(2);
    const twoClasses = twoBox.className;
    cleanup();

    const twenty = await mount(failed(20));
    const twentyBox = within(twenty).getByTestId("creation-log");
    expect(twentyBox.className).toBe(twoClasses);
    const items = within(twentyBox).getAllByRole("listitem");
    expect(items).toHaveLength(20);
    expect(items[19]!.textContent).toContain("Sandbox limit reached (2)");
    expect(items[19]!.className).toContain("text-destructive-foreground");
  });

  it("keeps the timestamp and the duration in mono and lets the message wrap between them", async () => {
    const view = await mount(failed(2));
    const list = within(view).getByRole("list", { name: "Creation log" });
    expect(list.className).toContain("font-mono");
    expect(list.className).toContain("tabular-nums");
    const [first] = within(list).getAllByRole("listitem");
    const time = first!.querySelector("time")!;
    expect(time.className).toContain("shrink-0");
    const duration = first!.lastElementChild!;
    expect(duration.textContent).toBe("0.8s");
    expect(duration.className).toContain("shrink-0");
    const message = time.nextElementSibling!;
    expect(message.textContent).toContain("Stage 1 of the create");
    expect(message.className).toContain("break-words");
  });

  it("the wave rule spans the same column as the log box", async () => {
    const view = await mount(failed(2));
    const wave = within(view).getByRole("progressbar", { name: "Creation stopped" });
    const box = within(view).getByTestId("creation-log");
    expect(wave.parentElement).toBe(box.parentElement);
    expect(wave.className).toContain("w-full");
    expect(box.className).toContain("w-full");
  });

  it("while creating, the same layout holds with the wave moving and no buttons", async () => {
    useStore.setState({ creations: [] });
    const view = await mount({ key: "k", name: "beta", workspaceId: null, lines: [], failed: null });
    expect(view.getAttribute("aria-busy")).toBe("true");
    expect(view.firstElementChild!.className).toContain("text-center");
    expect(within(view).getByTestId("creation-log").textContent).toContain("Asking the runtime for a fork.");
    expect(within(view).getByRole("progressbar", { name: "Creating" })).toBeDefined();
    expect(within(view).queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
