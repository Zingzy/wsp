// SPDX-License-Identifier: AGPL-3.0-only
// What the installed OpenCode binary reports about itself, read without a turn:
// `opencode --version`, then `opencode models --verbose`, which prints each
// model as its provider/id on a line of its own and its JSON on the lines
// under it, with the variants --variant takes. Measured on 1.18.18 under an
// empty home: the free models it serves with no sign-in are listed, in 2.4 s.
import { programWord, shellQuote } from "@wsp/protocol";
import type { AgentLaunch, HarnessCatalogAnswer, HarnessCatalogModelProbe } from "@wsp/protocol";
import { AUTO_MODE } from "./command.js";

const SEP = "__WSP_CATALOG_SEP__";
const MODEL_LINE = /^[A-Za-z0-9][\w.-]*\/\S+$/;

/** The login PATH rides the line, since a host with a bare one would find no opencode. */
export function catalogProbeCommand(options: { baseEnv?: Readonly<Record<string, string | undefined>>; launch?: AgentLaunch }): string {
  const opencode = programWord("opencode", options.launch);
  const path = options.baseEnv?.["PATH"];
  return `cd ~ && ${path === undefined ? "" : `export PATH=${shellQuote(path)}; `}${opencode} --version; echo ${SEP}; ${opencode} models --verbose`;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function modelOf(slug: string, body: readonly string[]): HarnessCatalogModelProbe | undefined {
  let entry: Record<string, unknown> | undefined;
  try {
    entry = rec(JSON.parse(body.join("\n")));
  } catch {
    return undefined;
  }
  if (entry === undefined) return undefined;
  const label = typeof entry["name"] === "string" && entry["name"] !== "" ? entry["name"] : slug;
  return { slug, label, efforts: Object.keys(rec(entry["variants"]) ?? {}), contextWindows: [], isDefault: false };
}

export function parseCatalogProbe(stdout: string): HarnessCatalogAnswer {
  const at = stdout.indexOf(SEP);
  if (at === -1) return null;
  const version = stdout.slice(0, at).trim().split("\n").at(-1)?.trim() || null;
  const models: HarnessCatalogModelProbe[] = [];
  let slug: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    const model = slug === undefined ? undefined : modelOf(slug, body);
    if (model !== undefined) models.push(model);
  };
  for (const line of stdout.slice(at + SEP.length).split("\n")) {
    if (!MODEL_LINE.test(line)) {
      body.push(line);
      continue;
    }
    flush();
    slug = line;
    body = [];
  }
  flush();
  if (models.length === 0) return null;
  return { version, models, efforts: [...new Set(models.flatMap(m => m.efforts ?? []))], permissionModes: [AUTO_MODE] };
}
