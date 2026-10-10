// SPDX-License-Identifier: AGPL-3.0-only
// Codex's own reads of its TOML file beside the format's text edits: what a
// server's start hands it from the environment, and the trust table that
// says whether a folder's own servers are read at all.
import type { McpResolved, McpServer, Placed } from "./mcp.js";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const tomlString = (s: string): string => JSON.stringify(s);

/** Codex reads nothing inside its strings: a command's env_vars pass through where they have a value, and a header
 * named by env_http_headers or bearer_token_env_var is sent with its variable's value, which it must have. */
export function resolveCodex(server: McpServer, value: (name: string) => string | undefined): McpResolved {
  const t = server.transport;
  const r = server.reads;
  if (r === undefined) return { transport: t, values: [] };
  const values: string[] = [];
  const read = (name: string): string | undefined => {
    const got = value(name);
    if (got !== undefined) values.push(got);
    return got;
  };
  if (t.kind === "stdio") {
    const env = { ...t.env };
    for (const name of r.env) {
      const got = read(name);
      if (got !== undefined) env[name] = got;
    }
    return { transport: { ...t, env }, values };
  }
  const headers = { ...t.headers };
  const sent = Object.entries(r.headers).map(([header, name]) => ({ header, name, bearer: false }));
  if (r.bearer !== undefined) sent.push({ header: "Authorization", name: r.bearer, bearer: true });
  for (const { header, name, bearer } of sent) {
    const got = read(name);
    if (got === undefined) return { missing: name };
    headers[header] = bearer ? `Bearer ${got}` : got;
  }
  return { transport: { ...t, headers }, values };
}

/** Codex's own trust table for a folder, read by a TOML parser so every spelling of the key reads the same. The parser is
 * loaded only when a folder's trust is asked. */
export async function codexTrusts(text: string, folder: string): Promise<boolean> {
  const { parse } = await import("smol-toml");
  try {
    const projects = (parse(text) as Record<string, unknown>)["projects"];
    const entry = isObject(projects) ? projects[folder] : undefined;
    return isObject(entry) && entry["trust_level"] === "trusted";
  } catch {
    return false;
  }
}

/** The folder's trust written as Codex writes it, a `[projects."<folder>"]` table of its own: its trust_level set in
 * place where that table is there, the table added at the end where the file names the folder nowhere. A file the edit
 * would leave unreadable, as a table added beside an inline `projects` leaves it, is refused. */
export async function trustCodex(text: string | undefined, folder: string): Promise<Placed> {
  const was = text ?? "";
  if (await codexTrusts(was, folder)) return { text: was };
  const { parse } = await import("smol-toml");
  const projects = (parse(was) as Record<string, unknown>)["projects"];
  const header = `[projects.${tomlString(folder)}]`;
  const lines = was.split("\n");
  const at = lines.findIndex(l => l.trim() === header);
  let out: string;
  if (at < 0) {
    if (isObject(projects) && projects[folder] !== undefined) throw new Error(`the trust of ${folder} is written in a shape wsp does not edit`);
    out = `${was}${was === "" || was.endsWith("\n") ? "" : "\n"}${was === "" ? "" : "\n"}${header}\ntrust_level = "trusted"\n`;
  } else {
    const end = lines.findIndex((l, i) => i > at && /^\s*\[/.test(l));
    const table = lines.slice(at + 1, end < 0 ? lines.length : end);
    const level = table.findIndex(l => /^\s*trust_level\s*=/.test(l));
    if (level >= 0) lines[at + 1 + level] = 'trust_level = "trusted"';
    else lines.splice(at + 1, 0, 'trust_level = "trusted"');
    out = lines.join("\n");
  }
  try {
    parse(out);
  } catch {
    throw new Error(`the trust of ${folder} cannot be added to a file that writes its projects in a shape wsp does not edit`);
  }
  return { text: out };
}
