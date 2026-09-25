// SPDX-License-Identifier: AGPL-3.0-only
// One agents report with every row the three segments draw: an agent wsp's
// recipe put on with a newer version out and the catalog pinning an older
// one, one the person installed with no sign-in, one behind a shim whose
// sign-in nobody checked, and one not on the PATH; a skill in the shared
// folder linked into three agents, a plugin's, a project's and the one wsp
// writes; stdio and http servers in every state, the wsp server among them,
// one set up for two agents that disagree about its sign-in and one in the
// project; two readers that could not answer. Shared by the render tests and
// the wireframe.
import type { AgentsReport, ServerToolsAnswer } from "@wsp/protocol";

export const AGENTS_REPORT: AgentsReport = {
  target: { placeId: "p_spoo" },
  home: "/home/ada",
  user: "ada",
  readAt: "2026-09-24T12:00:00.000Z",
  agents: [
    { id: "claude", name: "Claude Code", installed: true, version: "2.1.281", latest: "2.1.282", pinned: "2.1.280", road: "wsp", path: "/opt/wsp/bin/claude", signIn: "signed-in", signInRoad: "token", wspTools: true },
    { id: "codex", name: "Codex", installed: true, version: "0.62.0", road: "own", path: "~/.local/bin/codex", signIn: "none", signInRoad: "device", wspTools: true },
    { id: "opencode", name: "OpenCode", installed: true, version: "1.14.2", road: "shim", path: "~/.local/share/mise/shims/opencode", signIn: "unknown", signInRoad: "terminal", wspTools: false },
    { id: "pi", name: "Pi", installed: false, road: "none", signIn: "unknown", signInRoad: "terminal", wspTools: false },
  ],
  skills: [
    {
      name: "frontend-design",
      description: "Create distinctive, production-grade frontend interfaces with high design quality.",
      scope: "user",
      paths: [
        { path: "~/.claude/skills/frontend-design", agent: "claude", linkTo: "~/.agents/skills/frontend-design" },
        { path: "~/.agents/skills/frontend-design" },
        { path: "~/.codex/skills/frontend-design", agent: "codex" },
        { path: "~/.config/opencode/skills/frontend-design", agent: "opencode" },
      ],
    },
    { name: "pdf", scope: "plugin", paths: [{ path: "~/.claude/plugins/cache/anthropics/skills/pdf", agent: "claude" }] },
    { name: "wsp-review", scope: "project", paths: [{ path: "~/wsp/.agents/skills/wsp-review" }] },
    { name: "wsp", description: "Run work on wsp workspaces from inside an agent.", scope: "user", paths: [{ path: "~/.claude/skills/wsp", agent: "claude" }] },
  ],
  servers: [
    { agent: "claude", name: "airtable", scope: "user", file: "~/.claude.json", transport: { kind: "stdio", line: "npx -y airtable-mcp-server" }, envNames: ["AIRTABLE_API_KEY"], auth: "open", enabled: true, inRecipe: true },
    {
      agent: "opencode",
      name: "github",
      scope: "user",
      file: "~/.config/opencode/opencode.json",
      transport: { kind: "stdio", line: "npx -y @modelcontextprotocol/server-github" },
      envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      auth: "open",
      enabled: true,
      inRecipe: false,
    },
    { agent: "codex", name: "notion", scope: "user", file: "~/.codex/config.toml", transport: { kind: "http", host: "mcp.notion.com" }, envNames: ["Authorization"], auth: "unknown", enabled: true },
    { agent: "claude", name: "notion", scope: "user", file: "~/.claude.json", transport: { kind: "http", host: "mcp.notion.com" }, envNames: [], auth: "needs-sign-in", enabled: true },
    { agent: "claude", name: "spoo-metrics", scope: "project", file: "~/wsp/.mcp.json", transport: { kind: "stdio", line: "node scripts/metrics-mcp.js --token ${METRICS_TOKEN}" }, envNames: ["METRICS_TOKEN"], auth: "open", enabled: true },
    { agent: "claude", name: "linear", scope: "user", file: "~/.claude.json", transport: { kind: "http", host: "mcp.linear.app" }, envNames: [], auth: "needs-sign-in", enabled: true },
    { agent: "codex", name: "sentry", scope: "user", file: "~/.codex/config.toml", transport: { kind: "http", host: "mcp.sentry.dev" }, envNames: [], auth: "failed", enabled: false },
    { agent: "claude", name: "wsp", scope: "user", file: "~/.claude.json", transport: { kind: "stdio", line: "wsp mcp" }, envNames: [], auth: "open", enabled: true },
  ],
  refused: ["skills: the answer was cut short, so the list is not whole", "~/.hermes/config.yaml is over 1 MB and was not read"],
};

/** What List tools answers per server in the wireframe: airtable's tools, one description long enough to clamp;
 * github that did not answer in time. */
export const SERVER_TOOLS: Readonly<Record<string, ServerToolsAnswer>> = {
  airtable: {
    auth: "open",
    readAt: "2026-09-24T12:00:00.000Z",
    tools: [
      { name: "list_records", description: "List records in a table, filtered by a formula and sorted by any field, a page of up to one hundred records at a time with the offset for the next page." },
      { name: "create_record", description: "Create a record in a table." },
      { name: "list_bases" },
    ],
  },
  github: { auth: "failed", refused: "Did not answer in 20 s.", readAt: "2026-09-24T12:00:00.000Z" },
};
