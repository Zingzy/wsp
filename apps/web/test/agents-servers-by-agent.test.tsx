// SPDX-License-Identifier: AGPL-3.0-only
// The Tool servers tab beside a thread lists only the servers the thread's
// agent gets, under one line that says whose; the rest stand behind one link
// at the foot, each agent's under its name, shown and hidden by that link and
// never kept past the pane. In Settings every agent's stand under its name.
// The panel follows the agent the composer on screen is on.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Api } from "../src/protocol/client.js";
import type { PlaceView, WorkspaceView } from "@wsp/protocol";
import { AgentsSurface } from "../src/components/agents/AgentsSurface.js";
import { forgetAgentsReports } from "../src/components/agents/useAgentsReport.js";
import { SERVERS_VIEW_KEY } from "../src/components/agents/kinds/servers.js";
import { useComposerAgentStore } from "../src/components/chat/composerAgentStore.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { back, drawPanel, openRow, panel, tab } from "./agents-panel-harness.js";
import { settingsApi, settle } from "./settings-harness.js";

afterEach(cleanup);

/** Each card of the tab as its label and the servers in it, in the order drawn. */
const cards = (): string[][] =>
  [...panel().querySelectorAll<HTMLElement>("[data-settings-card^=kind-]")].map(card => [
    card.querySelector("[data-k=group-label]")?.textContent ?? "",
    ...[...card.querySelectorAll<HTMLElement>("[data-settings-row] [data-settings-title]")].map(t => t.textContent ?? ""),
  ]);
const link = (): HTMLButtonElement | null => panel().querySelector<HTMLButtonElement>("[data-k=kind-others]");

describe("beside a thread", () => {
  it("says a Codex thread's agent at the top and lists only Codex's servers, then the rest behind a link with their count", () => {
    drawPanel({ ctx: { where: "box", agent: "codex" } });
    tab("Tool servers");
    expect(cards()).toEqual([["Codex servers in this thread", "notion", "sentry"]]);
    expect(link()?.textContent).toBe("Other agents' servers (6)");
    expect(link()?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(link()!);
    expect(cards()).toEqual([
      ["Codex servers in this thread", "notion", "sentry"],
      ["Claude Code", "airtable", "linear", "notion", "wsp"],
      ["Claude Code", "spoo-metrics"],
      ["OpenCode", "github"],
    ]);
    expect(link()?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(link()!);
    expect(cards()).toEqual([["Codex servers in this thread", "notion", "sentry"]]);
  });

  it("lists a Claude Code thread's own, wsp's server and its project's among them", () => {
    drawPanel({ ctx: { where: "box", agent: "claude" } });
    tab("Tool servers");
    expect(cards()).toEqual([["Claude Code servers in this thread", "airtable", "linear", "notion", "spoo-metrics", "wsp"]]);
    expect(link()?.textContent).toBe("Other agents' servers (3)");
  });

  it("says a thread's agent has none rather than show another agent's", () => {
    drawPanel({ ctx: { where: "box", agent: "pi" } });
    tab("Tool servers");
    expect(cards()).toEqual([["Pi servers in this thread"]]);
    expect(panel().querySelector("[data-settings-line=kind-agent-none]")?.textContent).toBe("No tool servers for Pi on spoo.");
    expect(link()?.textContent).toBe("Other agents' servers (8)");
  });

  it("names whose a server is in words above it, with no agent's mark after its name", () => {
    drawPanel({ ctx: { where: "box", agent: "codex" } });
    tab("Tool servers");
    fireEvent.click(link()!);
    expect(panel().querySelectorAll("[data-settings-row] [data-row-marks]")).toHaveLength(0);
  });

  it("keeps the rest shown across a server's page and back, and nothing past the pane", () => {
    drawPanel({ ctx: { where: "box", agent: "codex" } });
    tab("Tool servers");
    fireEvent.click(link()!);
    openRow("server-claude-global-airtable-stdio-npx -y airtable-mcp-server");
    back();
    expect(link()?.getAttribute("aria-expanded")).toBe("true");
    cleanup();
    drawPanel({ ctx: { where: "box", agent: "codex" } });
    tab("Tool servers");
    expect(link()?.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});

describe("the groups layout, picked in a dev build", () => {
  beforeEach(() => localStorage.setItem(SERVERS_VIEW_KEY, "groups"));
  afterEach(() => localStorage.removeItem(SERVERS_VIEW_KEY));

  it("lists every agent's servers under its name beside a thread, the thread's agent first, with no line on top and no link", () => {
    drawPanel({ ctx: { where: "box", agent: "codex" } });
    tab("Tool servers");
    expect(link()).toBeNull();
    expect(cards()).toEqual([
      ["Codex on spoo", "notion", "sentry"],
      ["Claude Code", "airtable", "linear", "notion", "wsp"],
      ["Claude Code", "spoo-metrics"],
      ["OpenCode", "github"],
    ]);
    cleanup();
    drawPanel({ ctx: { where: "box", agent: "opencode" } });
    tab("Tool servers");
    expect(cards().map(c => c[0])).toEqual(["OpenCode on spoo", "Claude Code", "Claude Code", "Codex"]);
  });
});

describe("in Settings", () => {
  it("lists every agent's servers under its name with no line on top and no link", () => {
    drawPanel();
    tab("Tool servers");
    expect(link()).toBeNull();
    expect(cards()).toEqual([
      ["Claude Code on spoo", "airtable", "linear", "notion", "wsp"],
      ["Claude Code", "spoo-metrics"],
      ["Codex", "notion", "sentry"],
      ["OpenCode", "github"],
    ]);
  });
});

describe("the panel beside the composer", () => {
  const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
  const thread: WorkspaceView = { id: "ws_b", project: { id: "pr_wsp", name: "wsp", path: "~/wsp", computer: "p_2" }, name: "ws_b", kind: "place", place: "p_2", machineId: "p_2", phase: "running", golden: "", createdAt: "2026-10-07T00:00:00.000Z" };
  beforeEach(() => {
    forgetAgentsReports();
    useStore.setState({ places: [box], workspaces: [thread], api: settingsApi({ agentsRead: async () => AGENTS_REPORT } as Partial<Api>).api });
  });

  it("follows the agent the composer is on as it switches", async () => {
    act(() => useComposerAgentStore.getState().show("ws_b", "codex"));
    render(
      <TooltipProvider>
        <AgentsSurface workspaceId="ws_b" />
      </TooltipProvider>,
    );
    await settle();
    tab("Tool servers");
    expect(cards()).toEqual([["Codex servers in this thread", "notion", "sentry"]]);
    act(() => useComposerAgentStore.getState().show("ws_b", "claude"));
    expect(cards()).toEqual([["Claude Code servers in this thread", "airtable", "linear", "notion", "spoo-metrics", "wsp"]]);
    expect(link()?.textContent).toBe("Other agents' servers (3)");
  });
});
