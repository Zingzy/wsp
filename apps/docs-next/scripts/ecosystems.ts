// SPDX-License-Identifier: AGPL-3.0-only
// The worktree table on the Projects and worktrees page: for each ecosystem wsp knows by its lockfile, what a new
// worktree carries in from the project folder, what it never carries and the install that rebuilds the rest.
import { ECOSYSTEM_MODULES } from "../../../packages/catalog/src/index.js";
import { table, within, type Generated } from "./generated.js";

const code = (words: readonly string[]): string => (words.length === 0 ? "None" : words.map(w => `\`${w}\``).join(", "));

export default function ecosystems(): Generated[] {
  const rows = ECOSYSTEM_MODULES.map(e => [`\`${e.id}\``, code(e.lockfiles), code(e.carry), code(e.never), `\`${e.rebuild}\``]);
  return [within("content/features/projects.mdx", { ecosystems: table(["Ecosystem", "Lockfile", "Carried in", "Never carried", "Install that runs"], rows) })];
}
