// SPDX-License-Identifier: AGPL-3.0-only
// The MCP tools page: the server's instructions, then every tool the server lists with the cloud off, each with its
// description, what it takes and what it answers, read off the record the daemon's tool server serves from. That
// record is held to the TypeScript server by packages/host/test/mcp-record.test.ts.
import { readdirSync } from "node:fs";
import { COMMAND_LINES } from "../../../packages/host/src/cli.js";
import { cell, mdxSafe, page, read, table, type Generated } from "./generated.js";

const RECORD = new URL("../../../daemon/crates/wsp-mcp/record/", import.meta.url);

type Schema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  oneOf?: Schema[];
  $ref?: string;
  default?: unknown;
  additionalProperties?: boolean | Schema;
};

type Tool = { name: string; description: string; inputSchema: Schema; outputSchema?: Schema };

/** What a $ref points at, inside the schema it sits in. */
const resolve = (root: Schema, ref: string): Schema =>
  ref.replace(/^#\/?/, "").split("/").filter(Boolean).reduce<Schema>((at, key) => (at as Record<string, Schema>)[decodeURIComponent(key)] ?? {}, root);

/** A schema's type as a person reads it: its fixed values where it has them, either side of an anyOf, a list's
 * element type with []. */
function typeOf(root: Schema, s: Schema): string {
  if (s.$ref !== undefined) return typeOf(root, resolve(root, s.$ref));
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (s.enum !== undefined) return s.enum.map(v => `\`${String(v)}\``).join(", ");
  const either = s.anyOf ?? s.oneOf;
  if (either !== undefined) return either.map(x => typeOf(root, x)).join(" or ");
  if (s.type === "array") return `${s.items === undefined ? "any" : typeOf(root, s.items)}[]`;
  if (Array.isArray(s.type)) return s.type.join(" or ");
  return s.type ?? "any";
}

/** One row per field down to a depth, a nested field named by its path: a.b, or a[].b inside a list. */
function rows(root: Schema, s: Schema, depth: number, prefix = ""): string[][] {
  const at = s.$ref !== undefined ? resolve(root, s.$ref) : s;
  return Object.entries(at.properties ?? {}).flatMap(([key, field]) => {
    const name = `${prefix}${key}`;
    const shown = field.$ref !== undefined ? resolve(root, field.$ref) : field;
    const said = [field.description ?? shown.description ?? "", field.default !== undefined ? `Default \`${JSON.stringify(field.default)}\`.` : ""].filter(Boolean).join(" ");
    const row = [`\`${name}\``, cell(typeOf(root, field)), (at.required ?? []).includes(key) ? "yes" : "", cell(said)];
    const inner =
      depth <= 1 ? [] : shown.type === "array" && shown.items !== undefined ? rows(root, shown.items, depth - 1, `${name}[].`) : shown.properties !== undefined && field.$ref === undefined ? rows(root, shown, depth - 1, `${name}.`) : [];
    return [row, ...inner];
  });
}

/** What a tool takes is listed whole; what it answers two levels down, since a listing's rows nest a view each. */
const fields = (root: Schema, depth = Infinity): string => {
  const found = rows(root, root, depth);
  return found.length === 0 ? "Nothing." : table(["Field", "Type", "Required", "What it is"], found);
};

export default function mcpTools(): Generated[] {
  const server = JSON.parse(read(new URL("server.json", RECORD))) as { instructions: { cloudOff: string } };
  const tools = readdirSync(new URL("tools/", RECORD))
    .map(f => (JSON.parse(read(new URL(`tools/${f}`, RECORD))) as { cloudOff: Tool | null }).cloudOff)
    .filter((t): t is Tool => t !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const toolOnly = tools.map(t => t.name).filter(name => !COMMAND_LINES.some(line => "tool" in line && line.tool === name));
  const body = [
    `\`wsp mcp\` serves these ${tools.length} tools over stdio to an agent on your computer, and \`wsp mcp install --agent <id>\` writes it into that agent's own config. A tool answers a failure as a tool error that carries the object \`--json\` prints.`,
    `Each tool${toolOnly.length > 0 ? ` but ${toolOnly.map(name => `\`${name}\``).join(", ")}` : ""} is a line of the command line, its words joined with \`_\`, and that line's page links here.`,
    "## What the server tells an agent",
    "The instructions the server sends when an agent connects:",
    mdxSafe(server.instructions.cloudOff)
      .split("\n")
      .map(l => `> ${l}`)
      .join("\n"),
    ...tools.flatMap(t => [`## ${t.name}`, mdxSafe(t.description), "**Takes**", fields(t.inputSchema), "**Answers**", t.outputSchema === undefined ? "Text." : fields(t.outputSchema, 2)]),
  ];
  return [page("content/reference/mcp-tools.mdx", "MCP tools", "mcp-tools.ts", body.join("\n\n"))];
}
