// SPDX-License-Identifier: AGPL-3.0-only
// The agents panel over a read that covers every project on a computer: its
// tool servers and skills stand under Global, then one card per project by
// name with its folder; a server or skill of one name in two projects is two
// rows; an act on a project's row names that project to the host, and the
// report read again is the computer's. Add a tool server and Add a skill ask
// where it goes: the home, or one of the projects.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsProject, AgentsReport, AgentsTarget, McpRow, ServerAdd, ServerAsk, ServerToolsAnswer, SkillHit, SkillRow } from "@wsp/protocol";
import { AgentsPanel } from "../src/components/agents/AgentsPanel.js";
import { AGENTS_LIST_WORDS as W } from "../src/components/agents/agentsRows.js";
import { useServerActs } from "../src/components/agents/useServerActs.js";
import { useServerTools } from "../src/components/agents/useServerTools.js";
import { useSkillActs } from "../src/components/agents/useSkillActs.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { pickOption } from "./select.js";
import { back, headAct, openRow, panel } from "./agents-panel-harness.js";

const NOW = Date.parse("2026-09-25T12:03:00.000Z");
const READ_AT = "2026-09-25T12:00:00.000Z";
const APP: AgentsProject = { id: "pr_app", name: "app", path: "~/code/app" };
const WWW: AgentsProject = { id: "pr_www", name: "www", path: "~/code/www" };

const server = (name: string, project?: AgentsProject): McpRow => ({
  agent: "claude",
  name,
  scope: project === undefined ? "user" : "project",
  file: project === undefined ? "~/.claude.json" : `${project.path}/.mcp.json`,
  transport: { kind: "stdio", line: `npx ${name}-mcp` },
  envNames: [],
  auth: "open",
  enabled: true,
  ...(project === undefined ? {} : { project }),
});
const skill = (name: string, project?: AgentsProject): SkillRow => ({
  name,
  scope: project === undefined ? "user" : "project",
  paths: [{ path: project === undefined ? `~/.agents/skills/${name}` : `${project.path}/.claude/skills/${name}`, agent: "claude" }],
  ...(project === undefined ? {} : { project }),
});

const REPORT: AgentsReport = {
  target: { placeId: "p_spoo" },
  home: "/home/ada",
  user: "ada",
  readAt: READ_AT,
  agents: [{ id: "claude", name: "Claude Code", installed: true, version: "2.1.281", road: "own", signIn: "signed-in", signInRoad: "token", wspTools: false }],
  skills: [skill("pdf"), skill("deploy", APP), skill("deploy", WWW)],
  servers: [server("notion"), server("db", WWW), server("db", APP)],
  refused: [],
  projects: [APP, WWW],
};

/** The report read again after a project left the computer. */
const without = (gone: AgentsProject): AgentsReport => ({
  ...REPORT,
  projects: REPORT.projects!.filter(p => p.id !== gone.id),
  skills: REPORT.skills.filter(s => s.project?.id !== gone.id),
  servers: REPORT.servers.filter(s => s.project?.id !== gone.id),
});

function Page({ report = REPORT }: { report?: AgentsReport }) {
  const servers = useServerActs(REPORT.target);
  const skills = useSkillActs(REPORT.target);
  const tools = useServerTools(REPORT.target);
  return (
    <AgentsPanel
      on={{ name: "spoo" }}
      read={{ report, reading: false, error: null, readAt: NOW, refresh: () => {} }}
      ctx={{ where: "box", heldWhy: null, ...(servers === undefined ? {} : { servers }), ...(skills === undefined ? {} : { skills }), ...(tools === undefined ? {} : { tools }) }}
      now={NOW}
    />
  );
}

const PDF: SkillHit = { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 3_612_000 };

function host() {
  const removes: [AgentsTarget, ServerAsk | string][] = [];
  const adds: [AgentsTarget, ServerAdd | string, ...unknown[]][] = [];
  const tools: { target: AgentsTarget; name: string; answer: (a: ServerToolsAnswer) => void }[] = [];
  useStore.setState({
    api: {
      serversAdd: async (target: AgentsTarget, ask: ServerAdd) => (adds.push([target, ask]), { file: "" }),
      skillsSearch: async () => [PDF],
      skillsGet: () => new Promise(() => {}),
      skillsAdd: async (target: AgentsTarget, id: string, agents: readonly string[], project: boolean) => (adds.push([target, id, agents, project]), { path: "", agents: [] }),
      serversRemove: async (target: AgentsTarget, ask: ServerAsk) => void removes.push([target, ask]),
      serversToggle: async () => ({ file: "" }),
      serversTools: (target: AgentsTarget, _agent: string, name: string) => new Promise<ServerToolsAnswer>(answer => tools.push({ target, name, answer })),
      skillsPreview: () => new Promise(() => {}),
      skillsRemove: async (target: AgentsTarget, name: string) => void removes.push([target, name]),
    } as unknown as Api,
  });
  return { removes, adds, tools };
}

const tab = (name: string): void => void fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
/** Each card of rows: its id, its head, and the rows it holds. */
const groups = (): [string | null, string | null, string[]][] =>
  [...panel().querySelectorAll<HTMLElement>("[data-settings-card^=kind-]")].map(g => [
    g.getAttribute("data-settings-card"),
    g.querySelector("[data-settings-head]")?.textContent ?? null,
    [...g.querySelectorAll("[data-settings-row]")].map(r => r.getAttribute("data-settings-row")!),
  ]);
const remove = async (): Promise<void> => {
  fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-settings-card=kind-remove] [data-k=act-remove]")!);
  fireEvent.click(await screen.findByRole("button", { name: W.remove }));
};
const add = (): void => void fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-k=kind-add]")!);
/** Picks where an add goes, answering every option the pick offered, each as it reads. */
const pickWhere = (name: string): Promise<string[]> => pickOption(document.querySelector("[data-k=where-pick]")!, new RegExp(`^${name}`));
const whereTrigger = (): string | null | undefined => document.querySelector("[data-k=where-pick]")?.textContent;
const lost = (project: string): boolean => panel().textContent?.includes(W.projectLeft(project, "spoo")) === true;
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("a read over a computer's projects", () => {
  it("stands its servers under Global, then each project by name with its folder, one row per project for one name", () => {
    host();
    render(<Page />);
    tab("Tool servers");
    expect(groups()).toEqual([
      ["kind-global", "Global on spoochecked just now", ["server-global-notion-stdio-npx notion-mcp"]],
      ["kind-project-pr_app", "app~/code/app", ["server-project-pr_app-db-stdio-npx db-mcp"]],
      ["kind-project-pr_www", "www~/code/www", ["server-project-pr_www-db-stdio-npx db-mcp"]],
    ]);
  });

  it("stands its skills by source with one card per project, and the search finds a project by its name", () => {
    host();
    render(<Page />);
    tab("Skills");
    expect(groups()).toEqual([
      ["kind-source-user", "Global on spoochecked just now", ["skill-user-pdf"]],
      ["kind-project-pr_app", "app~/code/app", ["skill-project-pr_app-deploy"]],
      ["kind-project-pr_www", "www~/code/www", ["skill-project-pr_www-deploy"]],
    ]);
    fireEvent.change(screen.getByPlaceholderText("Search skills"), { target: { value: "www" } });
    expect(groups().flatMap(g => g[2])).toEqual(["skill-project-pr_www-deploy"]);
  });

  it("names the project to the host when a project's server or skill is removed, and the computer alone for the computer's own", async () => {
    const h = host();
    render(<Page />);
    tab("Tool servers");
    openRow("server-project-pr_www-db-stdio-npx db-mcp");
    await remove();
    back();
    openRow("server-global-notion-stdio-npx notion-mcp");
    await remove();
    back();
    tab("Skills");
    openRow("skill-project-pr_app-deploy");
    await remove();
    await settle();
    expect(h.removes).toEqual([
      [{ placeId: "p_spoo", project: "pr_www" }, { agent: "claude", name: "db", scope: "project" }],
      [{ placeId: "p_spoo" }, { agent: "claude", name: "notion", scope: "user" }],
      [{ placeId: "p_spoo", project: "pr_app" }, "deploy"],
    ]);
  });

  it("asks a project's server for its tools in that project, and lists each tool with what it does", async () => {
    const h = host();
    render(<Page />);
    tab("Tool servers");
    openRow("server-project-pr_app-db-stdio-npx db-mcp");
    fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-settings-card=kind-under] [data-k=agents-refresh]")!);
    const db = h.tools.filter(t => t.name === "db");
    expect(db.map(t => [t.target, t.name])).toEqual([[{ placeId: "p_spoo", project: "pr_app" }, "db"]]);
    db[0]!.answer({ auth: "connected", tools: [{ name: "query", description: "Runs one query", params: [{ name: "sql", type: "string", required: true }] }], readAt: READ_AT });
    await settle();
    const tool = panel().querySelector<HTMLElement>("[data-settings-card=kind-under] [data-settings-row=under-query]")!;
    expect([tool.querySelector("[data-settings-title]")?.textContent, tool.querySelector("[data-settings-description]")?.textContent]).toEqual(["query", "Runs one query"]);
  });

  it("adds a tool server to the home or to the project picked, the file following it, and names that project to the host", async () => {
    const h = host();
    render(<Page />);
    tab("Tool servers");
    add();
    expect(whereTrigger()).toBe(W.global);
    expect(panel().querySelector("[data-k=add-server-file]")?.textContent).toBe("~/.claude.json");
    expect(await pickWhere("www")).toEqual([W.global, "app", "www"]);
    expect(whereTrigger()).toBe("www");
    expect(panel().querySelector("[data-k=add-server-file]")?.textContent).toBe("~/code/www/.mcp.json");
    fireEvent.change(panel().querySelector<HTMLInputElement>("[data-k=add-server-name]")!, { target: { value: "acme" } });
    fireEvent.change(panel().querySelector<HTMLInputElement>("[data-k=add-server-command]")!, { target: { value: "uvx acme" } });
    fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-k=add-server-go]")!);
    await settle();
    expect(h.adds).toEqual([[{ placeId: "p_spoo", project: "pr_www" }, { agent: "claude", name: "acme", project: true, command: "uvx", args: ["acme"] }]]);
  });

  it("installs a skill in the home or in the project picked, reading installed off the folder it would go in", async () => {
    const h = host();
    render(<Page />);
    tab("Skills");
    add();
    fireEvent.change(panel().querySelector<HTMLInputElement>("[data-k=add-search]")!, { target: { value: "pdf" } });
    fireEvent.keyDown(panel().querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    fireEvent.click(panel().querySelector<HTMLElement>('[data-found-row="anthropics/skills/pdf"]')!);
    const status = (): string | null | undefined => panel().querySelector("[data-k=kind-head] [data-k=kind-status]")?.textContent;
    expect(status()).toBe("Installed");
    expect(headAct("install")).toBeNull();
    await pickWhere("app");
    expect(headAct("install")?.textContent).toBe("Install pdf");
    fireEvent.click(headAct("install")!);
    await settle();
    expect(h.adds).toEqual([[{ placeId: "p_spoo", project: "pr_app" }, "anthropics/skills/pdf", ["claude"], true]]);
  });

  it("holds Add a tool server where the project picked left on a read again, naming it, and never falls back to the home", async () => {
    const h = host();
    const { rerender } = render(<Page />);
    tab("Tool servers");
    add();
    await pickWhere("www");
    fireEvent.change(panel().querySelector<HTMLInputElement>("[data-k=add-server-name]")!, { target: { value: "acme" } });
    fireEvent.change(panel().querySelector<HTMLInputElement>("[data-k=add-server-command]")!, { target: { value: "uvx acme" } });
    rerender(<Page report={without(WWW)} />);
    expect(lost("www")).toBe(true);
    expect(whereTrigger()).not.toContain("pr_www");
    expect(whereTrigger()).not.toContain(W.global);
    expect(panel().querySelector("[data-k=add-server-file]")?.textContent).not.toBe("~/.claude.json");
    const go = panel().querySelector<HTMLButtonElement>("[data-k=add-server-go]")!;
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    fireEvent.keyDown(panel().querySelector("[data-k=add-server-command]")!, { key: "Enter" });
    await settle();
    expect(h.adds).toEqual([]);
    await pickWhere("app");
    expect(lost("www")).toBe(false);
    fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-k=add-server-go]")!);
    await settle();
    expect(h.adds).toEqual([[{ placeId: "p_spoo", project: "pr_app" }, { agent: "claude", name: "acme", project: true, command: "uvx", args: ["acme"] }]]);
  });

  it("holds Install where the project picked left on a read again, naming it, and shows no id in the pick", async () => {
    const h = host();
    const { rerender } = render(<Page />);
    tab("Skills");
    add();
    fireEvent.change(panel().querySelector<HTMLInputElement>("[data-k=add-search]")!, { target: { value: "pdf" } });
    fireEvent.keyDown(panel().querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    fireEvent.click(panel().querySelector<HTMLElement>('[data-found-row="anthropics/skills/pdf"]')!);
    await pickWhere("app");
    expect(whereTrigger()).toBe("app");
    rerender(<Page report={without(APP)} />);
    expect(lost("app")).toBe(true);
    expect(whereTrigger()).not.toContain("pr_app");
    expect(whereTrigger()).not.toContain(W.global);
    expect(headAct("install")).toBeNull();
    await settle();
    expect(h.adds).toEqual([]);
  });
});
