// SPDX-License-Identifier: AGPL-3.0-only
// The command line, the MCP tools and the skill are one contract: the served
// tools are the verb table under the one naming rule, every command line has
// a tool or says why not, every tool has a skill row, and every wsp line the
// skill or the instructions show parses against the flag table the command
// actually reads.
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { NOTIFY_WORDS, SessionStartOutcome, TURN_END_WORDS, stillWorkingRefusal } from "@wsp/protocol";
import { COMMAND_LINES, HELP, JSON_COMMANDS, PROSE_COMMANDS, type CommandLine } from "../src/cli.js";
import { mcpServer } from "../src/mcp.js";
import { INSTRUCTIONS, WSP_SKILL } from "../src/skill.js";
import { CLI_VERBS, COMMON, VERBS, toolName } from "../src/verbs.js";

interface Tool {
  name: string;
  description?: string;
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
    return tools.map(t => ({ name: t.name, description: t.description, inputs: Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort() }));
  } finally {
    await client.close();
    await server.close();
  }
}

interface SkillRow {
  words: string;
  /** The `--flag` names the command cell shows, each once, sorted. */
  flags: string[];
  tools: Tool[];
}

/** The `--flag` names a line of usage shows, each once, sorted; a bare `--` is not one. */
const flagsOf = (text: string): string[] => [...new Set([...text.matchAll(/--([a-z][a-z-]*)/g)].map(m => m[1]!))].sort();

/** The rows of the skill's verbs table: the command's words, its flags, and each tool it names with the inputs in its
 * parentheses. */
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
      return { words: words.join(" "), flags: flagsOf(command!), tools: named };
    });
}

/** The flags a command reads beside the ones every command takes. */
const ownFlags = (options: CommandLine["options"]): string[] => Object.keys(options).filter(name => !Object.hasOwn(COMMON, name)).sort();

/** Where the skill's verbs table and the flag tables disagree, one line each: a flag the command reads that its row
 * does not show, or one the row shows that the command refuses. Nothing when every row matches. */
export function flagDrift(skill: string, lines: readonly CommandLine[]): string[] {
  const rowOf = new Map(skillRows(skill).map(r => [r.words, r]));
  const drift: string[] = [];
  for (const { words, options } of lines) {
    const row = rowOf.get(words);
    if (row === undefined) continue;
    const shown = row.flags.filter(name => !Object.hasOwn(COMMON, name));
    for (const name of ownFlags(options)) if (!shown.includes(name)) drift.push(`wsp ${words} reads --${name}, which its row does not show`);
    for (const name of shown) if (!Object.hasOwn(options, name)) drift.push(`the row for wsp ${words} shows --${name}, which it does not read`);
  }
  return drift;
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
  it("the served tools are the verb table, one per entry under the naming rule, and the table's inputs are what is served", async () => {
    const tools = await listTools();
    expect(tools.map(t => t.name).sort()).toEqual(VERBS.map(v => toolName(v.name)).sort());
    for (const verb of VERBS) expect(tools.find(t => t.name === toolName(verb.name))!.inputs, verb.name).toEqual(Object.keys(verb.tool.input).sort());
    expect(toolName("thread new")).toBe("thread_new");
  });

  it("every command line has a tool or says why not, every tool has a skill row naming its inputs, and a tool with no command line says why", async () => {
    const tools = await listTools();
    const rows = skillRows(WSP_SKILL);
    const toolsOf = new Map<string, Tool>(tools.map(t => [t.name, t]));
    const rowOf = new Map<string, SkillRow>(rows.map(r => [r.words, r]));
    const named = new Set<string>();
    for (const line of COMMAND_LINES) {
      const { words } = line;
      expect(WSP_SKILL, `${words} is not in the skill`).toContain(`\`wsp ${words}`);
      if ("cliOnly" in line) {
        expect(line.cliOnly, `${words} says why it has no tool`).toMatch(/\S/);
        expect(toolsOf.has(toolName(words)), `${words} has a tool and a reason not to`).toBe(false);
        continue;
      }
      const tool = toolsOf.get(line.tool);
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
      const entry = VERBS.find(v => toolName(v.name) === tool.name);
      expect(entry !== undefined && "toolOnly" in entry && /\S/.test(entry.toolOnly), `${tool.name} has no command line and no reason`).toBe(true);
      const row = rows.find(r => r.tools.some(t => t.name === tool.name));
      expect(row, `${tool.name} is in no row of the skill's verbs table`).toBeDefined();
      expect(row!.tools.find(t => t.name === tool.name)!.inputs, `${tool.name}'s inputs in the skill`).toEqual(tool.inputs);
    }
    expect(COMMAND_LINES.filter(c => "cliOnly" in c).map(c => c.words).sort()).toEqual(["doctor", "down", "init", "mcp", "mcp install", "status", "up"]);
    expect(VERBS.filter(v => "toolOnly" in v).map(v => v.name)).toEqual(["workspaces"]);
  });

  it("every command line is a verb table entry or a command carrying why it has no tool, so a new command sits in neither only by failing here", () => {
    for (const line of COMMAND_LINES) {
      if ("tool" in line) expect(CLI_VERBS.some(v => v.name === line.words), `${line.words} names a tool but is not in the verb table`).toBe(true);
      else expect(line.cliOnly, `${line.words} carries no reason for having no tool`).toMatch(/\S/);
    }
    for (const verb of CLI_VERBS) expect(COMMAND_LINES.find(c => c.words === verb.name && "tool" in c), `${verb.name} is in the table and not in the command lines`).toBeDefined();
    for (const words of [...JSON_COMMANDS, ...PROSE_COMMANDS]) expect(COMMAND_LINES.find(c => c.words === words && "cliOnly" in c), `${words} is a command with no reason in the command lines`).toBeDefined();
  });

  it("every wsp line in the skill, the instructions and the tool descriptions parses against the flags its command reads", () => {
    const commands = wspCommands([WSP_SKILL, INSTRUCTIONS, ...VERBS.map(v => v.tool.description)].join("\n\n"));
    expect(commands.length).toBeGreaterThan(30);
    const stale = commands.map(argv => usageError(argv, COMMAND_LINES)).filter(e => e !== undefined);
    expect(stale).toEqual([]);
    // Every command line is shown at least once, so a reader finds an example of each.
    for (const { words } of COMMAND_LINES) expect(commands.some(argv => argv.slice(1, 1 + words.split(" ").length).join(" ") === words), `no example of wsp ${words}`).toBe(true);
    // A subcommand's word after a flag (wsp recipe --json scan) is the parent's line with a stray positional, refused
    // at the terminal, so no example may spell it that way.
    for (const argv of commands) {
      const line = [...COMMAND_LINES].sort((a, b) => b.words.length - a.words.length).find(c => c.words.split(" ").every((w, i) => argv[1 + i] === w));
      if (line === undefined) continue;
      const deeper = COMMAND_LINES.filter(c => c.words.startsWith(`${line.words} `)).map(c => c.words.split(" ").at(-1)!);
      const rest = argv.slice(1 + line.words.split(" ").length).filter(w => !w.startsWith("-"));
      expect(rest.filter(w => deeper.includes(w)), `${argv.join(" ")} puts a flag before the subcommand`).toEqual([]);
    }
  });

  it("every flag a command reads is in its row of the skill's verbs table and the row shows no other; every verb's usage names only flags it reads", () => {
    expect(flagDrift(WSP_SKILL, COMMAND_LINES)).toEqual([]);
    for (const verb of CLI_VERBS) for (const name of flagsOf(verb.usage)) expect(Object.hasOwn(verb.options, name), `wsp ${verb.name}'s usage names --${name}`).toBe(true);
    // The rows the skill carried while thread new and send already read the three picks: each missing pick is named.
    const stale = WSP_SKILL.split("\n")
      .map(line => {
        if (line.startsWith("| `wsp thread new ")) return '| `wsp thread new --in <workspace> [--agent <id>] [--cwd <path>] [--notify <thread\\|me>] "<task>"` | `thread_new` (workspace, task, agent, cwd, notify) | opens |';
        if (line.startsWith("| `wsp send ")) return '| `wsp send <thread> "<message>"` | `send` (thread, message) | a message |';
        return line;
      })
      .join("\n");
    expect(flagDrift(stale, COMMAND_LINES)).toEqual([
      "wsp thread new reads --access, which its row does not show",
      "wsp thread new reads --effort, which its row does not show",
      "wsp thread new reads --model, which its row does not show",
      "wsp send reads --access, which its row does not show",
      "wsp send reads --effort, which its row does not show",
      "wsp send reads --model, which its row does not show",
    ]);
    expect(flagDrift(stale.replace("| `wsp stop <thread>`", "| `wsp stop <thread> [--now]`"), COMMAND_LINES)).toContain("the row for wsp stop shows --now, which it does not read");
  });

  it("what a send meets on a running or a replied thread is said in the runtime's words, the same in the skill's send section and the send tool", async () => {
    const tool = (await listTools()).find(t => t.name === "send")!.description!;
    const section = WSP_SKILL.slice(WSP_SKILL.indexOf("### send"), WSP_SKILL.indexOf("### stop"));
    for (const text of [tool, section]) {
      for (const outcome of SessionStartOutcome.options) expect(text, outcome).toContain(`(outcome \`${outcome}\`)`);
      expect(text).toContain(`\`${stillWorkingRefusal("1a2b3c4d-0000")}\``);
    }
  });

  it("when a turn ends and when the notify line goes are the runtime's words in every door: the skill, the thread_new tool and the help", async () => {
    const tool = (await listTools()).find(t => t.name === "thread_new")!.description!;
    for (const text of [tool, WSP_SKILL]) {
      expect(text).toContain(TURN_END_WORDS);
      expect(text).toContain(NOTIFY_WORDS);
    }
    // The help wraps the sentence at 80 columns, so it is read with its line breaks folded.
    const help = HELP.replace(/\s+/g, " ");
    expect(help).toContain(TURN_END_WORDS);
    for (const text of [tool, WSP_SKILL, help]) expect(text).not.toMatch(/when the (first )?turn ends/);
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
    expect(row).toEqual({ words: "thread new", flags: ["agent", "in"], tools: [{ name: "thread_new", inputs: ["agent", "task", "workspace"] }, { name: "threads", inputs: [] }] });
    expect(shellWords('wsp recipe --add just="brew install just" [--set <id>=on|off] --notify <thread|me> "<the task>" # a note')).toEqual({
      words: ["wsp", "recipe", "--add", 'just="brew install just"', "--set", "<id>=on|off", "--notify", "<thread|me>", '"<the task>"'],
      comment: "a note",
    });
  });
});
