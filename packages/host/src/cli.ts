// SPDX-License-Identifier: AGPL-3.0-only
// wsp: local app entry. Embeds the runtime in-process and serves the web app
// on loopback. There is no control plane; the Solari key is read here
// and used only for direct calls from this process to the machine API.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { isCancel } from "@clack/prompts";
import { collect, computeRecipe, nodeHost, type Manifest, type Rung } from "@wsp/collect";
import {
  SolariBackend,
  createRuntime,
  goldenHead,
  hostIdentity,
  jsonFileStore,
  type GoldenBuilderView,
  type GoldenRecipe,
  type GoldenVersion,
  type Machine,
  type Runtime,
} from "@wsp/runtime";
import { GOLDEN_SETUP, GOLDEN_SMOKE, MCP_AGENT_IDS } from "@wsp/catalog";
import { LOGIN_CHOICES, RECIPE_TICKS } from "@wsp/protocol";
import { assetDir } from "./assets.js";
import { HARNESS_ADAPTERS } from "./adapters.js";
import { claudeEnvs, deployDaemon, doctor } from "./doctor.js";
import { keychainReader } from "./init-import.js";
import { readBrewTable } from "./init-brew.js";
import { runInit, type InitIO } from "./init.js";
import { recipePath } from "./init-recipe.js";
import { smallRecipePath } from "./recipe-file.js";
import { isRecipeTick, runRecipe, runScan } from "./recipe-command.js";
import { recipeAnswer, recipePrintout, scanPrintout } from "./recipe-answer.js";
import { scanTools } from "./scan.js";
import { colourDepth, confirmPrompt, isTTY, passwordPrompt, type PromptOptions } from "./init-layout.js";
import { TAGLINE, opening } from "./init-opening.js";
import { systemOpener, type UrlOpener } from "./relay.js";
import { hostTokenPath, lockPathFor, servingHost, takeLock, type HostLock } from "./host-lock.js";
import { startHost, type HostHandle } from "./server.js";
import { serveMcp } from "./mcp.js";
import { installEach, installLines, mcpServerSpec } from "./mcp-install.js";
import { findVerb, runVerb, verbHelp, verbUsage } from "./verbs.js";
import { VERSION } from "./version.js";

export const HELP = `wsp - ${TAGLINE}

usage:
  wsp up             start the app and the runtime over the golden you sealed
                     (plain wsp does the same)
  wsp init           set up your first golden image: the agents, what they
                     need and the sign-ins, three screens, then the build and
                     the browser
  wsp recipe scan    read this computer and print every option, writing
                     nothing: the agents, the tools with why and size, what
                     else a package manager here has that the image could
                     take, the commands your agents ran, and the sign-ins,
                     each with what to do about it and
                     one line of why; --project weighs the histories by a
                     folder and --json prints it as one object
  wsp recipe         write the recipe and print it as a table: every catalog
                     agent and tool with its tick, why it has it and what it
                     costs on the machine, then the commands your agents ran
                     that no catalog row carries. --tick used|installed|default
                     names the rule that decides every tick (used, the default,
                     ticks what your agents actually ran here); --set <id>=on|off
                     and --signin <id>=copy|machine|key|skip flip a row and a
                     sign-in by catalog id, key bringing the key files beside a
                     login and nothing else of it; --add <id>=<command> carries
                     a tool the catalog does not, installed by that command on
                     the machine, with --add-check <id>=<command> saying it is
                     there; --project weighs the histories by a folder,
                     --out says where the file goes and --json prints the table
                     as one object. Naming --tick or --project decides every
                     tick again; without either, what the file says stands and
                     the flags flip rows on top of it. A sign-in answer stands
                     either way: no rule decides one. All of them repeat.
                     Review it, then wsp init --recipe
  wsp doctor         run the reach loop end to end against one live machine
  wsp mcp            serve the verbs as MCP tools over stdio to an agent on this
                     computer; wsp mcp install --agent <id> puts the server in
                     that agent's own MCP config (${MCP_AGENT_IDS})
                     and the wsp skill in its skills folder. --agent repeats,
                     and --json prints one line holding what each agent took and
                     a failures array for the ones that took nothing; both are
                     read by mcp install alone
  wsp --version      print the version

verbs, against the host wsp up started; every one takes --json for the raw
protocol values:
${verbHelp()}

  wsp send streams the reply to stderr as it arrives and prints the last message
  on stdout when the turn ends; wsp exec streams the command's output and exits
  with its code. thread new, send and exec wake a paused workspace first, with
  one line on stderr saying so.

options:
  --port N           app port (default 4400)
  --ws-port N        runtime websocket port (default 4410)
  --state PATH       state file (default ~/.wsp/state.json, or ./.wsp/state.json
                     when the current directory has a .env)
  --yes              init: take every default and ask nothing (required off a
                     terminal); a login with a browser or device sign-in, or one
                     held in the Keychain, defaults to sign in on the machine
                     unless a saved recipe answered copy, so macOS has nothing
                     to ask either and the sign-ins wait for the app's terminal
  --recipe PATH      init: tick the agents and tools from this recipe (wsp recipe
                     writes it; init writes <state dir>/recipe.json too) and go
                     straight to the sign-ins; this machine is still read for
                     what travels
  --non-interactive  init: ask nothing, but still run the sign-ins on the
                     machine: each one prints the page to open on this computer,
                     the code when the flow shows one, and the command that
                     opens it, then waits for you (this is what a run off a
                     terminal does anyway)
  --json             init: print each sign-in hand-off and its outcome as one
                     JSON object on stdout, everything else on stderr; implies
                     --non-interactive, and is refused beside --yes, which skips
                     the sign-ins

keys are read from the environment, then ./.env, then ~/.wsp/.env (WSP_HOME
overrides ~/.wsp). The prompt runs only when no Solari key is found; it asks
for the optional Anthropic key at the same time and can save both to that file.
With a Solari key present, a missing Anthropic key is only noted at start.
`;

export interface CliIO {
  log(line: string): void;
  error(line: string): void;
  /** Raw text on stderr, no newline added: a reply as it streams in. */
  stream?(text: string): void;
  /** A yes-or-no question; resolves to "yes" or "no". */
  ask(question: string): Promise<string>;
  /** A person is at the keyboard (stdin and stdout are terminals); absent means an agent or a pipe, and nothing is asked. */
  isTTY?: boolean;
  /** A key, typed without echo. Lines after the first are shown under the question. */
  askSecret(question: string): Promise<string>;
}

export interface Keys {
  solari: string;
  anthropic?: string;
}

export interface KeySources {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
}

const DEFAULT_HOME = join(homedir(), ".wsp");

export function wspHome(): string {
  return process.env["WSP_HOME"] ?? DEFAULT_HOME;
}

/** Fixed spot a launcher without WSP_HOME (Finder, a service) can read to
 * learn which home the running host serves. */
export function currentHomePointer(): string {
  return join(homedir(), ".wsp", "current-home");
}

export function currentHome(): string | undefined {
  const path = currentHomePointer();
  if (!existsSync(path)) return undefined;
  const home = readFileSync(path, "utf8").trim();
  return home === "" ? undefined : home;
}

type Stream<T> = T & { isTTY?: boolean };

/** Questions are clack prompts on the terminal; off a terminal there is nobody to answer them. */
export function terminalIO(input: Stream<Readable> = process.stdin, output: Stream<Writable> = process.stdout): CliIO {
  const screen = input.isTTY === true && output.isTTY === true;
  const nobody = (q: string): Promise<never> =>
    Promise.reject(new Error(`${q.split("\n")[0]}: no terminal to ask on; set it in the environment, ./.env, or ~/.wsp/.env.`));
  // The first line of a question is the question; the lines under it are its hint.
  const split = (q: string): PromptOptions => {
    const nl = q.indexOf("\n");
    return nl < 0 ? { message: q, input, output } : { message: q.slice(0, nl), hint: q.slice(nl + 1), input, output };
  };
  const answered = async <T>(prompt: Promise<T | symbol>): Promise<T> => {
    const value = await prompt;
    if (isCancel(value)) throw new Error("Nothing was changed.");
    return value as T;
  };
  return {
    log: line => console.log(line),
    error: line => console.error(line),
    stream: text => process.stderr.write(text),
    isTTY: screen,
    ask: q => (screen ? answered(confirmPrompt(split(q))).then(yes => (yes ? "yes" : "no")) : nobody(q)),
    askSecret: q => (screen ? answered(passwordPrompt(split(q))) : nobody(q)),
  };
}

/** What an init under --json speaks through: stdout carries the objects alone, so every line the run says goes to
 * stderr beside them, and a key that is not in the environment or a .env file is an error rather than a prompt on a
 * stream nobody is reading. */
export function jsonCliIO(err: Writable = process.stderr): CliIO {
  const say = (line: string): void => void err.write(`${line}\n`);
  const nobody = (q: string): Promise<never> =>
    Promise.reject(new Error(`${q.split("\n")[0]}: --json asks nothing; set it in the environment, ./.env, or ~/.wsp/.env.`));
  return { log: say, error: say, stream: text => void err.write(text), ask: nobody, askSecret: nobody };
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2]) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function writeEnvFile(path: string, set: Record<string, string>): void {
  const pending = new Map(Object.entries(set));
  const lines: string[] = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const key = line.match(/^([A-Z_]+)=/)?.[1];
      const value = key === undefined ? undefined : pending.get(key);
      if (key === undefined || value === undefined) {
        lines.push(line);
        continue;
      }
      lines.push(`${key}=${value}`);
      pending.delete(key);
    }
    while (lines.at(-1) === "") lines.pop();
  }
  for (const [k, v] of pending) lines.push(`${k}=${v}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file.
  chmodSync(path, 0o600);
}

export async function loadKeys(
  io: CliIO,
  sources: KeySources = { env: process.env, cwd: process.cwd(), home: wspHome() },
  ask: { anthropic: boolean } = { anthropic: true },
): Promise<Keys> {
  const homeEnv = join(sources.home, ".env");
  const layers = [sources.env, parseEnvFile(join(sources.cwd, ".env")), parseEnvFile(homeEnv)];
  const find = (name: string): string | undefined => layers.map(l => l[name]).find(v => v !== undefined && v !== "");

  let solari = find("SOLARI_API_KEY");
  let anthropic = find("ANTHROPIC_API_KEY");
  if (solari !== undefined) return { solari, ...(anthropic !== undefined ? { anthropic } : {}) };

  solari = (await io.askSecret("Solari API key\nNo Solari key found.\nconsole.getsolari.com")).trim();
  if (!solari) throw new Error("A Solari API key is needed to start.");
  const set: Record<string, string> = { SOLARI_API_KEY: solari };

  if (anthropic === undefined && ask.anthropic) {
    const typed = (
      await io.askSecret("Anthropic API key\noptional, enter skips\nOn a Claude subscription, skip this and sign in with /login on the machine instead.")
    ).trim();
    if (typed) {
      anthropic = typed;
      set["ANTHROPIC_API_KEY"] = typed;
    }
  }

  if ((await io.ask(saveQuestion(sources.home, Object.keys(set).length))) === "yes") writeEnvFile(homeEnv, set);
  return { solari, ...(anthropic !== undefined ? { anthropic } : {}) };
}

/** Names the file only when WSP_HOME moved it off the default. */
export function saveQuestion(home: string, keys: number): string {
  const what = keys > 1 ? "keys" : "key";
  return home === DEFAULT_HOME ? `Save the ${what} so wsp stops asking?` : `Save the ${what} to ${join(home, ".env")} so wsp stops asking?`;
}

/** What every golden wsp init seals is made of: the harness install and its
 * smoke from the doctor, the daemon bundle deploy, and the loaded keys as envs. */
export function goldenRecipe(
  keys: Pick<Keys, "anthropic">,
  hooks: { deployDaemon?: (machine: Machine) => Promise<void | string> } = {},
): GoldenRecipe {
  return {
    setup: GOLDEN_SETUP,
    smoke: GOLDEN_SMOKE,
    cpu: 2,
    memMb: 4096,
    envs: claudeEnvs(keys.anthropic),
    deployDaemon: hooks.deployDaemon ?? (async machine => `daemon on node ${(await deployDaemon(machine)).node}`),
  };
}

function defaultStatePath(): string {
  // A .env in cwd marks a dev checkout; share its .wsp state with wspx.
  if (existsSync(join(process.cwd(), ".env"))) return join(process.cwd(), ".wsp", "state.json");
  return join(wspHome(), "state.json");
}

/** The state file a command works on: its `--state` word when it gave one, else this computer's default, absolute
 * either way, so the lock, the token and the recipe beside it name one path whatever the cwd is. */
function statePathFrom(flag?: string): string {
  return resolve(flag ?? defaultStatePath());
}

export function makeRuntime(keys: Keys, statePath: string, recipe: GoldenRecipe = goldenRecipe(keys)): Runtime {
  return createRuntime({
    backend: new SolariBackend({ apiKey: keys.solari }),
    store: jsonFileStore(statePath),
    adapters: HARNESS_ADAPTERS,
    goldenRecipe: recipe,
    hostId: hostIdentity(),
  });
}

/** With --json stdout carries the objects alone, so every line the run says moves to stderr beside it. */
export function terminalInitIO(json = false): InitIO {
  const os = platform();
  return {
    input: process.stdin,
    output: json ? process.stderr : process.stdout,
    stderr: process.stderr,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    env: process.env,
    open: systemOpener(os),
    signals: process,
    exit: code => process.exit(code),
    ...(json ? { json: (record: Record<string, unknown>) => void process.stdout.write(`${JSON.stringify(record)}\n`) } : {}),
  };
}

/** The collector's ladder over this laptop; onRung lets the terminal count rows as each rung lands. */
function collectThisComputer(onRung: (rung: Rung, rows: number) => void): Promise<Manifest> {
  return collect(nodeHost(), { onRung });
}

/** Ctrl-C and a service stop both end with the lock removed. `once` leaves a
 * second signal to node's default exit, so a close that hangs cannot trap the terminal. */
function stopOnSignals(handle: HostHandle, io: CliIO): void {
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    stopping ??= handle.close().then(
      () => process.exit(0),
      (e: unknown) => {
        io.error(`host close failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Init ends by starting a host on this state, which the lock would refuse only after the builder is booted and billed. */
function initRefusal(lock: HostLock, statePath: string): string {
  return `wsp init: a wsp host (pid ${lock.pid}) is already serving ${statePath}. Stop it first (Ctrl-C in its terminal, or kill ${lock.pid}), then run wsp init again, or point --state at a different file.`;
}

async function init(io: CliIO, opts: { port: number; wsPort: number; statePath: string }, flags: { yes: boolean; nonInteractive: boolean; json: boolean; recipe?: string }): Promise<number> {
  if (flags.json && flags.yes) {
    io.error("wsp init: --json prints the sign-ins as they are handed to you, and --yes skips the sign-ins, so there would be nothing to print. Drop one of them.");
    return 1;
  }
  const held = servingHost(opts.statePath);
  if (held !== undefined) {
    io.error(initRefusal(held, opts.statePath));
    return 1;
  }
  // Under --json every line this run says, the host's own included, goes to stderr so stdout is the objects' alone.
  const say = flags.json ? jsonCliIO() : io;
  const screen = terminalInitIO(flags.json);
  opening(screen, { command: "init", version: VERSION, yes: flags.yes });
  const keys = await loadKeys(say, undefined, { anthropic: false });
  const result = await runInit(
    {
      yes: flags.yes,
      nonInteractive: flags.nonInteractive,
      ...(flags.recipe !== undefined ? { recipeFile: resolve(flags.recipe) } : {}),
      collect: collectThisComputer,
      recipe: onHistory => computeRecipe(nodeHost(), { onHistory }),
      keys,
      pricing: new SolariBackend({ apiKey: keys.solari }).pricing,
      statePath: opts.statePath,
      home: homedir(),
      secrets: keychainReader(),
      platform: platform() === "darwin" ? "darwin" : "linux",
      brew: () => readBrewTable(nodeHost()),
      scan: recipe => scanTools(nodeHost(), recipe),
      runtime: recipe => makeRuntime(keys, opts.statePath, { ...recipe, deployDaemon: async machine => `daemon on node ${(await deployDaemon(machine)).node}` }),
      host: (rt, builder, hooks) => hostFor(rt, keys, { ...opts, builder, ...hooks }, say),
    },
    screen,
  );
  if (result.handle !== undefined) stopOnSignals(result.handle, say);
  return result.code;
}

export interface ServeOptions {
  port: number;
  wsPort: number;
  statePath: string;
  webDir?: string;
  runtime?: Runtime;
  openUrl?: UrlOpener;
}

export async function serve(io: CliIO, opts: ServeOptions): Promise<HostHandle> {
  const keys = await loadKeys(io);
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath);
  return hostFor(rt, keys, opts, io);
}

export async function up(io: CliIO, opts: ServeOptions): Promise<HostHandle | undefined> {
  const keys = await loadKeys(io, undefined, { anthropic: false });
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath);
  if (goldenHead(await rt.golden.get()) === undefined) {
    io.error("no golden yet; run wsp init");
    return undefined;
  }
  return hostFor(rt, keys, opts, io);
}

async function hostFor(
  rt: Runtime,
  keys: Keys,
  opts: {
    port: number;
    wsPort: number;
    statePath: string;
    webDir?: string;
    builder?: GoldenBuilderView;
    openUrl?: UrlOpener;
    autoOpen?: (targetId: string, url: string, port?: number) => boolean;
    openLine?: (workspace: string, hostname: string, url: string) => string;
    onLine?: (line: string) => boolean;
  },
  io: CliIO,
): Promise<HostHandle> {
  const lockPath = lockPathFor(opts.statePath);
  const lock = takeLock(lockPath, opts.statePath, { port: opts.port, wsPort: opts.wsPort });
  try {
    const handle = await startHost({
      runtime: rt,
      port: opts.port,
      wsPort: opts.wsPort,
      webDir: opts.webDir ?? assetDir("web"),
      ...(opts.builder !== undefined ? { builder: opts.builder } : {}),
      ...(keys.anthropic !== undefined ? { workspaceEnvs: (golden: GoldenVersion) => claudeEnvs(keys.anthropic, golden) } : {}),
      ...(opts.openUrl !== undefined ? { openUrl: opts.openUrl } : {}),
      ...(opts.autoOpen !== undefined ? { autoOpen: opts.autoOpen } : {}),
      ...(opts.openLine !== undefined ? { openLine: opts.openLine } : {}),
      log: line => {
        if (!opts.onLine?.(line)) io.log(line);
      },
      recipePath: recipePath(opts.statePath),
    });
    writeFileSync(lockPath, JSON.stringify({ ...lock, port: handle.port, wsPort: handle.wsPort }));
    // Other local tools read the token from disk; the WS never sees it in a URL.
    const tokenPath = hostTokenPath(opts.statePath);
    writeFileSync(tokenPath, handle.authToken, { mode: 0o600 });
    const home = resolve(wspHome());
    const pointer = currentHomePointer();
    mkdirSync(dirname(pointer), { recursive: true });
    writeFileSync(pointer, `${home}\n`);

    io.log(`app         http://127.0.0.1:${handle.port}`);
    io.log(`runtime ws  ws://127.0.0.1:${handle.wsPort} (token: ${tokenPath})`);
    io.log(`state       ${opts.statePath}`);
    if (keys.anthropic === undefined) {
      io.log("note: no ANTHROPIC_API_KEY found; new workspaces fork without claude credentials");
    }
    return {
      ...handle,
      close: async () => {
        await handle.close();
        rmSync(lockPath, { force: true });
        // A host that started later owns the pointer now.
        if (currentHome() === home) rmSync(pointer, { force: true });
      },
    };
  } catch (e) {
    rmSync(lockPath, { force: true });
    throw e;
  }
}

/** The flags the shared parse reads; a command that answers on its own word (mcp, recipe) parses its own. */
interface SharedFlags {
  version?: boolean;
  help?: boolean;
  port?: string;
  "ws-port"?: string;
  state?: string;
  yes?: boolean;
  "non-interactive"?: boolean;
  json?: boolean;
  recipe?: string;
  out?: string;
}

interface Command {
  /** Whether stdout is objects under --json; a command without it refuses the flag rather than hand prose to whoever reads them. */
  json: boolean;
  run(io: CliIO, opts: { port: number; wsPort: number; statePath: string }, values: SharedFlags): Promise<number>;
}

/** The commands the shared parse serves, by word; a line with no word is `up`. */
const COMMANDS: Readonly<Record<string, Command>> = {
  up: {
    json: false,
    run: async (io, opts) => {
      const handle = await up(io, opts);
      if (handle === undefined) return 1;
      stopOnSignals(handle, io);
      return 0;
    },
  },
  init: {
    json: true,
    run: (io, opts, values) =>
      init(io, opts, {
        yes: values.yes === true,
        // --json has nobody to answer the screens: its objects are for whoever is driving the run.
        nonInteractive: values["non-interactive"] === true || values.json === true,
        json: values.json === true,
        ...(values.recipe !== undefined ? { recipe: values.recipe } : {}),
      }),
  },
  doctor: {
    json: false,
    run: async (io, opts) => {
      const keys = await loadKeys(io);
      const rt = makeRuntime(keys, opts.statePath);
      return doctor(rt, io, keys.anthropic !== undefined ? { envs: claudeEnvs(keys.anthropic) } : {});
    },
  },
};

/** The words that take --json on the shared parse and those that refuse it, the one fact the refusal and its test read. */
export const JSON_COMMANDS: readonly string[] = Object.keys(COMMANDS).filter(w => COMMANDS[w]!.json);
export const PROSE_COMMANDS: readonly string[] = Object.keys(COMMANDS).filter(w => !COMMANDS[w]!.json);

/** The word `recipe` opens the command, as `mcp` does: its flags are its own, so `--json` and the rest never reach
 * the shared parse, where a command with no table to print would take them and answer in prose. */
const RECIPE_COMMAND = "recipe";

/** The words only the write verb reads. `scan` writes nothing, so one of these on its line is a person asking for
 * something that will not happen, and it is refused rather than dropped. */
const WRITE_ONLY_FLAGS = ["tick", "set", "signin", "add", "add-check", "out"] as const;

const recipeUsage = (): string =>
  `usage: wsp ${RECIPE_COMMAND} [--tick used|installed|default] [--set <id>=on|off] [--signin <id>=${LOGIN_CHOICES.join("|")}] [--add <id>=<command>] [--add-check <id>=<command>] [--project <folder>] [--out <path>] [--json]\n       wsp ${RECIPE_COMMAND} scan [--project <folder>] [--json]`;

/** `wsp recipe` and `wsp recipe scan`: read this computer, write the recipe file (scan writes nothing) and print
 * the table, or the same object as JSON. Progress goes to stderr so what is on stdout is the whole answer. */
async function recipe(io: CliIO, argv: string[], statePathOf: (flag?: string) => string): Promise<number> {
  const usage = recipeUsage();
  let values: { out?: string; tick?: string; set?: string[]; signin?: string[]; add?: string[]; "add-check"?: string[]; project?: string[]; json?: boolean; state?: string; help?: boolean };
  let words: string[];
  try {
    ({ values, positionals: words } = parseArgs({
      args: argv,
      options: {
        out: { type: "string" },
        tick: { type: "string" },
        set: { type: "string", multiple: true },
        signin: { type: "string", multiple: true },
        add: { type: "string", multiple: true },
        "add-check": { type: "string", multiple: true },
        project: { type: "string", multiple: true },
        json: { type: "boolean" },
        state: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    }));
  } catch (e) {
    io.error(`${e instanceof Error ? e.message : String(e)}\n\n${usage}`);
    return 1;
  }
  if (values.help === true) {
    io.log(usage);
    return 0;
  }
  const statePath = statePathOf(values.state);
  if (words.length > 0 && (words[0] !== "scan" || words.length !== 1)) {
    io.error(`unknown command: wsp ${RECIPE_COMMAND} ${words.join(" ")}\n\n${usage}`);
    return 1;
  }
  const scanning = words[0] === "scan";
  if (scanning) {
    const flags = WRITE_ONLY_FLAGS.filter(f => values[f] !== undefined).map(f => `--${f}`);
    if (flags.length > 0) {
      const named = flags.length === 1 ? flags[0] : `${flags.slice(0, -1).join(", ")} and ${flags.at(-1)}`;
      io.error(`wsp ${RECIPE_COMMAND} scan writes nothing, so ${named} ${flags.length === 1 ? "is" : "are"} the write verb's alone\n\n${usage}`);
      return 1;
    }
  }
  if (values.tick !== undefined && !isRecipeTick(values.tick)) {
    io.error(`--tick takes one of ${RECIPE_TICKS.join(", ")}, not ${JSON.stringify(values.tick)}`);
    return 1;
  }
  // The reading is progress, not the answer: stdout carries the table alone, so --json is one object and nothing else.
  const streams = { log: (line: string) => io.log(line), note: (line: string) => io.error(line) };
  const depth = colourDepth(isTTY(process.stdout));
  const projects = values.project !== undefined ? { projects: values.project.map(p => resolve(p)) } : {};
  const out = resolve(values.out ?? smallRecipePath(statePath));
  try {
    if (scanning) {
      const scan = await runScan(nodeHost(), { ...projects, alsoHere: recipe => scanTools(nodeHost(), recipe) }, streams);
      if (values.json === true) io.log(JSON.stringify(scan));
      else {
        for (const line of scanPrintout(scan, depth)) io.log(line);
        io.log(`Nothing was written. Take the do column with wsp recipe --set <id>=on and --signin <id>=machine, then run wsp init --recipe ${out}.`);
      }
      return 0;
    }
    const table = await runRecipe(
      nodeHost(),
      {
        out,
        ...(values.tick !== undefined ? { tick: values.tick } : {}),
        ...(values.set !== undefined ? { set: values.set } : {}),
        ...(values.signin !== undefined ? { signin: values.signin } : {}),
        ...(values.add !== undefined ? { add: values.add } : {}),
        ...(values["add-check"] !== undefined ? { addCheck: values["add-check"] } : {}),
        ...projects,
      },
      streams,
    );
    if (values.json === true) io.log(JSON.stringify(table));
    else {
      for (const line of recipePrintout(table, depth)) io.log(line);
      io.log(`Recipe written to ${out}. Review it, flip a row with wsp recipe --set <id>=on, then run wsp init --recipe ${out}.`);
    }
    return 0;
  } catch (e) {
    io.error(`wsp recipe: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** The word `mcp` opens the command, as a verb's words open a verb: its flags are its own, so it is dispatched on
 * that word before the shared parse ever sees them. */
const MCP_COMMAND = "mcp";

const mcpInstallUsage = (): string => `wsp ${MCP_COMMAND} install --agent <id> [--agent <id>] [--json]   (${MCP_AGENT_IDS})`;
const mcpUsage = (): string => `usage: wsp ${MCP_COMMAND}\n       ${mcpInstallUsage()}`;

/** The usage of the command a line stopped short of, whether it is a verb, `mcp` or `recipe`; none when no command
 * owns the word. Those two need their own answer here because neither is in the verb table and their flags follow
 * the word. */
function commandUsage(word: string): string | undefined {
  if (word === MCP_COMMAND) return mcpUsage();
  if (word === RECIPE_COMMAND) return recipeUsage();
  return verbUsage(word);
}

/** `wsp mcp` serves until the agent closes its stdin; `wsp mcp install --agent <id>` writes the agent's config,
 * once per `--agent` given, and answers with the lines or, with `--json`, the report as one line. Its flags are
 * parsed here rather than in the table every command shares, so a command that has no JSON to print refuses
 * `--json` instead of taking it and printing prose. */
async function mcp(io: CliIO, argv: string[], statePathOf: (flag?: string) => string): Promise<number> {
  const usage = mcpUsage();
  let values: { agent?: string[]; json?: boolean; state?: string; help?: boolean };
  let words: string[];
  try {
    ({ values, positionals: words } = parseArgs({
      args: argv,
      options: {
        agent: { type: "string", multiple: true },
        json: { type: "boolean" },
        state: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    }));
  } catch (e) {
    io.error(`${e instanceof Error ? e.message : String(e)}\n\n${usage}`);
    return 1;
  }
  if (values.help === true) {
    io.log(usage);
    return 0;
  }
  const statePath = statePathOf(values.state);
  if (words.length === 0) {
    await serveMcp(statePath, { alsoHere: recipe => scanTools(nodeHost(), recipe) });
    return 0;
  }
  if (words[0] !== "install" || words.length !== 1) {
    io.error(`unknown command: ${MCP_COMMAND} ${words.join(" ")}\n\n${usage}`);
    return 1;
  }
  const agents = values.agent ?? [];
  if (agents.length === 0) {
    io.error(`usage: ${mcpInstallUsage()}`);
    return 1;
  }
  const json = values.json === true;
  const report = installEach(agents, mcpServerSpec(statePath), homedir());
  if (json) io.log(JSON.stringify(report));
  else {
    for (const placed of report.installed) for (const line of installLines(placed)) io.log(line);
    for (const failed of report.failures) io.error(`wsp mcp install: ${failed.error}`);
  }
  return report.failures.length > 0 ? 1 : 0;
}

export async function cli(argv: string[], io: CliIO = terminalIO()): Promise<number> {
  const verb = findVerb(argv);
  if (verb !== undefined) return runVerb(verb, argv, io, statePathFrom);
  if (argv[0] === MCP_COMMAND) return mcp(io, argv.slice(1), statePathFrom);
  if (argv[0] === RECIPE_COMMAND) return recipe(io, argv.slice(1), statePathFrom);
  let values: SharedFlags;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
        port: { type: "string" },
        "ws-port": { type: "string" },
        state: { type: "string" },
        yes: { type: "boolean", short: "y" },
        "non-interactive": { type: "boolean" },
        json: { type: "boolean" },
        recipe: { type: "string" },
        out: { type: "string" },
        add: { type: "string", multiple: true },
        "add-check": { type: "string", multiple: true },
      },
      allowPositionals: true,
    }));
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (values.version) {
    io.log(`wsp ${VERSION}`);
    return 0;
  }
  if (values.help) {
    io.log(HELP);
    return 0;
  }
  const opts = {
    port: values.port !== undefined ? Number(values.port) : 4400,
    wsPort: values["ws-port"] !== undefined ? Number(values["ws-port"]) : 4410,
    statePath: statePathFrom(values.state),
  };
  const word = positionals[0] ?? "up";
  const command = COMMANDS[word];
  if (command === undefined) {
    io.error(commandUsage(word) ?? `unknown command: ${word}\n\n${HELP}`);
    return 1;
  }
  if (values.json === true && !command.json) {
    io.error(`Unknown option '--json' for wsp ${word}: only ${JSON_COMMANDS.map(w => `wsp ${w}`).join(", ")} prints JSON.`);
    return 1;
  }
  return command.run(io, opts, values);
}
