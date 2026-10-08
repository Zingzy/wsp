// SPDX-License-Identifier: AGPL-3.0-only
// wsp: local app entry. Embeds the runtime in-process and serves the web app
// on loopback. There is no control plane; the Solari key is read here
// and used only for direct calls from this process to the machine API.

import { parseArgs } from "node:util";
import { DAEMON_VERSION, cloudOffRefusal, jsonLine, runForTheList, unknownWordLine, usageRefusal, foreignFlagLine } from "@wsp/protocol";
import { CLOUD_BUILT, CLOUD_ON } from "./cloud.js";
// The writer of a host's own .env now sits beside its reader; the name stays exported here for every caller
// that already had it from this module.
export { writeEnvFile } from "./env-keys.js";
import { alsoHere } from "./scan.js";
import { systemOpener } from "./relay.js";
import { starterFor, type HostStarter } from "./host-start.js";
import { wspHome } from "./hosts.js";
import { runningWsp, type RunningWsp } from "./mcp-install.js";
import { cloudLineOf, failed, findVerb, jsonAsked, runVerb, takeCommon, verbUsage } from "./verbs.js";
import { VERSION } from "./version.js";
import { type CliIO, terminalIO } from "./cli/io.js";
export { type CliIO, terminalIO, jsonCliIO } from "./cli/io.js";
export { type KeySources, keySources, type NoProviderKey, type LoadedKeys, loadKeys, keysFound, vaultNow, saveQuestion } from "./cli/keys.js";
import { statePathFrom } from "./cli/state.js";
export { devCheckoutState, type StatePick, statePick, defaultStatePath, statesHere, stateStore } from "./cli/state.js";
import { SERVE_FLAGS, optsFor, type SharedFlags, SHARED_OPTIONS } from "./cli/flags.js";
export { type ServeAsked, SERVE_FLAGS, type SharedOpts, optsFor, SHARED_OPTIONS } from "./cli/flags.js";
export { goldenRecipe, localWorkFolder, type LocalDaemonStart, localWiring, hostRecipeWatch, providerSlotOf, swapProvider, servingWiring, makeRuntime, hostSeed, projectFolder } from "./cli/wiring.js";
export { type StopProcess, OWN_FILES_POLL_MS, stopOnSignals, type UncaughtProcess, stayOnUncaught, type ServeOptions, serve, noClaudeKeyNote, hostDoctorReaders } from "./cli/serve.js";
export { terminalInitIO, providerBesideRefusal, upCommandFor } from "./cli/init.js";
export { up, type ServiceDeps, hostRoadWord, hostStoppedLine, systemService, serviceArgv, keyOnlyInThisShell, claudeKeyOnlyInThisShell, upServiceCommand, downCommand, statusCommand, pickUpPorts } from "./cli/service.js";
import { type CommandDeps, SYSTEM_COMMAND_DEPS, HOST_COMMANDS, HOST_WORD, HOST_LINES, findCommand, JSON_COMMANDS, MCP_COMMAND, mcpUsage, SHARED_FLAGS, readers } from "./cli/commands.js";
export { HOST_STARTS_ITSELF, type HostFlag, type CommandDeps, SYSTEM_COMMAND_DEPS, DOCTOR_HANDLES_ENV, doctorKeyAsk, doctorRow, HOST_FLAG, HOST_COMMANDS, SHARED_WORDS, COMMANDS_FOR_HELP, HOST_WORD, HOST_LINES, JSON_COMMANDS, PROSE_COMMANDS, MCP_OPTIONS, type CommandLine, COMMAND_LINES, type SharedFlag, SHARED_FLAGS, readers } from "./cli/commands.js";
import { HELP, HELP_PAGES, agentPage, hostPage, devPage, commandPage } from "./cli/help.js";
export { HELP, HELP_PAGES, agentPage, hostPage, devPage, commandPage } from "./cli/help.js";
import { mcp } from "./cli/mcp.js";

export type { Keys } from "./env-keys.js";

// The hosts file sits under the same home, so where that home is lives beside it and is re-exported here for every
// reader that already had it from the command line.
export { wspHome };

/** The usage of the command a line stopped short of, whether it is a verb, `mcp` or the word the plumbing folds
 * under; none when no command owns the word. `mcp` needs its own answer here because it is not in the verb table
 * and its flags follow the word. */
function commandUsage(word: string): string | undefined {
  if (word === MCP_COMMAND) return mcpUsage();
  if (word === HOST_WORD) return HOST_LINES.map(words => `usage: wsp ${words}`).join("\n");
  return verbUsage(word);
}

/** `run` is how this process was started, which the MCP install writes into an agent's config as the way to start it
 * again; the desktop's bundled command hands in its shim, the npm command the default reading. `env` is the
 * environment the verbs run with, this process's for a real command line and its own for a test. `start` is what
 * brings a host up when none serves the state file: the one built from `run` unless a caller says otherwise, and
 * `false` for a caller that wants a line with no host to refuse rather than start one. `caller` is where the line was
 * typed: the folder, which a thread with no workspace is placed by, and whether that place is somewhere other than
 * this computer, which is what every rule that would read a path here reads. This process's own folder and here by
 * default; a line typed inside a machine says both. */
export async function cli(
  argv: string[],
  io: CliIO = terminalIO(),
  run: RunningWsp = runningWsp(),
  given: Readonly<Record<string, string | undefined>> = process.env,
  start?: HostStarter | false,
  caller: { cwd?: string; elsewhere?: boolean } = {},
  deps: CommandDeps = SYSTEM_COMMAND_DEPS,
): Promise<number> {
  const env = given;
  const starter = start ?? starterFor(run, env);
  const starts = starter === false ? {} : { start: starter };
  // One reading for every road out of this process, and the sentence about it said once: a verb, a command and the
  // tool server all pick their state here, so none of them can run against a state another of them named.
  const chooseState = (flag?: string): string => statePathFrom(flag, env, line => io.error(line));
  // The flags every line shares are taken off the whole line here, before the words that select the line are read,
  // so one of them binds wherever it was typed and what is left reaches its own parse in the order it was given.
  const { common, rest } = takeCommon(argv);
  const cloudLine = cloudLineOf(rest);
  if (cloudLine !== undefined) return failed(io, jsonAsked(argv), cloudOffRefusal(cloudLine));
  const verb = findVerb(rest);
  if (verb !== undefined) {
    const words = verb.name.split(" ");
    return runVerb(verb, [...words, ...common, ...rest.slice(words.length)], io, chooseState, { alsoHere, cwd: caller.cwd ?? process.cwd(), env, open: systemOpener(), ...starts, ...(caller.elsewhere === true ? { elsewhere: true } : {}) });
  }
  if (rest[0] === MCP_COMMAND) {
    const argv = [...common, ...rest.slice(1)];
    return mcp(io, argv, chooseState, run, env, starts);
  }
  let values: SharedFlags;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: [...common, ...rest], options: SHARED_OPTIONS, allowPositionals: true }));
  } catch (e) {
    return failed(io, jsonAsked(argv), usageRefusal(e instanceof Error ? e.message : String(e), runForTheList("wsp --help")));
  }
  if (values.version) {
    // Under --json with the daemon version this build is: a computer's daemon asks the wsp it runs, and the host reads
    // off that answer which `wsp leave` the computer has.
    io.log(values.json === true ? jsonLine({ version: VERSION, daemon: DAEMON_VERSION }) : `wsp ${VERSION}`);
    return 0;
  }
  // `help` is the word for the flag: a person reaching for it types one as readily as the other, and answering the
  // word with a typo's refusal is the tool arguing about punctuation. A line that opens with it is that same line
  // with the flag on it, so what follows selects a page or a command as it would either way. A line with no word at
  // all asks the same question: typing the program's name asks what it is, and answering by serving made a second
  // host of it.
  const asked = positionals[0] === "help" ? positionals.slice(1) : positionals;
  const wantsHelp = values.help === true || positionals[0] === "help" || asked.length === 0;
  const word = asked[0];
  // The word the plumbing folds under prints its own page, by itself or with the flag every other line answers to.
  if (word === HOST_WORD && asked.length === 1) {
    io.log(hostPage());
    return 0;
  }
  if (wantsHelp && findCommand(asked) === undefined) {
    // A command asking for its own help falls through to the parse below; only a word no command answers to is
    // read as the name of a page.
    if (word === undefined) {
      io.log(HELP);
      return 0;
    }
    const page = HELP_PAGES.find(p => p === word);
    if (page !== undefined) {
      io.log(page === "agent" ? agentPage() : devPage());
      return 0;
    }
    if (word === HOST_WORD) {
      io.log(hostPage());
      return 0;
    }
    // A word that opens lines rather than being one answers with the lines it opens, as it does without the flag.
    const opens = commandUsage(word);
    if (opens !== undefined) {
      io.log(opens);
      return 0;
    }
    return failed(io, values.json === true, usageRefusal(`wsp --help takes a page, and got ${word}.`, `The pages are ${HELP_PAGES.map(p => `wsp --help ${p}`).join(", ")} and wsp host --help.`));
  }
  const opts = { ...optsFor(values, env, line => io.error(line)), ...starts, running: run };
  const found = findCommand(asked);
  const json = values.json === true;
  if (found === undefined) {
    // A word that opens a line but is no line of its own gets the lines it opens; one no command answers to gets
    // the pointer, since the help behind it runs to hundreds of rows.
    const usage = commandUsage(word!);
    const refusal = usage === undefined ? usageRefusal(unknownWordLine(word!), runForTheList("wsp --help")) : usageRefusal(`wsp ${word!} opens a line rather than being one.`, usage);
    return failed(io, json, refusal);
  }
  const { words, command } = found;
  // The line's own help, in place of the whole front page: its usage, what it does and its own flags.
  if (wantsHelp) {
    io.log(commandPage(words, command));
    return 0;
  }
  if (json && !command.json) {
    return failed(io, json, usageRefusal(`Unknown option '--json' for wsp ${words}: it answers in prose.`, `That flag belongs to ${JSON_COMMANDS.map(w => `wsp ${w}`).join(", ")}, and to every verb.`));
  }
  if (values.host !== undefined && command.host === "refused") {
    return failed(io, json, usageRefusal(`Unknown option '--host' for wsp ${words}: it runs on this computer.`, `That flag belongs to ${HOST_COMMANDS.map(w => `wsp ${w}`).join(", ")}, and to every verb.`));
  }
  const cloudFlag = CLOUD_ON || !CLOUD_BUILT ? undefined : SERVE_FLAGS.find(f => f.cloud === true && values[f.name] !== undefined);
  if (cloudFlag !== undefined) return failed(io, json, cloudOffRefusal(`wsp ${words} --${cloudFlag.name}`));
  // A flag another command of the shared parse reads: the union is one parse, so the line that does not read it is
  // told which lines do rather than taking it and doing nothing with it.
  const foreign = SHARED_FLAGS.find(f => values[f.name] !== undefined && !readers(f.name).includes(words));
  if (foreign !== undefined) {
    return failed(io, json, usageRefusal(foreignFlagLine(`--${foreign.name}`, readers(foreign.name).map(w => `wsp ${w}`), `wsp ${words}`), `usage: ${command.usage}`));
  }
  try {
    return await command.run(io, opts, values, asked.slice(words.split(" ").length), deps);
  } catch (e) {
    return failed(io, json, e);
  }
}
