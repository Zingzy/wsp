// SPDX-License-Identifier: AGPL-3.0-only
// A person and an agent meet projects, threads, folders and branches: the
// words "workspace" and "task" are gone from everything they read about
// threads on this computer, the command line's usage, about and refusal
// lines, the tools' prose, the MCP server's instructions and the skill. The
// verbs that still take a box's workspace keep the word until those are
// renamed, and they are listed here by name; identifiers (ops, inputs, code
// spans) are exempt, and "task" stays where an agent's own background task is
// meant.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { mcpServer } from "../src/mcp.js";
import { INSTRUCTIONS, WSP_SKILL } from "../src/skill.js";
import { COMMAND_LINES, HELP } from "../src/cli.js";
import { ALL_VERBS, CLI_VERBS, toolName, verbPage } from "../src/verbs.js";

/** The verbs that take a workspace on a box today, which keep the word until they are renamed for every computer. */
const BOX_VERBS: ReadonlySet<string> = new Set([
  "agents",
  "agents signin",
  "skills",
  "skills show",
  "skills add",
  "skills remove",
  "skills disable",
  "skills enable",
  "servers",
  "servers signin",
  "servers tools",
  "servers add",
  "servers remove",
  "servers disable",
  "servers enable",
  "workspaces agents",
  "rename",
  "snapshot",
  "fork",
  "commit",
  "discard",
  "fix",
  "merge",
  "merge in",
  "review",
  "review post",
  "update",
  "pause",
  "wake",
  "rebuild",
  "image",
  "image move",
  "image remove",
  "forget",
  "delete",
  "ssh",
  "exec",
  "export",
]);

const BANNED = /\b(workspaces?|tasks?)\b/i;

/** The banned words a piece of prose holds, outside code spans and the agents' own background tasks. */
function banned(text: string): string[] {
  const prose = text.replace(/`[^`]*`/g, "").replace(/--[\w-]+/g, "").replace(/\bbackground tasks?\b/gi, "");
  return [...prose.matchAll(new RegExp(BANNED.source, "gi"))].map(m => m[0]);
}

/** One line per sentence holding a banned word, with where it was read, so a failure names the line to rewrite. */
function offenders(where: string, text: string): string[] {
  return text
    .split(/(?<=[.;:])\s+|\n/)
    .filter(sentence => banned(sentence).length > 0)
    .map(sentence => `${where}: ${sentence.trim().slice(0, 200)}`);
}

async function toolProse(): Promise<Map<string, string[]>> {
  const server = mcpServer("/nonexistent/state.json", { env: {} });
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "words", version: "0" });
  await server.connect(toServer);
  await client.connect(toClient);
  try {
    const { tools } = await client.listTools();
    const described = (schema: unknown): string[] => Object.values((schema as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {}).map(f => f.description ?? "");
    return new Map(tools.map(t => [t.name, [t.description ?? "", ...described(t.inputSchema), ...described(t.outputSchema)]]));
  } finally {
    await client.close();
    await server.close();
  }
}

/** The prose string literals of each verb's entry in the verb table, by name, read off the source with the compiler,
 * so a refusal line is held to the words as its usage is; a literal that is a name (an op, a flag, a key) is none. */
function verbStrings(): Map<string, string[]> {
  const path = fileURLToPath(new URL("../src/verbs.ts", import.meta.url));
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found = new Map<string, string[]>();
  const texts = (node: ts.Node, into: string[]): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) into.push(node.text);
    else if (ts.isTemplateExpression(node)) into.push(node.head.text, ...node.templateSpans.map(span => span.literal.text));
    ts.forEachChild(node, child => texts(child, into));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const name = node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(file) === "name" && ts.isStringLiteral(p.initializer));
      if (name !== undefined) {
        const into: string[] = [];
        texts(node, into);
        found.set((name.initializer as ts.StringLiteral).text, into.filter(text => !/^[\w.-]*$/.test(text)));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the words a person and an agent read about threads on this computer", () => {
  it("leave every verb but the box verbs: usage, about and every refusal line", () => {
    const found: string[] = [];
    const strings = verbStrings();
    for (const verb of ALL_VERBS) {
      if (BOX_VERBS.has(verb.name)) continue;
      found.push(...offenders(`wsp ${verb.name} usage`, "usage" in verb ? verb.usage : ""), ...offenders(`wsp ${verb.name} about`, "about" in verb ? verb.about : ""));
      for (const text of strings.get(verb.name) ?? []) found.push(...offenders(`wsp ${verb.name} source`, text));
    }
    expect(found).toEqual([]);
  });

  it("leave every help page but the box verbs', every flag's line in it", () => {
    const found: string[] = [];
    for (const verb of CLI_VERBS) if (!BOX_VERBS.has(verb.name)) found.push(...offenders(`wsp ${verb.name} --help`, verbPage(verb, "a host on another computer")));
    expect(found).toEqual([]);
  });

  it("leave the front help page and every line the command line alone has", () => {
    const found = offenders("wsp --help", HELP);
    for (const line of COMMAND_LINES.filter(l => !BOX_VERBS.has(l.words))) found.push(...offenders(`wsp ${line.words} usage`, line.usage), ...offenders(`wsp ${line.words} about`, line.about));
    expect(found).toEqual([]);
  });

  it("leave every tool but the box verbs' own", async () => {
    const found: string[] = [];
    const boxTools = new Set([...BOX_VERBS].map(toolName));
    for (const [name, prose] of await toolProse()) {
      if (boxTools.has(name)) continue;
      for (const text of prose) found.push(...offenders(`tool ${name}`, text));
    }
    expect(found).toEqual([]);
  });

  it("leave the MCP server's instructions", () => {
    expect(offenders("instructions", INSTRUCTIONS)).toEqual([]);
  });

  it("leave the skill, but for the rows of the box verbs and the lines a command shows", () => {
    const found: string[] = [];
    let fenced = false;
    for (const line of WSP_SKILL.split("\n")) {
      if (line.trimStart().startsWith("```")) fenced = !fenced;
      if (fenced) continue;
      const row = /^\| `wsp ([a-z ]+?)(?: [<[-]|`)/.exec(line);
      if (row !== null && BOX_VERBS.has(row[1]!.trim())) continue;
      found.push(...offenders("skill", line));
    }
    expect(found).toEqual([]);
  });

  it("catch the word where it stands, so a usage line left behind fails", () => {
    expect(banned('wsp run [<workspace>] "<task>"')).toEqual(["workspace", "task"]);
    expect(banned("a thread in `wsp workspaces` with background tasks running")).toEqual([]);
  });
});
