// SPDX-License-Identifier: AGPL-3.0-only
// The command line, the MCP tools and the skill are one contract: the served
// tools are the verb table under the one naming rule, every command line has
// a tool or says why not, every tool has a skill row, every list a tool takes
// is a flag the command line reads again, and every wsp line the skill or the
// instructions show parses against the flag table the command actually reads.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT } from "@wsp/catalog";
import { COORDINATOR_HANDOFF, EXIT_CODES, EXIT_WORDS, ExitClass, NOTIFY_CALLER, NOTIFY_WORDS, RuntimeRequest, SessionStartOutcome, TURN_END_WORDS, effortsFor, markedDefault, stillWorkingLine, type WorkspaceView } from "@wsp/protocol";
import { harnessCatalog } from "@wsp/runtime";
import { cli, COMMAND_LINES, HELP, HOST_FLAG, JSON_COMMANDS, PROSE_COMMANDS, SERVE_FLAGS, type CliIO, type CommandLine } from "../src/cli.js";
import { mcpServer } from "../src/mcp.js";
import { INSTRUCTIONS, RULES_HEADING, SHELL_HEADING, VERBS_HEADING, WSP_SKILL } from "../src/skill.js";
import { CLI_VERBS, COMMON, VERBS, flagList, hasTool, openingOf, toolName, type Flags } from "../src/verbs.js";

interface Tool {
  name: string;
  description?: string;
  inputs: string[];
  outputs: string[];
  /** Every line of prose the tool serves: its own description and the description on each input and output field.
   * Absent on a tool read off the skill's table, which carries no prose. */
  prose?: string[];
  /** The inputs the served schema types as a list. Absent on a tool read off the skill's table, which carries no types. */
  arrays?: string[];
}

async function listTools(): Promise<Tool[]> {
  const server = mcpServer("/nonexistent/state.json", { env: {} });
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity", version: "0" });
  await server.connect(toServer);
  await client.connect(toClient);
  try {
    const { tools } = await client.listTools();
    const fields = (schema: unknown): Record<string, { description?: string; type?: string }> => (schema as { properties?: Record<string, { description?: string; type?: string }> } | undefined)?.properties ?? {};
    const keys = (schema: unknown): string[] => Object.keys(fields(schema)).sort();
    const described = (schema: unknown): string[] => Object.values(fields(schema)).map(field => field.description ?? "");
    const listed = (schema: unknown): string[] =>
      Object.entries(fields(schema))
        .filter(([, field]) => field.type === "array")
        .map(([name]) => name)
        .sort();
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      inputs: keys(t.inputSchema),
      outputs: keys(t.outputSchema),
      prose: [t.description ?? "", ...described(t.inputSchema), ...described(t.outputSchema)],
      arrays: listed(t.inputSchema),
    }));
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
      // A row whose command takes no argument closes its code span on the last word, so the backtick comes off before
      // the word is read.
      for (const token of command!.trim().slice("`wsp ".length).split(" ")) {
        const word = token.replace(/`$/, "");
        if (/^[a-z]+$/.test(word)) words.push(word);
        else break;
      }
      const named: Tool[] = [];
      for (const m of tools!.matchAll(/`(\w+)`(?: \(([^)]*)\))?/g)) named.push({ name: m[1]!, inputs: m[2] === undefined ? [] : m[2].split(",").map(s => s.trim()).sort(), outputs: [] });
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

/** Every list a tool takes, against how the command line carries the same list: the flag a person types again for
 * each value, or why that command reads the values another way. A flag that takes one value where the wire wants a
 * list sends a string and the start is refused before the thread opens, so a new list input belongs here the day it
 * is added. */
const LISTS_ON_THE_COMMAND_LINE: Record<string, string> = {
  "threads wait threads": "the threads are the words after the verb",
  "exec argv": "the command is the words after the verb",
  "import agents": "the catalog ids are one comma-joined value of --agents",
  "export agents": "the catalog ids are one comma-joined value of --agents",
  "recipe scan project": "--project",
  "recipe set": "--set",
  "recipe signin": "--signin",
  "recipe add": "--add",
  "recipe add_check": "--add-check",
  "recipe project": "--project",
  "fork notify": "--notify",
  "thread new notify": "--notify",
  "thread new images": "--image",
  "send images": "--image",
  "import keep": "--keep",
  "import cut": "--cut",
};

describe("the command line, the MCP tools and the skill are one contract", () => {
  it("the served tools are the verb table, one per entry under the naming rule, and the table's inputs are what is served", async () => {
    const tools = await listTools();
    const served = VERBS.filter(hasTool);
    expect(tools.map(t => t.name).sort()).toEqual(served.map(v => toolName(v.name)).sort());
    for (const verb of served) expect(tools.find(t => t.name === toolName(verb.name))!.inputs, verb.name).toEqual(Object.keys(verb.tool.input).sort());
    expect(toolName("thread new")).toBe("thread_new");
  });

  it("every served tool carries an output schema with the entry's fields, so a verb cannot ship without saying what it answers with", async () => {
    for (const tool of await listTools()) {
      const entry = VERBS.filter(hasTool).find(v => toolName(v.name) === tool.name)!;
      expect(tool.outputs.length, `${tool.name} serves no output schema`).toBeGreaterThan(0);
      expect(tool.outputs, tool.name).toEqual(Object.keys(entry.tool.output).sort());
    }
  });

  it("the skill's contract section, the help and the repo's AGENTS.md name exactly the exit codes the protocol exports, in its words", () => {
    const rows = WSP_SKILL.split("\n")
      .filter(line => /^\| \d+ \| `\w+` \|/.test(line))
      .map(line => line.split("|").slice(1, -1).map(cell => cell.trim()))
      .map(([code, cls, when]) => ({ code: Number(code), cls: cls!.replaceAll("`", ""), when }));
    expect(rows.map(r => [r.cls, r.code])).toEqual(Object.entries(EXIT_CODES));
    for (const row of rows) expect(row.when, row.cls).toBe(EXIT_WORDS[ExitClass.parse(row.cls)]);
    const help = HELP.replace(/\s+/g, " ");
    const agents = readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    for (const cls of ExitClass.options) {
      expect(help).toContain(`${EXIT_CODES[cls]} ${cls}`);
      expect(agents).toContain(`${EXIT_CODES[cls]} ${cls}`);
    }
    // One section says it, once: the skill names the codes in the table alone and nowhere as a bare "exit 1".
    for (const text of [WSP_SKILL, HELP]) expect(text.match(/\bexits? [0-9]\b/g) ?? []).toEqual([]);
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
    expect(COMMAND_LINES.filter(c => "cliOnly" in c).map(c => c.words).sort()).toEqual([
      "add",
      "doctor",
      "down",
      "host clients",
      "host clients revoke",
      "host connect",
      "host default",
      "host devices",
      "host devices revoke",
      "host forget",
      "host link",
      "host linked",
      "host list",
      "host pair",
      "host unlink",
      "image export",
      "init",
      "join",
      "leave",
      "mcp",
      "mcp install",
      "remove",
      "status",
      "up",
    ]);
    // Every tool has a command line of its own: the seam above still holds a tool that has none to a stated reason.
    expect(VERBS.filter(v => "toolOnly" in v).map(v => v.name)).toEqual([]);
  });

  it("every command line is a verb table entry or a command carrying why it has no tool, so a new command sits in neither only by failing here", () => {
    for (const line of COMMAND_LINES) {
      if ("tool" in line) expect(CLI_VERBS.some(v => v.name === line.words), `${line.words} names a tool but is not in the verb table`).toBe(true);
      else expect(line.cliOnly, `${line.words} carries no reason for having no tool`).toMatch(/\S/);
    }
    for (const verb of CLI_VERBS) expect(COMMAND_LINES.find(c => c.words === verb.name && ("cliOnly" in verb ? "cliOnly" in c : "tool" in c)), `${verb.name} is in the table and not in the command lines`).toBeDefined();
    for (const words of [...JSON_COMMANDS, ...PROSE_COMMANDS]) expect(COMMAND_LINES.find(c => c.words === words && "cliOnly" in c), `${words} is a command with no reason in the command lines`).toBeDefined();
  });

  it("every wsp line in the skill, the instructions and the tool descriptions parses against the flags its command reads", () => {
    const commands = wspCommands([WSP_SKILL, INSTRUCTIONS, ...VERBS.filter(hasTool).map(v => v.tool.description)].join("\n\n"));
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

  it("a line of two words or more advertises the flags its first word reads, so the usage table refuses what a terminal refuses", async () => {
    // --host is one key in the shared parse, and the command line refuses it on a word that runs here. A line whose
    // flags were written out beside it advertised the flag anyway, and this table is what every skill example is
    // held to, so the example would pass the gate and fail at a terminal.
    const refused = usageError(["wsp", "host", "default", "box", "--host", "box"], COMMAND_LINES) ?? "the usage table takes --host on wsp host default";
    expect(refused).toContain("Unknown option '--host'");
    const errors: string[] = [];
    const io: CliIO = { log: () => {}, error: line => errors.push(line), ask: () => Promise.reject(new Error("no prompt")), askSecret: () => Promise.reject(new Error("no prompt")) };
    expect(await cli(["host", "default", "box", "--host", "box"], io)).toBe(EXIT_CODES.usage);
    expect(errors[0]).toContain("Unknown option '--host' for wsp host default");
    // Every line the shared parse serves, one word or several, advertises exactly what its command answers. The
    // words that take the flag are the ones aimed at a host over there and the two that run at its own terminal:
    // only the ones that refuse it outright leave it out.
    for (const line of COMMAND_LINES) {
      const word = line.words.split(" ")[0]!;
      // A verb serves itself, flags and all; only the lines the shared parse serves are held to their command's table.
      if (!("cliOnly" in line) || word === "mcp" || CLI_VERBS.some(v => v.name === line.words)) continue;
      // The command a line selects is the longest key that opens it, which is what the parse itself reads.
      const key = Object.keys(HOST_FLAG).filter(k => k.split(" ").every((w, i) => line.words.split(" ")[i] === w)).sort((a, b) => b.length - a.length)[0]!;
      expect(Object.hasOwn(line.options, "host"), `wsp ${line.words} advertises --host`).toBe(HOST_FLAG[key] !== "refused");
      expect(Object.hasOwn(line.options, "json"), `wsp ${line.words} advertises --json`).toBe(JSON_COMMANDS.includes(key));
    }
  });

  it("the help's --host rule names the two words that take the flag to say where to run, and no word that refuses it", () => {
    // The block is prose deciding what the declaration decides, which is how it came to promise a refusal to eight
    // words while calling four of them lines that start or stop something. Its last sentence is held to the table
    // word by word, so a word that changes what it does with the flag cannot leave the help saying the old thing.
    const block = HELP.slice(HELP.indexOf("  --host ALIAS"), HELP.indexOf("  --code CODE"));
    const opener = "lines that read this computer's own files refuse it";
    expect(block, "the --host block states the rule in the declaration's own words").toContain(opener);
    const rule = block.slice(block.indexOf(opener)).replace(/\s+/g, " ");
    for (const [word, flag] of Object.entries(HOST_FLAG)) {
      expect(rule.includes(`wsp ${word}`), `wsp ${word} named in the --host rule`).toBe(flag === "hostSide");
    }
  });

  it("every flag that shapes a serving host is in the help and in the skill, so a row added to the table is a word a person can read", () => {
    // The table drives the parse and the unit wsp up --service writes, so a row added is read and travels; without
    // this, it would do both and be named nowhere a person or an agent looks.
    for (const flag of SERVE_FLAGS) {
      expect(HELP, `--${flag.name} in wsp --help`).toMatch(new RegExp(`--${flag.name}\\b`));
      expect(WSP_SKILL, `--${flag.name} in the skill`).toMatch(new RegExp(`--${flag.name}\\b`));
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
      "wsp thread new reads --detach, which its row does not show",
      "wsp thread new reads --effort, which its row does not show",
      "wsp thread new reads --image, which its row does not show",
      "wsp thread new reads --model, which its row does not show",
      "wsp thread new reads --project, which its row does not show",
      "wsp thread new reads --title, which its row does not show",
      "wsp send reads --access, which its row does not show",
      "wsp send reads --detach, which its row does not show",
      "wsp send reads --effort, which its row does not show",
      "wsp send reads --image, which its row does not show",
      "wsp send reads --model, which its row does not show",
    ]);
    expect(flagDrift(stale.replace("| `wsp stop <thread>`", "| `wsp stop <thread> [--now]`"), COMMAND_LINES)).toContain("the row for wsp stop shows --now, which it does not read");
  });

  it("every list a tool takes is a flag the command line reads again, or a command that reads its values another way", async () => {
    const carried = new Set<string>();
    for (const tool of await listTools()) {
      const line = COMMAND_LINES.find(c => "tool" in c && c.tool === tool.name);
      if (line === undefined) continue;
      for (const input of tool.arrays!) {
        const key = `${line.words} ${input}`;
        const how = LISTS_ON_THE_COMMAND_LINE[key];
        expect(how, `${tool.name} takes ${input} as a list and nothing says how wsp ${line.words} carries it`).toMatch(/\S/);
        carried.add(key);
        if (!how!.startsWith("--")) continue;
        const option = line.options[how!.slice(2)] as { multiple?: boolean } | undefined;
        expect(option, `wsp ${line.words} does not read ${how}`).toBeDefined();
        expect(option!.multiple, `wsp ${line.words} reads ${how} as one value where ${tool.name} takes a list`).toBe(true);
      }
    }
    expect([...carried].sort()).toEqual(Object.keys(LISTS_ON_THE_COMMAND_LINE).sort());
  });

  it("a --notify typed once and a --notify typed again both reach the start as an array of targets, the one shape the protocol takes", () => {
    // notifyOf resolves each reference and keeps the count, so what is under test here is the flag table and the
    // reader over it: a lone value passed through as a string is refused before the thread opens.
    const workspace = { id: "ws_notify" } as WorkspaceView;
    const cases: ReadonlyArray<[string, string[], string[]]> = [
      ["thread new", ["--notify", "me", "build it"], ["me"]],
      ["thread new", ["--notify", "me", "--notify", "1a2b3c4d", "build it"], ["me", "1a2b3c4d"]],
      ["fork", ["alpha", "--send", "build it", "--notify", "me"], ["me"]],
      ["fork", ["alpha", "--send", "build it", "--notify", "me", "--notify", "1a2b3c4d"], ["me", "1a2b3c4d"]],
    ];
    for (const [words, argv, targets] of cases) {
      const typed = `wsp ${words} ${argv.join(" ")}`;
      const entry = CLI_VERBS.find(v => v.name === words)!;
      const { values } = parseArgs({ args: argv, options: { ...COMMON, ...entry.options }, allowPositionals: true });
      const notify = flagList(values as Flags, "notify");
      expect(notify, typed).toEqual(targets);
      const start = openingOf({}, workspace, "build it", { notify });
      expect(start["notify"], typed).toEqual(targets);
      const wire = RuntimeRequest.safeParse({ id: "1", op: "sessions.start", ...start });
      expect(wire.success ? [] : wire.error.issues, typed).toEqual([]);
    }
  });

  it("the --effort words the thread_new tool and the skill name are the picker's options for the default agent, and the default they say runs is the one the picker marks", () => {
    const claude = harnessCatalog(DEFAULT_AGENT.id)!;
    const options = effortsFor(claude, markedDefault(claude.models) ?? null);
    const words = options.map(o => o.value);
    const fallback = markedDefault(options)!.value;
    const effort = VERBS.filter(hasTool).find(v => v.name === "thread new")!.tool.input.effort!.description!;
    expect(/\(([^)]*)\)/.exec(effort)![1]!.split(", ")).toEqual(words);
    expect(effort).toContain(`absent means the agent's default, ${fallback} for ${claude.harness}`);
    expect(WSP_SKILL).toContain(words.map(w => `\`${w}\``).join(", "));
    expect(WSP_SKILL).toContain(`(\`${fallback}\` for ${claude.harness})`);
  });

  it("what a send meets on a running or a replied thread is said in the runtime's words, the same in the skill's send section and the send tool", async () => {
    const tool = (await listTools()).find(t => t.name === "send")!.description!;
    const section = WSP_SKILL.slice(WSP_SKILL.indexOf("### send"), WSP_SKILL.indexOf("### stop"));
    for (const text of [tool, section]) {
      for (const outcome of SessionStartOutcome.options) expect(text, outcome).toContain(`(outcome \`${outcome}\`)`);
      expect(text).toContain(`\`${stillWorkingLine()}\``);
    }
  });

  it("the verb that blocks is a shell script's on every door: its row sits under the shell heading and not in the agent rows, and both roads to a child's end are named in the skill's rules, the instructions and the wait tool", async () => {
    const rows = (from: string, to: string): SkillRow[] => skillRows(WSP_SKILL.slice(WSP_SKILL.indexOf(from), WSP_SKILL.indexOf(to)));
    const named = (list: readonly SkillRow[]): string[] => list.flatMap(r => r.tools.map(t => t.name));
    // The table an agent reads names every tool but the one that blocks; the shell section names that one.
    expect(named(rows(VERBS_HEADING, SHELL_HEADING))).not.toContain("threads_wait");
    expect(named(rows(SHELL_HEADING, RULES_HEADING))).toEqual(["threads_wait"]);
    // One home for each of the two sentences: the rules an agent holding only the tools reads, and the tool itself.
    const wait = (await listTools()).find(t => t.name === "threads_wait")!.description!;
    for (const words of [NOTIFY_CALLER, COORDINATOR_HANDOFF]) {
      expect(WSP_SKILL, words.slice(0, 40)).toContain(words);
      expect(INSTRUCTIONS, words.slice(0, 40)).toContain(words);
      expect(wait, words.slice(0, 40)).toContain(words);
    }
    // The tool says whose verb it is, so an agent reading the tool alone does not take the blocking road.
    expect(wait).toContain("it is for a shell script and not for your own conversation");
  });

  it("no tool sends an agent to the blocking wait or says a send is refused, in its description or on any of its fields", async () => {
    const tools = await listTools();
    for (const tool of tools) {
      if (tool.name === "threads_wait") continue;
      const text = tool.prose!.join(" ");
      expect(text, `${tool.name} names the wait`).not.toMatch(/threads.wait/);
      expect(text, `${tool.name} says a send is refused`).not.toMatch(/send is refused|refused with `?thread/);
    }
    // The verb that owns the wait still says what it is: the fact has one home rather than none.
    expect(tools.find(t => t.name === "threads_wait")!.description).toContain("it is for a shell script and not for your own conversation");
  });

  it("when a turn ends and when the notify line goes are the runtime's words in every door: the skill, the thread_new tool and the help; the wait tool says the wait is the notify line's", async () => {
    const tools = await listTools();
    const tool = tools.find(t => t.name === "thread_new")!.description!;
    expect(tools.find(t => t.name === "threads_wait")!.description).toContain("the one line a notify sends");
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
    expect(row).toEqual({ words: "thread new", flags: ["agent", "in"], tools: [{ name: "thread_new", inputs: ["agent", "task", "workspace"], outputs: [] }, { name: "threads", inputs: [], outputs: [] }] });
    expect(shellWords('wsp recipe --add just="brew install just" [--set <id>=on|off] --notify <thread|me> "<the task>" # a note')).toEqual({
      words: ["wsp", "recipe", "--add", 'just="brew install just"', "--set", "<id>=on|off", "--notify", "<thread|me>", '"<the task>"'],
      comment: "a note",
    });
  });
});
