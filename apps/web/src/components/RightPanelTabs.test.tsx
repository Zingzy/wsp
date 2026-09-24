// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's launcher and its tab strip: five panes and no others,
// each with its own letter, and a pane the workspace cannot serve yet drawn
// held with the one line that says why.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RightPanelTabs } from "./RightPanelTabs";
import type { RightPanelSurface } from "../rightPanelStore";

const NONE: ReadonlySet<string> = new Set();

function draw(over: { surfaces?: RightPanelSurface[]; activeSurfaceId?: string | null; diffAvailable?: boolean; processesAvailable?: boolean } = {}) {
  return render(
    <RightPanelTabs
      mode="inline"
      surfaces={over.surfaces ?? []}
      activeSurfaceId={over.activeSurfaceId ?? null}
      pendingSurfaceIds={NONE}
      previewSessions={{}}
      terminalLabelsById={new Map()}
      onActivate={vi.fn()}
      onCloseSurface={vi.fn()}
      onAddBrowser={vi.fn()}
      onAddTerminal={vi.fn()}
      onAddDiff={vi.fn()}
      onAddMachine={vi.fn()}
      onAddProcesses={vi.fn()}
      browserAvailable
      terminalAvailable
      diffAvailable={over.diffAvailable ?? true}
      machineAvailable
      processesAvailable={over.processesAvailable ?? true}
    >
      <div data-pane />
    </RightPanelTabs>,
  );
}

const cards = () => [...document.querySelectorAll<HTMLElement>("[data-surface-launch]")].map(el => el.dataset["surfaceLaunch"]);

afterEach(cleanup);

describe("the right panel's launcher", () => {
  it("offers Browser, Terminal, Diff, Workspace and Processes and nothing else", () => {
    draw();
    expect(cards()).toEqual(["browser", "terminal", "diff", "machine", "processes"]);
    for (const label of ["Browser", "Terminal", "Diff", "Task", "Processes"]) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText("Files")).toBeNull();
    expect(screen.queryByText("Screen")).toBeNull();
    expect(document.querySelector("[data-surface-launcher-keys]")?.getAttribute("data-surface-launcher-keys")).toBe("BTDMP");
  });

  it("says what the Browser pane is for in the person's own words", () => {
    draw();
    expect(screen.getByText("Open your dev server or a URL.")).toBeTruthy();
  });

  it("keeps a pane it cannot open drawn, held, with the one line that says why", () => {
    draw({ diffAvailable: false });
    expect(cards()).toEqual(["browser", "terminal", "diff", "machine", "processes"]);
    const diff = document.querySelector<HTMLElement>('[data-surface-launch="diff"]')!;
    expect(diff.dataset["available"]).toBe("false");
    expect(diff.textContent).toContain("Review changes once the task is running.");
  });

  it("holds Processes with the line that says why", () => {
    draw({ processesAvailable: false });
    const procs = document.querySelector<HTMLElement>('[data-surface-launch="processes"]')!;
    expect(procs.dataset["available"]).toBe("false");
    expect(procs.textContent).toContain("Available while the task is running.");
  });

  it("names the open panes on the tab strip", () => {
    draw({ surfaces: [{ id: "diff", kind: "diff" }, { id: "machine", kind: "machine" }, { id: "processes", kind: "processes" }], activeSurfaceId: "diff" });
    const strip = document.querySelector("[data-right-panel-tab-list]")?.textContent;
    expect(strip).toContain("Diff");
    expect(strip).toContain("Task");
    expect(strip).toContain("Processes");
    expect(document.querySelector("[data-pane]")).not.toBeNull();
  });
});
