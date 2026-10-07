// SPDX-License-Identifier: AGPL-3.0-only
// The terminal pane and panel, the Browser panel and the pause button name the
// thread or its computer: every line they can show, walked, says no task and
// no VM, which are the words of the record underneath, and a computer of the
// person's own is named by its own name.
import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { absentComputer, type PlaceView, type WorkspaceState, type WorkspaceView } from "@wsp/protocol";
import { phaseHint, phaseWord } from "../src/actions/format.js";
import { linkDownLine, SHELL_ENDED_LINE, terminalEmptyLine, terminalInputRefusal, terminalPaneHints, terminalPaneTitle, terminalPaneState, type TerminalPaneState } from "../src/adapt/index.js";
import { explainRefusal } from "../src/browser/refusal.js";
import { UNFRAMEABLE } from "../src/components/preview/BrowserSurface.js";
import { PREVIEW_EMPTY } from "../src/components/preview/PreviewEmptyState.js";
import { WorkspaceTerminalPanel } from "../src/components/WorkspaceTerminalPanel.js";
import { useStore } from "../src/protocol/store.js";
import { ownComputerName, useTerminalPane } from "../src/terminal/paneWords.js";
import { resetSurfaces, view, WS } from "./surface-harness.js";

beforeEach(resetSurfaces);

const HETZNER: PlaceView = { id: "p_hetzner", kind: "computer", name: "hetzner", default: false, present: true } as PlaceView;
const BOX: WorkspaceView = { ...view, kind: "cloud", place: "p_hetzner" };
const CLOUD: WorkspaceView = { ...view, kind: "cloud", provider: "solari" };

const RECORD_WORDS = /\b(?:tasks?|VMs?)\b/i;

const STATES: readonly WorkspaceState[] = ["running", "pausing", "paused", "waking", "unreachable", "gone"];

const OOM = { used: 3.6e9, total: 3.9e9, load1: 6.4 } as const;

const PANES: readonly TerminalPaneState[] = [
  { kind: "live" },
  { kind: "starting", local: false, where: "hello" },
  { kind: "starting", local: true, where: "zingzy-mbp" },
  { kind: "unanswered", local: false, where: "hello" },
  { kind: "unanswered", local: true, where: "zingzy-mbp" },
  { kind: "reconnecting" },
  { kind: "reconnecting", computer: "hetzner" },
  { kind: "reconnecting", outOfMemory: OOM },
  { kind: "not-answering", outOfMemory: OOM },
  { kind: "reauth" },
  { kind: "refused", reason: "" },
  { kind: "refused", reason: "hetzner is behind" },
  { kind: "refused", reason: "", computer: "hetzner" },
  { kind: "not-answering" },
  { kind: "not-answering", computer: "hetzner" },
  { kind: "no-daemon" },
  { kind: "no-daemon", computer: "hetzner" },
  { kind: "absent", absent: absentComputer("hetzner", null) },
  { kind: "paused", pausing: false },
  { kind: "paused", pausing: true },
  { kind: "waking" },
  { kind: "gone" },
];

function linesOf(pane: TerminalPaneState): string[] {
  const hints = [...terminalPaneHints(pane, { cpu: 2, memMb: 4096 }, [{ cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 }]), ...terminalPaneHints(pane, { cpu: 2, memMb: 4096 }, [])];
  return [terminalPaneTitle(pane), terminalEmptyLine(pane), terminalInputRefusal(pane), linkDownLine(pane), ...hints].filter((line): line is string => line !== null);
}

describe("the words for where a thread runs", () => {
  it("the terminal pane says no task in any state it can be in", () => {
    const said = [...PANES.flatMap(linesOf), SHELL_ENDED_LINE];
    // A pane with no record yet still names somewhere, and that somewhere is not a task either.
    said.push(...linesOf(terminalPaneState({ state: "running", reach: null, socket: "opening" })));
    expect(said.length).toBeGreaterThan(40);
    expect(said.filter(line => RECORD_WORDS.test(line))).toEqual([]);
  });

  it("the Browser panel says no task in its empty state, its refused address or a refusal it explains", () => {
    const at = { port: 8080, host: "8080.preview.example" };
    const refusals = [
      explainRefusal({ status: 401, body: "" }, at),
      explainRefusal({ status: 403, body: "Blocked request. This host (8080.preview.example) is not allowed." }, at),
      explainRefusal({ status: 403, body: "Invalid Host header" }, at),
      explainRefusal({ status: 403, body: "Blocked hosts: 8080.preview.example" }, at),
    ].flatMap(r => (r === null ? [] : [r.title, r.detail]));
    expect(refusals).toHaveLength(8);
    expect([UNFRAMEABLE, PREVIEW_EMPTY, ...refusals].filter(line => RECORD_WORDS.test(line))).toEqual([]);
  });

  it("the pause button and its palette row name what stops, every thread on it, in the same words", () => {
    const said = STATES.flatMap(state => [phaseWord(state, "hello"), phaseHint(state, "hello")]);
    expect(said.filter(line => RECORD_WORDS.test(line))).toEqual([]);
    expect(phaseWord("running", "hello")).toBe("Pause hello");
    expect(phaseHint("running", "hello")).toBe("Pause hello and every thread on it; its files are kept");
    expect(phaseWord("paused", "hello")).toBe("Wake hello");
    expect(phaseHint("paused", "hello")).toBe("Wake hello and every thread on it, with its files as they were");
    // The hover goes on from the palette's own words, so the row and the button cannot say two things.
    for (const state of STATES) expect(phaseHint(state, "hello").startsWith(phaseWord(state, "hello"))).toBe(true);
  });

  it("a shell that ended names the terminal process that restarted, never the computer", () => {
    expect(SHELL_ENDED_LINE).toBe("This shell ended when the terminal process on its computer restarted");
  });

  it("names the person's own computer by its own name, and a lent machine as the thread's computer", () => {
    expect(ownComputerName([HETZNER], BOX, null)).toBe("hetzner");
    expect(ownComputerName([HETZNER], CLOUD, null)).toBeUndefined();
    const box = terminalPaneState({ state: "running", reach: "reachable", socket: "connecting", computer: "hetzner" });
    expect(terminalPaneTitle(box)).toBe("Reconnecting to hetzner");
    expect(terminalInputRefusal(box)).toBe("Typing is refused while hetzner reconnects");
    const quiet = terminalPaneState({ state: "unreachable", reach: "zombie", socket: "connecting", computer: "hetzner" });
    expect(terminalPaneTitle(quiet)).toBe("hetzner is not answering");
    const lent = terminalPaneState({ state: "running", reach: "reachable", socket: "connecting" });
    expect(terminalPaneTitle(lent)).toBe("Reconnecting to the thread's computer");
  });

  it("a pane on a box names the box wherever it names a computer, and one on a lent machine says the thread's computer", () => {
    useStore.setState({ workspaces: [BOX], places: [HETZNER] });
    const box = renderHook(() => useTerminalPane(WS, "connecting")).result.current.pane;
    expect(terminalPaneTitle(box)).toBe("Reconnecting to hetzner");
    expect(terminalPaneTitle(renderHook(() => useTerminalPane(WS, "opening")).result.current.pane)).toBe("Starting a terminal on hetzner");
    useStore.setState({ workspaces: [CLOUD] });
    expect(terminalPaneTitle(renderHook(() => useTerminalPane(WS, "connecting")).result.current.pane)).toBe("Reconnecting to the thread's computer");
    useStore.setState({ places: [] });
  });

  it("the terminal panel with no link yet says no task, and names a computer of the person's", () => {
    const surface = { id: "terminal:t1" as const, kind: "terminal" as const, resourceId: "t1", terminalIds: ["t1"], activeTerminalId: "t1" as const };
    const lent = render(<WorkspaceTerminalPanel workspaceId={WS} surface={surface} />);
    expect(lent.container.textContent).not.toBe("");
    expect(lent.container.textContent).not.toMatch(RECORD_WORDS);
    expect(lent.container.textContent).toContain("the thread's computer");
    lent.unmount();
    useStore.setState({ workspaces: [BOX], places: [HETZNER] });
    const box = render(<WorkspaceTerminalPanel workspaceId={WS} surface={surface} />);
    expect(box.container.textContent).not.toMatch(RECORD_WORDS);
    expect(box.container.textContent).toContain("hetzner");
    useStore.setState({ places: [] });
  });
});
