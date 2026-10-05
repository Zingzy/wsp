// SPDX-License-Identifier: AGPL-3.0-only
// The cloud behind one flag. Off, nothing a person or an agent reads names a
// cloud, and every line that only means something on one refuses in one
// sentence naming the flag; on, every one of them is there as it always was.
// The file runs in both: the node project has the flag off and the cloud
// project in vitest.workspace.ts has it on.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { CLOUD_ENV, EXIT_CODES } from "@wsp/protocol";
import { agentPage, cli, HELP, type CliIO } from "../src/cli.js";
import type { RunningWsp } from "../src/mcp-install.js";
import { mcpServer } from "../src/mcp.js";
import { CLOUD_ON } from "../src/cloud.js";
import { PROVIDER_MODULES } from "../src/providers.js";
import { CLOUD_MARK, CLOUD_SPAN_END, instructions, NO_CLOUD_MARK, NO_CLOUD_SPAN_END, skillFor, wspSkill } from "../src/skill.js";
import { CLI_VERBS, VERBS, verbPage } from "../src/verbs.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const captured = (): CliIO & { lines: string[]; errors: string[] } => {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: l => lines.push(l), error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt };
};

/** Every word a cloud goes by: the two providers, the one's product and the other's company. */
const CLOUD_WORDS = ["Solari", "ASCII", "Boat"];

/** Where the word cloud stands with the cloud off, each with why. */
const CLOUD_ALLOWED: string[] = [
  // A project's glyph by name, in every schema that carries a workspace's look: a picture of a cloud, not a provider.
  '"cloud","globe"',
  // A computer's icon by name, the same picture on a computer's own row.
  '"server","cloud","cpu"',
  // The wire's word for a workspace on a provider's machine, in the schemas that carry a workspace: no record with the
  // cloud off holds it, and a wire value is not renamed by a flag.
  '"enum":["cloud","local"]',
];

/** The tool list as an agent reads it: every name, description and field description. */
async function toolList(): Promise<{ names: string[]; text: string; inputs: Record<string, string[]> }> {
  const server = mcpServer("/nonexistent/state.json", { env: {} });
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cloud", version: "0" });
  await server.connect(toServer);
  await client.connect(toClient);
  try {
    const { tools } = await client.listTools();
    return {
      names: tools.map(t => t.name),
      text: JSON.stringify(tools),
      inputs: Object.fromEntries(tools.map(t => [t.name, Object.keys((t.inputSchema as { properties?: object }).properties ?? {})])),
    };
  } finally {
    await client.close();
  }
}

const PROC: RunningWsp = { execPath: "/opt/node/bin/node", execArgv: [], argv: ["/opt/node/bin/node", "/opt/wsp/dist/bin.js"], version: "0.1.2", PATH: "/usr/bin:/bin" };

const say = async (...argv: string[]): Promise<{ code: number; io: ReturnType<typeof captured> }> => {
  const io = captured();
  const code = await cli(argv, io, PROC, { HOME: "/nonexistent" }, false);
  return { code, io };
};

/** Every line that only means something on a provider, as a person types it. */
const CLOUD_LINES = [
  ["snapshot", "w"],
  ["fork", "w"],
  ["rebuild", "w"],
  ["image", "build", "somewhere"],
  ["image", "move", "w"],
  ["image", "remove", "snap-1"],
  ["image", "export", "/tmp/image.wsp"],
  ["add", "solari"],
  ["add", "box"],
  ["init", "--provider", "solari"],
  ["up", "--provider", "box"],
];

/** The tools those lines are served as. */
const CLOUD_TOOLS = ["snapshot", "fork", "rebuild", "image_build", "image_move", "image_remove"];

describe.runIf(!CLOUD_ON)("with the cloud off", () => {
  it("registers neither cloud", () => {
    expect(PROVIDER_MODULES.map(m => m.id)).toEqual(["fake", "none"]);
  });

  it("refuses on the row with no machine by what is missing, naming no line the flag refuses", async () => {
    const refused = await PROVIDER_MODULES.at(-1)!.build({}).create({} as never).catch((e: unknown) => (e as Error).message);
    expect(refused).not.toContain("<provider>");
    expect(refused).toContain("wsp add user@host");
  });

  it("no page, tool, skill line or instruction names a cloud", async () => {
    const tools = await toolList();
    const read = { "wsp --help": HELP, "wsp --help agent": agentPage(), "wsp computers set --help": verbPage(CLI_VERBS.find(v => v.name === "computers set")!, ""), "the tool list": tools.text, "the skill": wspSkill(), "the instructions": instructions() };
    const named = Object.entries(read).flatMap(([where, text]) => CLOUD_WORDS.filter(word => text.includes(word)).map(word => `${where}: ${word}`));
    expect(named).toEqual([]);
  });

  it("no page, tool, skill line or instruction says cloud, but for the uses allowed here", async () => {
    const tools = await toolList();
    const read = { "wsp --help": HELP, "wsp --help agent": agentPage(), "wsp computers set --help": verbPage(CLI_VERBS.find(v => v.name === "computers set")!, ""), "the tool list": tools.text, "the skill": wspSkill(), "the instructions": instructions() };
    const said = Object.entries(read).flatMap(([where, text]) =>
      [...text.matchAll(/[^.\n]*\bclouds?\b[^.\n]*/gi)].map(m => m[0].trim()).filter(line => !CLOUD_ALLOWED.some(allowed => line.includes(allowed))).map(line => `${where}: ${line}`),
    );
    expect(said).toEqual([]);
  });

  it("serves none of the provider's tools", async () => {
    const tools = await toolList();
    expect(tools.names.filter(name => CLOUD_TOOLS.includes(name))).toEqual([]);
  });

  it("prints none of the provider's lines on a page", () => {
    const page = agentPage();
    for (const words of ["snapshot", "fork", "rebuild", "image build", "image move", "image remove", "image export"]) expect(page).not.toContain(`wsp ${words}`);
    expect(page).not.toContain("--from <project image>");
    expect(HELP).not.toContain("cloud");
  });

  it.each(CLOUD_LINES)("wsp %s refuses in one sentence naming the flag", async (...argv) => {
    const { code, io } = await say(...argv);
    expect(io.errors).toHaveLength(1);
    expect(io.errors[0]).toContain(`${CLOUD_ENV}=1`);
    expect(code).toBe(EXIT_CODES.usage);
  });
});

describe.runIf(CLOUD_ON)("with the cloud on", () => {
  it("registers both clouds", () => {
    expect(PROVIDER_MODULES.map(m => m.id)).toEqual(["fake", "box", "solari", "none"]);
  });

  it("serves every one of the provider's tools", async () => {
    const tools = await toolList();
    expect(CLOUD_TOOLS.filter(name => !tools.names.includes(name))).toEqual([]);
  });

  it("answers every one of the provider's lines", () => {
    for (const words of ["snapshot", "fork", "rebuild", "image build", "image move", "image remove", "image export"]) expect(CLI_VERBS.map(v => v.name)).toContain(words);
    expect(agentPage()).toContain("wsp snapshot");
    expect(HELP).toContain("each cloud account");
  });

  it("reads the skill as it always was, the marks gone", () => {
    expect(wspSkill()).toContain("SOLARI_API_KEY");
    expect(wspSkill()).not.toContain(CLOUD_MARK);
    expect(wspSkill()).not.toContain(CLOUD_SPAN_END);
    expect(wspSkill()).not.toContain(NO_CLOUD_MARK);
    expect(wspSkill()).not.toContain("with none joined this run builds nothing");
  });
});

describe("the skill's cloud marks", () => {
  const skill = ["# t", "a line", "only on a cloud " + CLOUD_MARK, `both ${CLOUD_MARK}cloud ${CLOUD_SPAN_END}${NO_CLOUD_MARK}local ${NO_CLOUD_SPAN_END}ways`, `## cloud part ${CLOUD_MARK}`, "under it", "```", "# not a heading", "```", "### deeper", "## next", "kept"].join("\n");

  it("keeps the text and drops the marks with the cloud on", () => {
    expect(skillFor(skill, true)).toBe(["# t", "a line", "only on a cloud", "both cloud ways", "## cloud part", "under it", "```", "# not a heading", "```", "### deeper", "## next", "kept"].join("\n"));
  });

  it("drops a marked line, a marked span and a marked heading's whole section with it off", () => {
    expect(skillFor(skill, false)).toBe(["# t", "a line", "both local ways", "## next", "kept"].join("\n"));
  });

  it("marks every cloud verb's row, so the rows and the table go together", () => {
    const rows = wspSkill().split("\n").filter(line => line.startsWith("| `wsp "));
    const verbs = VERBS.map(v => v.name);
    const unknown = rows.map(row => /^\| `wsp ([a-z]+(?: [a-z]+)?)/.exec(row)![1]!).filter(words => !verbs.some(v => v === words || words.startsWith(`${v} `) || v.startsWith(`${words} `)));
    expect(unknown).toEqual([]);
  });
});
