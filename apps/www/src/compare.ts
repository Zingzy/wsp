// SPDX-License-Identifier: AGPL-3.0-only
// What /compare says about every tool, each cell with the pages it was read from. A cell says only what its pages say
// on the day in READ; a fact read later is read again from the product's own page and the day moves with it. wsp's row
// is read from the repo at WSP_AT, not from this site.

export const READ = "2026-10-09";
const WSP_AT = "https://github.com/wsp-labs/wsp/blob/825d65548f7edf7b1f321666318fa00a15de0831";

/** The words, then every page they were read from. */
export type Cell = readonly [text: string, source: string, ...more: string[]];

export const COLUMNS = [
  { key: "runs", label: "Runs agents on" },
  { key: "second", label: "A second computer" },
  { key: "has", label: "What that computer has when the agent starts" },
  { key: "agents", label: "Agents" },
  { key: "platforms", label: "Platforms" },
  { key: "price", label: "Price" },
  { key: "code", label: "Source code" },
] as const;

export type Column = (typeof COLUMNS)[number]["key"];
/** The column that sorts the field, lit on the page and first on a phone. */
export const LIT: Column = "has";

export type Tool = { name: string; cells: Record<Column, Cell> };
export type Kind = { name: string; tools: Tool[] };

/** What the vendors' clouds carry onto their machine, as /compare's intro and the landing page's table both say it. */
export const VENDORS_BRING = "your repo, a setup script, and on Claude and Cursor some skills you turn on";

export const WSP: Tool = {
  name: "wsp",
  cells: {
    runs: ["Your computer, and Linux computers you own", `${WSP_AT}/skills/wsp/SKILL.md#L8`, `${WSP_AT}/AGENTS.md#L77`],
    second: ["Yes. Added over ssh, or it dials out to join", `${WSP_AT}/skills/wsp/SKILL.md#L71`, `${WSP_AT}/skills/wsp/SKILL.md#L154`],
    has: [
      "Your agents signed in, MCP servers, CLIs, skills, Claude Code plugins, GitHub sign-in, git and shell settings, your projects",
      `${WSP_AT}/apps/web/src/settings/add/addFlow.ts#L43-L50`,
    ],
    agents: ["Claude Code, Codex, OpenCode, Cursor", `${WSP_AT}/packages/catalog/src/thread-agents.ts#L9`],
    platforms: ["macOS, Linux", `${WSP_AT}/.github/workflows/release.yml#L3-L5`],
    price: ["Free", `${WSP_AT}/apps/www/src/sections/close.tsx#L13`],
    code: ["AGPL-3.0", `${WSP_AT}/LICENSE`],
  },
};

const CONDUCTOR = "https://www.conductor.build";
const SUPERSET = "https://docs.superset.sh";
const ORCA = "https://www.onorca.dev";
const EMDASH = "https://emdash.com";
const T3 = "https://github.com/pingdotgg/t3code/blob/main/docs/user";
const SOLO = "https://soloterm.com";
const HERDR = "https://herdr.dev";
const CLAUDE = "https://code.claude.com/docs/en";
const CODEX = "https://learn.chatgpt.com/docs";
const CURSOR = "https://cursor.com/docs/cloud-agent";

export const KINDS: Kind[] = [
  {
    name: "Apps on the computer you sit at",
    tools: [
      {
        name: "Conductor",
        cells: {
          runs: ["Your Mac, or its cloud sandboxes on Pro", `${CONDUCTOR}/docs/cloud`],
          second: ['No. "Not yet"', `${CONDUCTOR}/docs/cloud/faq`],
          has: [
            "Cloud only: API keys, env settings and MCP servers imported from your Mac; other tools from an install script you write",
            `${CONDUCTOR}/changelog/0.78.0-introducing-conductor-cloud`,
            `${CONDUCTOR}/changelog/0.83.0-auto-port-forwarding`,
            `${CONDUCTOR}/docs/cloud/cloud-computer`,
          ],
          agents: ["Claude Code, Codex, Cursor, OpenCode", `${CONDUCTOR}/docs/reference/harnesses`],
          platforms: ["macOS, iOS", `${CONDUCTOR}/docs/installation`, `${CONDUCTOR}/changelog/0.90.0-conductor-for-ios`],
          price: ["Free; cloud on Pro, $50/mo", `${CONDUCTOR}/pricing`],
          code: ["Closed", CONDUCTOR],
        },
      },
      {
        name: "Superset",
        cells: {
          runs: ["Your computer, and others you own through its relay", `${SUPERSET}/remote-access`],
          second: ["Yes, on Pro", "https://superset.sh/pricing"],
          has: ["Nothing carried. You install the agents and sign in on each host", `${SUPERSET}/cli/host-server`, `${SUPERSET}/usage`],
          agents: ["Any CLI agent; 22 listed", `${SUPERSET}/agent-integration`],
          platforms: ["macOS, iPhone, iPad; Linux experimental", `${SUPERSET}/faq`, "https://superset.sh/mobile"],
          price: ["Free; Pro $20/user/mo", "https://superset.sh/pricing"],
          code: ["ELv2, source available", "https://github.com/superset-sh/superset"],
        },
      },
      {
        name: "Orca",
        cells: {
          runs: ["Your computer, ssh hosts, Orca servers, a cloud VM on your own account in its experimental mode", `${ORCA}/docs/ways-to-run`],
          second: ["Yes, over ssh or an Orca server", `${ORCA}/docs/ways-to-run`],
          has: ['Not carried: "A login on your laptop does not automatically carry over". Shared skills can be installed on a host', `${ORCA}/docs/remote-servers`, `${ORCA}/docs/cli/skills`],
          agents: ["41 listed", `${ORCA}/docs/agents/supported`],
          platforms: ["macOS, Windows, Linux, iOS, Android, web", `${ORCA}/docs/install`, `${ORCA}/docs/mobile`, `${ORCA}/docs/android-apk`],
          price: ["Free", ORCA],
          code: ["MIT", "https://github.com/stablyai/orca"],
        },
      },
      {
        name: "Emdash",
        cells: {
          runs: ["Your computer, ssh hosts", `${EMDASH}/docs/remote-development`],
          second: ["Yes, over ssh, since 2026-08-28", `${EMDASH}/changelog`],
          has: ["Not carried. It can run an agent's installer on the host", `${EMDASH}/docs/remote-development/remote-projects`],
          agents: ["35 listed", `${EMDASH}/docs/providers`],
          platforms: ["macOS, Windows, Linux", `${EMDASH}/docs/installation`],
          price: ["Free", EMDASH],
          code: ["Apache-2.0", "https://github.com/generalaction/emdash"],
        },
      },
      {
        name: "T3 Code",
        cells: {
          runs: ["Your computer, ssh hosts, any computer through its relay", `${T3}/remote-access.md`],
          second: ["Yes, and it can spread new threads across them", `${T3}/remote-access.md`],
          has: [
            'Not carried: "Installation, login, and configuration belong to that environment\'s machine". It installs Codex and ACP agents itself',
            `${T3}/install.md`,
            `${T3}/welcome-wizard.md`,
          ],
          agents: ["8 named, any ACP agent", "https://t3.codes", `${T3}/providers-acp.md`],
          platforms: ["macOS, Windows, Linux, web, iOS, Android", "https://t3.codes/download"],
          price: ["Free", "https://t3.codes"],
          code: ["MIT", "https://github.com/pingdotgg/t3code"],
        },
      },
      {
        name: "Solo",
        cells: {
          runs: ["The computer you sit at", SOLO],
          second: ["No", SOLO],
          has: ["One computer, nothing to carry", SOLO],
          agents: ["8 built in, any CLI", `${SOLO}/docs/agents/setting-up-tools`],
          platforms: ["macOS, Windows", `${SOLO}/docs/getting-started/installation`],
          price: ["Free for 4 projects; Pro $99/yr", SOLO],
          code: ["Closed", `${SOLO}/terms-of-service`],
        },
      },
    ],
  },
  {
    name: "A runtime over ssh",
    tools: [
      {
        name: "herdr",
        cells: {
          runs: ["Your computer, and saved ssh machines", HERDR, "https://github.com/herdrdev/herdr/releases/tag/v0.9.0"],
          second: ["Yes, over ssh, since 2026-09-07", "https://github.com/herdrdev/herdr/releases/tag/v0.9.0"],
          has: ['Only herdr. It "does not copy local command plugins, configuration, executables, or secrets"', `${HERDR}/docs/connecting-machines/`],
          agents: ["22 detected, any terminal program", `${HERDR}/docs/agents/`],
          platforms: ["macOS, Linux, Windows", `${HERDR}/docs/install/`],
          price: ["No price stated", HERDR],
          code: ["Apache-2.0", "https://github.com/herdrdev/herdr"],
        },
      },
    ],
  },
  {
    name: "The vendors' clouds",
    tools: [
      {
        name: "Claude Code on the web",
        cells: {
          runs: ["Anthropic's VM; your own runners on Team and Enterprise, in beta", `${CLAUDE}/claude-code-on-the-web`, `${CLAUDE}/self-hosted-environments`],
          second: ["Only through runners, on Team and Enterprise", `${CLAUDE}/self-hosted-environments`],
          has: ["What the repo has committed, and skills you turn on at claude.ai. Not your ~/.claude, plugins or local MCP servers", `${CLAUDE}/cloud-environments`],
          agents: ["Claude Code", `${CLAUDE}/claude-code-on-the-web`],
          platforms: ["Web, desktop, CLI, iOS, Android, Slack", `${CLAUDE}/claude-code-on-the-web`],
          price: ["In Pro, $20/mo, and up", "https://claude.com/pricing"],
          code: ["Closed", "https://github.com/anthropics/claude-code/blob/main/LICENSE.md"],
        },
      },
      {
        name: "Codex cloud",
        cells: {
          runs: ["OpenAI's VM", `${CODEX}/cloud`],
          second: ["No", `${CODEX}/environments/cloud-environments`],
          has: ['Repo skills and AGENTS.md. "Personal skills from your local computer aren\'t synced"', `${CODEX}/environments/cloud-environments`],
          agents: ["Codex", `${CODEX}/models`],
          platforms: ["Web, desktop, CLI, IDE, iOS", `${CODEX}/environments/cloud-environments`],
          price: ["In Plus, $20/mo, and up", `${CODEX}/pricing`],
          code: ["Closed; CLI Apache-2.0", `${CODEX}/open-source`],
        },
      },
      {
        name: "Cursor cloud agents",
        cells: {
          runs: ["Cursor's VM, or your own machine with My Machines", CURSOR, `${CURSOR}/self-hosted/my-machines`],
          second: ["Yes, My Machines on paid plans", `${CURSOR}/self-hosted`],
          has: ["Your rules, skills if you turn on sync, MCP servers set in its dashboard", `${CURSOR}/best-practices`, "https://cursor.com/docs/skills", `${CURSOR}/capabilities`],
          agents: ["Cursor's agent, many models", CURSOR],
          platforms: ["Desktop, web, iOS, Slack", CURSOR, `${CURSOR}/mobile`],
          price: ["Paid plans from $20/mo, models at API price", "https://cursor.com/help/account-and-billing/pricing"],
          code: ["Not stated", "https://cursor.com/cli"],
        },
      },
    ],
  },
];

/** Where the others are ahead, each with the pages that say so. */
export const AHEAD: { title: string; body: Cell }[] = [
  { title: "Windows", body: ["T3 Code, herdr, Orca, Emdash and Solo run on Windows. wsp runs on macOS and Linux.", "https://t3.codes/download", `${HERDR}/docs/install/`, `${ORCA}/docs/install`, `${EMDASH}/docs/installation`, `${SOLO}/docs/getting-started/installation`] },
  { title: "Your phone", body: ["T3 Code, Orca, Superset, Conductor and all three vendors have a phone app. wsp has none.", "https://t3.codes/download", `${ORCA}/docs/mobile`, "https://superset.sh/mobile", `${CONDUCTOR}/changelog/0.90.0-conductor-for-ios`, `${CLAUDE}/claude-code-on-the-web`, `${CODEX}/environments/cloud-environments`, `${CURSOR}/mobile`] },
  { title: "No computer of your own", body: ["Claude Code on the web, Codex cloud and Cursor run agents on their own machines, in the plan you pay for. wsp needs a computer you own for every agent.", `${CLAUDE}/claude-code-on-the-web`, `${CODEX}/cloud`, CURSOR] },
  { title: "More agents", body: ["Orca lists 41 agents and Emdash 35. wsp runs threads on four.", `${ORCA}/docs/agents/supported`, `${EMDASH}/docs/providers`] },
  { title: "Teammates", body: ["Conductor, Superset and all three vendors sell plans for teams. wsp is for one person.", `${CONDUCTOR}/pricing`, "https://superset.sh/pricing", "https://claude.com/pricing", `${CODEX}/pricing`, "https://cursor.com/help/account-and-billing/pricing"] },
  { title: "Size", body: ["Orca has 88,402 GitHub stars, herdr 43,078 and T3 Code 26,545. wsp has 8; it started in September 2026.", "https://github.com/stablyai/orca", "https://github.com/herdrdev/herdr", "https://github.com/pingdotgg/t3code", "https://github.com/wsp-labs/wsp"] },
];

/** Every page the table and the cells under it read, numbered in the order the page first cites them. */
export function sources(): string[] {
  const all = [...[WSP, ...KINDS.flatMap(k => k.tools)].flatMap(t => COLUMNS.flatMap(c => t.cells[c.key].slice(1))), ...AHEAD.flatMap(a => a.body.slice(1))];
  return [...new Set(all)];
}
