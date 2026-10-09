// SPDX-License-Identifier: AGPL-3.0-only
// Every generator, by its file: what pnpm --filter @wsp/docs-next generate writes and test/generated.test.ts holds
// the committed pages to.
import addAComputer from "./add-a-computer.js";
import agents from "./agents.js";
import changelog from "./changelog.js";
import cli from "./cli.js";
import contract from "./contract.js";
import contributing from "./contributing.js";
import ecosystems from "./ecosystems.js";
import editors from "./editors.js";
import environment from "./environment.js";
import mcpInstall from "./mcp-install.js";
import mcpTools from "./mcp-tools.js";
import security from "./security.js";
import settings from "./settings.js";
import shortcuts from "./shortcuts.js";
import skill from "./skill.js";
import slate from "./slate.js";
import type { Generated } from "./generated.js";

export const SCRIPTS: Record<string, () => Generated[] | Promise<Generated[]>> = {
  "cli.ts": cli,
  "mcp-tools.ts": mcpTools,
  "slate.ts": slate,
  "environment.ts": environment,
  "contract.ts": contract,
  "skill.ts": skill,
  "changelog.ts": changelog,
  "contributing.ts": contributing,
  "security.ts": security,
  "shortcuts.ts": shortcuts,
  "agents.ts": agents,
  "ecosystems.ts": ecosystems,
  "editors.ts": editors,
  "mcp-install.ts": mcpInstall,
  "settings.ts": settings,
  "add-a-computer.ts": addAComputer,
};
