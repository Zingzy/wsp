// SPDX-License-Identifier: AGPL-3.0-only
// The command line, the MCP tools and the skill are one contract: every
// verb has a tool and a skill row, every tool has a verb or a stated reason
// not to, and every wsp line the skill or the instructions show parses
// against the flag table the command actually reads.
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { COMMAND_LINES, type CommandLine } from "../src/cli.js";
import { mcpServer } from "../src/mcp.js";
import { INSTRUCTIONS, WSP_SKILL } from "../src/skill.js";

/** Tools with no command line, each with why: a caller with a shell has the verb named instead. */
const TOOL_ONLY: Readonly<Record<string, string>> = {
  workspaces: "the rows wsp threads folds its output from; the command line lists threads with their workspace on every row",
};

/** Command lines with no tool, each with why. */
const CLI_ONLY: Readonly<Record<string, string>> = {
  up: "starts the host on the person's computer; a tool runs against a host that is already up",
  down: "stops the service holding the host up on the person's computer, which a tool would be cutting the ground from under",
  status: "reads this computer's lock and service manager; a tool that answers at all is proof a host is up",
  init: "builds the golden and serves for hours; an agent runs it from a shell and relays the sign-ins it prints",
  doctor: "forks a live machine and bills while it runs; a person decides that at a terminal",
  mcp: "is the tool server itself",
  "mcp install": "writes an agent's own config and skills folder, which is done once from a shell",
};

const toolNameOf = (words: string): string => words.replace(/ /g, "_");

interface Tool {
  name: string;
  inputs: string[];
}

async function listTools(): Promise<Tool[]> {
  const server = mcpServer("/nonexistent/state.json");
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity", version: "0" });
  await server.connect(toServer);
  await client.connect(toClient);
  try {
    const { tools } = await client.listTools();
    return tools.map(t => ({ name: t.name, inputs: Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort() }));
  } finally {
    await client.close();
    await server.close();
  }
}

interface SkillRow {
  words: string;
  tools: Tool[];
}

/** The rows of the skill's verbs table: the command's words, and each tool it names with the inputs in its parentheses. */
export function skillRows(skill: string): SkillRow[] {
  return skill
    .split("\n")
    .filter(line => line.startsWith("| `wsp "))
    .map(line => {
      const [command, tools] = line.split(/(?<!\\)\|/).slice(1);
      const words: string[] = [];
      for (const token of command!.trim().slice("`wsp ".length).split(" ")) {
        if (/^[a-z]/.test(token)) words.push(token);
        else break;
      }
      const named: Tool[] = [];
      for (const m of tools!.matchAll(/`(\w+)`(?: \(([^)]*)\))?/g)) named.push({ name: m[1]!, inputs: m[2] === undefined ? [] : m[2].split(",").map(s => s.trim()).sort() });
      return { words: words.join(" "), tools: named };
    });
}

/** The words of a shell line: quotes and `<...>` placeholders group, `[` and `]` are dropped, and a redirect, a
 * pipe, a `&` or a `#` comment ends the line; the comment's text comes back beside the words. */
export function shellWords(line: string): { words: string[]; comment?: string } {
  const words: string[] = [];
  let word = "";
  let quote: string | undefined;
  let angle = 0;
  const flush = (): void => {
    if (word !== "") words.push(word);
    word = "";
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== undefined) {
      word += c;
      if (c === quote) quote = undefined;
      continue;
    }
    if (angle > 0) {
      word += c;
      if (c === "<") angle++;
      if (c === ">") angle--;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word += c;
      continue;
    }
    if (c === "<") {
      angle = 1;
      word += c;
      continue;
    }
    if (c === "[" || c === "]") continue;
    if (c === "#" && word === "") return { words, comment: line.slice(i + 1).trim() };
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    if (word === "" && (c === ">" || c === "&" || c === "|" || c === ";" || /^\d>/.test(line.slice(i)))) {
      return { words };
    }
    word += c;
  }
  flush();
  return { words };
}

export const ILLUSTRATIVE = "illustrative";

/** Every `wsp ...` line a reader would copy from the text: each line of a fenced block and each inline code span
 * that opens with wsp (a leading nohup dropped). An output line (`wsp <version>`), an error line (`wsp new: ...`)
 * and a fenced line whose comment says illustrative are not commands. */
export function wspCommands(text: string): string[][] {
  const candidates: string[] = [];
  const lines = text.split("\n");
  let fenced = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) candidates.push(line);
    else for (const m of line.matchAll(/`([^`]+)`/g)) candidates.push(m[1]!);
  }
  const commands: string[][] = [];
  for (const candidate of candidates) {
    const { words, comment } = shellWords(candidate.trim());
    if (words[0] === "nohup") words.shift();
    if (words[0] !== "wsp" || words.length < 2) continue;
    if (comment === ILLUSTRATIVE) continue;
    const first = words[1]!;
    if (first.startsWith("<") || first.endsWith(":")) continue;
    commands.push(words);
  }
  return commands;
}

/** Why the line does not parse against the command it names, or nothing when it does. */
export function usageError(argv: readonly string[], lines: readonly CommandLine[]): string | undefined {
  const rest = argv.slice(1);
  const command = [...lines]
    .sort((a, b) => b.words.length - a.words.length)
    .find(c => c.words.split(" ").every((w, i) => rest[i] === w)) ?? (rest[0]!.startsWith("-") ? lines.find(c => c.words === "up") : undefined);
  if (command === undefined) return `unknown command: ${argv.join(" ")}`;
  try {
    parseArgs({ args: rest.slice(command.words === "up" && rest[0]!.startsWith("-") ? 0 : command.words.split(" ").length), options: command.options, allowPositionals: true, strict: true });
    return undefined;
  } catch (e) {
    return `${argv.join(" ")}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

describe("the command line, the MCP tools and the skill are one contract", () => {
  it("every command line has a tool and a skill row, and every tool has a command line or a reason", async () => {
    const tools = await listTools();
    const rows = skillRows(WSP_SKILL);
    const toolsOf = new Map<string, Tool>(tools.map(t => [t.name, t]));
    const rowOf = new Map<string, SkillRow>(rows.map(r => [r.words, r]));
    const named = new Set<string>();
    for (const { words } of COMMAND_LINES) {
      expect(WSP_SKILL, `${words} is not in the skill`).toContain(`\`wsp ${words}`);
      if (words in CLI_ONLY) {
        expect(toolsOf.has(toolNameOf(words)), `${words} has a tool and a reason not to`).toBe(false);
        continue;
      }
      const tool = toolsOf.get(toolNameOf(words));
      expect(tool, `${words} has no MCP tool`).toBeDefined();
      named.add(tool!.name);
      const row = rowOf.get(words);
      expect(row, `${words} has no row in the skill's verbs table`).toBeDefined();
      const listed = row!.tools.find(t => t.name === tool!.name);
      expect(listed, `the row for ${words} does not name ${tool!.name}`).toBeDefined();
      expect(listed!.inputs, `${tool!.name}'s inputs in the skill`).toEqual(tool!.inputs);
    }
    for (const tool of tools) {
      if (named.has(tool.name)) continue;
      expect(TOOL_ONLY[tool.name], `${tool.name} has no command line and no reason`).toBeTruthy();
      const row = rows.find(r => r.tools.some(t => t.name === tool.name));
      expect(row, `${tool.name} is in no row of the skill's verbs table`).toBeDefined();
      expect(row!.tools.find(t => t.name === tool.name)!.inputs, `${tool.name}'s inputs in the skill`).toEqual(tool.inputs);
    }
    for (const words of Object.keys(TOOL_ONLY)) expect(toolsOf.has(words), `${words} is allow-listed but not a tool`).toBe(true);
    for (const words of Object.keys(CLI_ONLY)) expect(COMMAND_LINES.some(c => c.words === words), `${words} is allow-listed but not a command line`).toBe(true);
  });

  it("every wsp line in the skill and the instructions parses against the flags its command reads", () => {
    const commands = wspCommands(`${WSP_SKILL}\n\n${INSTRUCTIONS}`);
    expect(commands.length).toBeGreaterThan(30);
    const stale = commands.map(argv => usageError(argv, COMMAND_LINES)).filter(e => e !== undefined);
    expect(stale).toEqual([]);
    // Every command line is shown at least once, so a reader finds an example of each.
    for (const { words } of COMMAND_LINES) expect(commands.some(argv => argv.slice(1, 1 + words.split(" ").length).join(" ") === words), `no example of wsp ${words}`).toBe(true);
  });

  it("a stale flag, a renamed verb and a dropped flag value fail; an output line, an error line and an illustrative line are skipped", () => {
    const planted = [
      "```",
      "wsp recipe --tick used --pick node=on",
      "wsp threads --json   # illustrative",
      "wsp exec dev -- sh -c 'ls | wc -l' > /tmp/out 2>&1 &",
      "```",
      "Then `wsp thread new --in dev --cwd`, `wsp forkk dev`, `wsp <version>` and `wsp new: no golden yet; run wsp init`.",
    ].join("\n");
    const commands = wspCommands(planted);
    expect(commands).toEqual([
      ["wsp", "recipe", "--tick", "used", "--pick", "node=on"],
      ["wsp", "exec", "dev", "--", "sh", "-c", "'ls | wc -l'"],
      ["wsp", "thread", "new", "--in", "dev", "--cwd"],
      ["wsp", "forkk", "dev"],
    ]);
    const errors = commands.map(argv => usageError(argv, COMMAND_LINES));
    expect(errors[0]).toContain("Unknown option '--pick'");
    expect(errors[1]).toBeUndefined();
    expect(errors[2]).toContain("--cwd");
    expect(errors[3]).toBe("unknown command: wsp forkk dev");
  });

  it("reads a usage row as its words and each tool with its inputs", () => {
    const [row] = skillRows("| `wsp thread new --in <workspace> [--agent <id>] \"<task>\"` | `thread_new` (workspace, task, agent), `threads` | opens |");
    expect(row).toEqual({ words: "thread new", tools: [{ name: "thread_new", inputs: ["agent", "task", "workspace"] }, { name: "threads", inputs: [] }] });
    expect(shellWords('wsp recipe --add just="brew install just" [--set <id>=on|off] --notify <thread|me> "<the task>" # a note')).toEqual({
      words: ["wsp", "recipe", "--add", 'just="brew install just"', "--set", "<id>=on|off", "--notify", "<thread|me>", '"<the task>"'],
      comment: "a note",
    });
  });
});
