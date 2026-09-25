// SPDX-License-Identifier: AGPL-3.0-only
// A computer's page covers every project on it: its MCP servers and skills
// stand under Global, then one group per project by name with its folder; a
// server or skill of one name in two projects is two rows; an act on a
// project's row names that project to the host, and the report read again is
// the computer's. A tool's own level lists its parameters.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsProject, AgentsReport, AgentsTarget, McpRow, ServerAsk, ServerToolsAnswer, SkillRow } from "@wsp/protocol";
import { AgentsManager } from "../src/components/agents/AgentsManager.js";
import { AGENTS_LIST_WORDS as W } from "../src/components/agents/agentsRows.js";
import { useServerActs } from "../src/components/agents/useServerActs.js";
import { useServerTools } from "../src/components/agents/useServerTools.js";
import { useSkillActs } from "../src/components/agents/useSkillActs.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

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
  agents: [],
  skills: [skill("pdf"), skill("deploy", APP), skill("deploy", WWW)],
  servers: [server("notion"), server("db", WWW), server("db", APP)],
  refused: [],
  projects: [APP, WWW],
};

function Page() {
  const servers = useServerActs(REPORT.target);
  const skills = useSkillActs(REPORT.target);
  const tools = useServerTools(REPORT.target);
  return (
    <AgentsManager
      shell="page"
      head={{ line: "x" }}
      report={REPORT}
      reading={false}
      on="spoo"
      ctx={{ where: "box", heldWhy: null, ...(servers === undefined ? {} : { servers }), ...(skills === undefined ? {} : { skills }), ...(tools === undefined ? {} : { tools }) }}
      onRefresh={() => {}}
      now={NOW}
    />
  );
}

function host() {
  const removes: [AgentsTarget, ServerAsk | string][] = [];
  const tools: { target: AgentsTarget; name: string; answer: (a: ServerToolsAnswer) => void }[] = [];
  useStore.setState({
    api: {
      serversAdd: async () => ({ file: "" }),
      serversRemove: async (target: AgentsTarget, ask: ServerAsk) => void removes.push([target, ask]),
      serversToggle: async () => ({ file: "" }),
      serversTools: (target: AgentsTarget, _agent: string, name: string) => new Promise<ServerToolsAnswer>(answer => tools.push({ target, name, answer })),
      skillsPreview: () => new Promise(() => {}),
      skillsRemove: async (target: AgentsTarget, name: string) => void removes.push([target, name]),
    } as unknown as Api,
  });
  return { removes, tools };
}

const tab = (name: string): void => void fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
const groups = (): [string | null, string | null, string[]][] =>
  [...document.querySelectorAll<HTMLElement>("[data-agents-group]")].map(g => [
    g.getAttribute("data-agents-group"),
    g.querySelector("[data-group-label]")?.textContent ?? null,
    [...g.querySelectorAll("[data-agents-row]")].map(r => r.getAttribute("data-agents-row")!),
  ]);
const open = (key: string): HTMLElement => {
  fireEvent.click(document.querySelector<HTMLElement>(`[data-agents-row="${key}"] [data-row-trigger]`)!);
  return document.querySelector<HTMLElement>("[data-agents-detail]")!;
};
const remove = async (detail: HTMLElement): Promise<void> => {
  fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-detail-acts] [data-k=act-remove]")!);
  fireEvent.click(await screen.findByRole("button", { name: W.remove }));
};
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("a computer's page over its projects", () => {
  it("stands its servers under Global, then each project by name with its folder, one row per project for one name", () => {
    host();
    render(<Page />);
    tab("MCP servers");
    expect(groups()).toEqual([
      ["global", "Global", ["server-global-notion-stdio-npx notion-mcp"]],
      ["project-pr_app", "app~/code/app", ["server-project-pr_app-db-stdio-npx db-mcp"]],
      ["project-pr_www", "www~/code/www", ["server-project-pr_www-db-stdio-npx db-mcp"]],
    ]);
  });

  it("stands its skills by source with one group per project, and the search finds a project by its name", () => {
    host();
    render(<Page />);
    tab("Skills");
    expect(groups()).toEqual([
      ["source-user", "Global", ["skill-user-pdf"]],
      ["project-pr_app", "app~/code/app", ["skill-project-pr_app-deploy"]],
      ["project-pr_www", "www~/code/www", ["skill-project-pr_www-deploy"]],
    ]);
    fireEvent.change(screen.getByPlaceholderText("Search skills"), { target: { value: "www" } });
    expect(groups().flatMap(g => g[2])).toEqual(["skill-project-pr_www-deploy"]);
  });

  it("names the project to the host when a project's server or skill is removed, and the computer alone for the computer's own", async () => {
    const h = host();
    render(<Page />);
    tab("MCP servers");
    await remove(open("server-project-pr_www-db-stdio-npx db-mcp"));
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    await remove(open("server-global-notion-stdio-npx notion-mcp"));
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    tab("Skills");
    await remove(open("skill-project-pr_app-deploy"));
    await settle();
    expect(h.removes).toEqual([
      [{ placeId: "p_spoo", project: "pr_www" }, { agent: "claude", name: "db", scope: "project" }],
      [{ placeId: "p_spoo" }, { agent: "claude", name: "notion", scope: "user" }],
      [{ placeId: "p_spoo", project: "pr_app" }, "deploy"],
    ]);
  });

  it("asks a project's server for its tools in that project, and a tool's own level lists its parameters with their type and whether a call needs them", async () => {
    const h = host();
    render(<Page />);
    tab("MCP servers");
    const detail = open("server-project-pr_app-db-stdio-npx db-mcp");
    fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-detail-acts] [data-k=act-list-tools]")!);
    expect(h.tools.map(t => [t.target, t.name])).toEqual([[{ placeId: "p_spoo", project: "pr_app" }, "db"]]);
    h.tools[0]!.answer({
      auth: "connected",
      tools: [{ name: "query", description: "Runs one query", params: [{ name: "sql", type: "string", required: true, description: "The query to run" }, { name: "limit", type: "integer", required: false }, { name: "raw", required: false }] }],
      readAt: READ_AT,
    });
    await settle();
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-agents-detail] [data-k=act-view-tools]")!);
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-under-row=query] button")!);
    const level = document.querySelector<HTMLElement>("[data-agents-under-row]")!;
    expect(level.querySelector("[data-k=under-list] h4")?.textContent).toBe(W.parameters);
    expect([...level.querySelectorAll("[data-under-item]")].map(i => [...i.querySelectorAll("span")].map(s => s.textContent))).toEqual([
      ["sqlstring · required", "sql", "string · required", "The query to run"],
      ["limitinteger", "limit", "integer"],
      ["raw", "raw"],
    ]);
  });
});
