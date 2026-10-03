// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's launcher and its tab strip: the registry's panes and no others,
// each with its own letter, and a pane the workspace cannot serve yet drawn
// held with the one line that says why.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RightPanelTabs, TILE_SURFACE } from "./RightPanelTabs";
import type { RightPanelSurface } from "../rightPanelStore";
import { PANE_KINDS, PANES, type RightPanelKind } from "../panes";

function draw(over: { surfaces?: RightPanelSurface[]; activeSurfaceId?: string | null; diffAvailable?: boolean; processesAvailable?: boolean; prAvailable?: boolean; onAdd?: (kind: RightPanelKind) => void } = {}) {
  return render(
    <RightPanelTabs
      mode="inline"
      surfaces={over.surfaces ?? []}
      activeSurfaceId={over.activeSurfaceId ?? null}
      previewSessions={{}}
      terminalLabelsById={new Map()}
      onActivate={vi.fn()}
      onCloseSurface={vi.fn()}
      onAdd={over.onAdd ?? vi.fn()}
      available={{ ...Object.fromEntries(PANE_KINDS.map(k => [k, true])), diff: over.diffAvailable ?? true, processes: over.processesAvailable ?? true, pr: over.prAvailable ?? false } as Record<RightPanelKind, boolean>}
    >
      <div data-pane />
    </RightPanelTabs>,
  );
}

const cards = () => [...document.querySelectorAll<HTMLElement>("[data-surface-launch]")].map(el => el.dataset["surfaceLaunch"]);

afterEach(cleanup);

describe("the right panel's launcher", () => {
  it("offers Browser, Terminal, Changes, Files, Computer, Processes, Agents and Slate and nothing else", () => {
    draw();
    expect(cards()).toEqual(["preview", "terminal", "diff", "files", "machine", "processes", "agents", "slate"]);
    for (const label of ["Browser", "Terminal", "Changes", "Files", "Computer", "Processes", "Agents"]) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText("Screen")).toBeNull();
    expect(screen.queryByText("Workspace")).toBeNull();
    expect(document.querySelector("[data-surface-launcher-keys]")?.getAttribute("data-surface-launcher-keys")).toBe("BTDFMPAS");
  });

  it("offers Pull request only once the work has one, beside Changes, and never draws it held", () => {
    draw({ prAvailable: true });
    expect(cards()).toEqual(["preview", "terminal", "diff", "pr", "files", "machine", "processes", "agents", "slate"]);
    expect(screen.getByText("Pull request")).toBeTruthy();
    expect(document.querySelector("[data-surface-launcher-keys]")?.getAttribute("data-surface-launcher-keys")).toBe("BTDRFMPAS");
    cleanup();
    draw({ prAvailable: false });
    expect(document.querySelector('[data-surface-launch="pr"]')).toBeNull();
  });

  it("says what each pane is for in the person's own words, never a task", () => {
    draw();
    expect(screen.getByText("A browser, a terminal, the changes, the files, the computer or what runs on it.")).toBeTruthy();
    expect(screen.getByText("Browse and read the files here.")).toBeTruthy();
    expect(screen.getByText("Open your dev server or a URL.")).toBeTruthy();
    expect(screen.getByText("Start a shell here.")).toBeTruthy();
    expect(screen.getByText("Review the changes here.")).toBeTruthy();
  });

  it("never says task or workspace, in a pane's label, its line or the reason it is held", () => {
    const banned = /\b(task|workspace)s?\b/i;
    for (const kind of PANE_KINDS) for (const words of [PANES[kind].label, PANES[kind].description, PANES[kind].hint]) expect(words).not.toMatch(banned);
    draw({ diffAvailable: false, processesAvailable: false });
    expect(document.querySelector('[aria-label="Open a panel"]')!.textContent).not.toMatch(banned);
  });

  it("keeps a pane it cannot open drawn, held, with the one line that says why", () => {
    draw({ diffAvailable: false });
    expect(cards()).toEqual(["preview", "terminal", "diff", "files", "machine", "processes", "agents", "slate"]);
    const diff = document.querySelector<HTMLElement>('[data-surface-launch="diff"]')!;
    expect(diff.dataset["available"]).toBe("false");
    expect(diff.textContent).toContain("Review the changes once it runs.");
  });

  it("holds Processes with the line that says why", () => {
    draw({ processesAvailable: false });
    const procs = document.querySelector<HTMLElement>('[data-surface-launch="processes"]')!;
    expect(procs.dataset["available"]).toBe("false");
    expect(procs.textContent).toContain("Available while this runs.");
  });

  it("draws each pane as its own card tile, 8px apart, that fills on hover, its key in mono", () => {
    draw({ diffAvailable: false, prAvailable: true });
    const browser = document.querySelector<HTMLElement>('[data-surface-launch="preview"]')!;
    for (const kind of PANE_KINDS) {
      const tile = document.querySelector<HTMLElement>(`[data-surface-launch="${kind}"]`)!;
      for (const surface of TILE_SURFACE.split(" ")) expect(tile.classList).toContain(surface);
    }
    expect(browser.parentElement!.className).toContain("gap-2");
    expect(browser.className).toContain("hover:bg-card-hover");
    expect(browser.querySelector("kbd")!.className).toContain("font-mono");
  });

  it("moves the highlight with the arrows over the tiles it can open, skipping a held one", () => {
    draw({ diffAvailable: false });
    const launcher = document.querySelector<HTMLElement>("[data-surface-launcher-keys]")!;
    const lit = () => cards().filter(kind => document.querySelector(`[data-surface-launch="${kind}"]`)!.classList.contains("bg-card-hover"));
    expect(lit()).toEqual([]);
    fireEvent.keyDown(launcher, { key: "ArrowDown" });
    expect(lit()).toEqual(["preview"]);
    fireEvent.keyDown(launcher, { key: "ArrowDown" });
    fireEvent.keyDown(launcher, { key: "ArrowDown" });
    expect(lit()).toEqual(["files"]);
    expect(document.querySelector('[data-surface-launch="files"]')!.classList).not.toContain("bg-card");
    fireEvent.keyDown(launcher, { key: "ArrowUp" });
    expect(lit()).toEqual(["terminal"]);
  });

  it("dims a held row's label, glyph and key at 0.64 and leaves its reason at full ink", () => {
    draw({ diffAvailable: false });
    const diff = document.querySelector<HTMLElement>('[data-surface-launch="diff"]')!;
    expect(within(diff).getByText("Changes").className).toContain("opacity-64");
    expect(diff.querySelector("kbd")!.className).toContain("opacity-64");
    expect(diff.querySelector("svg")!.getAttribute("class")).toContain("opacity-64");
    expect(within(diff).getByText("Review the changes once it runs.").className).not.toContain("opacity");
  });

  it("draws the open tab as a 6px chip and the add button as a 28px square", () => {
    draw({ surfaces: [{ id: "diff", kind: "diff" }], activeSurfaceId: "diff" });
    const chip = document.querySelector<HTMLElement>("[data-active-tab]")!;
    expect(chip.className).toContain("rounded-sm");
    expect(chip.className).toContain("h-6");
    expect(screen.getByRole("button", { name: "Add a panel" }).className).toContain("size-7");
  });

  it("names the open panes on the tab strip", () => {
    draw({ surfaces: [{ id: "diff", kind: "diff" }, { id: "machine", kind: "machine" }, { id: "processes", kind: "processes" }], activeSurfaceId: "diff" });
    const strip = document.querySelector("[data-right-panel-tab-list]")?.textContent;
    expect(strip).toContain("Changes");
    expect(strip).toContain("Computer");
    expect(strip).toContain("Processes");
    expect(document.querySelector("[data-pane]")).not.toBeNull();
  });

  it("says what the Agents pane holds, and its letter opens it", () => {
    const onAdd = vi.fn();
    draw({ onAdd });
    const agents = document.querySelector<HTMLElement>('[data-surface-launch="agents"]')!;
    expect(agents.textContent).toContain("Agents");
    expect(agents.textContent).toContain("Agents, skills and servers here.");
    expect(agents.querySelector("kbd")?.textContent).toBe("A");
    fireEvent.keyDown(window, { key: "a" });
    expect(onAdd.mock.calls).toEqual([["agents"]]);
  });

  it("names the Agents pane on the tab strip once it is open", () => {
    draw({ surfaces: [{ id: "agents", kind: "agents" }], activeSurfaceId: "agents" });
    expect(document.querySelector("[data-right-panel-tab-list]")?.textContent).toContain("Agents");
  });
});
