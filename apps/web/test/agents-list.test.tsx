// SPDX-License-Identifier: AGPL-3.0-only
// Agents, Skills and Servers over one fixture report: each segment's rows
// with their chips in the fixed order, the slot's word or button, the row
// that opens downward as its own labelled region off a disclosure button
// that holds no other button, the head-less card of refusals, and every
// state word: the first read, a read over a report, empty, away, paused, a
// fork and a cloud's page. Heights are measured in the render test.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsReport, SealedImage } from "@wsp/protocol";
import { AgentsList, type AgentsListProps } from "../src/components/agents/AgentsList.js";
import { AGENTS_LIST_WORDS, imageAgentsReport, recipeMissLines, refusedLines } from "../src/components/agents/agentsRows.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";

const NOW = Date.parse("2026-09-24T12:03:00.000Z");

afterEach(cleanup);

function draw(over: Partial<AgentsListProps> = {}) {
  return render(<AgentsList shell="page" report={AGENTS_REPORT} reading={false} on="spoo" ctx={{ where: "box" }} onRefresh={() => {}} now={NOW} {...over} />);
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-agents-row]")];
const rowEl = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-agents-row="${id}"]`)!;
const titles = (): string[] => rows().map(row => row.querySelector("[data-row-title]")!.textContent ?? "");
const chips = (id: string): string[] => [...rowEl(id).querySelectorAll<HTMLElement>("[data-chip]")].map(chip => chip.textContent ?? "");
const twoLineChips = (id: string): string[] => [...rowEl(id).querySelectorAll<HTMLElement>("[data-chip]:not([data-page-only])")].map(chip => chip.textContent ?? "");
const word = (id: string): string | undefined => rowEl(id).querySelector("[data-row-word]")?.textContent ?? undefined;
const slotButton = (id: string): HTMLButtonElement | null => rowEl(id).querySelector<HTMLButtonElement>("[data-row-slot] button");
const trigger = (id: string): HTMLButtonElement => rowEl(id).querySelector<HTMLButtonElement>("[data-row-trigger]")!;
const region = (id: string): HTMLElement | null => rowEl(id).querySelector<HTMLElement>("[role=region]");
const lines = (el: ParentNode): [string, string | undefined][] => [...el.querySelectorAll<HTMLElement>("[data-open-line]")].map(line => [line.querySelector("[data-open-label]")!.textContent ?? "", line.querySelector("[data-open-value]")?.textContent ?? undefined]);
const acts = (id: string): string[] => [...region(id)!.querySelectorAll<HTMLElement>("[data-row-acts] button")].map(b => b.textContent ?? "");
const segment = (name: string): void => {
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
};

describe("the Agents segment", () => {
  it("heads the list with the three segments and their counts, and draws one row per agent on the PATH", () => {
    draw();
    expect(screen.getByRole("region", { name: AGENTS_LIST_WORDS.section }).tagName).toBe("SECTION");
    expect(screen.getAllByRole("radio").map(r => r.textContent)).toEqual(["Agents3", "Skills3", "Servers6"]);
    expect(titles()).toEqual(["Claude Code", "Codex", "OpenCode"]);
  });

  it("puts version, wsp tools and recipe in that order, the recipe on the one-line row alone", () => {
    draw();
    expect(chips("agent-claude")).toEqual(["2.1.281", "wsp tools", "recipe"]);
    expect(twoLineChips("agent-claude")).toEqual(["2.1.281", "wsp tools"]);
    // A fact the report does not carry drops its chip: a shorter line, never a taller row.
    expect(chips("agent-opencode")).toEqual(["1.14.2"]);
  });

  it("shows Update where a newer version exists with the version as its hover, Sign in where none stands, and the word otherwise", () => {
    draw();
    expect(word("agent-claude")).toBe("signed in");
    expect(slotButton("agent-claude")?.textContent).toBe("Update");
    expect(rowEl("agent-claude").querySelector("[data-act-hover=update]")?.getAttribute("title")).toBe("2.1.282");
    expect(word("agent-codex")).toBeUndefined();
    expect(slotButton("agent-codex")?.textContent).toBe("Sign in");
    expect(word("agent-opencode")).toBe("not checked");
    expect(slotButton("agent-opencode")).toBeNull();
    // Every act here waits for its own road, so none of them can be pressed yet.
    expect(slotButton("agent-codex")?.disabled).toBe(true);
  });

  it("opens a row downward as a region named by its title, from a disclosure that holds no other button", () => {
    draw();
    const t = trigger("agent-claude");
    expect(t.tagName).toBe("BUTTON");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(region("agent-claude")).toBeNull();
    expect(t.querySelector("button")).toBeNull();
    expect(t.contains(slotButton("agent-claude"))).toBe(false);
    fireEvent.click(t);
    expect(t.getAttribute("aria-expanded")).toBe("true");
    const open = region("agent-claude")!;
    expect(t.getAttribute("aria-controls")).toBe(open.id);
    expect(screen.getByRole("region", { name: "Claude Code" })).toBe(open);
    expect(lines(open)).toEqual([
      ["Version", "2.1.281 · recipe pins 2.1.280"],
      ["Installed at", "/opt/wsp/bin/claude"],
      ["Sign-in", "token"],
      ["wsp tools", "~/.claude.json"],
    ]);
    expect(acts("agent-claude")).toEqual(["Sign in", "Update", "Remove"]);
    expect(rowEl("agent-claude").querySelector("[data-row-slot] svg")?.getAttribute("class")).toContain("rotate-180");
    // Only the rows below move: the next row is still there, shut.
    expect(trigger("agent-codex").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(t);
    expect(region("agent-claude")).toBeNull();
  });

  it("offers Add the wsp tools only where the agent has none, and holds Update and Remove on a binary wsp did not put there", () => {
    draw();
    fireEvent.click(trigger("agent-opencode"));
    expect(acts("agent-opencode")).toEqual(["Sign in", "Add the wsp tools", "Remove"]);
    expect(rowEl("agent-opencode").querySelector("[data-act-hover=remove]")?.getAttribute("title")).toBe(AGENTS_LIST_WORDS.shim);
    fireEvent.click(trigger("agent-codex"));
    expect(acts("agent-codex")).toEqual(["Sign in", "Remove"]);
    expect(rowEl("agent-codex").querySelector("[data-act-hover=remove]")?.getAttribute("title")).toBe(AGENTS_LIST_WORDS.own);
  });

  it("puts Install an agent under the card", () => {
    draw();
    expect(document.querySelector("[data-agents-under]")?.textContent).toBe("Install an agent");
  });
});

describe("the Skills segment", () => {
  it("draws the real folder and the agents that read it, their names on the hover, and marks a plugin's and a project's", () => {
    draw();
    segment("Skills");
    expect(titles()).toEqual(["frontend-design", "pdf", "wsp-review"]);
    expect(chips("skill-user-frontend-design")).toEqual(["~/.agents/skills/frontend-design", "3 agents"]);
    expect(rowEl("skill-user-frontend-design").querySelectorAll("[data-chip]")[1]!.getAttribute("title")).toBe("Claude Code, Codex, OpenCode");
    expect(rowEl("skill-plugin-pdf").querySelector("[data-row-mark]")?.textContent).toBe("plugin");
    expect(rowEl("skill-project-wsp-review").querySelector("[data-row-mark]")?.textContent).toBe("project");
    expect(rowEl("skill-user-frontend-design").querySelector("[data-row-mark]")).toBeNull();
    // A skill has no state: no word in its slot.
    expect(word("skill-user-frontend-design")).toBeUndefined();
    expect(document.querySelector("[data-agents-under]")?.textContent).toBe("Add a skill");
  });

  it("opens on its description, the shared folder first and then each agent's own path alone, and a plugin's row has no act", () => {
    draw();
    segment("Skills");
    fireEvent.click(trigger("skill-user-frontend-design"));
    const open = region("skill-user-frontend-design")!;
    expect(open.querySelector("p")?.textContent).toBe("Create distinctive, production-grade frontend interfaces with high design quality.");
    expect(lines(open)).toEqual([
      ["shared", "~/.agents/skills/frontend-design"],
      ["Claude Code", "~/.claude/skills/frontend-design"],
      ["Codex", "~/.codex/skills/frontend-design"],
      ["OpenCode", "~/.config/opencode/skills/frontend-design"],
    ]);
    expect(acts("skill-user-frontend-design")).toEqual(["Remove"]);
    fireEvent.click(trigger("skill-plugin-pdf"));
    expect(region("skill-plugin-pdf")!.querySelector("[data-row-acts]")).toBeNull();
  });
});

describe("the Servers segment", () => {
  it("puts the transport, the names and the recipe in that order, the two-line row keeping the transport and the recipe", () => {
    draw();
    segment("Servers");
    expect(chips("server-claude-user-airtable")).toEqual(["npx -y airtable-mcp-server", "AIRTABLE_API_KEY", "recipe"]);
    expect(twoLineChips("server-claude-user-airtable")).toEqual(["npx -y airtable-mcp-server", "recipe"]);
    expect(chips("server-codex-user-notion")).toEqual(["mcp.notion.com", "Authorization"]);
    expect(rowEl("server-claude-user-airtable").querySelector("[data-row-mark]")?.textContent).toBe("Claude Code");
  });

  it("says each server's word, never red, and puts Sign in where one is needed", () => {
    draw();
    segment("Servers");
    expect(word("server-claude-user-airtable")).toBeUndefined();
    expect(word("server-codex-user-notion")).toBe("not checked");
    expect(word("server-codex-user-sentry")).toBe("disabled");
    expect(slotButton("server-claude-user-linear")?.textContent).toBe("Sign in");
    expect(word("server-claude-user-linear")).toBeUndefined();
    for (const w of document.querySelectorAll("[data-row-word]")) expect(w.getAttribute("class")).not.toContain("destructive");
  });

  it("opens on its command, its file and the names it reads, with List tools saying it starts the server once", () => {
    draw();
    segment("Servers");
    fireEvent.click(trigger("server-claude-user-airtable"));
    expect(lines(region("server-claude-user-airtable")!)).toEqual([
      ["Command", "npx -y airtable-mcp-server"],
      ["File", "~/.claude.json"],
      ["Environment", "AIRTABLE_API_KEY"],
    ]);
    expect(acts("server-claude-user-airtable")).toEqual(["List tools", "Remove"]);
    expect(rowEl("server-claude-user-airtable").querySelector("[data-act-hover=list-tools]")?.getAttribute("title")).toBe("starts the server once");
    fireEvent.click(trigger("server-codex-user-notion"));
    expect(lines(region("server-codex-user-notion")!)[0]).toEqual(["Address", "mcp.notion.com"]);
    expect(acts("server-codex-user-notion")).toEqual(["List tools", "Sign in", "Remove"]);
  });
});

describe("the lines under the rows", () => {
  it("draws each reader that could not answer as its own line in a head-less card, and a line with no reader as a sentence", () => {
    draw({ misses: recipeMissLines([{ id: "agents/mcp/linear", label: "linear", outcome: "skipped", kind: "server", note: "waited on GitHub CLI" }]) });
    const card = document.querySelector<HTMLElement>("[data-agents-refused]")!;
    expect(card.querySelector("h2")).toBeNull();
    expect(lines(card)).toEqual([
      ["Skills", "the answer was cut short, so the list is not whole"],
      ["~/.hermes/config.yaml is over 1 MB and was not read", undefined],
      ["linear", "set aside: waited on GitHub CLI"],
    ]);
    // Never mixed into the card of rows.
    expect(document.querySelector("[data-agents-rows] [data-open-line]")).toBeNull();
  });

  it("draws no such card where nothing was refused", () => {
    draw({ report: { ...AGENTS_REPORT, refused: [] } });
    expect(document.querySelector("[data-agents-refused]")).toBeNull();
  });

  it("maps the report's flat refusals and the recipe's missing rows to lines", () => {
    expect(refusedLines(["agents: the login PATH could not be read", "list: the answer for 3 paths was cut short"])).toEqual([
      { id: "refused-0", label: "Agents", value: "the login PATH could not be read" },
      { id: "refused-1", label: "List", value: "the answer for 3 paths was cut short" },
    ]);
    expect(
      recipeMissLines([
        { id: "agents/codex", label: "Codex", outcome: "failed", note: "npm exited 1" },
        { id: "agents/claude", label: "Claude Code", outcome: "installed" },
        { id: "tools/gh", label: "GitHub CLI", outcome: "failed" },
        { id: "agents/files/skills", label: "code-review", outcome: "failed", kind: "file" },
      ]).map(l => [l.label, l.value]),
    ).toEqual([
      ["Codex", "failed: npm exited 1"],
      ["code-review", "failed"],
    ]);
  });
});

describe("the list's states", () => {
  it("holds the list at three rows' height before the first report, busy", () => {
    draw({ report: null, reading: true });
    expect(document.querySelectorAll("[data-k=agents-skeleton]")).toHaveLength(3);
    expect(document.querySelector("[data-agents-rows]")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByRole("radio").map(r => r.textContent)).toEqual(["Agents", "Skills", "Servers"]);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("dims the rows in place while a read runs over a report", () => {
    draw({ reading: true });
    expect(rows()).toHaveLength(3);
    for (const row of rows()) expect(row.className).toContain("opacity-50");
  });

  it("reads again on the refresh glyph, which says when the report was read", () => {
    const onRefresh = vi.fn();
    draw({ onRefresh });
    const again = screen.getByRole("button", { name: "Read again" });
    expect(again.parentElement?.getAttribute("title")).toBe("read 3 min ago");
    fireEvent.click(again);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("says a segment is empty in one muted line naming the computer", () => {
    draw({ report: { ...AGENTS_REPORT, skills: [], servers: [] } });
    segment("Skills");
    expect(document.querySelector("[data-k=agents-empty]")?.textContent).toBe("No skills on spoo yet.");
    segment("Servers");
    expect(document.querySelector("[data-k=agents-empty]")?.textContent).toBe("No MCP servers on spoo yet.");
  });

  it("holds every act and the refresh glyph with the page's away word over the last report", () => {
    draw({ ctx: { where: "box", heldWhy: "no answer" } });
    expect(screen.getByRole("button", { name: "Read again" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Read again" }).parentElement?.getAttribute("title")).toBe("no answer");
    expect(rowEl("agent-claude").querySelector("[data-act-hover=update]")?.getAttribute("title")).toBe("no answer");
    expect(document.querySelector("[data-agents-under] [data-act-hover]")?.getAttribute("title")).toBe("no answer");
  });

  it("says paused beside the glyph on a paused task's last report, and holds what it offers", () => {
    draw({ shell: "panel", report: { ...AGENTS_REPORT, stale: "napping" }, ctx: { where: "fork" } });
    expect(document.querySelector("[data-k=agents-paused]")?.textContent).toBe("paused");
    expect(screen.getByRole("button", { name: "Read again" }).hasAttribute("disabled")).toBe(true);
  });

  it("offers one Edit image on a fork in every act's place, and no button in a slot", () => {
    const editImage = vi.fn();
    draw({ shell: "panel", ctx: { where: "fork", editImage } });
    expect(slotButton("agent-codex")).toBeNull();
    fireEvent.click(trigger("agent-claude"));
    expect(acts("agent-claude")).toEqual(["Edit image"]);
    const under = within(document.querySelector<HTMLElement>("[data-agents-under]")!).getByRole("button");
    expect(under.textContent).toBe("Edit image");
    fireEvent.click(under);
    expect(editImage).toHaveBeenCalledTimes(1);
  });

  it("holds a task on a box's acts for that box's page", () => {
    draw({ shell: "panel", ctx: { where: "box-task", computer: "spoo" } });
    expect(rowEl("agent-claude").querySelector("[data-act-hover=update]")?.getAttribute("title")).toBe("on spoo's page");
  });

  it("draws the panel with no card shell, the rows divided by hairlines", () => {
    draw({ shell: "panel" });
    const list = document.querySelector<HTMLElement>("[data-agents-rows]")!;
    expect(list.className).not.toContain("rounded");
    expect(list.className).toContain("divide-y");
    expect(document.querySelector("[data-agents-list]")?.className).toContain("@container");
  });

  it("says the host's own sentence where a read was refused and nothing stood before it", () => {
    draw({ report: null, error: "Solari keeps no computer to read" });
    expect(document.querySelector("[data-k=agents-skeleton]")).toBeNull();
    expect(lines(document.querySelector("[data-agents-refused]")!)).toEqual([["Solari keeps no computer to read", undefined]]);
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

  it("draws the agents the image was sealed with at their pins, the recipe chip on each, and Edit image under the card", () => {
    const editImage = vi.fn();
    const report: AgentsReport = imageAgentsReport(image, "solari");
    draw({ report, ctx: { where: "provider", editImage } });
    expect(titles()).toEqual(["Claude Code", "Codex"]);
    expect(chips("agent-claude")).toEqual(["2.1.280", "recipe"]);
    expect(word("agent-claude")).toBe("signed in");
    expect(word("agent-codex")).toBe("not checked");
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-agents-under]")!).getByRole("button"));
    expect(editImage).toHaveBeenCalledTimes(1);
    segment("Skills");
    expect(document.querySelector("[data-agents-under]")).toBeNull();
  });
});
