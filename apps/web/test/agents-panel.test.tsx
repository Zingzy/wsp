// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's agents, tool servers and skills over one fixture report,
// drawn in Settings > Agents' own cards and rows: the first card's head with
// the computer, its read time and its refresh; each row's glyph frame, name,
// sans fact, and its state as a word with its dot or the one step in its
// place; the marks before an agent's state; the agents not installed in a
// card of their own; an item's page in place of the list with the back at
// its top; and every state a read or a task can stand in. Widths are
// photographed in the render test.
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsReport, SealedImage, ServerToolsAnswer } from "@wsp/protocol";
import { AGENTS_LIST_WORDS as W, imageAgentsReport, NOT_ANSWERING_AFTER_MS, refusedLines, saysNotAnswering, type RowsContext, type ServerTools, type ToolsState } from "../src/components/agents/agentsRows.js";
import { foldServers, rowState } from "../src/components/agents/kinds/servers.js";
import { AGENTS_REPORT, SERVER_TOOLS } from "./fixtures/agents-report.js";
import { back, descriptionOf, drawPanel, factOf, factsOf, head, headAct, headActs, headsOf, headTitle, panel, panelOf, rowIds, rowOf, slotOf, stateOf, stepOf, tab, titleOf, openRow } from "./agents-panel-harness.js";

afterEach(cleanup);

const SERVER = { notion: "server-global-notion-http-mcp.notion.com", airtable: "server-global-airtable-stdio-npx -y airtable-mcp-server", github: "server-global-github-stdio-npx -y @modelcontextprotocol/server-github", linear: "server-global-linear-http-mcp.linear.app", sentry: "server-global-sentry-http-mcp.sentry.dev", wsp: "server-global-wsp-stdio-wsp mcp" };
const METRICS = "server-project-pr_wsp-spoo-metrics-stdio-node scripts/metrics-mcp.js --token ${METRICS_TOKEN}";

/** A tools road the test answers by hand, as the hook would hold its answers. */
function fakeTools(): ServerTools & { asks: [string, string, boolean][]; answer(name: string, a: ServerToolsAnswer): void } {
  const answers = new Map<string, ServerToolsAnswer>();
  const listing = new Set<string>();
  const asks: [string, string, boolean][] = [];
  const keyOf = (row: { agent: string; name: string }): string => `${row.agent}\0${row.name}`;
  return {
    asks,
    of: (row): ToolsState | undefined => {
      const answer = answers.get(row.name);
      return answer === undefined && !listing.has(keyOf(row)) ? undefined : { listing: listing.has(keyOf(row)), ...(answer === undefined ? {} : { answer }) };
    },
    // An answer that stands for the server is the host's kept one, handed back at once unless refreshed.
    list: (row, refresh = false) => {
      asks.push([row.agent, row.name, refresh]);
      if (!answers.has(row.name) || refresh) listing.add(keyOf(row));
    },
    answer: (name, a) => {
      answers.set(name, a);
      for (const k of [...listing]) if (k.endsWith(`\0${name}`)) listing.delete(k);
    },
  };
}

describe("the head and the tabs", () => {
  it("names the computer in the first card's head with when it was read and its refresh, the name opening its page", () => {
    const open = vi.fn();
    const refresh = vi.fn();
    drawPanel({ on: { name: "spoo", open }, refresh });
    expect(screen.getByRole("region", { name: W.section }).tagName).toBe("SECTION");
    expect(headsOf()).toEqual(["On spoochecked 3 min ago", W.availableToInstall, "Not read"]);
    const computer = screen.getByRole("button", { name: "Open spoo in Settings" });
    expect(computer.textContent).toBe("spoo");
    expect(computer.className).toContain("underline");
    fireEvent.click(computer);
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Read the agents again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    tab("Tool servers");
    expect(headsOf()[0]).toBe("Global on spoochecked 3 min ago");
    fireEvent.click(screen.getByRole("button", { name: "Open spoo in Settings" }));
    expect(open).toHaveBeenCalledTimes(2);
    cleanup();
    drawPanel({ on: { name: "zingzy-mbp" } });
    expect(headsOf()[0]).toBe("On zingzy-mbpchecked 3 min ago");
    expect(panel().querySelector("[data-k=agents-computer]"), "a computer with no page of its own is no link").toBeNull();
  });

  it("offers Agents, Tool servers and Skills as Settings does, with no search or Add on Agents and both on the rest", () => {
    drawPanel();
    expect(screen.getAllByRole("radio").map(r => r.textContent)).toEqual(["Agents", "Tool servers", "Skills"]);
    expect(panel().querySelector("[data-k=kind-search]")).toBeNull();
    expect(panel().querySelector("[data-k=kind-add]")).toBeNull();
    tab("Tool servers");
    expect(panel().querySelector<HTMLInputElement>("[data-k=kind-search]")?.placeholder).toBe("Search tool servers");
    const add = panel().querySelector<HTMLButtonElement>("[data-k=kind-add]")!;
    expect(add.textContent).toBe("Add a tool server");
    expect(add.disabled).toBe(true);
    expect(add.closest("[title]")?.getAttribute("title")).toBe(W.notYet);
    tab("Skills");
    expect(panel().querySelector<HTMLInputElement>("[data-k=kind-search]")?.placeholder).toBe("Search skills");
    expect(panel().querySelector("[data-k=kind-add]")?.textContent).toBe("Add skill");
  });

  it("stands no mono in a row a person reads", () => {
    drawPanel({ ctx: { where: "here", typeInTerminal: () => {} } });
    for (const name of ["Agents", "Tool servers", "Skills"]) {
      tab(name);
      for (const el of panel().querySelectorAll<HTMLElement>("[data-settings-card] [data-settings-row], [data-settings-card] [data-settings-row] *")) expect(el.className.toString(), name).not.toContain("font-mono");
    }
  });
});

describe("the agents", () => {
  it("says each agent's version in the sans under its name and its state as a word with its dot, or the one step in its place", () => {
    drawPanel();
    expect(rowIds()).toEqual(["claude", "codex", "opencode", "pi"]);
    expect([titleOf("claude"), descriptionOf("claude")]).toEqual(["Claude Code", "v2.1.281"]);
    expect(descriptionOf("opencode")).toBe("v1.14.2");
    expect(rowOf("claude").querySelector("[data-settings-description]")?.className).not.toContain("font-mono");
    expect(stateOf("claude")).toEqual(["Signed in", "good"]);
    // On a box the sign-ins are that box's to start, so the state stands where Sign in would.
    expect(stateOf("codex")).toEqual(["Needs sign-in", "waiting"]);
    expect(stateOf("opencode")).toEqual(["Not checked", "quiet"]);
    const dot = rowOf("claude").querySelector("[data-k=agent-status] > span[aria-hidden]");
    expect(dot?.className).toContain("bg-success");
    expect(rowOf("claude").querySelector("[data-settings-row] [data-k=lead-tile], [data-harness-mark]")).not.toBeNull();
  });

  it("stands Sign in alone where a sign-in is needed and the computer takes one, and no state beside it", () => {
    drawPanel({ ctx: { where: "here", acts: { flowOf: () => undefined, start: () => {}, cancel: () => {}, code: () => {}, save: () => {}, addTools: () => {}, adding: () => false } } });
    expect(slotOf("codex")).toEqual(["Sign in"]);
    expect(stateOf("codex")).toBeNull();
    expect(stepOf("codex", "sign-in")?.querySelector("svg")).toBeNull();
  });

  it("starts a signed-in agent in the task's terminal from a small mark before its state, on a workspace on this computer alone", () => {
    const typed: string[] = [];
    drawPanel({ ctx: { where: "here", typeInTerminal: line => void typed.push(line) } });
    const mark = stepOf("claude", "open-terminal")!;
    expect(mark.textContent).toBe("");
    expect(mark.getAttribute("aria-label")).toBe(W.openInTerminal);
    expect(mark.getAttribute("data-size") ?? mark.className).toMatch(/icon-xs|size-6/);
    expect(stateOf("claude")).toEqual(["Signed in", "good"]);
    // The mark stands before the state.
    const state = rowOf("claude").querySelector("[data-k=agent-status]")!;
    expect(mark.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(mark);
    expect(typed).toEqual(["claude"]);
    expect(headTitle(), "the mark acts in place").toBeUndefined();
    cleanup();
    drawPanel();
    expect(stepOf("claude", "open-terminal")).toBeNull();
    expect(panel().textContent).not.toContain(W.openInTerminal);
  });

  it("marks a newer version before the state, its version on the hover", () => {
    drawPanel({ report: { ...AGENTS_REPORT, agents: AGENTS_REPORT.agents.map(a => (a.id === "claude" ? { ...a, update: { to: "2.1.290", command: "claude update" } } : a)) } });
    expect(rowOf("claude").querySelector("[data-k=agent-update]")?.getAttribute("aria-label")).toBe("Update to 2.1.290");
    expect(rowOf("codex").querySelector("[data-k=agent-update]")).toBeNull();
  });

  it("lists the agents not installed in a card of their own, who each is under its name and Install alone", () => {
    drawPanel({ ctx: { where: "here" } });
    const available = panel().querySelector<HTMLElement>("[data-settings-card=agents-available]")!;
    expect(available.querySelector("[data-settings-head]")?.textContent).toBe(W.availableToInstall);
    expect([...available.querySelectorAll<HTMLElement>("[data-settings-row]")].map(r => r.dataset["settingsRow"])).toEqual(["pi"]);
    expect(panel().querySelector("[data-settings-card=agents-on] [data-settings-row=pi]")).toBeNull();
    expect(descriptionOf("pi")).toBe("A small coding agent for the terminal with read, bash, edit and write tools and saved sessions.");
    expect(slotOf("pi")).toEqual(["Install"]);
    expect(stepOf("pi", "install")?.closest("[title]")?.getAttribute("title")).toBe(W.notYet);
    expect(stateOf("pi")).toBeNull();
  });
});

describe("the tool servers and the skills", () => {
  it("folds a server two agents name the same way into one row with both marks, its worst state as its word", () => {
    drawPanel();
    tab("Tool servers");
    expect(rowIds()).toEqual([SERVER.airtable, SERVER.github, SERVER.linear, SERVER.notion, SERVER.sentry, SERVER.wsp, METRICS]);
    const notion = rowOf(SERVER.notion);
    expect([...notion.querySelectorAll("[data-row-marks] [data-harness-mark]")].map(m => m.getAttribute("data-harness-mark"))).toEqual(["codex", "claude"]);
    expect(notion.querySelector("[data-row-marks]")?.getAttribute("title")).toBe("Codex, Claude Code");
    expect(descriptionOf(SERVER.notion)).toBe("mcp.notion.com");
    expect(stateOf(SERVER.notion)).toEqual(["Needs sign-in", "waiting"]);
  });

  it("says every server's state as its word and tone, and the one step only where it has a road", () => {
    const report: AgentsReport = { ...AGENTS_REPORT, servers: AGENTS_REPORT.servers.map(s => (s.name === "wsp" ? { ...s, transport: { kind: "http", host: "wsp.example" }, auth: "unknown" } : s)) };
    const tools = fakeTools();
    tools.answer("github", { auth: "connected", tools: Array.from({ length: 33 }, (_, i) => ({ name: `t${i}` })), readAt: AGENTS_REPORT.readAt });
    tools.answer("linear", { auth: "needs-sign-in", holder: "claude", readAt: AGENTS_REPORT.readAt });
    tools.answer("wsp", { auth: "connected", readAt: AGENTS_REPORT.readAt });
    drawPanel({ report, ctx: { where: "box", tools } });
    tab("Tool servers");
    expect(slotOf(SERVER.airtable)).toEqual(["Check"]);
    expect(stateOf(SERVER.notion)).toEqual(["Checking", "quiet"]);
    expect(stateOf(SERVER.linear)).toEqual(["Needs sign-in", "waiting"]);
    // Off is a state the row says; Turn on is the switch on the server's own page.
    expect(stateOf(SERVER.sentry)).toEqual(["Off", "quiet"]);
    expect(stateOf("server-global-wsp-http-wsp.example")).toEqual(["Connected", "good"]);
    expect(stateOf(SERVER.github)).toEqual(["Connected with 33 tools", "good"]);
    expect(descriptionOf(METRICS)).toBe("node scripts/metrics-mcp.js --token ${METRICS_TOKEN}");
    // A project's server is what a repo names: never asked when the tab shows it, it keeps its config's word.
    expect(stateOf(METRICS)).toEqual(["No sign-in needed", "quiet"]);
    expect(tools.asks.map(a => a[1]).sort()).toEqual(["linear", "notion", "notion", "wsp"]);
  });

  it("reads a server whose token comes from the environment as the environment's key, with no Sign in", () => {
    const report: AgentsReport = { ...AGENTS_REPORT, servers: [...AGENTS_REPORT.servers, { agent: "codex", name: "posthog", scope: "user", file: "~/.codex/config.toml", transport: { kind: "http", host: "mcp.posthog.com" }, envNames: ["POSTHOG_TOKEN"], auth: "env-key", enabled: true }] };
    drawPanel({ report, ctx: { where: "here" } });
    tab("Tool servers");
    const key = "server-global-posthog-http-mcp.posthog.com";
    expect(stateOf(key)).toEqual(["Key from the environment", "quiet"]);
    openRow(key);
    expect(headActs()).not.toContain("Sign in");
  });

  it("says a failed server as Failed with its red dot and its reason on the hover, Reconnect as an icon beside it", () => {
    const tools = fakeTools();
    tools.answer("github", SERVER_TOOLS["github"]!);
    drawPanel({ ctx: { where: "box", tools } });
    tab("Tool servers");
    expect(headsOf().slice(0, 2)).toEqual(["Global on spoochecked 3 min ago", "wsp~/wsp"]);
    expect(stateOf(SERVER.github)).toEqual(["Failed", "bad"]);
    const reconnect = stepOf(SERVER.github, "reconnect")!;
    expect(reconnect.textContent).toBe("");
    expect(reconnect.getAttribute("aria-label")).toBe(W.reconnect);
    fireEvent.click(reconnect);
    expect(tools.asks.filter(a => a[2])).toEqual([["opencode", "github", true]]);
    expect(headTitle(), "Reconnect acts in place").toBeUndefined();
  });

  it("checks a command server on a joined computer or a fork in place, its grey state saying why on its hover", () => {
    for (const [where, extra, on] of [["box", {}, "spoo"], ["fork", { editImage: () => {} }, "wsp-fork (Solari)"]] as const) {
      const tools = fakeTools();
      drawPanel({ on: { name: on }, ctx: { where, ...extra, tools } });
      tab("Tool servers");
      expect(slotOf(SERVER.airtable), where).toEqual(["Check"]);
      fireEvent.click(stepOf(SERVER.airtable, "check")!);
      expect(tools.asks.filter(a => a[1] === "airtable"), where).toEqual([["claude", "airtable", false]]);
      expect(headTitle(), "Check checks in place").toBeUndefined();
      cleanup();
    }
  });

  it("reads a server's state off its connect alone, whatever word its config gave the report", () => {
    const tools = fakeTools();
    tools.answer("linear", { auth: "needs-sign-in", holder: "claude", readAt: "2026-09-24T11:00:00.000Z" });
    tools.answer("airtable", { ...SERVER_TOOLS["airtable"]!, readAt: "2026-09-24T11:00:00.000Z" });
    const report: AgentsReport = { ...AGENTS_REPORT, servers: AGENTS_REPORT.servers.map(s => (s.name === "linear" ? { ...s, auth: "signed-in" } : s)) };
    drawPanel({ report, ctx: { where: "box", tools } });
    tab("Tool servers");
    expect(stateOf(SERVER.linear)?.[0]).toBe("Needs sign-in");
    expect(stateOf(SERVER.airtable)?.[0]).toBe("Connected with 3 tools");
  });

  it("lists skills by source, each with its real folder under its name and the agents that read it after", () => {
    drawPanel();
    tab("Skills");
    expect(headsOf().slice(0, 4)).toEqual(["System on spoochecked 3 min ago", "Plugins", "Global", "wsp~/wsp"]);
    expect(descriptionOf("skill-user-frontend-design")).toBe("~/.agents/skills/frontend-design");
    expect([...rowOf("skill-user-frontend-design").querySelectorAll("[data-row-marks] [data-harness-mark]")].map(m => m.getAttribute("data-harness-mark"))).toEqual(["claude", "codex", "opencode"]);
  });

  it("filters rows in place as the search is typed, and says when nothing matches", () => {
    drawPanel();
    tab("Skills");
    const search = panel().querySelector<HTMLInputElement>("[data-k=kind-search]")!;
    fireEvent.change(search, { target: { value: "production-grade" } });
    expect(rowIds()).toEqual(["skill-user-frontend-design"]);
    fireEvent.change(search, { target: { value: "codex" } });
    expect(rowIds()).toEqual(["skill-user-frontend-design"]);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(panel().querySelector("[data-settings-line=kind-none]")?.textContent).toBe('Nothing matches "zzz".');
  });
});

describe("an item's page", () => {
  it("opens in place of the list with a back at its top in the tabs' place, and the back finds the list as it was", () => {
    drawPanel();
    openRow("codex");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    const backButton = panel().querySelector<HTMLButtonElement>("[data-k=agents-back]")!;
    expect(backButton.getAttribute("aria-label")).toBe("Back to Agents");
    expect(backButton.textContent).toBe("Agents");
    expect(panel().querySelector("[data-agents-top]")?.contains(backButton)).toBe(true);
    expect(headTitle()).toBe("Codex");
    expect(panel().querySelector("[data-k=kind-about]")?.textContent).toBe("OpenAI's coding agent that runs locally in the terminal.");
    expect(factsOf()).toEqual([
      ["Version", "0.62.0"],
      ["Installed at", "~/.local/bin/codex"],
      ["wsp tools", "not added"],
      ["Threads", "in wsp"],
      ["Made by", "OpenAI"],
      ["License", "Apache-2.0"],
      ["Homepage", "developers.openai.com/codex"],
      ["Repository", "github.com/openai/codex"],
    ]);
    back();
    expect(screen.getByRole("radiogroup")).not.toBeNull();
    expect(rowIds()).toEqual(["claude", "codex", "opencode", "pi"]);
    tab("Tool servers");
    openRow(SERVER.notion);
    expect(panel().querySelector("[data-k=agents-back]")?.textContent).toBe("Tool servers");
    back();
    expect(screen.getByRole("radio", { name: /^Tool servers/ }).getAttribute("aria-checked") ?? screen.getByRole("radio", { name: /^Tool servers/ }).getAttribute("data-checked")).not.toBeNull();
  });

  it("puts focus on the back when a page opens, so Escape where focus lands goes back one page, from an item to its list and from a found result to its add", () => {
    const skills = { busyOf: () => false, toggle: () => {}, remove: () => {}, previewOf: () => undefined, loadPreview: () => {}, refusedOf: () => undefined, search: () => {}, searchOf: () => ({ reading: false, hits: [{ id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 3 }] }), remoteOf: () => undefined, loadRemote: () => {}, picksOf: () => ({ agents: [] }), setPicks: () => {}, add: () => {} } as unknown as RowsContext["skills"];
    drawPanel({ ctx: { where: "box", ...(skills === undefined ? {} : { skills }) } });
    const escape = (): void => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    // On the list itself Escape is left to whoever else hears it.
    rowOf("codex").focus();
    escape();
    expect(rowIds()).toEqual(["claude", "codex", "opencode", "pi"]);
    fireEvent.click(rowOf("codex"));
    expect(headTitle()).toBe("Codex");
    expect(document.activeElement?.getAttribute("data-k")).toBe("agents-back");
    escape();
    expect(headTitle()).toBeUndefined();
    expect(screen.getByRole("radiogroup")).not.toBeNull();
    tab("Skills");
    fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-k=kind-add]")!);
    const field = panel().querySelector<HTMLInputElement>("[data-k=add-search]")!;
    fireEvent.change(field, { target: { value: "pdf" } });
    fireEvent.keyDown(field, { key: "Enter" });
    // A field keeps its own Escape.
    field.focus();
    escape();
    expect(panel().querySelector("[data-k=add-search]")).not.toBeNull();
    fireEvent.click(panel().querySelector<HTMLElement>('[data-found-row="anthropics/skills/pdf"]')!);
    expect(headTitle()).toBe("pdf");
    expect(document.activeElement?.getAttribute("data-k")).toBe("agents-back");
    escape();
    expect(panel().querySelector<HTMLInputElement>("[data-k=add-search]")?.value).toBe("pdf");
    expect(document.activeElement?.getAttribute("data-k")).toBe("agents-back");
    escape();
    expect(panel().querySelector("[data-k=add-search]")).toBeNull();
    expect(screen.getByRole("radio", { name: /^Skills/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps a typed form on Escape at any of its controls, and leaves it on Escape at its back", () => {
    const servers = { add: () => new Promise(() => {}), remove: () => {}, toggle: () => {}, busyOf: () => false, refusedOf: () => undefined };
    drawPanel({ ctx: { where: "box", servers } });
    tab("Tool servers");
    fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-k=kind-add]")!);
    const name = panel().querySelector<HTMLInputElement>("[data-k=add-server-name]")!;
    fireEvent.change(name, { target: { value: "acme" } });
    const controls = [panel().querySelector<HTMLElement>("[data-k=add-server-agent]")!, screen.getByRole("radio", { name: W.byAddress }), panel().querySelector<HTMLElement>("[data-k=add-server-pair-add]")!];
    for (const control of controls) {
      control.focus();
      fireEvent.keyDown(control, { key: "Escape" });
      expect(panel().querySelector<HTMLInputElement>("[data-k=add-server-name]")?.value, control.getAttribute("data-k") ?? control.textContent ?? "").toBe("acme");
    }
    const backButton = panel().querySelector<HTMLButtonElement>("[data-k=agents-back]")!;
    backButton.focus();
    fireEvent.keyDown(backButton, { key: "Escape" });
    expect(panel().querySelector("[data-k=add-server-name]")).toBeNull();
    expect(panel().querySelector("[data-k=kind-search]")).not.toBeNull();
  });

  it("names the real binary where another app's wrapper answers first, the latest and the recipe's pin beside the version", () => {
    drawPanel();
    openRow("claude");
    expect(factOf("installed-at")?.querySelector("[data-fact-value]")?.textContent).toBe("/opt/wsp/bin/claude");
    expect(factOf("installed-at")?.textContent).toContain("via a shim from cmux");
    expect(factOf("version")?.textContent).toContain("latest 2.1.282, recipe pins 2.1.280");
    back();
    openRow("opencode");
    expect(factOf("installed-at")?.querySelector("[data-fact-value]")).toBeNull();
    expect(factOf("installed-at")?.textContent).toContain("via a shim from mise");
  });

  it("says who an agent not installed is, its latest version, the line that installs it to copy, and opens its pages in the browser", () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    drawPanel();
    openRow("pi");
    expect(panel().querySelector("[data-k=kind-about]")?.textContent).toMatch(/^A small coding agent/);
    expect(factsOf()).toEqual([
      ["Latest", "0.84.4"],
      ["Threads", "not yet in wsp"],
      ["Made by", "Earendil Works"],
      ["License", "MIT"],
      ["Repository", "github.com/earendil-works/pi"],
      ["Install", "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4"],
    ]);
    expect(factOf("install")?.querySelector("[data-copy-row]")).not.toBeNull();
    fireEvent.click(factOf("repo")!.querySelector<HTMLElement>("[data-fact-value]")!);
    expect(opened).toHaveBeenCalledWith("https://github.com/earendil-works/pi", "_blank", "noopener,noreferrer");
    opened.mockRestore();
  });

  it("says where a release installs from in words, not a line to copy, and no Repository where the source is not public", () => {
    const available = (id: string, name: string): AgentsReport["agents"][number] => ({ id, name, installed: false, road: "none", signIn: "none", signInRoad: "none", wspTools: false });
    drawPanel({ report: { ...AGENTS_REPORT, agents: [...AGENTS_REPORT.agents, available("crush", "Crush"), available("amp", "Amp")] } });
    expect(descriptionOf("crush")).toMatch(/^Charm's coding agent for the terminal\./);
    openRow("crush");
    expect(factsOf().at(-1)).toEqual(["Install", "the v0.96.1 release of github.com/charmbracelet/crush"]);
    expect(factOf("install")?.querySelector("[data-copy-row]")).toBeNull();
    back();
    openRow("amp");
    expect(factsOf().map(f => f[0])).toEqual(["Threads", "Made by", "License", "Homepage", "Install"]);
  });

  it("offers a signed-in agent its terminal in the head where the task's terminal is, and Sign in where none stands", () => {
    const typed: string[] = [];
    const acts = { flowOf: () => undefined, start: () => {}, cancel: () => {}, code: () => {}, save: () => {}, addTools: () => {}, adding: () => false };
    drawPanel({ ctx: { where: "here", acts, typeInTerminal: line => void typed.push(line) } });
    openRow("claude");
    expect(headActs()).toEqual(["Open in terminal"]);
    fireEvent.click(headAct("open-terminal")!);
    expect(typed).toEqual(["claude"]);
    back();
    openRow("opencode");
    expect(headActs()).toEqual(["Add the wsp tools", "Sign in"]);
  });

  it("shows a folded server's command, each agent's file with its own state where they disagree, and its sign-in on that agent's line", () => {
    drawPanel();
    tab("Tool servers");
    openRow(SERVER.notion);
    expect(factsOf()).toEqual([
      ["URL", "mcp.notion.com"],
      ["Headers", "Authorization"],
      ["Config location", "~/.codex/config.toml"],
      ["", "~/.claude.json"],
    ]);
    expect([...panel().querySelectorAll<HTMLElement>("[data-settings-line^=fact-config-] [data-k=kind-status]")].map(s => s.textContent)).toEqual(["Not checked", "Needs sign-in"]);
    expect([...panel().querySelectorAll("[data-settings-line^=fact-config-] [data-harness-mark]")].map(m => m.getAttribute("data-harness-mark"))).toEqual(["codex", "claude"]);
    expect(factOf("config-claude")?.querySelector("[data-k=act-sign-in]")).not.toBeNull();
    expect(factOf("reach")?.querySelector("[data-k=fact-copy]")).not.toBeNull();
    expect(panel().querySelector("[data-settings-card=kind-remove] [data-k=act-remove]")?.textContent).toBe("Remove");
  });

  it("lists a project server's tools from the tools card's refresh, and says why a harness-held server's are not listed in the quiet voice", () => {
    const tools = fakeTools();
    const { rerender } = drawPanel({ ctx: { where: "box", tools } });
    tab("Tool servers");
    openRow(METRICS);
    const card = (): HTMLElement => panel().querySelector<HTMLElement>("[data-settings-card=kind-under]")!;
    expect(card().querySelector("[data-settings-head]")?.textContent).toContain("Tools of spoo-metrics");
    expect(card().querySelector("[data-settings-line=under-none]")?.textContent).toBe("Not listed yet.");
    fireEvent.click(card().querySelector<HTMLButtonElement>("[data-k=agents-refresh]")!);
    expect(tools.asks.filter(a => a[1] === "spoo-metrics")).toEqual([["claude", "spoo-metrics", true]]);
    tools.answer("spoo-metrics", SERVER_TOOLS["airtable"]!);
    rerender(panelOf({ report: { ...AGENTS_REPORT }, ctx: { where: "box", tools } }));
    expect([...card().querySelectorAll<HTMLElement>("[data-settings-row^=under-]")].map(r => r.dataset["settingsRow"])).toEqual(["under-list_records", "under-create_record", "under-list_bases"]);
    back();
    tools.answer("notion", { auth: "signed-in", holder: "claude", readAt: AGENTS_REPORT.readAt });
    rerender(panelOf({ report: { ...AGENTS_REPORT }, ctx: { where: "box", tools } }));
    openRow(SERVER.notion);
    const quiet = card().querySelector<HTMLElement>("[data-settings-line=under-none]")!;
    expect(quiet.textContent).toBe(W.keepsSignIn("Claude Code"));
    expect(quiet.innerHTML).not.toContain("destructive");
  });

  it("says what a skill wsp writes, a plugin's and a project's can and cannot do", () => {
    drawPanel();
    tab("Skills");
    openRow("skill-user-wsp");
    expect(head().querySelector("[data-k=kind-status]")?.textContent).toBe("Always on");
    expect(headActs()).toEqual([]);
    back();
    openRow("skill-user-frontend-design");
    expect(factsOf()).toEqual([
      ["Description", "Create distinctive, production-grade frontend interfaces with high design quality."],
      ["Path", "~/.agents/skills/frontend-design"],
      ["", "~/.claude/skills/frontend-design"],
      ["", "~/.codex/skills/frontend-design"],
      ["", "~/.config/opencode/skills/frontend-design"],
    ]);
    expect(factOf("path-0")?.textContent).toContain("shared");
    back();
    openRow("skill-plugin-pdf");
    expect(headActs()).toEqual([]);
  });

  it("goes back to the list when the open item leaves the report, and stays there when it returns", () => {
    const { rerender } = drawPanel();
    openRow("codex");
    rerender(panelOf({ report: { ...AGENTS_REPORT, agents: AGENTS_REPORT.agents.filter(a => a.id !== "codex") } }));
    rerender(panelOf({ report: { ...AGENTS_REPORT, agents: AGENTS_REPORT.agents.filter(a => a.id !== "codex") } }));
    expect(headTitle()).toBeUndefined();
    rerender(panelOf());
    expect(headTitle()).toBeUndefined();
    expect(rowIds()).toEqual(["claude", "codex", "opencode", "pi"]);
  });

  it("leaves no timer behind when a copied value's glyph goes before its check has turned back", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } });
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = drawPanel();
    openRow("codex");
    fireEvent.click(factOf("installed-at")!.querySelector<HTMLButtonElement>("[data-k=fact-copy]")!);
    await act(async () => {});
    const at = set.mock.calls.findIndex(c => c[1] === 1_400);
    expect(at).toBeGreaterThanOrEqual(0);
    const id = set.mock.results[at]!.value as unknown;
    unmount();
    expect(clear.mock.calls.map(c => c[0])).toContain(id);
    set.mockRestore();
    clear.mockRestore();
  });
});

describe("the states", () => {
  it("stands a card's skeleton before the first report", () => {
    drawPanel({ report: null, reading: true });
    expect(panel().querySelector("[data-k=agents-reading]")?.getAttribute("aria-busy")).toBe("true");
    tab("Tool servers");
    expect(panel().querySelector("[data-k=agents-reading]")).not.toBeNull();
  });

  it("says the host's own sentence where a read was refused and nothing stood before it, with no skeleton", () => {
    drawPanel({ report: null, error: "Solari keeps no computer to read" });
    expect(panel().querySelector("[data-k=agents-reading]")).toBeNull();
    expect(panel().querySelector("[data-settings-card=not-read] [data-refused-line=read-refused]")?.textContent).toBe("Solari keeps no computer to read");
  });

  it("lists each refusal of the report in the Not read card, the reader then the reason", () => {
    drawPanel();
    const lines = [...panel().querySelectorAll<HTMLElement>("[data-settings-card=not-read] [data-refused-line]")].map(l => [l.querySelector("[data-settings-title]")?.textContent, l.querySelector("[data-settings-description]")?.textContent ?? ""]);
    expect(lines).toEqual([
      ["Skills", "The answer was cut short, so the list is not whole"],
      ["~/.hermes/config.yaml is over 1 MB and was not read", ""],
    ]);
  });

  it("says an empty tab in the card's one quiet line", () => {
    drawPanel({ report: { ...AGENTS_REPORT, skills: [], servers: [] } });
    tab("Tool servers");
    expect(panel().querySelector("[data-settings-line=kind-none]")?.textContent).toBe("No tool servers on spoo yet.");
  });

  it("says not answering in place of the read time, its reason on the hover, and holds every act", () => {
    const refresh = vi.fn();
    drawPanel({ ctx: { where: "here", heldWhy: "no answer 5m", typeInTerminal: () => {} }, refresh });
    const stale = panel().querySelector<HTMLElement>("[data-k=agents-stale]")!;
    expect(stale.textContent).toBe("Not answering");
    expect(stale.getAttribute("title")).toBe("no answer 5m");
    expect(panel().querySelector("[data-k=agents-read-at]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Read the agents again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stepOf("claude", "open-terminal")).toBeNull();
    expect(slotOf("pi")).toEqual([]);
    tab("Skills");
    expect(panel().querySelector("[data-k=kind-add]")?.closest("[title]")?.getAttribute("title")).toBe("no answer 5m");
  });

  it("calls a computer not answering only once it has been silent a while", () => {
    expect(saysNotAnswering(null)).toBe(true);
    expect(saysNotAnswering(NOT_ANSWERING_AFTER_MS - 1)).toBe(false);
    expect(saysNotAnswering(NOT_ANSWERING_AFTER_MS)).toBe(true);
  });

  it("says paused on a paused task's last report and holds what it offers", () => {
    drawPanel({ report: { ...AGENTS_REPORT, stale: "napping" }, ctx: { where: "here", typeInTerminal: () => {} } });
    expect(panel().querySelector("[data-k=agents-stale]")?.textContent).toBe("Paused");
    expect(stepOf("claude", "open-terminal")).toBeNull();
  });

  it("offers Edit image on a fork in Add's place and on every item's page, and nothing else", () => {
    const editImage = vi.fn();
    drawPanel({ ctx: { where: "fork", editImage } });
    expect(slotOf("codex")).toEqual([]);
    openRow("claude");
    expect(headActs()).toEqual(["Edit image"]);
    fireEvent.click(headAct("edit-image")!);
    expect(editImage).toHaveBeenCalledTimes(1);
    back();
    tab("Skills");
    const add = panel().querySelector<HTMLButtonElement>("[data-k=kind-add]")!;
    expect(add.textContent).toBe("Edit image");
    fireEvent.click(add);
    expect(editImage).toHaveBeenCalledTimes(2);
  });

  it("shows a task on a box no act of its own: states in place of steps, no Install, and Add held for that box's page", () => {
    drawPanel({ ctx: { where: "box-task", computer: "spoo", typeInTerminal: () => {} } });
    expect(stateOf("codex")).toEqual(["Needs sign-in", "waiting"]);
    expect(slotOf("pi")).toEqual([]);
    openRow("claude");
    expect(headActs()).toEqual([]);
    back();
    tab("Tool servers");
    expect(panel().querySelectorAll("[data-settings-card] [data-settings-control] [data-k^=act-]")).toHaveLength(0);
    expect(panel().querySelector("[data-k=kind-add]")?.closest("[title]")?.getAttribute("title")).toBe("on spoo's page");
  });
});

describe("the status dots", () => {
  it("stands a dot after every state's word in every row and on every page, on all three tabs", () => {
    const tools = fakeTools();
    tools.answer("airtable", SERVER_TOOLS["airtable"]!);
    tools.answer("github", SERVER_TOOLS["github"]!);
    drawPanel({ ctx: { where: "box", tools } });
    const undotted = (): string[] => [...panel().querySelectorAll<HTMLElement>("[data-k=agent-status], [data-k=kind-status]")].filter(s => !/bg-(success|warning|destructive|foreground\/30)/.test(s.lastElementChild?.className ?? "")).map(s => s.textContent ?? "");
    for (const name of ["Agents", "Tool servers", "Skills"]) {
      tab(name);
      expect(undotted(), name).toEqual([]);
      for (const id of rowIds()) {
        openRow(id);
        expect(undotted(), id).toEqual([]);
        back();
      }
    }
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
    const linear = { ...AGENTS_REPORT.servers.find(s => s.name === "linear")!, auth: "unknown" } as const;
    const box = { where: "box" } as const;
    const checked = { where: "box", tools: fakeTools() } as const;
    expect(rowState(linear, undefined, box)).toBe("unknown");
    expect(rowState(linear, undefined, checked)).toBe("checking");
    expect(rowState(linear, undefined, { ...checked, heldWhy: "away 5 min" }), "nothing is asked while the computer is away").toBe("unknown");
    expect(rowState(linear, { listing: true }, box)).toBe("checking");
    expect(rowState(linear, { listing: false, answer: { auth: "signed-in", readAt: "" } }, checked)).toBe("signed-in");
    expect(rowState(linear, { listing: true, answer: { auth: "failed", readAt: "" } }, checked), "the last answer stands while the next is asked").toBe("failed");
    expect(rowState(linear, { listing: false, error: "spoo is not answering" }, checked)).toBe("failed");
    expect(rowState({ ...linear, scope: "project" }, undefined, checked)).toBe("unknown");
    expect(rowState({ ...linear, auth: "env-key" }, undefined, checked)).toBe("env-key");
    expect(rowState({ ...linear, enabled: false }, { listing: false, answer: { auth: "signed-in", readAt: "" } }, checked)).toBe("off");
  });

  it("maps the report's flat refusals to lines", () => {
    expect(refusedLines(["agents: the login PATH could not be read", "a sentence alone"])).toEqual([
      { id: "refused-0", label: "Agents", value: "the login PATH could not be read" },
      { id: "refused-1", label: "a sentence alone" },
    ]);
  });

  it("reads a cloud's agents off the image it sealed, at the pins, signed in where the seal carried the login", () => {
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
      sealedFrom: "zingzy-mbp",
    } as SealedImage;
    const report = imageAgentsReport(image, "solari");
    expect(report.agents.map(a => [a.id, a.version, a.signIn])).toEqual([
      ["claude", "2.1.280", "signed-in"],
      ["codex", "0.62.0", "unknown"],
    ]);
  });
});
