// SPDX-License-Identifier: AGPL-3.0-only
// The pickers' gears with the app's real tooltip, which the sidebar's own test
// files replace with a stand-in that never opens.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaceView } from "@wsp/protocol";
import { SidebarProvider } from "../components/ui/sidebar.js";
import { ComputerSwitcher } from "./ComputerSwitcher.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { COMPUTER_SWITCHER_WORDS, SWITCHER_WORDS } from "./words.js";

const BOX: PlaceView = { id: "p_box", kind: "computer", name: "lab-box", default: false, present: true, takesForks: true, engine: "none" } as PlaceView;

/** What the app's tooltips say 300 ms and then 700 ms after a mouse comes onto an element and rests there. */
const tipsOnRest = async (el: HTMLElement): Promise<[string[], string[]]> => {
  vi.useFakeTimers();
  try {
    fireEvent.pointerEnter(el, { pointerType: "mouse" });
    fireEvent.mouseEnter(el);
    fireEvent.mouseMove(el);
    const after = async (ms: number) => {
      await act(async () => void vi.advanceTimersByTime(ms));
      return [...document.querySelectorAll("[data-slot=tooltip-popup]")].map(popup => popup.textContent ?? "");
    };
    return [await after(300), await after(400)];
  } finally {
    vi.useRealTimers();
  }
};

afterEach(cleanup);

describe("a picker's gear", () => {
  it("in the project picker's menu names the project's settings on the app's tooltip once the pointer rests on it", async () => {
    render(
      <SidebarProvider defaultOpen>
        <ProjectSwitcher projects={[{ id: "pr_lab", name: "lab" }]} named={new Map()} pick={null} onPick={() => {}} onNewThread={() => {}} onAddProject={() => {}} onContextMenu={() => {}} onReorder={() => {}} />
      </SidebarProvider>,
    );
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=project-switcher]")!);
    const gear = document.querySelector<HTMLElement>("[data-k=project-settings]")!;
    expect(gear.hasAttribute("title")).toBe(false);
    expect(await tipsOnRest(gear)).toEqual([[], [SWITCHER_WORDS.settingsOf("lab")]]);
  });

  it("in the computer picker's menu names the computer's settings on the app's tooltip once the pointer rests on it", async () => {
    render(
      <SidebarProvider defaultOpen>
        <ComputerSwitcher places={[BOX]} pick={null} onPick={() => {}} />
      </SidebarProvider>,
    );
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=computer-switcher]")!);
    const gear = document.querySelector<HTMLElement>("[data-k=computer-settings]")!;
    expect(await tipsOnRest(gear)).toEqual([[], [COMPUTER_SWITCHER_WORDS.settingsOf("lab-box")]]);
  });
});
