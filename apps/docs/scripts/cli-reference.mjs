// SPDX-License-Identifier: AGPL-3.0-only
// Writes content/reference/cli.md from the built command line's own help text, so the page can never drift from the binary.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, "../../../packages/host/dist/bin.js");
const out = resolve(here, "../content/reference/cli.md");

const help = (args) => {
  try {
    return execFileSync("node", [bin, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
  } catch (error) {
    if (error && typeof error.stdout === "string" && error.stdout.length > 0) return error.stdout;
    throw error;
  }
};

const version = help(["--version"]).trim();
const main = help(["--help"]).trimEnd();
const pages = [
  ["wsp --help agent", ["--help", "agent"]],
  ["wsp host --help", ["host", "--help"]],
  ["wsp --help dev", ["--help", "dev"]],
];
const verbs = ["init", "add", "places", "remove", "new", "import", "run", "pause", "wake", "delete", "workspaces", "threads", "send", "stop", "status", "mcp", "up", "down", "recipe", "fork", "snapshot", "rename", "forget", "thread read", "exec", "folders", "export", "image", "join", "leave", "doctor"];

const sections = [
  ...pages.map(([title, args]) => `## ${title}\n\n\`\`\`text\n${help(args).trimEnd()}\n\`\`\``),
  ...verbs.map(verb => `## wsp ${verb}\n\n\`\`\`text\n${help([...verb.split(" "), "--help"]).trimEnd()}\n\`\`\``),
].join("\n\n");

const page = `# Command line

Every verb, as \`wsp --help\` prints it. This page is generated from the binary at ${version}; do not edit it by hand, run \`pnpm --filter @wsp/docs cli\` after the host changes.

Every verb takes \`--json\` for one JSON object per line, frames first and the result last, and \`--state <path>\` to name the state file the host serves. A refusal is one line on stderr and an exit code of its class: 0 ok, 1 provider, 2 auth, 3 usage. \`wsp exec\` exits with the command's own code.

\`\`\`text
${main}
\`\`\`

${sections}
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`wrote ${out} from ${version}`);
