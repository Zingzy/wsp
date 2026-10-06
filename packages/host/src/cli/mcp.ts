// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { MCP_AGENT_IDS } from "@wsp/catalog";
import { authRefusal, type McpServerSpec, hostFromEnv, jsonLine, SCOPED_MCP_ARG, scopedNoPairLine, EXIT_CODES, runForTheList, unknownWordLine, usageRefusal } from "@wsp/protocol";
import { alsoHere } from "../scan.js";
import { wrap } from "../init-layout.js";
import type { HostStarter } from "../host-start.js";
import { agentsOnPath, installEach, installLines, mcpServerSpec, nextLine, registeredLine, removeEach, removeLines, toolServerLine, type RunningWsp } from "../mcp-install.js";
import { COMMON_FLAG_WORDS, failed, HELP_WIDTH, helpPage, jsonAsked } from "../verbs.js";
import type { CliIO } from "./io.js";
import { MCP_COMMAND, MCP_OPTIONS, mcpInstallUsage, mcpUsage, COMMAND_LINES } from "./commands.js";

/** `wsp mcp` serves until the agent closes its stdin; `wsp mcp install --agent <id>` writes the agent's config,
 * once per `--agent` given, and answers with the lines or, with `--json`, the report as one line. Its flags are
 * parsed here rather than in the table every command shares, so a command that has no JSON to print refuses
 * `--json` instead of taking it and printing prose. */
export async function mcp(io: CliIO, argv: string[], statePathOf: (flag?: string) => string, run: RunningWsp, env: Readonly<Record<string, string | undefined>>, starts: { start?: HostStarter }): Promise<number> {
  const usage = mcpUsage();
  let values: { agent?: string[]; host?: string; json?: boolean; remove?: boolean; state?: string; scoped?: boolean; "no-slate"?: boolean; help?: boolean };
  let words: string[];
  try {
    ({ values, positionals: words } = parseArgs({ args: argv, options: MCP_OPTIONS, allowPositionals: true }));
  } catch (e) {
    return failed(io, jsonAsked(argv), usageRefusal(e instanceof Error ? e.message : String(e), usage));
  }
  if (values.help === true) {
    io.log(mcpPage(words[0] === "install"));
    return 0;
  }
  if (values["no-slate"] === true && values.scoped !== true) return failed(io, jsonAsked(argv), usageRefusal(`--no-slate goes with ${SCOPED_MCP_ARG}: it is for a thread another thread started`, usage));
  // Ahead of every reading of the state: a scoped server missing its pair would otherwise dial this computer's host
  // on the host's own token, which is acting as the person.
  if (values.scoped === true && words.length === 0 && hostFromEnv(env) === undefined) return failed(io, jsonAsked(argv), authRefusal(scopedNoPairLine));
  const statePath = statePathOf(values.state);
  if (words.length === 0) {
    const line = toolServerLine(statePath, values, run);
    if (line !== undefined) return toolServerRan(io, line, env);
    // A platform gap: a Linux host's daemon binary is the static guest build, which carries no tool server, so the
    // TypeScript server answers there. The agent starts it in its own folder, which is the folder a thread opened with
    // no workspace is placed by.
    const { serveMcp } = await import("../mcp.js");
    await serveMcp(statePath, { alsoHere, cwd: process.cwd(), env, ...starts, ...(values.host !== undefined ? { host: values.host } : {}), ...(values.scoped === true ? { scoped: true } : {}), ...(values["no-slate"] === true ? { noSlate: true } : {}) });
    return 0;
  }
  const json = values.json === true;
  if (words[0] !== "install" || words.length !== 1) return failed(io, json, usageRefusal(unknownWordLine(`${MCP_COMMAND} ${words.join(" ")}`), runForTheList(`wsp ${MCP_COMMAND} --help`)));
  // Nobody named an agent: at a terminal that is a line half typed, but an agent running this has no terminal to be
  // asked at, so every agent whose own command is on this computer's PATH takes it.
  const agents = values.agent ?? (io.isTTY === true ? [] : agentsOnPath(run.PATH));
  if (agents.length === 0) {
    const none =
      io.isTTY !== true
        ? "wsp mcp install: no agent of the catalog's is on this computer's PATH."
        : "wsp mcp install writes the config of the agents it is given, and was given none.";
    return failed(io, json, usageRefusal(none, `Name one with --agent.\n\nusage: ${mcpInstallUsage()}`));
  }
  const project = process.cwd();
  if (values.remove === true) {
    const gone = removeEach(agents, project);
    if (json) io.log(jsonLine(gone));
    else {
      for (const agent of gone.removed) for (const line of removeLines(agent)) io.log(line);
      for (const failed of gone.failures) io.error(`wsp mcp install: ${failed.error}`);
    }
    return gone.failures.length > 0 ? 1 : 0;
  }
  const report = installEach(agents, mcpServerSpec(statePath, run, values.host !== undefined ? { host: values.host } : {}), homedir(), project);
  if (json) io.log(jsonLine(report));
  else {
    for (const placed of report.installed) for (const line of installLines(placed)) io.log(line);
    const registered = registeredLine(report);
    if (registered !== undefined) io.log(registered);
    for (const failed of report.failures) io.error(`wsp mcp install: ${failed.error}`);
    const next = nextLine(report);
    if (next !== undefined) io.log(next);
  }
  return report.failures.length > 0 ? 1 : 0;
}

/** The tool server run on this process's own stdio until the agent closes it, and the code it exits with. */
function toolServerRan(io: CliIO, line: McpServerSpec, env: Readonly<Record<string, string | undefined>>): Promise<number> {
  return new Promise(done => {
    const child = spawn(line.command, [...line.args], { stdio: "inherit", env: env as NodeJS.ProcessEnv });
    child.once("error", e => {
      io.error(`${line.command}: ${e.message}`);
      done(EXIT_CODES.provider);
    });
    child.once("exit", code => done(code ?? EXIT_CODES.provider));
  });
}

/** What each flag the tool server reads says on its own page. Its parse is its own, so its words are too; the page
 * they print on is the one every other line prints on. */
const MCP_FLAG_WORDS: Readonly<Record<string, string>> = {
  agent: `the agent to write the server, this skill and wsp's own section of AGENTS.md into, by catalog id (${MCP_AGENT_IDS}); repeats, and off a terminal every agent whose own command is on this computer's PATH takes it`,
  remove: "take the server, the skill and that section back out of those agents instead",
  json: "print what each agent took as one JSON object",
  state: COMMON_FLAG_WORDS.state,
  host: "write the server against a host on your account, by the name wsp hosts lists it under, so the tools drive that host",
  scoped: "what the host puts on a thread's own tools: without the launch pair in the environment the server refuses rather than dial this computer's host on its own token",
  "no-slate": "what the host puts beside it for a thread another thread started, which has no slate: the server's instructions say nothing of one",
};

/** The tool server's own two pages, each with the flags it reads. `wsp mcp` alone serves; `wsp mcp install` writes
 * an agent's config. Both were two usage lines and no words until a person asked what --agent took. */
function mcpPage(install: boolean): string {
  const line = COMMAND_LINES.find(l => l.words === (install ? `${MCP_COMMAND} install` : MCP_COMMAND))!;
  const flags = install ? ["agent", "remove", "json", "state", "host"] : ["state", "host", "scoped", "no-slate"];
  return helpPage(line.usage, wrap(`  ${line.about}`, HELP_WIDTH, "  "), flags.map(name => [`--${name}`, MCP_FLAG_WORDS[name]!] as const));
}
