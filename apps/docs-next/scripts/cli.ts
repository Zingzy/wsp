// SPDX-License-Identifier: AGPL-3.0-only
// The command line's pages: an index from the help pages and one page per line COMMAND_LINES holds, each the help
// that line's --help prints, run through the same dispatcher the binary runs. init has no page of its own; its help
// prints on the index. The sidebar group lists exactly these pages.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, COMMAND_LINES, type CliIO } from "../../../packages/host/src/cli.js";
import { block, cell, DOCS, page, table, type Generated } from "./generated.js";

const SCRIPT = "cli.ts";
const CONFIG = "scalar.config.json";
export const CLI_DIR = "content/reference/cli";

/** The line that prints on the index rather than on a page of its own. */
export const NO_PAGE = ["init"];

/** What `wsp <argv>` prints, stdout and stderr in the order written, with no host dialled and none started. */
async function printed(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const refuse = (q: string): Promise<string> => Promise.reject(new Error(`wsp ${argv.join(" ")} asked: ${q}`));
  const io: CliIO = { log: l => lines.push(l), error: l => lines.push(l), ask: refuse, askSecret: refuse };
  await cli(argv, io, undefined, {}, false);
  const text = lines.join("\n").trimEnd();
  if (text === "") throw new Error(`wsp ${argv.join(" ")} printed nothing`);
  return text;
}

/** The page's name under the cli folder: the line's words joined with a dash. */
export const pageName = (words: string): string => words.replaceAll(" ", "-");

const toolLine = (line: (typeof COMMAND_LINES)[number]): string =>
  "tool" in line ? `MCP tool: [\`${line.tool}\`](/reference/mcp-tools#${line.tool.replaceAll("_", "")}).` : `No MCP tool: ${cell(line.cliOnly)}.`;

export default async function cliPages(): Promise<Generated[]> {
  const lines = [...COMMAND_LINES].sort((a, b) => a.words.localeCompare(b.words));
  const paged = lines.filter(l => !NO_PAGE.includes(l.words));
  const pages: Generated[] = [];
  for (const line of paged) {
    const help = await printed([...line.words.split(" "), "--help"]);
    pages.push(page(`${CLI_DIR}/${pageName(line.words)}.mdx`, `wsp ${line.words}`, SCRIPT, `${block(help)}\n\n${toolLine(line)}`));
  }

  const rows = lines.map(l => [NO_PAGE.includes(l.words) ? `\`wsp ${l.words}\`` : `[\`wsp ${l.words}\`](/reference/cli/${pageName(l.words)})`, cell(l.about)]);
  const unpaged = await Promise.all(
    lines.filter(l => NO_PAGE.includes(l.words)).map(async l => `## wsp ${l.words}\n\n${block(await printed([...l.words.split(" "), "--help"]))}\n\n${toolLine(l)}`),
  );
  const index = [
    "Every line `wsp` answers, as its own `--help` prints it. `wsp --help` prints the front page, `wsp --help agent` the lines your agents use, `wsp host --help` the lines for a host outside your account and `wsp --help dev` the doctor.",
    block(await printed(["--help"])),
    "## Every line",
    table(["Line", "What it does"], rows),
    ...unpaged,
    "## wsp --help agent",
    block(await printed(["--help", "agent"])),
    "## wsp host --help",
    block(await printed(["host", "--help"])),
    "## wsp --help dev",
    block(await printed(["--help", "dev"])),
  ].join("\n\n");
  pages.unshift(page(`${CLI_DIR}/index.mdx`, "Command line", SCRIPT, index));

  const config = JSON.parse(readFileSync(join(DOCS, CONFIG), "utf8"));
  const group = config.navigation.routes["/"].children["/reference"].children["/cli"];
  group.children = {
    "/": { type: "page", title: "Command line", filepath: `${CLI_DIR}/index.mdx` },
    ...Object.fromEntries(paged.map(l => [`/${pageName(l.words)}`, { type: "page", title: `wsp ${l.words}`, filepath: `${CLI_DIR}/${pageName(l.words)}.mdx` }])),
  };
  return [...pages, { file: CONFIG, text: `${JSON.stringify(config, null, 2)}\n` }];
}
