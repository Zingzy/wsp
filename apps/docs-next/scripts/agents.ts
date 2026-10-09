// SPDX-License-Identifier: AGPL-3.0-only
// The agents table on the Agents and sign-ins page: every agent the catalog carries, whether wsp runs threads on it,
// the command it installs, how it signs in and the variables it reads a token or a key from.
import { CATALOG_AGENTS, hasLogin, mintsToken, runsThreads, type AgentEntry } from "../../../packages/catalog/src/index.js";
import { cell, table, within, type Generated } from "./generated.js";

function signIn(agent: AgentEntry): string {
  const s = agent.signIn;
  if (mintsToken(s)) return `With a token you make, from \`${s.mint}\``;
  if (!hasLogin(s)) return s.note !== undefined ? cell(s.note) : "Needs no sign-in";
  const how = s.questions?.some(q => "person" in q)
    ? "In its own terminal, where it asks you to pick"
    : s.kind === "key"
      ? "With a key"
      : s.kind === "device" || s.headless === "device"
        ? "On a page, with a device code"
        : "With a code you paste back";
  return `${how}, from \`${s.login}\``;
}

function keyEnv(agent: AgentEntry): string {
  const s = agent.signIn;
  const names = [mintsToken(s) ? s.tokenEnv : undefined, "keyEnv" in s ? s.keyEnv : undefined].filter(n => n !== undefined);
  return names.length === 0 ? "None" : names.map(n => `\`${n}\``).join(" or ");
}

export default function agents(): Generated[] {
  const rows = CATALOG_AGENTS.map(a => [a.name, `\`${a.bin}\``, runsThreads(a.id) ? "Yes" : "No", signIn(a), keyEnv(a)]);
  return [within("content/features/agents.mdx", { agents: table(["Agent", "Command", "Runs threads", "How it signs in", "Key in the environment"], rows) })];
}
