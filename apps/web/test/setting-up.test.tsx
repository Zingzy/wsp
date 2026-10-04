// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's Setting up section: a card per computer whose setup runs,
// waits on the person or stopped, with its count, its line and its bar, each
// opening Add a computer on that computer's running steps.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlaceSetup, PlaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import { closeAdd, useAddFlow } from "../src/settings/add/addFlow.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { SettingUpSection } from "../src/sidebar/SettingUpSection.js";
import { resetSettings } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false };
const AT = "2026-10-03T10:00:00.000Z";
const running: PlaceSetup = { state: "running", addId: "a_1", startedAt: AT, steps: [{ step: "floor", state: "done" }, { step: "agents", state: "done" }, { step: "skills", state: "running" }], waiting: [] };
const box = (id: string, name: string, over: Partial<PlaceView> = {}): PlaceView => ({ id, kind: "computer", name, default: false, present: true, ...over });

beforeEach(() => resetSettings());
afterEach(() => {
  act(() => closeAdd());
  cleanup();
});

/** The section with its fold held as the sidebar holds it. */
function Section() {
  const [collapsed, setCollapsed] = useState(false);
  return <SettingUpSection collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} />;
}

describe("the sidebar's Setting up section", () => {
  const mount = () =>
    render(
      <TooltipProvider>
        <SidebarProvider defaultOpen>
          <Section />
        </SidebarProvider>
      </TooltipProvider>,
    );
  const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-setup-card='${id}']`)!;

  it("holds a card for each computer setting up, waiting on the person or stopped, none for one that is ready", () => {
    const wait = { row: "signins/codex", label: "Codex", expiresAt: AT, state: "waiting" as const };
    useStore.setState({
      places: [
        here,
        box("p_studio", "studio", { setup: running }),
        box("p_mongo", "spoo-mongo", { setup: { ...running, state: "done", steps: [{ step: "floor", state: "done" }], waiting: [wait] } }),
        box("p_disha", "dishapc", { setup: { ...running, state: "failed", said: "base packages did not install", steps: [{ step: "floor", state: "failed" }] } }),
        box("p_ready", "spoo", { setup: { ...running, state: "done", steps: [{ step: "floor", state: "done" }] } }),
      ],
    });
    mount();
    expect(document.querySelector("[data-section-head='setting-up']")?.textContent).toBe("Setting up (3)");
    expect([...document.querySelectorAll("[data-setup-card]")].map(c => [c.getAttribute("data-setup-card"), c.getAttribute("data-tone")])).toEqual([
      ["p_studio", "working"],
      ["p_mongo", "needs-you"],
      ["p_disha", "failed"],
    ]);
    // The count is steps done of all, the bar the same share; the line says the step under way.
    expect(card("p_studio").querySelector("[data-k=setup-count]")?.textContent).toBe("3/10");
    expect(card("p_studio").querySelector<HTMLElement>("[data-k=setup-bar]")?.style.width).toBe("30%");
    expect(card("p_studio").textContent).toContain("Setting up the skills");
    expect(card("p_mongo").querySelector("[data-state-mark='needs-you']")).not.toBeNull();
    expect(card("p_disha").querySelector("[data-k=setup-count]")?.textContent).toBe("Setup failed");
    expect(card("p_disha").textContent).toContain("Base packages did not install");
    fireEvent.click(card("p_studio").querySelector("button")!);
    expect(useAddFlow.getState()).toMatchObject({ open: true, placeId: "p_studio", step: "running" });
  });

  it("bounds its list at three cards' height and scrolls the rest under it, so the threads above keep their room", () => {
    useStore.setState({ places: [here, ...["a", "b", "c", "d"].map(n => box(`p_${n}`, n, { setup: running }))] });
    mount();
    const list = document.querySelector<HTMLElement>("[data-k=setup-cards]")!;
    expect(list.querySelectorAll("[data-setup-card]")).toHaveLength(4);
    expect(list.className).toContain("max-h-49");
    expect(list.className).toContain("overflow-y-auto");
  });

  it("draws nothing while no computer is being set up, and folds under its head", () => {
    useStore.setState({ places: [here] });
    mount();
    expect(document.querySelector("[data-section='setting-up']")).toBeNull();
    cleanup();
    useStore.setState({ places: [here, box("p_studio", "studio", { setup: running })] });
    mount();
    fireEvent.click(document.querySelector("[data-section-head='setting-up']")!);
    expect(document.querySelector("[data-setup-card]")).toBeNull();
  });
});

