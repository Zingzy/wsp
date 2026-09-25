// SPDX-License-Identifier: AGPL-3.0-only
// The agents manager over one fixture report, as a task's panel and as a
// computer's page: the head, the three tabs with their icons and counts, the
// toolbar, rows in groups with one fact under the name and no chips or rules,
// the MCP servers folded across agents with one badge each, the detail that
// replaces the list with its facts and its acts next step first, a server's
// tools and one tool, the keyboard at every level, and every state. Heights
// and widths are measured in the render test.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsReport, SealedImage, ServerToolsAnswer } from "@wsp/protocol";
import { AgentsManager, type AgentsManagerProps } from "../src/components/agents/AgentsManager.js";
import { AGENTS_LIST_WORDS as W, imageAgentsReport, recipeMissLines, refusedLines, type ServerTools, type ToolsState } from "../src/components/agents/agentsRows.js";
import { foldServers, rowState } from "../src/components/agents/kinds/servers.js";
import { AGENTS_REPORT, SERVER_TOOLS } from "./fixtures/agents-report.js";

const NOW = Date.parse("2026-09-24T12:03:00.000Z");
const HEAD = { title: "On spoo, for wsp", line: "Agents, MCP servers and skills this thread can use: global on spoo, plus wsp's own at ~/wsp." };

afterEach(cleanup);

function draw(over: Partial<AgentsManagerProps> = {}) {
  return render(<AgentsManager shell="panel" head={HEAD} report={AGENTS_REPORT} reading={false} on="spoo" ctx={{ where: "box", project: { name: "wsp", path: "~/wsp" } }} onRefresh={() => {}} now={NOW} {...over} />);
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-agents-row]")];
const rowEl = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-agents-row="${key}"]`)!;
const titles = (): string[] => rows().map(r => r.querySelector("[data-row-title]")!.textContent ?? "");
const subtext = (key: string): string | undefined => rowEl(key).querySelector("[data-row-subtext]")?.textContent ?? undefined;
const word = (key: string): string | undefined => rowEl(key).querySelector("[data-row-word]")?.textContent ?? undefined;
const quick = (key: string): HTMLButtonElement | null => rowEl(key).querySelector<HTMLButtonElement>("[data-row-slot] button");
const badge = (el: ParentNode): HTMLElement => el.querySelector<HTMLElement>("[data-k=server-badge]")!;
const tab = (name: string): void => void fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
const openRow = (key: string): HTMLElement => {
  fireEvent.click(rowEl(key).querySelector<HTMLButtonElement>("[data-row-trigger]")!);
  return document.querySelector<HTMLElement>("[data-agents-detail]")!;
};
const facts = (el: ParentNode): [string, string][] => [...el.querySelectorAll<HTMLElement>("[data-fact]")].map(f => [f.querySelector("[data-fact-label]")!.textContent ?? "", f.querySelector("[data-fact-value]")?.textContent ?? f.querySelector("[data-k=server-badge]")?.textContent ?? ""]);
const acts = (el: ParentNode): string[] => [...el.querySelectorAll<HTMLElement>("[data-detail-acts] button")].map(b => b.textContent ?? "");
const groupLabels = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-group-label]")].map(l => l.textContent ?? "");
const SERVER = { notion: "server-global-notion-http-mcp.notion.com", airtable: "server-global-airtable-stdio-npx -y airtable-mcp-server", github: "server-global-github-stdio-npx -y @modelcontextprotocol/server-github", linear: "server-global-linear-http-mcp.linear.app", sentry: "server-global-sentry-http-mcp.sentry.dev", wsp: "server-global-wsp-stdio-wsp mcp" };

/** A tools road the test answers by hand, as the hook would hold its answers. */
function fakeTools(): ServerTools & { asks: [string, string, boolean][]; answer(name: string, a: ServerToolsAnswer): void } {
  const states = new Map<string, ToolsState>();
  const asks: [string, string, boolean][] = [];
  return {
    asks,
    of: row => states.get(row.name),
    list: (row, refresh = false) => {
      asks.push([row.agent, row.name, refresh]);
      states.set(row.name, { listing: true });
    },
    answer: (name, a) => states.set(name, { listing: false, answer: a }),
  };
}

describe("the head and the tabs", () => {
  it("says whose these are in two lines, and links the panel to the computer's page", () => {
    const open = vi.fn();
    draw({ head: { ...HEAD, manage: { computer: "spoo", open } } });
    expect(screen.getByRole("region", { name: W.section }).tagName).toBe("SECTION");
    expect(document.querySelector("[data-k=agents-title]")?.textContent).toBe("On spoo, for wsp");
    expect(document.querySelector("[data-k=agents-line]")?.textContent).toBe(HEAD.line);
    const manage = document.querySelector<HTMLButtonElement>("[data-k=agents-manage]")!;
    expect(manage.textContent).toBe("Manage all on spoo");
    expect(manage.querySelector("svg")).not.toBeNull();
    fireEvent.click(manage);
    expect(open).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-k=agents-manage-glyph]")?.getAttribute("aria-label")).toBe("Manage all on spoo");
  });

  it("draws the page's head as its one line beside Read again", () => {
    draw({ shell: "page", head: { line: "Agents, MCP servers and skills on spoo." } });
    expect(document.querySelector("[data-k=agents-title]")).toBeNull();
    expect(document.querySelector("[data-k=agents-line]")?.textContent).toBe("Agents, MCP servers and skills on spoo.");
    expect(screen.getByRole("button", { name: "Read again" })).toBeTruthy();
  });

  it("offers Agents, MCP servers and Skills, each with its glyph and its count once the report stands, and never Plugins or CLIs yet", () => {
    draw();
    const radios = screen.getAllByRole("radio");
    expect(radios.map(r => r.querySelector("[data-segment-word]")?.textContent)).toEqual(["Agents", "MCP servers", "Skills"]);
    expect(radios.map(r => r.querySelector("[data-segment-count]")?.textContent)).toEqual(["3", "7", "4"]);
    for (const r of radios) expect(r.querySelector("svg")).not.toBeNull();
    expect(radios.map(r => r.querySelector("[data-segment-label]")?.getAttribute("aria-label"))).toEqual(["Agents", "MCP servers", "Skills"]);
    expect(document.querySelector("[data-segment-word]")?.className).toContain("hidden");
    cleanup();
    draw({ report: null, reading: true });
    expect(document.querySelector("[data-segment-count]")).toBeNull();
  });

  it("stands the toolbar on every tab: no search on Agents, a search and Group and sort on the rest, Add at the right end held with its reason", () => {
    draw();
    expect(document.querySelector("[data-k=agents-search]")).toBeNull();
    expect(document.querySelector("[data-k=agents-view]")).toBeNull();
    const add = document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!;
    expect(add.getAttribute("aria-label")).toBe("Install an agent");
    expect(add.textContent).toBe("Add");
    expect(add.querySelector("svg")).not.toBeNull();
    expect(add.disabled).toBe(true);
    expect(add.parentElement?.getAttribute("title")).toBe(W.notYet);
    expect(document.querySelector("[data-k=agents-count]")?.textContent).toBe("3 agents");
    tab("MCP servers");
    expect(document.querySelector<HTMLInputElement>("[data-k=agents-search]")?.placeholder).toBe("Search MCP servers");
    expect(document.querySelector("[data-k=agents-view]")?.getAttribute("aria-label")).toBe("Group and sort");
    expect(document.querySelector("[data-k=agents-add]")?.getAttribute("aria-label")).toBe("Add an MCP server");
    tab("Skills");
    expect(document.querySelector<HTMLInputElement>("[data-k=agents-search]")?.placeholder).toBe("Search skills");
    expect(document.querySelector("[data-k=agents-add]")?.getAttribute("aria-label")).toBe("Add a skill");
  });
});

describe("the list grammar", () => {
  it("draws no rule between rows and no chip, one fact under each name", () => {
    draw();
    expect(document.querySelector("[data-chip]")).toBeNull();
    expect(document.querySelector(".divide-y")).toBeNull();
    for (const row of rows()) expect(row.className).not.toMatch(/border-[by]/);
    expect(subtext("agent-claude")).toBe("2.1.281");
    expect(subtext("agent-opencode")).toBe("1.14.2");
    for (const row of rows()) expect(row.querySelector("[data-row-subtext]")?.textContent ?? "").not.toContain(" · ");
  });

  it("puts the next step at an agent's right end, else its sign-in word, and the ones not installed in their own group, faded, with Install", () => {
    draw();
    expect(titles()).toEqual(["Claude Code", "Codex", "OpenCode", "Pi"]);
    expect(quick("agent-claude")?.textContent).toBe("Update");
    expect(word("agent-claude")).toBeUndefined();
    expect(quick("agent-codex")?.textContent).toBe("Sign in");
    expect(word("agent-opencode")).toBe("not checked");
    expect(quick("agent-opencode")).toBeNull();
    // Every step button carries its glyph.
    for (const b of document.querySelectorAll("[data-row-slot] button")) expect(b.querySelector("svg")).not.toBeNull();
    expect(groupLabels()).toEqual(["Available to install"]);
    const pi = rowEl("agent-pi");
    expect(pi.hasAttribute("data-available")).toBe(true);
    expect(pi.querySelector("[data-row-title]")?.className).toContain("text-foreground/70");
    expect(pi.querySelector("[data-harness-mark]")?.getAttribute("class")).toContain("grayscale");
    expect(quick("agent-pi")?.textContent).toBe("Install");
    expect(quick("agent-pi")?.closest("[title]")?.getAttribute("title")).toBe(W.notYet);
    expect(within(document.querySelector<HTMLElement>("[data-agents-group=installed]")!).queryByText("Pi")).toBeNull();
  });

  it("folds a server two agents name the same way into one entry with both marks, its worst state on its one badge", () => {
    draw();
    tab("MCP servers");
    expect(titles()).toEqual(["airtable", "github", "linear", "notion", "sentry", "wsp", "spoo-metrics"]);
    const notion = rowEl(SERVER.notion);
    expect([...notion.querySelectorAll("[data-row-marks] [data-harness-mark]")].map(m => m.getAttribute("data-harness-mark"))).toEqual(["codex", "claude"]);
    expect(notion.querySelector("[data-row-marks]")?.getAttribute("title")).toBe("Codex, Claude Code");
    expect(subtext(SERVER.notion)).toBe("mcp.notion.com");
    expect(badge(notion).dataset["state"]).toBe("needs-sign-in");
    expect(badge(notion).textContent).toBe("needs sign-in");
    expect(badge(notion).getAttribute("title")).toBe(W.signInToSee);
    expect(quick(SERVER.notion)?.textContent).toBe("Sign in");
  });

  it("says each server's state in muted words with the hue in the mark alone, and a step only where one is needed", () => {
    draw();
    tab("MCP servers");
    const read = (key: string) => {
      const b = badge(rowEl(key));
      return [b.dataset["state"], b.textContent, b.querySelector("svg")!.getAttribute("class")!.match(/text-[a-z-]+-foreground/)?.[0]];
    };
    expect(read(SERVER.airtable)).toEqual(["connected", "open", "text-success-foreground"]);
    expect(read(SERVER.linear)).toEqual(["needs-sign-in", "needs sign-in", "text-warning-foreground"]);
    expect(read(SERVER.sentry)).toEqual(["off", "off", "text-muted-foreground"]);
    for (const b of document.querySelectorAll<HTMLElement>("[data-k=server-badge]")) expect(b.className).toContain("text-muted-foreground");
    expect(quick(SERVER.airtable)).toBeNull();
    expect(quick(SERVER.sentry)?.textContent).toBe("Turn on");
    // The command as the file writes it, its placeholder kept as text.
    expect(subtext("server-project-spoo-metrics-stdio-node scripts/metrics-mcp.js --token ${METRICS_TOKEN}")).toBe("node scripts/metrics-mcp.js --token ${METRICS_TOKEN}");
  });

  it("groups servers by where they are set up, the project by its name and folder, and turns a failed connect's badge with its reason as the hover and Reconnect", () => {
    const tools = fakeTools();
    tools.answer("github", SERVER_TOOLS["github"]!);
    draw({ ctx: { where: "box", tools, project: { name: "wsp", path: "~/wsp" } } });
    tab("MCP servers");
    expect(groupLabels()).toEqual(["Global", "wsp~/wsp"]);
    const github = badge(rowEl(SERVER.github));
    expect([github.dataset["state"], github.textContent, github.getAttribute("title")]).toEqual(["failed", "failed", "Did not answer in 20 s."]);
    expect(github.querySelector("svg")?.getAttribute("class")).toContain("text-destructive-foreground");
    fireEvent.click(quick(SERVER.github)!);
    expect(tools.asks).toEqual([["opencode", "github", true]]);
    // Pressing the step opens the detail under it.
    expect(document.querySelector("[data-agents-detail] [data-k=detail-title]")?.textContent).toBe("github");
  });

  it("regroups a tab from Group and sort, which offers the tab's own groupings and sorts by name alone", async () => {
    draw();
    tab("MCP servers");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-view]")!);
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map(i => i.textContent)).toEqual(["Scope", "State", "Agent", "None", "Name"]);
    fireEvent.click(items[1]!);
    expect(groupLabels()).toEqual(["Needs sign-in", "Off", "Connected"]);
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-view]")!);
    fireEvent.click((await screen.findAllByRole("menuitemradio"))[2]!);
    expect(groupLabels()).toEqual(["Claude Code", "OpenCode", "Codex"]);
    // A folded entry stands under each of its agents.
    expect(document.querySelectorAll(`[data-agents-row="${SERVER.notion}"]`)).toHaveLength(2);
  });

  it("reads a skill's real folder under its name and the agents that read it after, grouped by source on the page", () => {
    draw();
    tab("Skills");
    expect(titles()).toEqual(["frontend-design", "pdf", "wsp", "wsp-review"]);
    expect(subtext("skill-user-frontend-design")).toBe("~/.agents/skills/frontend-design");
    expect([...rowEl("skill-user-frontend-design").querySelectorAll("[data-row-marks] [data-harness-mark]")].map(m => m.getAttribute("data-harness-mark"))).toEqual(["claude", "codex", "opencode"]);
    expect(quick("skill-user-frontend-design")).toBeNull();
    expect(groupLabels()).toEqual([]);
    cleanup();
    draw({ shell: "page" });
    tab("Skills");
    expect(groupLabels()).toEqual(["System", "Plugins", "Global", "Project"]);
  });

  it("filters rows in place as the search is typed, counts what it shows, and says when nothing matches", () => {
    draw();
    tab("Skills");
    const search = document.querySelector<HTMLInputElement>("[data-k=agents-search]")!;
    fireEvent.change(search, { target: { value: "production-grade" } });
    expect(titles()).toEqual(["frontend-design"]);
    expect(document.querySelector("[data-k=agents-count]")?.textContent).toBe("1 of 4");
    fireEvent.change(search, { target: { value: "codex" } });
    expect(titles()).toEqual(["frontend-design"]);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(document.querySelector("[data-k=agents-empty]")?.textContent).toBe('Nothing matches "zzz".');
  });
});

describe("the detail", () => {
  it("replaces the list with the agent's facts and its acts next step first, each with its glyph, and goes back on Back", () => {
    draw();
    const detail = openRow("agent-codex");
    expect(document.querySelector("[data-agents-rows]")).toBeNull();
    expect(detail.querySelector("[data-k=detail-title]")?.textContent).toBe("Codex");
    expect(facts(detail)).toEqual([
      ["Status", "not signed in"],
      ["Version", "0.62.0"],
      ["Installed at", "~/.local/bin/codex"],
      ["wsp tools", "not added"],
    ]);
    expect(acts(detail)).toEqual(["Sign in", "Uninstall"]);
    for (const b of detail.querySelectorAll("[data-detail-acts] button")) expect(b.querySelector("svg")).not.toBeNull();
    expect(detail.querySelector("[data-act-hover=uninstall]")?.getAttribute("title")).toBe(W.ownHold);
    expect(detail.querySelector("[data-fact=installed-at] [data-fact-note]")?.textContent).toBe(W.own);
    const back = detail.querySelector<HTMLButtonElement>("[data-k=agents-back]")!;
    expect(back.getAttribute("aria-label")).toBe("Back to Agents");
    fireEvent.click(back);
    expect(document.querySelector("[data-agents-detail]")).toBeNull();
    expect(rows()).toHaveLength(4);
  });

  it("offers Update first where a newer version is out, and names the latest and the recipe's pin beside the version", () => {
    draw();
    const detail = openRow("agent-claude");
    expect(detail.querySelector("[data-fact=version] [data-fact-note]")?.textContent).toBe("latest 2.1.282, recipe pins 2.1.280");
    expect(facts(detail)[0]).toEqual(["Status", "signed in"]);
    expect(acts(detail)).toEqual(["Update", "Sign in", "Uninstall"]);
    expect(detail.querySelector("[data-act-hover=update]")?.getAttribute("title")).toBe(W.notYet);
  });

  it("shows a folded server's status, command, each agent's file with its own state where they disagree, and the tools line", () => {
    draw();
    tab("MCP servers");
    const detail = openRow(SERVER.notion);
    expect(facts(detail)).toEqual([
      ["Status", "needs sign-in"],
      ["URL", "mcp.notion.com"],
      ["Headers", "Authorization"],
      ["Config location", "~/.codex/config.toml"],
      ["", "~/.claude.json"],
      ["Tools", W.signInToSee],
    ]);
    expect([...detail.querySelectorAll("[data-fact^=config-] [data-fact-note]")].map(n => n.textContent)).toEqual(["not checked", "needs sign-in"]);
    expect([...detail.querySelectorAll("[data-fact^=config-] [data-harness-mark]")].map(m => m.getAttribute("data-harness-mark"))).toEqual(["codex", "claude"]);
    expect(acts(detail)).toEqual(["Sign in", "Turn off", "Remove"]);
    // Each agent that needs its own sign-in has it at the end of its line.
    expect(detail.querySelector("[data-fact=config-claude] [data-k=act-sign-in]")).not.toBeNull();
    expect(detail.querySelector("[data-fact=reach] [data-k=fact-copy]")).not.toBeNull();
  });

  it("lists a server's tools on a click, reads their count on the badge, then opens the tools and one tool as levels with Back", () => {
    const tools = fakeTools();
    const { rerender } = draw({ ctx: { where: "box", tools } });
    tab("MCP servers");
    let detail = openRow(SERVER.airtable);
    expect(facts(detail).find(f => f[0] === "Tools")).toEqual(["Tools", W.notListed]);
    expect(acts(detail)).toEqual(["List tools", "Turn off", "Remove"]);
    fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-k=act-list-tools]")!);
    expect(tools.asks).toEqual([["claude", "airtable", false]]);
    tools.answer("airtable", SERVER_TOOLS["airtable"]!);
    rerender(<AgentsManager shell="panel" head={HEAD} report={{ ...AGENTS_REPORT }} reading={false} on="spoo" ctx={{ where: "box", tools }} onRefresh={() => {}} now={NOW} />);
    detail = document.querySelector<HTMLElement>("[data-agents-detail]")!;
    expect(facts(detail)[0]).toEqual(["Status", "3 tools"]);
    expect(acts(detail)).toEqual(["View tools", "Reconnect", "Turn off", "Remove"]);
    fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-k=act-view-tools]")!);
    const level = document.querySelector<HTMLElement>("[data-agents-tools]")!;
    expect(level.querySelector("[data-k=detail-title]")?.textContent).toBe("Tools of airtable");
    expect([...level.querySelectorAll("[data-tool]")].map(t => t.getAttribute("data-tool"))).toEqual(["list_records", "create_record", "list_bases"]);
    fireEvent.click(level.querySelector<HTMLButtonElement>("[data-tool=list_records] button")!);
    const one = document.querySelector<HTMLElement>("[data-agents-tool]")!;
    expect(one.querySelector("[data-k=detail-title]")?.textContent).toBe("list_records");
    expect(one.querySelector("p")?.textContent).toContain("the offset for the next page");
    expect(one.querySelector("[data-k=agents-back]")?.getAttribute("aria-label")).toBe("Back to Tools of airtable");
    fireEvent.keyDown(one, { key: "Escape" });
    expect(document.querySelector("[data-agents-tools]")).not.toBeNull();
    fireEvent.keyDown(document.querySelector("[data-agents-tools]")!, { key: "Escape" });
    expect(document.querySelector("[data-agents-detail]")).not.toBeNull();
    // The list stays behind the levels: back to the tab's rows, off the server's row.
    fireEvent.keyDown(document.querySelector("[data-agents-detail]")!, { key: "Escape" });
    expect(document.activeElement?.closest("[data-agents-row]")?.getAttribute("data-agents-row")).toBe(SERVER.airtable);
  });

  it("says a harness holds a server's sign-in, never zero tools", () => {
    const tools = fakeTools();
    tools.answer("linear", { auth: "signed-in", holder: "claude", readAt: AGENTS_REPORT.readAt });
    draw({ ctx: { where: "box", tools } });
    tab("MCP servers");
    expect(badge(rowEl(SERVER.linear)).textContent).toBe("signed in");
    const detail = openRow(SERVER.linear);
    const line = detail.querySelector<HTMLElement>("[data-fact=tools] [data-fact-value]")!;
    expect(line.textContent).toBe("held by Claude Code");
    expect(line.getAttribute("title")).toBe(W.heldByHover("Claude Code"));
  });

  it("says what a skill wsp writes, a plugin's and a project's can and cannot do", () => {
    draw();
    tab("Skills");
    let detail = openRow("skill-user-wsp");
    expect(facts(detail)[0]).toEqual(["Status", "always on"]);
    expect(detail.querySelector("[data-fact=status] [data-fact-note]")?.textContent).toBe(W.keptCurrent);
    expect(acts(detail)).toEqual([]);
    fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    detail = openRow("skill-project-wsp-review");
    expect(detail.querySelector("[data-fact=status] [data-fact-note]")?.textContent).toBe(W.inRepo);
    expect(acts(detail)).toEqual(["Turn off", "Remove"]);
    expect(detail.querySelector("[data-act-hover=turn-off]")?.getAttribute("title")).toBe("lives in the repo at ~/wsp/.agents/skills/wsp-review");
    fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    detail = openRow("skill-user-frontend-design");
    expect(facts(detail)).toEqual([
      ["Status", "on"],
      ["Description", "Create distinctive, production-grade frontend interfaces with high design quality."],
      ["Path", "~/.agents/skills/frontend-design"],
      ["", "~/.claude/skills/frontend-design"],
      ["", "~/.codex/skills/frontend-design"],
      ["", "~/.config/opencode/skills/frontend-design"],
    ]);
    expect(detail.querySelector("[data-fact=path-0] [data-fact-note]")?.textContent).toBe("shared");
    fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    expect(acts(openRow("skill-plugin-pdf"))).toEqual([]);
  });
});

describe("the keyboard", () => {
  it("keeps one row in the Tab order and moves it with the arrows past group labels, Home and End, and opens on Enter", () => {
    draw();
    const triggers = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>("[data-agents-rows] [data-row-trigger]")];
    expect(triggers().map(t => t.tabIndex)).toEqual([0, -1, -1, -1]);
    triggers()[0]!.focus();
    fireEvent.keyDown(triggers()[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(triggers()[1]);
    fireEvent.keyDown(triggers()[1]!, { key: "End" });
    // Pi stands in the next group; the label between is skipped.
    expect(document.activeElement?.closest("[data-agents-row]")?.getAttribute("data-agents-row")).toBe("agent-pi");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(triggers()[0]);
    expect(triggers().map(t => t.tabIndex)).toEqual([0, -1, -1, -1]);
    fireEvent.keyDown(triggers()[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(triggers()[0]);
  });

  it("focuses Back when a detail opens, steps to the first act it can take on ArrowDown, and goes back to the opened row on Escape", () => {
    draw({ ctx: { where: "box", tools: fakeTools() } });
    tab("MCP servers");
    openRow(SERVER.airtable);
    const back = document.querySelector<HTMLButtonElement>("[data-k=agents-back]")!;
    expect(document.activeElement).toBe(back);
    fireEvent.keyDown(back, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-k")).toBe("act-list-tools");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.querySelector("[data-agents-detail]")).toBeNull();
    expect(document.activeElement?.closest("[data-agents-row]")?.getAttribute("data-agents-row")).toBe(SERVER.airtable);
    expect((document.activeElement as HTMLButtonElement).tabIndex).toBe(0);
  });

  it("focuses the search on / from anywhere in the manager but a field, and returns to the list on Escape in an empty search", () => {
    draw();
    tab("Skills");
    const row = document.querySelector<HTMLButtonElement>("[data-row-trigger]")!;
    row.focus();
    fireEvent.keyDown(row, { key: "/" });
    const search = document.querySelector<HTMLInputElement>("[data-k=agents-search]")!;
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(document.activeElement).toBe(row);
  });
});

describe("the states", () => {
  it("holds the list at three rows of the tab's height before the first report, busy", () => {
    draw({ report: null, reading: true });
    const bars = [...document.querySelectorAll<HTMLElement>("[data-k=agents-skeleton]")];
    expect(bars).toHaveLength(3);
    for (const bar of bars) expect(bar.className).toContain("h-14");
    expect(document.querySelector("[data-agents-rows]")?.getAttribute("aria-busy")).toBe("true");
    tab("MCP servers");
    for (const bar of document.querySelectorAll<HTMLElement>("[data-k=agents-skeleton]")) expect(bar.className).toContain("h-[84px]");
  });

  it("dims the rows in place while a read runs over a report, and says when it was read on Read again", () => {
    const onRefresh = vi.fn();
    draw({ reading: false, onRefresh });
    const again = screen.getByRole("button", { name: "Read again" });
    expect(again.parentElement?.getAttribute("title")).toBe("read 3 min ago");
    fireEvent.click(again);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    cleanup();
    draw({ reading: true });
    for (const row of rows()) expect(row.className).toContain("opacity-50");
  });

  it("says an empty tab in one centred sentence in the panel, and draws the page's empty with its ghost word and Add", () => {
    draw({ report: { ...AGENTS_REPORT, skills: [], servers: [] } });
    tab("MCP servers");
    const empty = document.querySelector<HTMLElement>("[data-k=agents-empty]")!;
    expect(empty.textContent).toBe("No MCP servers on spoo yet.");
    expect(empty.className).toContain("min-h-[168px]");
    expect(empty.querySelector("button")).toBeNull();
    cleanup();
    draw({ shell: "page", report: { ...AGENTS_REPORT, skills: [], servers: [] } });
    tab("Skills");
    const page = document.querySelector<HTMLElement>("[data-k=agents-empty]")!;
    expect(page.querySelector(".border-dashed")?.textContent).toBe("no skills");
    expect(page.querySelector("button")?.textContent).toBe("Add a skill");
  });

  it("draws each refusal as a line under the list, the reader then the reason, and the recipe's missing rows", () => {
    draw({ misses: recipeMissLines([{ id: "agents/mcp/linear", label: "linear", outcome: "skipped", kind: "server", note: "waited on GitHub CLI" }]) });
    const lines = [...document.querySelectorAll<HTMLElement>("[data-refused-line]")].map(l => [l.querySelector("[data-refused-label]")!.textContent, l.querySelector("[data-refused-value]")?.textContent]);
    expect(lines).toEqual([
      ["Skills", "the answer was cut short, so the list is not whole"],
      ["~/.hermes/config.yaml is over 1 MB and was not read", undefined],
      ["linear", "set aside: waited on GitHub CLI"],
    ]);
  });

  it("says the host's own sentence where a read was refused and nothing stood before it, with no bars", () => {
    draw({ report: null, error: "Solari keeps no computer to read" });
    expect(document.querySelector("[data-k=agents-skeleton]")).toBeNull();
    expect(document.querySelector("[data-refused-line]")?.textContent).toBe("Solari keeps no computer to read");
  });

  it("holds every act and Read again with the away word over the last report, and says away in the head", () => {
    draw({ ctx: { where: "box", heldWhy: "away 5 min" } });
    for (const row of rows()) expect(row.className).toContain("opacity-50");
    expect(document.querySelector("[data-k=agents-stale]")?.textContent).toBe("away");
    expect(document.querySelector("[data-k=agents-stale]")?.getAttribute("title")).toBe("away 5 min");
    expect(screen.getByRole("button", { name: "Read again" }).hasAttribute("disabled")).toBe(true);
    expect(rowEl("agent-codex").querySelector("[data-act-hover=sign-in]")?.getAttribute("title")).toBe("away 5 min");
    expect(document.querySelector("[data-k=agents-add]")?.parentElement?.getAttribute("title")).toBe("away 5 min");
  });

  it("says paused on a paused task's last report and holds what it offers", () => {
    draw({ report: { ...AGENTS_REPORT, stale: "napping" }, ctx: { where: "fork" } });
    expect(document.querySelector("[data-k=agents-stale]")?.textContent).toBe("paused");
    expect(screen.getByRole("button", { name: "Read again" }).hasAttribute("disabled")).toBe(true);
  });

  it("offers Edit image on a fork in every act's place and in the toolbar's", () => {
    const editImage = vi.fn();
    draw({ ctx: { where: "fork", editImage } });
    expect(quick("agent-codex")).toBeNull();
    const add = document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!;
    expect(add.textContent).toBe("Edit image");
    fireEvent.click(add);
    expect(editImage).toHaveBeenCalledTimes(1);
    const detail = openRow("agent-claude");
    expect(acts(detail)).toEqual(["Edit image"]);
  });

  it("holds a task on a box's acts for that box's page", () => {
    draw({ ctx: { where: "box-task", computer: "spoo" } });
    expect(rowEl("agent-claude").querySelector("[data-act-hover=update]")?.getAttribute("title")).toBe("on spoo's page");
  });
});

describe("a cloud's page", () => {
  const image = {
    name: "default",
    version: 3,
    hash: "a".repeat(64),
    recipeHash: "r",
    pins: [
      { id: "claude", tag: "2.1.280" },
      { id: "gh", tag: "2.60.0" },
      { id: "codex", tag: "0.62.0" },
    ],
    logins: [{ name: "claude", state: "copied" }],
    sealedAt: "2026-09-24T09:00:00.000Z",
    sealedFrom: "this Mac",
  } as SealedImage;

  it("draws the agents the image was sealed with at their pins, and Edit image where Add stands", () => {
    const editImage = vi.fn();
    const report: AgentsReport = imageAgentsReport(image, "solari");
    draw({ shell: "page", head: { line: "x" }, report, ctx: { where: "provider", editImage } });
    expect(titles()).toEqual(["Claude Code", "Codex"]);
    expect(subtext("agent-claude")).toBe("2.1.280");
    expect(word("agent-claude")).toBe("signed in");
    expect(word("agent-codex")).toBe("not checked");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!);
    expect(editImage).toHaveBeenCalledTimes(1);
  });
});

describe("the pure rules", () => {
  it("folds servers by scope, name and reach, and reads each agent's state off its connect before its config", () => {
    const entries = foldServers(AGENTS_REPORT.servers);
    expect(entries.map(e => [e.name, e.rows.map(r => r.agent)])).toEqual([
      ["airtable", ["claude"]],
      ["github", ["opencode"]],
      ["notion", ["codex", "claude"]],
      ["spoo-metrics", ["claude"]],
      ["linear", ["claude"]],
      ["sentry", ["codex"]],
      ["wsp", ["claude"]],
    ]);
    const renamed = foldServers([AGENTS_REPORT.servers[2]!, { ...AGENTS_REPORT.servers[3]!, name: "notion-2" }]);
    expect(renamed).toHaveLength(2);
    const project = foldServers([AGENTS_REPORT.servers[2]!, { ...AGENTS_REPORT.servers[2]!, agent: "claude", scope: "project" }]);
    expect(project).toHaveLength(2);
    const linear = AGENTS_REPORT.servers.find(s => s.name === "linear")!;
    expect(rowState(linear, undefined)).toBe("needs-sign-in");
    expect(rowState(linear, { auth: "signed-in", readAt: "" })).toBe("connected");
    expect(rowState({ ...linear, enabled: false }, { auth: "signed-in", readAt: "" })).toBe("off");
  });

  it("maps the report's flat refusals to lines", () => {
    expect(refusedLines(["agents: the login PATH could not be read", "a sentence alone"])).toEqual([
      { id: "refused-0", label: "Agents", value: "the login PATH could not be read" },
      { id: "refused-1", label: "a sentence alone" },
    ]);
  });
});
