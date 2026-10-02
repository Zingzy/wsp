// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Agents' Tool servers and Skills tabs, drawn in the page's own
// rows: each card's head, each row's words, its state's word and tone, the
// step that stands in the state's place, and every write as the host takes
// it, with the page drawing the report the host answers. An item's own page
// and the tab's add open in place of the list, and the crumb goes back.
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentsTarget, PlaceView, ServerAdd, ServerAsk } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { AGENTS_TOOLS_REPORT, SERVER_TOOLS, SKILL_HITS, SKILL_PREVIEWS } from "./fixtures/agents-report.js";
import { HARNESSES } from "./fixtures/harnesses.js";
import { descriptionOf, mountSettings, resetSettings, rowOf, settingsApi, settle } from "./settings-harness.js";

const MAC = "zingzy's MacBook Pro";
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: MAC, default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 } };
const HERE: AgentsTarget = { placeId: "here" };

const AIRTABLE = "server-global-airtable-stdio-npx -y airtable-mcp-server";
const GITHUB = "server-global-github-stdio-npx -y @modelcontextprotocol/server-github";
const LINEAR = "server-global-linear-http-mcp.linear.app";
const NOTION = "server-global-notion-http-mcp.notion.com";
const SENTRY = "server-global-sentry-http-mcp.sentry.dev";
const WSP = "server-global-wsp-stdio-wsp mcp";
const METRICS = "server-project-pr_wsp-spoo-metrics-stdio-node scripts/metrics-mcp.js --token ${METRICS_TOKEN}";

/** An api over this Mac's report with every server and skill in it, recording each ask the tabs make. A server's
 * tools answer as the wireframe's do; wsp's own is still being asked. */
function toolsApi(over: Partial<Api> = {}) {
  const asked = { tools: [] as Array<[AgentsTarget, string, string, boolean | undefined]>, toggles: [] as Array<[AgentsTarget, ServerAsk, boolean]>, removes: [] as Array<[AgentsTarget, ServerAsk]>, adds: [] as Array<[AgentsTarget, ServerAdd]>, skills: [] as unknown[][], reads: 0 };
  const made = settingsApi({
    agentsRead: async () => (asked.reads++, AGENTS_TOOLS_REPORT),
    listHarnesses: async () => HARNESSES,
    serversTools: async (target, agent, name, refresh) => {
      asked.tools.push([target, agent, name, refresh]);
      return name === "wsp" ? new Promise<never>(() => {}) : (SERVER_TOOLS[name] ?? { auth: "connected", tools: [], readAt: AGENTS_TOOLS_REPORT.readAt });
    },
    serversToggle: async (target, ask, on) => (asked.toggles.push([target, ask, on]), { file: "~/.codex/config.toml" }),
    serversRemove: async (target, ask) => (asked.removes.push([target, ask]), { file: "~/.codex/config.toml" }),
    serversAdd: async (target, ask) => (asked.adds.push([target, ask]), { file: "~/.claude.json" }),
    agentsSignIn: async () => ({ signInId: "si", stop: () => {}, off: () => {} }),
    skillsPreview: async (target, name, project) => (asked.skills.push(["preview", target, name, project]), SKILL_PREVIEWS[name] ?? { text: `# ${name}\n`, size: name.length + 3 }),
    skillsToggle: async (target, name, project, on) => void asked.skills.push(["toggle", target, name, project, on]),
    skillsRemove: async (target, name, project) => void asked.skills.push(["remove", target, name, project]),
    skillsSearch: async q => (asked.skills.push(["search", q]), [...SKILL_HITS]),
    skillsGet: async skill => (asked.skills.push(["get", skill]), { text: "# pdf\n\nFill PDF forms.\n", size: 22 }),
    skillsAdd: async (target, skill, agents, project) => (asked.skills.push(["add", target, skill, [...agents], project]), { path: "~/.agents/skills/pdf", agents: [] }),
    ...over,
  });
  return { ...made, asked };
}

const page = (): HTMLElement => document.querySelector<HTMLElement>("[data-settings-page]")!;
const card = (id: string): HTMLElement => page().querySelector<HTMLElement>(`[data-settings-card="${id}"]`)!;
const headOf = (id: string): string => card(id).querySelector("[data-settings-head]")?.textContent ?? "";
const status = (key: string): HTMLElement | null => rowOf(key)!.querySelector<HTMLElement>("[data-k=kind-status]");
const crumbPage = (): string | undefined => document.querySelector("[data-breadcrumb-page]")?.textContent ?? undefined;
const level = () => useSettingsStore.getState().agentsLevel;

const mountTab = async (api: Api, tab: "servers" | "skills"): Promise<void> => {
  useSettingsStore.getState().pickAgentsTab(tab);
  mountSettings({ api, at: { kind: "group", group: "agents" } });
  await settle();
};
const open = async (key: string): Promise<void> => {
  await act(async () => void fireEvent.click(rowOf(key)!.querySelector("[data-settings-title]")!));
  await settle();
};
const confirmRemove = async (): Promise<void> => {
  await act(async () => void fireEvent.click(card("kind-remove").querySelector("[data-k=act-remove]")!));
  const dialog = await screen.findByRole("alertdialog");
  await act(async () => void fireEvent.click(within(dialog).getByRole("button", { name: "Remove" })));
  await settle();
};

beforeEach(() => {
  resetSettings();
  useStore.setState({ places: [here], harnesses: HARNESSES, projects: [] });
});

afterEach(() => {
  cleanup();
});

describe("the Tool servers tab", () => {
  it("puts the person's own servers under the computer's name and a project's under its own, each row with its reach, its agents and its state in words", async () => {
    await mountTab(toolsApi().api, "servers");
    expect(headOf("kind-global")).toContain(`Global on ${MAC}`);
    expect(card("kind-global").querySelector("[data-k=agents-read-at]")?.textContent).toBe("checked just now");
    expect(card("kind-global").querySelector("[data-k=agents-refresh]")).not.toBeNull();
    expect(headOf("kind-project-pr_wsp")).toBe("wsp~/wsp");
    expect(descriptionOf(AIRTABLE)).toBe("npx -y airtable-mcp-server");
    expect(descriptionOf(LINEAR)).toBe("mcp.linear.app");
    const marks = (key: string): string[] => [...rowOf(key)!.querySelectorAll<HTMLElement>("[data-row-marks] [data-harness-mark]")].map(m => m.dataset["harnessMark"] ?? "");
    expect(marks(NOTION)).toEqual(["codex", "claude"]);
    expect(marks(AIRTABLE)).toEqual(["claude"]);
    // The state in the page's own words, its tool count with it, and the dot's tone.
    expect(status(AIRTABLE)?.textContent).toBe("Connected with 3 tools");
    expect(status(AIRTABLE)?.dataset["tone"]).toBe("good");
    expect(status(SENTRY)?.textContent).toBe("Off");
    expect(status(SENTRY)?.dataset["tone"]).toBe("quiet");
    expect(status(WSP)?.textContent).toBe("Checking");
    expect(status(METRICS)?.textContent).toBe("No sign-in needed");
    expect(rowOf(METRICS)!.closest("[data-settings-card]")?.getAttribute("data-settings-card")).toBe("kind-project-pr_wsp");
  });

  it("says a failed server as its status with Reconnect as an icon beside it and no line under the row, and stands Sign in in its state's place", async () => {
    await mountTab(toolsApi().api, "servers");
    expect(rowOf(GITHUB)!.querySelector("[data-k=act-reconnect]")?.getAttribute("aria-label")).toBe("Reconnect");
    expect(status(GITHUB)?.textContent).toBe("Failed");
    expect(status(GITHUB)?.dataset["tone"]).toBe("bad");
    expect(rowOf(GITHUB)!.closest("[data-kind-item]")!.querySelector("[data-k=kind-row-refused]")).toBeNull();
    expect(rowOf(LINEAR)!.querySelector("[data-k=act-sign-in]")?.textContent).toBe("Sign in");
    expect(status(LINEAR)).toBeNull();
    // Off is a state the row says; turning it on is the server's own page's switch.
    expect(rowOf(SENTRY)!.querySelector("[data-k=act-turn-on]")).toBeNull();
  });

  it("connects a failed server again in place, without opening its page", async () => {
    const { api, asked } = toolsApi();
    await mountTab(api, "servers");
    await act(async () => void fireEvent.click(rowOf(GITHUB)!.querySelector("[data-k=act-reconnect]")!));
    await settle();
    expect(asked.tools.at(-1)).toEqual([HERE, "opencode", "github", true]);
    expect(level()).toBeNull();
  });

  it("opens a server's page with its state, how it is reached and where it is set up, and its tools, asking nothing again; the crumb goes back", async () => {
    const { api, asked } = toolsApi();
    await mountTab(api, "servers");
    const before = asked.tools.length;
    await open(AIRTABLE);
    expect(crumbPage()).toBe("airtable");
    // The tabs give way to the page; the computer's picker stays.
    expect(document.querySelector("[data-k=agents-tabs]")).toBeNull();
    expect(document.querySelector("[data-k=agents-picker]")).not.toBeNull();
    const head = page().querySelector<HTMLElement>("[data-k=kind-head]")!;
    expect(head.querySelector("[data-settings-title]")?.textContent).toBe("airtable");
    expect(head.querySelector("[data-settings-description]")?.textContent).toBe("npx -y airtable-mcp-server");
    expect(head.querySelector("[data-k=kind-status]")?.textContent).toBe("Connected with 3 tools");
    const fact = (id: string) => page().querySelector<HTMLElement>(`[data-settings-line="fact-${id}"]`)!;
    expect(fact("reach").querySelector("[data-settings-label]")?.textContent).toBe("Command");
    expect(fact("reach").querySelector("[data-fact-value]")?.textContent).toBe("npx -y airtable-mcp-server");
    expect(fact("names").querySelector("[data-fact-value]")?.textContent).toBe("AIRTABLE_API_KEY");
    expect(fact("config-claude").querySelector("[data-fact-value]")?.textContent).toBe("~/.claude.json");
    expect(page().querySelector("[data-settings-line='fact-tools']")).toBeNull();
    expect(headOf("kind-under")).toContain("Tools of airtable");
    expect([...card("kind-under").querySelectorAll("[data-settings-row] [data-settings-title]")].map(t => t.textContent)).toEqual(["list_records", "create_record", "list_bases"]);
    expect(descriptionOf("under-create_record")).toBe("Create a record in a table.");
    // The answer the list already had stands; opening the page starts no server.
    expect(asked.tools.length).toBe(before);
    // Claude Code keeps no switch per server that wsp turns, so its page holds none.
    expect(head.querySelector("[data-k=kind-on]")).toBeNull();
    const back = document.querySelector<HTMLElement>("[data-k=settings-up]")!;
    expect(back.getAttribute("aria-label")).toBe("Back to Agents");
    await act(async () => void fireEvent.click(back));
    await settle();
    expect(level()).toBeNull();
    expect(rowOf(AIRTABLE)).not.toBeNull();
    expect(asked.tools.length).toBe(before);
  });

  it("turns a server on through the host from its page, and removes it once the confirmation is taken", async () => {
    const { api, asked } = toolsApi();
    await mountTab(api, "servers");
    await open(SENTRY);
    const on = page().querySelector<HTMLElement>("[data-k=kind-head] [data-k=kind-on]")!;
    expect(on.getAttribute("aria-checked")).toBe("false");
    expect(on.getAttribute("aria-label")).toBe(`sentry on ${MAC}`);
    await act(async () => void fireEvent.click(on));
    await settle();
    expect(asked.toggles).toEqual([[HERE, { agent: "codex", name: "sentry", scope: "user" }, true]]);
    expect(rowOf("kind-remove")!.querySelector("[data-settings-title]")?.textContent).toBe("Remove sentry");
    expect(descriptionOf("kind-remove")).toBe(`It comes out of ~/.codex/config.toml on ${MAC}.`);
    await confirmRemove();
    expect(asked.removes).toEqual([[HERE, { agent: "codex", name: "sentry", scope: "user" }]]);
  });

  it("goes back to the list once the server it shows is gone from what the host reads", async () => {
    const report = { ...AGENTS_TOOLS_REPORT };
    const made = toolsApi({ agentsRead: async () => report });
    await mountTab(made.api, "servers");
    await open(SENTRY);
    expect(crumbPage()).toBe("sentry");
    report.servers = AGENTS_TOOLS_REPORT.servers.filter(s => s.name !== "sentry");
    await act(async () => made.push({ type: "agents.changed", target: HERE } as never));
    await settle();
    expect(level()).toBeNull();
    expect(rowOf(SENTRY)).toBeNull();
  });

  it("finds a server by its name, its reach or an agent's name, and says when nothing matches", async () => {
    await mountTab(toolsApi().api, "servers");
    const field = page().querySelector<HTMLInputElement>("input[data-k=kind-search]")!;
    expect(field.placeholder).toBe("Search tool servers");
    fireEvent.change(field, { target: { value: "notion" } });
    expect([...page().querySelectorAll<HTMLElement>("[data-kind-row]")].map(r => r.dataset["kindRow"])).toEqual([NOTION]);
    fireEvent.change(field, { target: { value: "opencode" } });
    expect([...page().querySelectorAll<HTMLElement>("[data-kind-row]")].map(r => r.dataset["kindRow"])).toEqual([GITHUB]);
    fireEvent.change(field, { target: { value: "zzz" } });
    expect(page().querySelector("[data-settings-line='kind-none'] [data-settings-label]")?.textContent).toBe('Nothing matches "zzz".');
  });

  it("adds an MCP server from its own page in the page's rows, and goes back to the list once the host took it", async () => {
    const { api, asked } = toolsApi();
    await mountTab(api, "servers");
    await act(async () => void fireEvent.click(page().querySelector("[data-k=kind-add]")!));
    await settle();
    expect(crumbPage()).toBe("Add a tool server");
    expect(page().querySelector("[data-add-server]")).toBeNull();
    fireEvent.change(page().querySelector("input[data-k=add-server-name]")!, { target: { value: "notion2" } });
    fireEvent.change(page().querySelector("input[data-k=add-server-command]")!, { target: { value: "npx -y @notionhq/notion-mcp-server" } });
    expect(page().querySelector("[data-k=add-server-file]")?.textContent).toBe("~/.claude.json");
    await act(async () => void fireEvent.click(page().querySelector("[data-k=add-server-go]")!));
    await settle();
    expect(asked.adds).toEqual([[HERE, { agent: "claude", name: "notion2", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] }]]);
    expect(level()).toBeNull();
  });

  it("says the host's refusal of an add under the form and keeps what was typed", async () => {
    const { api } = toolsApi({ serversAdd: async () => Promise.reject(new Error("notion2 is already in ~/.claude.json, so nothing was written; remove it first or pick another name.")) });
    await mountTab(api, "servers");
    await act(async () => void fireEvent.click(page().querySelector("[data-k=kind-add]")!));
    await settle();
    fireEvent.change(page().querySelector("input[data-k=add-server-name]")!, { target: { value: "notion2" } });
    fireEvent.change(page().querySelector("input[data-k=add-server-command]")!, { target: { value: "npx x" } });
    await act(async () => void fireEvent.click(page().querySelector("[data-k=add-server-go]")!));
    await settle();
    expect(page().querySelector("[data-k=add-server-refused]")?.textContent).toBe("notion2 is already in ~/.claude.json, so nothing was written; remove it first or pick another name.");
    expect(page().querySelector<HTMLInputElement>("input[data-k=add-server-name]")!.value).toBe("notion2");
    expect(crumbPage()).toBe("Add a tool server");
  });
});

describe("the Skills tab", () => {
  const SHARED = "skill-user-frontend-design";
  const OWN = "skill-user-wsp";
  const PLUGIN = "skill-plugin-pdf";
  const REPO = "skill-project-pr_wsp-wsp-review";

  it("lists each skill under where it comes from, with the folder it lives in and the agents that read it, a switch where the host turns it and its state in words where it does not", async () => {
    await mountTab(toolsApi().api, "skills");
    expect(headOf("kind-source-system")).toContain(`System on ${MAC}`);
    expect(headOf("kind-source-plugin")).toBe("Plugins");
    expect(headOf("kind-source-user")).toBe("Global");
    expect(headOf("kind-project-pr_wsp")).toBe("wsp~/wsp");
    expect(descriptionOf(SHARED)).toBe("~/.agents/skills/frontend-design");
    expect([...rowOf(SHARED)!.querySelectorAll<HTMLElement>("[data-row-marks] [data-harness-mark]")].map(m => m.dataset["harnessMark"])).toEqual(["claude", "codex", "opencode"]);
    const on = rowOf(SHARED)!.querySelector<HTMLElement>("[data-k=kind-on]")!;
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(status(SHARED)).toBeNull();
    expect(status(OWN)?.textContent).toBe("Always on");
    expect(status(OWN)?.dataset["tone"]).toBe("good");
    expect(status(PLUGIN)?.textContent).toBe("On");
    // A project's skill lives in the repo, so the page says its state and turns nothing.
    expect(status(REPO)?.textContent).toBe("On");
    for (const key of [OWN, PLUGIN, REPO]) expect(rowOf(key)!.querySelector("[data-k=kind-on]")).toBeNull();
  });

  it("turns a skill off through the host from its row, without opening its page", async () => {
    const { api, asked } = toolsApi();
    await mountTab(api, "skills");
    await act(async () => void fireEvent.click(rowOf(SHARED)!.querySelector("[data-k=kind-on]")!));
    await settle();
    expect(asked.skills).toEqual([["toggle", HERE, "frontend-design", false, false]]);
    expect(level()).toBeNull();
  });

  it("says under the row why the host refused a turn made there, in the host's own words", async () => {
    const { api } = toolsApi({ skillsToggle: async () => Promise.reject(new Error("~/.agents/skills/frontend-design is not writable, so nothing was changed.")) });
    await mountTab(api, "skills");
    await act(async () => void fireEvent.click(rowOf(SHARED)!.querySelector("[data-k=kind-on]")!));
    await settle();
    const refused = page().querySelector(`[data-kind-item="${SHARED}"] [data-k=kind-row-refused]`);
    expect(refused?.textContent).toBe("~/.agents/skills/frontend-design is not writable, so nothing was changed.");
  });

  it("opens a skill's page with its description, every folder it lives in and its SKILL.md, and removes it once the confirmation is taken", async () => {
    const { api, asked } = toolsApi();
    await mountTab(api, "skills");
    await open(SHARED);
    expect(crumbPage()).toBe("frontend-design");
    expect(rowOf("fact-description")!.querySelector("[data-settings-title]")?.textContent).toBe("Description");
    expect(descriptionOf("fact-description")).toBe("Create distinctive, production-grade frontend interfaces with high design quality.");
    expect([...page().querySelectorAll("[data-settings-card='kind-facts'] [data-fact-value]")].map(v => v.textContent)).toEqual(["~/.agents/skills/frontend-design", "~/.claude/skills/frontend-design", "~/.codex/skills/frontend-design", "~/.config/opencode/skills/frontend-design"]);
    expect(asked.skills).toEqual([["preview", HERE, "frontend-design", false]]);
    expect(headOf("kind-doc")).toBe("SKILL.md");
    expect(card("kind-doc").querySelector("[data-k=skill-preview-body]")?.textContent).toContain("Pick one bold direction");
    await confirmRemove();
    expect(asked.skills.at(-1)).toEqual(["remove", HERE, "frontend-design", false]);
  });

  it("offers no switch and no Remove on the skill wsp writes", async () => {
    await mountTab(toolsApi().api, "skills");
    await open(OWN);
    expect(page().querySelector("[data-k=kind-head] [data-k=kind-status]")?.textContent).toBe("Always on");
    expect(page().querySelector("[data-k=kind-head] [data-k=kind-on]")).toBeNull();
    expect(page().querySelector("[data-settings-card='kind-remove']")).toBeNull();
  });

  it("adds a skill off skills.sh: the search asked once the person pauses, a result's own page, Install through the host, and the crumb back to what was found", async () => {
    const { api, asked } = toolsApi();
    await mountTab(api, "skills");
    await act(async () => void fireEvent.click(page().querySelector("[data-k=kind-add]")!));
    await settle();
    expect(crumbPage()).toBe("Add a skill");
    expect(page().querySelector("[data-settings-line='add-none'] [data-settings-label]")?.textContent).toBe("Type a name or a topic to find a skill.");
    fireEvent.change(page().querySelector("input[data-k=add-search]")!, { target: { value: "pdf" } });
    await act(async () => void (await new Promise(r => setTimeout(r, 300))));
    await settle();
    expect(asked.skills).toEqual([["search", "pdf"]]);
    const found = rowOf("anthropics/skills/pdf")!;
    expect(descriptionOf("anthropics/skills/pdf")).toBe("anthropics/skills");
    expect(found.querySelector("[data-settings-word]")?.textContent).toBe("3.6M");
    expect(rowOf("acme/kit/frontend-design")!.querySelector("[data-settings-word]")?.textContent).toBe("installed");
    await act(async () => void fireEvent.click(found.querySelector("[data-settings-title]")!));
    await settle();
    expect(crumbPage()).toBe("pdf");
    expect(asked.skills).toContainEqual(["get", "anthropics/skills/pdf"]);
    expect(page().querySelector("[data-k=kind-head] [data-k=kind-status]")).toBeNull();
    const install = page().querySelector<HTMLElement>("[data-k=kind-head] [data-k=act-install]")!;
    expect(install.textContent).toBe("Install pdf");
    await act(async () => void fireEvent.click(install));
    await settle();
    expect(asked.skills.find(a => a[0] === "add")?.slice(0, 3)).toEqual(["add", HERE, "anthropics/skills/pdf"]);
    expect(asked.skills.find(a => a[0] === "add")?.[4]).toBe(false);
    const back = document.querySelector<HTMLElement>("[data-k=settings-up]")!;
    expect(back.getAttribute("aria-label")).toBe("Back to Add a skill");
    await act(async () => void fireEvent.click(back));
    await settle();
    expect(crumbPage()).toBe("Add a skill");
    expect(page().querySelector<HTMLInputElement>("input[data-k=add-search]")!.value).toBe("pdf");
    expect(rowOf("anthropics/skills/pdf")).not.toBeNull();
  });
});
