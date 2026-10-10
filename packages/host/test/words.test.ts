// SPDX-License-Identifier: AGPL-3.0-only
// A person and an agent meet projects, threads, folders, machines and subagents: the words "workspace" and "task" are
// gone from everything they read with no cloud registered, the command line's usage, about, help pages and refusal
// lines, the tools' prose and input names, the MCP server's instructions, the skill, and the section wsp writes into
// a project's AGENTS.md, and every line the host's protocol and runtime hold for those verbs to print. A machine wsp
// made is a cloud's alone, so the verbs and inputs that still take a workspace carry the cloud's mark on their entries
// and leave this build with it; "task" stays only where an agent's own background tasks are meant.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { mcpServer } from "../src/mcp.js";
import { cloudText, instructions, wspSkill } from "../src/skill.js";
import { sectionText } from "../src/agents-md.js";
import { COMMAND_LINES, COMMANDS_FOR_HELP, HELP, agentPage, commandPage, devPage, hostPage } from "../src/cli.js";
import { ALL_VERBS, CLI_VERBS, VERBS, hasTool, verbPage } from "../src/verbs.js";

const BANNED = /\b(workspaces?|tasks?)\b/i;
/** In the protocol and runtime source "task" is the agent's own word too, so only the machine's old name is held there. */
const SOURCE_BANNED = /\bworkspaces?\b/i;

const CLOUD = "the cloud's machines alone: a public build has no verb that reaches it";
const BOX_MACHINE = "a machine on a box, which no public line makes since the owner's 2026-10-08 ruling";
const BOX_ADD = "adding or joining a box with wsp add, which this change does not move";
const INIT = "wsp init, whose wizard and first machine wsp-map#1624 cuts";
const DOCTOR = "wsp doctor, which this change does not move; wsp-map#1954 rewords it";

/** Everything that may still say workspace, in one place, each with why: a word another change cuts, or a file or a
 * declaration of the protocol and runtime source (`file#name`) whose every line is printed by a road a public build
 * has no verb for. Every entry must still be read somewhere, so the list only shrinks. */
const KEPT: readonly ({ text: string; why: string } | { at: string; why: string })[] = [
  { text: "--first-workspace", why: INIT },
  { at: "packages/protocol/src/agents-report.ts#providerAgentsRefusal", why: CLOUD },
  { at: "packages/protocol/src/daemon-contract.ts#boxFullLine", why: BOX_MACHINE },
  { at: "packages/protocol/src/daemon-contract.ts#onBaseRefusal", why: CLOUD },
  { at: "packages/protocol/src/daemon-contract.ts#NOT_ON_A_BRANCH", why: CLOUD },
  { at: "packages/protocol/src/projects.ts#projectInUseRefusal", why: "wsp projects remove, which this change does not move" },
  { at: "packages/protocol/src/views/place-setup-words.ts#placeProvisioningLine", why: BOX_ADD },
  { at: "packages/protocol/src/views/place.ts#WorkspaceCopy", why: BOX_MACHINE },
  { at: "packages/protocol/src/views/place.ts#MachineShare", why: BOX_MACHINE },
  { at: "packages/protocol/src/views/place.ts#MachineBind", why: BOX_MACHINE },
  { at: "packages/protocol/src/views/preferences.ts#SSH_TICKET_REFUSAL", why: CLOUD },
  { at: "packages/protocol/src/wire/machine-link.ts", why: BOX_ADD },
  { at: "packages/protocol/src/words/computer.ts#spawnGoldenRefusal", why: CLOUD },
  { at: "packages/protocol/src/words/computer.ts#spawnRepositoryWorkspaceRefusal", why: CLOUD },
  { at: "packages/protocol/src/words/computer.ts#SPAWN_REPOSITORY_WORKSPACE_FIX", why: CLOUD },
  { at: "packages/protocol/src/words/computer.ts#spawnReachRefusal", why: CLOUD },
  { at: "packages/protocol/src/words/computer.ts#noParentWorkspaceLine", why: CLOUD },
  { at: "packages/protocol/src/words/computer.ts#parentProjectRefusal", why: CLOUD },
  { at: "packages/protocol/src/words/computer.ts#noWorkspaceRefusal", why: `${CLOUD}; a moved line names a thread, which the host reads before any record` },
  { at: "packages/protocol/src/words/computer.ts#idPrefixRefusal", why: CLOUD },
  { at: "packages/protocol/src/words/computer.ts#placeRootShellRefusal", why: BOX_ADD },
  { at: "packages/protocol/src/words/computer.ts#wakeFailedLine", why: CLOUD },
  { at: "packages/protocol/src/words/image.ts", why: CLOUD },
  { at: "packages/protocol/src/words/init.ts", why: INIT },
  { at: "packages/protocol/src/words/places.ts#placeEngineLine", why: BOX_ADD },
  { at: "packages/host/src/doctor.ts#toolsInside", why: DOCTOR },
  { at: "packages/host/src/init-job.ts#InitJobs", why: INIT },
  { at: "packages/host/src/relay.ts#startCallbackRelay", why: `${CLOUD}: the ssh road into a machine` },
  { at: "packages/host/src/verbs/workspaces-help.ts#sshWorkspaceOf", why: `${CLOUD}: wsp ssh` },
  { at: "packages/protocol/src/words/thread.ts#machineUnreachableLine", why: CLOUD },
  { at: "packages/protocol/src/words/thread.ts#execFailedLine", why: CLOUD },
  { at: "packages/protocol/src/words/thread.ts#HOSTNAME_KEPT", why: BOX_MACHINE },
  { at: "packages/protocol/src/words/thread.ts#recordRestoredLine", why: CLOUD },
  { at: "packages/protocol/src/words/thread.ts#nameTakenRefusal", why: CLOUD },
  { at: "packages/protocol/src/words/thread.ts#BLANK_NAME_REFUSAL", why: CLOUD },
  { at: "packages/protocol/src/words/thread.ts#NO_BUILD_PLACE_LINE", why: CLOUD },
  { at: "packages/protocol/src/words/thread.ts#buildPlaceAskLine", why: CLOUD },
  { at: "packages/protocol/src/words/thread.ts#placeForksNothingPickLine", why: CLOUD },
  { at: "packages/protocol/src/words/units.ts#providerFoldersRefusal", why: CLOUD },
  { at: "packages/protocol/src/workspace-state.ts#actionRefusal", why: CLOUD },
  { at: "packages/protocol/src/workspace-state.ts#CLOUD_SIGN_IN_ROAD", why: CLOUD },
  { at: "packages/protocol/src/workspace-state.ts#FORGET_NEEDS_GONE", why: CLOUD },
  { at: "packages/protocol/src/workspace-state.ts#goneRoadRefusal", why: CLOUD },
  { at: "packages/protocol/src/workspace-state.ts#goneRefusal", why: CLOUD },
];
const KEPT_TEXTS = KEPT.flatMap(k => ("text" in k ? [k.text] : []));
const KEPT_AT = KEPT.flatMap(k => ("at" in k ? [k.at] : []));

/** The banned words a piece of prose holds, outside the kept words and the agents' own background tasks. */
function banned(text: string): string[] {
  const prose = KEPT_TEXTS.reduce((t, k) => t.replaceAll(k, ""), text).replace(/\bbackground tasks?\b/gi, "");
  return [...prose.matchAll(new RegExp(BANNED.source, "gi"))].map(m => m[0]);
}

/** One line per sentence holding a banned word, with where it was read, so a failure names the line to rewrite. */
function offenders(where: string, text: string): string[] {
  return text
    .split(/(?<=[.;:])\s+|\n/)
    .filter(sentence => banned(sentence).length > 0)
    .map(sentence => `${where}: ${sentence.trim().slice(0, 200)}`);
}

interface ListedTool {
  name: string;
  prose: string[];
  inputs: string[];
}

async function listedTools(): Promise<ListedTool[]> {
  const server = mcpServer("/nonexistent/state.json", { env: {} });
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "words", version: "0" });
  await server.connect(toServer);
  await client.connect(toClient);
  try {
    const { tools } = await client.listTools();
    const fields = (schema: unknown): Record<string, { description?: string }> => (schema as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {};
    const described = (schema: unknown): string[] => Object.values(fields(schema)).map(f => f.description ?? "");
    return tools.map(t => ({ name: t.name, prose: [t.description ?? "", ...described(t.inputSchema), ...described(t.outputSchema)], inputs: Object.keys(fields(t.inputSchema)) }));
  } finally {
    await client.close();
    await server.close();
  }
}

/** The prose string literals of each verb's entry in every file of the verb table, by name, read off the source with
 * the compiler, so a refusal line is held to the words as its usage is; a literal that is a name (an op, a flag, a
 * key) is none, and a cloud span is read as this build reads it. */
function verbStrings(): Map<string, string[]> {
  const folder = fileURLToPath(new URL("../src/verbs/", import.meta.url));
  const found = new Map<string, string[]>();
  for (const name of readdirSync(folder).filter(f => f.endsWith(".ts"))) {
    const path = `${folder}${name}`;
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const texts = (node: ts.Node, into: string[]): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) into.push(node.text);
      else if (ts.isTemplateExpression(node)) into.push(node.head.text, ...node.templateSpans.map(span => span.literal.text));
      ts.forEachChild(node, child => texts(child, into));
    };
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const named = node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(file) === "name" && ts.isStringLiteral(p.initializer));
        if (named !== undefined) {
          const into: string[] = [];
          texts(node, into);
          const verb = (named.initializer as ts.StringLiteral).text;
          found.set(verb, [...(found.get(verb) ?? []), ...into.map(text => cloudText(text, false)).filter(text => !/^[\w.-]*$/.test(text))]);
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });

/** The prose literals of the protocol source, every one a line some verb or page may print, and of the runtime, the
 * engine and the host those it throws, each by `file#name` of the top-level declaration holding it. A literal that
 * is a name is none, unless it is a word a line is put together from: inside a template, a conditional or a sum. */
function sourceLines(): [string, string][] {
  const found: [string, string][] = [];
  const composes = (node: ts.Node): boolean => ts.isConditionalExpression(node.parent) || ts.isTemplateSpan(node.parent) || (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken);
  for (const [dir, thrownOnly] of [["packages/protocol/src", false], ["packages/runtime/src", true], ["packages/engine/src", true], ["packages/host/src", true]] as const) {
    for (const path of sourceFiles(join(REPO, dir))) {
      const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const at = path.slice(REPO.length);
      const visit = (node: ts.Node, named: string, thrown: boolean): void => {
        // A verb's own entry is read above as this build reads it, its cloud spans and cloud verbs dropped.
        if (at.startsWith("packages/host/src/verbs/") && ts.isObjectLiteralExpression(node) && node.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(file) === "name" && ts.isStringLiteral(p.initializer))) return;
        const declared = (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined;
        const name = named === "" && declared ? node.name!.getText(file) : named;
        const inThrow = thrown || ts.isThrowStatement(node);
        const texts = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? [node.text] : ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map(s => s.literal.text)] : [];
        if (!thrownOnly || inThrow) for (const text of texts) if (!/^[\w.:/-]*$/.test(text) || composes(node)) found.push([`${at}#${name}`, text]);
        ts.forEachChild(node, child => visit(child, name, inThrow));
      };
      ts.forEachChild(file, child => visit(child, "", false));
    }
  }
  return found;
}

const keptAt = (where: string): boolean => KEPT_AT.some(at => where === at || where.startsWith(`${at}#`));

/** Everything a person or an agent reads with no cloud registered, by where it was read. */
async function everythingRead(): Promise<[string, string][]> {
  const read: [string, string][] = [];
  const strings = verbStrings();
  const publicNames = new Set(VERBS.map(v => v.name));
  for (const verb of VERBS) {
    if ("usage" in verb) read.push([`wsp ${verb.name} usage`, verb.usage], [`wsp ${verb.name} about`, verb.about]);
    for (const text of strings.get(verb.name) ?? []) read.push([`wsp ${verb.name} source`, text]);
  }
  for (const name of strings.keys()) if (!publicNames.has(name) && !ALL_VERBS.some(v => v.name === name)) throw new Error(`verbStrings read an entry named ${name}, which is no verb`);
  for (const verb of CLI_VERBS) read.push([`wsp ${verb.name} --help`, verbPage(verb, "a host on another computer")]);
  read.push(["wsp --help", HELP], ["wsp --help agent", agentPage()], ["wsp host --help", hostPage()], ["wsp --help dev", devPage()]);
  for (const line of COMMAND_LINES) read.push([`wsp ${line.words} usage`, line.usage], [`wsp ${line.words} about`, line.about]);
  for (const [words, command] of Object.entries(COMMANDS_FOR_HELP)) read.push([`wsp ${words} --help`, commandPage(words, command)]);
  for (const tool of await listedTools()) {
    for (const text of tool.prose) read.push([`tool ${tool.name}`, text]);
    for (const input of tool.inputs) read.push([`tool ${tool.name} input`, input]);
  }
  read.push(["instructions", instructions()], ["a thread's instructions", instructions(true)]);
  read.push(["skill", wspSkill()], ["AGENTS.md section", sectionText()]);
  return read;
}

describe("the words a person and an agent read with no cloud registered", () => {
  it("never say workspace or task: every verb, page, tool, input, instruction, the skill and the AGENTS.md section", async () => {
    const found = (await everythingRead()).flatMap(([where, text]) => offenders(where, text));
    expect(found).toEqual([]);
  });

  it("keep a workspace only on the cloud's own verbs and inputs", () => {
    const takes = ALL_VERBS.filter(v => ("usage" in v && /<workspace>/.test(v.usage)) || (hasTool(v) && Object.hasOwn(v.tool.input, "workspace")));
    const unmarked = takes.filter(v => !("cloud" in v && v.cloud === true) && !("cloudFlags" in v && (v.cloudFlags ?? []).includes("workspace"))).map(v => v.name);
    expect(unmarked).toEqual([]);
    expect(takes.length).toBeGreaterThan(0);
  });

  it("never say workspace in a line the protocol holds or the runtime throws, outside the kept list", () => {
    const found = sourceLines().filter(([where, text]) => SOURCE_BANNED.test(text) && !keptAt(where));
    expect(found.map(([where, text]) => `${where}: ${text.trim().slice(0, 160)}`)).toEqual([]);
  });

  it("hold each kept word and declaration to something still read, so the list only shrinks", async () => {
    const all = (await everythingRead()).map(([, text]) => text).join("\n");
    expect(KEPT_TEXTS.filter(k => !all.includes(k))).toEqual([]);
    const lines = sourceLines();
    expect(KEPT_AT.filter(at => !lines.some(([where, text]) => (where === at || where.startsWith(`${at}#`)) && SOURCE_BANNED.test(text)))).toEqual([]);
  });

  it("catch the word where it stands, so a usage line left behind fails", () => {
    expect(banned('wsp run [<workspace>] "<task>"')).toEqual(["workspace", "task"]);
    expect(banned("a thread in `wsp workspaces` with background tasks running")).toEqual(["workspaces"]);
    expect(banned("`stop` (thread, task) by the id in the TASK column")).toEqual(["task", "TASK"]);
    expect(banned("wsp init [--first-workspace <name>]")).toEqual([]);
  });
});
