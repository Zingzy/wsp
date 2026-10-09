// SPDX-License-Identifier: AGPL-3.0-only
// What /compare and its page per tool say about every tool. Each cell holds the short answer the table shows, its mark,
// and the long sentence it sums with the pages that sentence was read from. A cell says only what its pages say on the
// day in READ; a fact read later is read again from the product's own page and the day moves with it. wsp's answers are
// read from the repo at WSP_AT, not from this site.

export const READ = "2026-10-09";
const WSP_AT = "https://github.com/wsp-labs/wsp/blob/917b67077b1523171095b99be61ffeddc8c2419f";

/** The words, then every page they were read from. */
export type Said = readonly [text: string, source: string, ...more: string[]];
/** What a table cell shows, at most six words, and whether it is a check or a dash, beside the record it sums. */
export type Cell = { short: string; good: boolean; says: Said };

const yes = (short: string, ...says: Said): Cell => ({ short, good: true, says });
const no = (short: string, ...says: Said): Cell => ({ short, good: false, says });

export const ROWS = [
  { key: "runs", label: "Runs agents on" },
  { key: "second", label: "Another computer" },
  { key: "has", label: "What that computer has when the agent starts" },
  { key: "keys", label: "Where your keys and sign-ins live" },
  { key: "agents", label: "Which agents" },
  { key: "platforms", label: "Platforms" },
  { key: "price", label: "Price" },
  { key: "code", label: "Source code" },
] as const;

export type Row = (typeof ROWS)[number]["key"];
export type Answers = Record<Row, Cell>;

export type Tool = {
  name: string;
  /** Its page, at /compare/<slug>. */
  slug: string;
  /** The card's line on /compare. */
  line: string;
  /** The sentence under the page's heading, which is also its description. */
  differs: string;
  well: string;
  fit: string;
  cells: Answers;
};
export type Kind = { name: string; tools: Tool[] };

/** What the vendors' clouds carry onto their machine, as /compare's intro and the landing page's table both say it. */
export const VENDORS_BRING = "your repo, a setup script, and on Claude and Cursor some skills you turn on";

export const WSP: Answers = {
  runs: yes("Computers you own", "Your computer, and Linux computers you own", `${WSP_AT}/skills/wsp/SKILL.md#L8`, `${WSP_AT}/AGENTS.md#L77`),
  second: yes("Yes, over ssh or dialing out", "Yes. Added over ssh, or it dials out to join", `${WSP_AT}/skills/wsp/SKILL.md#L71`, `${WSP_AT}/skills/wsp/SKILL.md#L154`),
  has: yes(
    "Your setup, agents signed in",
    "Your agents signed in, MCP servers, CLIs, skills, Claude Code plugins, GitHub sign-in, git and shell settings, your projects",
    `${WSP_AT}/apps/web/src/settings/add/addFlow.ts#L43-L50`,
  ),
  keys: yes(
    "Your computers, none on ours",
    "On your computers. wsp keeps none of your keys, and you sign in on each computer you add",
    `${WSP_AT}/apps/www/src/pages/legal.tsx#L33`,
    `${WSP_AT}/apps/www/src/pages/legal.tsx#L62`,
  ),
  agents: yes("Claude Code, Codex, OpenCode, Cursor", "Claude Code, Codex, OpenCode, Cursor", `${WSP_AT}/packages/catalog/src/thread-agents.ts#L9`),
  platforms: no("macOS, Linux", "macOS, Linux", `${WSP_AT}/.github/workflows/release.yml#L3-L5`),
  price: yes("Free", "Free", `${WSP_AT}/apps/www/src/sections/close.tsx#L13`),
  code: yes("AGPL-3.0", "AGPL-3.0", `${WSP_AT}/LICENSE`),
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

const OWN_WAY = "wsp fits when you already have another computer, a server you rent or an old laptop, and want your agents on it signed in, with your MCP servers, CLIs and skills.";

export const KINDS: Kind[] = [
  {
    name: "Apps on the computer you sit at",
    tools: [
      {
        name: "Conductor",
        slug: "conductor",
        line: "A Mac app for agents side by side, with cloud sandboxes on Pro.",
        differs: "Conductor runs agents on your Mac or in its own cloud. wsp runs them on your computer and on Linux computers you own, each set up from yours.",
        well: "Conductor runs Claude Code, Codex, Cursor and OpenCode on your Mac, and has an iOS app. On Pro its cloud sandboxes import your API keys, env settings and MCP servers from your Mac, so there is no second computer to keep running.",
        fit: `${OWN_WAY} Your keys stay on computers you own, it costs nothing, and the code is AGPL-3.0.`,
        cells: {
          runs: yes("Your Mac, or its cloud", "Your Mac, or its cloud sandboxes on Pro", `${CONDUCTOR}/docs/cloud`),
          second: no('No, "not yet"', 'No. "Not yet"', `${CONDUCTOR}/docs/cloud/faq`),
          has: no(
            "Cloud: your keys, MCP servers",
            "Cloud only: API keys, env settings and MCP servers imported from your Mac; other tools from an install script you write",
            `${CONDUCTOR}/changelog/0.78.0-introducing-conductor-cloud`,
            `${CONDUCTOR}/changelog/0.83.0-auto-port-forwarding`,
            `${CONDUCTOR}/docs/cloud/cloud-computer`,
          ),
          keys: no("Your Mac; its cloud on Pro", "On your Mac. Cloud setup can import the API keys configured on your Mac", `${CONDUCTOR}/changelog/0.78.0-introducing-conductor-cloud`),
          agents: yes("Claude Code, Codex, Cursor, OpenCode", "Claude Code, Codex, Cursor, OpenCode", `${CONDUCTOR}/docs/reference/harnesses`),
          platforms: no("macOS, iOS", "macOS, iOS", `${CONDUCTOR}/docs/installation`, `${CONDUCTOR}/changelog/0.90.0-conductor-for-ios`),
          price: yes("Free; cloud $50/mo", "Free; cloud on Pro, $50/mo", `${CONDUCTOR}/pricing`),
          code: no("Closed", "Closed", CONDUCTOR),
        },
      },
      {
        name: "Superset",
        slug: "superset",
        line: "A desktop app that reaches your other computers through its relay.",
        differs: "Superset reaches your other computers and leaves each one for you to set up. wsp sets each computer up from yours when you add it.",
        well: "Superset works with any CLI agent and lists 22. On Pro its relay reaches the other computers you own, and it has apps for iPhone and iPad.",
        fit: `${OWN_WAY} Superset leaves each host to you. wsp is free and AGPL-3.0, where Superset is source available under ELv2.`,
        cells: {
          runs: yes("Your computers, through its relay", "Your computer, and others you own through its relay", `${SUPERSET}/remote-access`),
          second: yes("Yes, on Pro", "Yes, on Pro", "https://superset.sh/pricing"),
          has: no("Nothing carried over", "Nothing carried. You install the agents and sign in on each host", `${SUPERSET}/cli/host-server`, `${SUPERSET}/usage`),
          keys: yes("On each host you sign in", "On each host: the host server reuses that computer's gh login and runs under your Superset session", `${SUPERSET}/cli/host-server`),
          agents: yes("Any CLI agent, 22 listed", "Any CLI agent; 22 listed", `${SUPERSET}/agent-integration`),
          platforms: no("macOS, iOS; Linux experimental", "macOS, iPhone, iPad; Linux experimental", `${SUPERSET}/faq`, "https://superset.sh/mobile"),
          price: yes("Free; Pro $20/user/mo", "Free; Pro $20/user/mo", "https://superset.sh/pricing"),
          code: no("ELv2, source available", "ELv2, source available", "https://github.com/superset-sh/superset"),
        },
      },
      {
        name: "Orca",
        slug: "orca",
        line: "An open source app for 41 agents, on every desktop and phone.",
        differs: "Orca runs agents on ssh hosts and Orca servers you set up by hand. wsp sets each computer up from yours when you add it.",
        well: "Orca lists 41 agents and runs on macOS, Windows, Linux, iOS, Android and the web. It reaches other computers over ssh or an Orca server, and is free under MIT.",
        fit: `${OWN_WAY} Orca can install shared skills on a server and leaves the rest to you; wsp copies your setup onto it.`,
        cells: {
          runs: yes("Your computer, ssh hosts, servers", "Your computer, ssh hosts, Orca servers, a cloud VM on your own account in its experimental mode", `${ORCA}/docs/ways-to-run`),
          second: yes("Yes, ssh or an Orca server", "Yes, over ssh or an Orca server", `${ORCA}/docs/ways-to-run`),
          has: no("Not carried; can install shared skills", 'Not carried: "A login on your laptop does not automatically carry over". Shared skills can be installed on a host', `${ORCA}/docs/remote-servers`, `${ORCA}/docs/cli/skills`),
          keys: yes("On each host you sign in", 'On each host: "Remote sessions use the server\'s PATH, home directory, and credentials", not the client\'s', `${ORCA}/docs/remote-servers`),
          agents: yes("41 listed", "41 listed", `${ORCA}/docs/agents/supported`),
          platforms: yes("Desktop, web, iOS, Android", "macOS, Windows, Linux, iOS, Android, web", `${ORCA}/docs/install`, `${ORCA}/docs/mobile`, `${ORCA}/docs/android-apk`),
          price: yes("Free", "Free", ORCA),
          code: yes("MIT", "MIT", "https://github.com/stablyai/orca"),
        },
      },
      {
        name: "Emdash",
        slug: "emdash",
        line: "An open source app for 35 agents, with remote projects over ssh.",
        differs: "Emdash opens projects on ssh hosts you set up yourself. wsp sets each computer up from yours when you add it.",
        well: "Emdash lists 35 agents and runs on macOS, Windows and Linux. Since 2026-08-28 it opens projects on ssh hosts and can run an agent's installer there. It is free under Apache-2.0.",
        fit: `${OWN_WAY} Emdash can run an agent's installer on the host and leaves the rest to you; wsp copies your setup onto it.`,
        cells: {
          runs: yes("Your computer, ssh hosts", "Your computer, ssh hosts", `${EMDASH}/docs/remote-development`),
          second: yes("Yes, over ssh", "Yes, over ssh, since 2026-08-28", `${EMDASH}/changelog`),
          has: no("Not carried; can install agents", "Not carried. It can run an agent's installer on the host", `${EMDASH}/docs/remote-development/remote-projects`),
          keys: yes("On each host you set up", "On each ssh host: it uses the Git credentials configured on the remote host", `${EMDASH}/docs/remote-development/remote-projects`),
          agents: yes("35 listed", "35 listed", `${EMDASH}/docs/providers`),
          platforms: yes("macOS, Windows, Linux", "macOS, Windows, Linux", `${EMDASH}/docs/installation`),
          price: yes("Free", "Free", EMDASH),
          code: yes("Apache-2.0", "Apache-2.0", "https://github.com/generalaction/emdash"),
        },
      },
      {
        name: "T3 Code",
        slug: "t3-code",
        line: "An open source app that spreads threads across your computers.",
        differs: "T3 Code reaches your other computers and leaves each one's setup to you. wsp sets each computer up from yours when you add it.",
        well: "T3 Code runs on every desktop, the web and both phones. It reaches computers over ssh or its relay, can spread new threads across them, and installs Codex and ACP agents itself. It is free under MIT.",
        fit: `${OWN_WAY} T3 Code installs Codex and ACP agents itself and leaves the rest to you; wsp copies your setup onto each computer.`,
        cells: {
          runs: yes("Your computer, ssh, its relay", "Your computer, ssh hosts, any computer through its relay", `${T3}/remote-access.md`),
          second: yes("Yes, threads spread across them", "Yes, and it can spread new threads across them", `${T3}/remote-access.md`),
          has: no(
            "Not carried; installs some agents",
            'Not carried: "Installation, login, and configuration belong to that environment\'s machine". It installs Codex and ACP agents itself',
            `${T3}/install.md`,
            `${T3}/welcome-wizard.md`,
          ),
          keys: yes("On each computer it runs on", 'On each computer: "Installation, login, and configuration belong to that environment\'s machine"', `${T3}/install.md`),
          agents: yes("8 named, any ACP agent", "8 named, any ACP agent", "https://t3.codes", `${T3}/providers-acp.md`),
          platforms: yes("Desktop, web, iOS, Android", "macOS, Windows, Linux, web, iOS, Android", "https://t3.codes/download"),
          price: yes("Free", "Free", "https://t3.codes"),
          code: yes("MIT", "MIT", "https://github.com/pingdotgg/t3code"),
        },
      },
      {
        name: "Solo",
        slug: "solo",
        line: "An app for the agents and dev processes on one computer.",
        differs: "Solo runs agents on the computer you sit at and no other. wsp runs them there and on Linux computers you own.",
        well: "Solo runs the agent CLIs already on your computer, eight built in and any other, beside your project's dev processes. Your API keys never pass through Solo, and it works on macOS and Windows.",
        fit: `${OWN_WAY} Solo "does not currently provide remote-host or headless session management".`,
        cells: {
          runs: yes("The computer you sit at", "The computer you sit at", SOLO),
          second: no("No", "No", SOLO),
          has: no("One computer, nothing to carry", "One computer, nothing to carry", SOLO),
          keys: yes("Your computer, never through Solo", 'On your computer: "your API keys and provider connection never pass through Solo"', SOLO),
          agents: yes("8 built in, any CLI", "8 built in, any CLI", `${SOLO}/docs/agents/setting-up-tools`),
          platforms: no("macOS, Windows", "macOS, Windows", `${SOLO}/docs/getting-started/installation`),
          price: yes("Free for 4 projects, then $99/yr", "Free for 4 projects; Pro $99/yr", SOLO),
          code: no("Closed", "Closed", `${SOLO}/terms-of-service`),
        },
      },
    ],
  },
  {
    name: "A runtime over ssh",
    tools: [
      {
        name: "herdr",
        slug: "herdr",
        line: "An open source terminal runtime for agents, on your computer and over ssh.",
        differs: "herdr runs agents on ssh machines and copies nothing of yours onto them. wsp copies your setup onto each computer you add.",
        well: "herdr detects 22 agents and runs any terminal program, on macOS, Linux and Windows. Since 2026-09-07 it reaches saved ssh machines, and authentication stays with OpenSSH. It is free under Apache-2.0.",
        fit: `${OWN_WAY} herdr "does not copy local command plugins, configuration, executables, or secrets onto SSH hosts".`,
        cells: {
          runs: yes("Your computer, saved ssh machines", "Your computer, and saved ssh machines", HERDR, "https://github.com/herdrdev/herdr/releases/tag/v0.9.0"),
          second: yes("Yes, over ssh", "Yes, over ssh, since 2026-09-07", "https://github.com/herdrdev/herdr/releases/tag/v0.9.0"),
          has: no("Only herdr itself", 'Only herdr. It "does not copy local command plugins, configuration, executables, or secrets"', `${HERDR}/docs/connecting-machines/`),
          keys: yes("On each machine, none copied", 'On each machine: herdr "does not store passwords, private keys, agent tickets" and copies no secrets to ssh hosts', `${HERDR}/docs/connecting-machines/`),
          agents: yes("22 detected, any terminal program", "22 detected, any terminal program", `${HERDR}/docs/agents/`),
          platforms: yes("macOS, Linux, Windows", "macOS, Linux, Windows", `${HERDR}/docs/install/`),
          price: no("Not stated", "No price stated", HERDR),
          code: yes("Apache-2.0", "Apache-2.0", "https://github.com/herdrdev/herdr"),
        },
      },
    ],
  },
  {
    name: "The vendors' clouds",
    tools: [
      {
        name: "Claude Code on the web",
        slug: "claude-code-web",
        line: "Claude Code on Anthropic's VM, from the web, desktop or phone.",
        differs: "Claude Code on the web runs on Anthropic's VM with your repo. wsp runs it on computers you own, with your setup on them.",
        well: "Claude Code on the web needs no computer of your own. It starts from the web, desktop, CLI, phones or Slack, and runs on Anthropic's VM inside the Pro plan and up. A proxy keeps your GitHub token outside the VM.",
        fit: `${OWN_WAY} Its VM has "what the repo has committed" and not your ~/.claude, plugins or local MCP servers. wsp also runs Codex, OpenCode and Cursor beside Claude Code.`,
        cells: {
          runs: no("Anthropic's VM; runners in beta", "Anthropic's VM; your own runners on Team and Enterprise, in beta", `${CLAUDE}/claude-code-on-the-web`, `${CLAUDE}/self-hosted-environments`),
          second: no("Runners, on Team and Enterprise", "Only through runners, on Team and Enterprise", `${CLAUDE}/self-hosted-environments`),
          has: no("Committed repo, skills you turn on", "What the repo has committed, and skills you turn on at claude.ai. Not your ~/.claude, plugins or local MCP servers", `${CLAUDE}/cloud-environments`),
          keys: no("Anthropic's servers", "Environment variables and network secrets are saved on the cloud environment, and a proxy holds your GitHub token", `${CLAUDE}/cloud-environments`),
          agents: no("Claude Code", "Claude Code", `${CLAUDE}/claude-code-on-the-web`),
          platforms: yes("Web, desktop, CLI, phones, Slack", "Web, desktop, CLI, iOS, Android, Slack", `${CLAUDE}/claude-code-on-the-web`),
          price: no("In Pro, $20/mo, and up", "In Pro, $20/mo, and up", "https://claude.com/pricing"),
          code: no("Closed", "Closed", "https://github.com/anthropics/claude-code/blob/main/LICENSE.md"),
        },
      },
      {
        name: "Codex cloud",
        slug: "codex-cloud",
        line: "Codex on OpenAI's VM, from the web, desktop, IDE or iOS.",
        differs: "Codex cloud runs on OpenAI's VM with your repo. wsp runs Codex on computers you own, with your setup on them.",
        well: "Codex cloud needs no computer of your own. It starts from the web, desktop, CLI, IDE or iOS, inside the Plus plan and up, and its CLI is open source under Apache-2.0.",
        fit: `${OWN_WAY} Codex cloud says "personal skills from your local computer aren't synced". wsp also runs Claude Code, OpenCode and Cursor beside Codex.`,
        cells: {
          runs: no("OpenAI's VM", "OpenAI's VM", `${CODEX}/cloud`),
          second: no("No", "No", `${CODEX}/environments/cloud-environments`),
          has: no("Repo skills and AGENTS.md", 'Repo skills and AGENTS.md. "Personal skills from your local computer aren\'t synced"', `${CODEX}/environments/cloud-environments`),
          keys: no("OpenAI's servers", "Environment variables and secrets saved on the environment or in your personal vault", `${CODEX}/environments/cloud-environments`),
          agents: no("Codex", "Codex", `${CODEX}/models`),
          platforms: yes("Web, desktop, CLI, IDE, iOS", "Web, desktop, CLI, IDE, iOS", `${CODEX}/environments/cloud-environments`),
          price: no("In Plus, $20/mo, and up", "In Plus, $20/mo, and up", `${CODEX}/pricing`),
          code: no("Closed; CLI Apache-2.0", "Closed; CLI Apache-2.0", `${CODEX}/open-source`),
        },
      },
      {
        name: "Cursor cloud agents",
        slug: "cursor-cloud-agents",
        line: "Cursor's agent on its VM, or on your own machine with My Machines.",
        differs: "Cursor cloud agents run on Cursor's VM, set up from its dashboard. wsp runs agents on computers you own, set up from yours.",
        well: "Cursor cloud agents need no computer of your own, and on paid plans My Machines runs them on yours. They carry your rules, synced skills and MCP servers set in the dashboard, and start from desktop, web, iOS or Slack.",
        fit: `${OWN_WAY} wsp copies your MCP servers and skills from the computer you sit at, not a dashboard, and runs Claude Code, Codex and OpenCode beside Cursor.`,
        cells: {
          runs: yes("Cursor's VM, or My Machines", "Cursor's VM, or your own machine with My Machines", CURSOR, `${CURSOR}/self-hosted/my-machines`),
          second: yes("Yes, My Machines on paid plans", "Yes, My Machines on paid plans", `${CURSOR}/self-hosted`),
          has: no("Rules, synced skills, dashboard MCP servers", "Your rules, skills if you turn on sync, MCP servers set in its dashboard", `${CURSOR}/best-practices`, "https://cursor.com/docs/skills", `${CURSOR}/capabilities`),
          keys: no("Cursor's servers", "Secrets added in its dashboard, scoped to the workspace or team and injected when an agent starts", CURSOR),
          agents: no("Cursor's agent, many models", "Cursor's agent, many models", CURSOR),
          platforms: yes("Desktop, web, iOS, Slack", "Desktop, web, iOS, Slack", CURSOR, `${CURSOR}/mobile`),
          price: no("From $20/mo, models at API price", "Paid plans from $20/mo, models at API price", "https://cursor.com/help/account-and-billing/pricing"),
          code: no("Not stated", "Not stated", "https://cursor.com/cli"),
        },
      },
    ],
  },
];

export const TOOLS: Tool[] = KINDS.flatMap(k => k.tools);

/** Where the others are ahead: what wsp lacks, then each tool that has it, by slug, with the pages that say so. */
export const AHEAD: { title: string; wsp: string; them: Partial<Record<string, Said>> }[] = [
  {
    title: "Windows",
    wsp: "wsp runs on macOS and Linux.",
    them: {
      "t3-code": ["T3 Code runs on Windows.", "https://t3.codes/download"],
      herdr: ["herdr runs on Windows.", `${HERDR}/docs/install/`],
      orca: ["Orca runs on Windows.", `${ORCA}/docs/install`],
      emdash: ["Emdash runs on Windows.", `${EMDASH}/docs/installation`],
      solo: ["Solo runs on Windows.", `${SOLO}/docs/getting-started/installation`],
    },
  },
  {
    title: "Your phone",
    wsp: "wsp has no phone app.",
    them: {
      "t3-code": ["T3 Code has apps for iOS and Android.", "https://t3.codes/download"],
      orca: ["Orca has apps for iOS and Android.", `${ORCA}/docs/mobile`, `${ORCA}/docs/android-apk`],
      superset: ["Superset has apps for iPhone and iPad.", "https://superset.sh/mobile"],
      conductor: ["Conductor has an iOS app.", `${CONDUCTOR}/changelog/0.90.0-conductor-for-ios`],
      "claude-code-web": ["Claude Code on the web runs from iOS and Android.", `${CLAUDE}/claude-code-on-the-web`],
      "codex-cloud": ["Codex cloud runs from iOS.", `${CODEX}/environments/cloud-environments`],
      "cursor-cloud-agents": ["Cursor cloud agents run from iOS.", `${CURSOR}/mobile`],
    },
  },
  {
    title: "No computer of your own",
    wsp: "wsp needs a computer you own for every agent.",
    them: {
      "claude-code-web": ["Claude Code on the web runs agents on Anthropic's machines, in the plan you pay for.", `${CLAUDE}/claude-code-on-the-web`],
      "codex-cloud": ["Codex cloud runs agents on OpenAI's machines, in the plan you pay for.", `${CODEX}/cloud`],
      "cursor-cloud-agents": ["Cursor runs agents on its own machines, in the plan you pay for.", CURSOR],
    },
  },
  {
    title: "More agents",
    wsp: "wsp runs threads on four.",
    them: {
      orca: ["Orca lists 41 agents.", `${ORCA}/docs/agents/supported`],
      emdash: ["Emdash lists 35 agents.", `${EMDASH}/docs/providers`],
      superset: ["Superset works with any CLI agent and lists 22.", `${SUPERSET}/agent-integration`],
      "t3-code": ["T3 Code names 8 agents and runs any ACP agent.", "https://t3.codes", `${T3}/providers-acp.md`],
      solo: ["Solo has 8 agents built in and runs any other CLI.", `${SOLO}/docs/agents/setting-up-tools`],
      herdr: ["herdr detects 22 agents and runs any terminal program.", `${HERDR}/docs/agents/`],
    },
  },
  {
    title: "Teammates",
    wsp: "wsp is for one person.",
    them: {
      conductor: ["Conductor sells plans for teams.", `${CONDUCTOR}/pricing`],
      superset: ["Superset sells plans for teams.", "https://superset.sh/pricing"],
      "claude-code-web": ["Anthropic sells Team and Enterprise plans.", "https://claude.com/pricing"],
      "codex-cloud": ["OpenAI sells plans for teams.", `${CODEX}/pricing`],
      "cursor-cloud-agents": ["Cursor sells plans for teams.", "https://cursor.com/help/account-and-billing/pricing"],
    },
  },
  {
    title: "Size",
    wsp: "wsp has 8; it started in September 2026.",
    them: {
      orca: ["Orca has 88,402 GitHub stars.", "https://github.com/stablyai/orca", "https://github.com/wsp-labs/wsp"],
      herdr: ["herdr has 43,078 GitHub stars.", "https://github.com/herdrdev/herdr", "https://github.com/wsp-labs/wsp"],
      "t3-code": ["T3 Code has 26,545 GitHub stars.", "https://github.com/pingdotgg/t3code", "https://github.com/wsp-labs/wsp"],
      superset: ["Superset has 15,031 GitHub stars.", "https://github.com/superset-sh/superset", "https://github.com/wsp-labs/wsp"],
      emdash: ["Emdash has 5,946 GitHub stars.", "https://github.com/generalaction/emdash", "https://github.com/wsp-labs/wsp"],
    },
  },
];

/** The rows of AHEAD a tool is ahead on, each in one sentence for that tool and one for wsp. */
export function aheadOf(tool: Tool): { title: string; said: Said; wsp: string }[] {
  return AHEAD.flatMap(a => {
    const said = a.them[tool.slug];
    return said === undefined ? [] : [{ title: a.title, said, wsp: a.wsp }];
  });
}

/** Every page a tool's page reads, in the order the page first uses them. */
export function sources(tool: Tool): string[] {
  const cells = ROWS.flatMap(r => [...tool.cells[r.key].says.slice(1), ...WSP[r.key].says.slice(1)]);
  return [...new Set([...cells, ...aheadOf(tool).flatMap(a => a.said.slice(1))])];
}
