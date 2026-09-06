// SPDX-License-Identifier: AGPL-3.0-only
// wsp: local app entry. Embeds the runtime in-process and serves the web app
// on loopback. There is no control plane; the Solari key is read here
// and used only for direct calls from this process to the machine API.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { isCancel } from "@clack/prompts";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { collect, nodeHost, nodeMachine, type Manifest, type Rung } from "@wsp/collect";
import {
  SolariBackend,
  createRuntime,
  hostIdentity,
  jsonFileStore,
  machineExecStream,
  type GoldenBuilderView,
  type GoldenRecipe,
  type GoldenVersion,
  type Machine,
  type Runtime,
} from "@wsp/runtime";
import { CLAUDE_CONFIG_DIR, GOLDEN_SETUP, GOLDEN_SMOKE } from "@wsp/catalog";
import { claudeEnvs, deployDaemon, doctor } from "./doctor.js";
import { keychainReader } from "./init-import.js";
import { readBrewTable } from "./init-brew.js";
import { runInit, type InitIO } from "./init.js";
import { recipePath } from "./init-recipe.js";
import { confirmPrompt, passwordPrompt, type PromptOptions } from "./init-layout.js";
import { TAGLINE, opening } from "./init-opening.js";
import { systemOpener, type UrlOpener } from "./relay.js";
import { startHost, type HostHandle } from "./server.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export const HELP = `wsp - ${TAGLINE}

usage:
  wsp                start the runtime and serve the app on localhost
  wsp init           set up your first golden image: tick what comes along from
                     this machine, build it, then finish in the browser
  wsp doctor         run the reach loop end to end against one live machine
  wsp --version      print the version

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
  --manifest PATH    init: tick from this file instead of reading the machine; a
                     saved recipe (<state dir>/golden-recipe.json) works here

keys are read from the environment, then ./.env, then ~/.wsp/.env (WSP_HOME
overrides ~/.wsp). The prompt runs only when no Solari key is found; it asks
for the optional Anthropic key at the same time and can save both to that file.
With a Solari key present, a missing Anthropic key is only noted at start.
`;

export interface CliIO {
  log(line: string): void;
  error(line: string): void;
  /** A yes-or-no question; resolves to "yes" or "no". */
  ask(question: string): Promise<string>;
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
    ask: q => (screen ? answered(confirmPrompt(split(q))).then(yes => (yes ? "yes" : "no")) : nobody(q)),
    askSecret: q => (screen ? answered(passwordPrompt(split(q))) : nobody(q)),
  };
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
    deployDaemon: hooks.deployDaemon ?? (async machine => `node ${(await deployDaemon(machine)).node}`),
  };
}

/** The built web app, next to the @wsp/web package the host depends on. */
function defaultWebDir(): string {
  return join(dirname(createRequire(import.meta.url).resolve("@wsp/web/package.json")), "dist");
}

function defaultStatePath(): string {
  // A .env in cwd marks a dev checkout; share its .wsp state with wspx.
  if (existsSync(join(process.cwd(), ".env"))) return join(process.cwd(), ".wsp", "state.json");
  return join(wspHome(), "state.json");
}

export function makeRuntime(keys: Keys, statePath: string, recipe: GoldenRecipe = goldenRecipe(keys)): Runtime {
  return createRuntime({
    backend: new SolariBackend({ apiKey: keys.solari }),
    store: jsonFileStore(statePath),
    adapters: {
      claude: ctx =>
        createClaudeAdapter({
          exec: machineExecStream(ctx.machine),
          configDir: CLAUDE_CONFIG_DIR,
        }),
    },
    goldenRecipe: recipe,
    hostId: hostIdentity(),
  });
}

export interface HostLock {
  pid: number;
  port: number;
  wsPort: number;
  startedAt: string;
}

function isHostLock(v: unknown): v is HostLock {
  return (
    typeof v === "object" &&
    v !== null &&
    "pid" in v &&
    typeof v.pid === "number" &&
    "port" in v &&
    typeof v.port === "number" &&
    "wsPort" in v &&
    typeof v.wsPort === "number" &&
    "startedAt" in v &&
    typeof v.startedAt === "string"
  );
}

function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** EPERM means the pid exists under another user, so it counts as alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === "EPERM";
  }
}

function readLock(path: string): HostLock | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isHostLock(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function heldBy(lock: HostLock, statePath: string): Error {
  return new Error(
    `another wsp host (pid ${lock.pid}) is already serving ${statePath} on port ${lock.port} (ws ${lock.wsPort}). ` +
      "Stop it first, or point --state at a different file.",
  );
}

function lockPathFor(statePath: string): string {
  return join(dirname(statePath), "host.lock");
}

/** The host whose lock names this state file, when that process is still alive. */
export function servingHost(statePath: string): HostLock | undefined {
  const held = readLock(lockPathFor(statePath));
  return held !== undefined && pidAlive(held.pid) ? held : undefined;
}

/** One state file, one host. A lock whose pid is gone is a crash leftover and
 * gives way; a lock this process cannot parse is treated the same. */
function refuseIfServed(lockPath: string, statePath: string): void {
  const held = readLock(lockPath);
  if (held !== undefined && pidAlive(held.pid)) throw heldBy(held, statePath);
}

/** Seeded with the requested ports so a refusal during startup can name them;
 * rewritten with the bound ports once the host is up. */
function takeLock(lockPath: string, statePath: string, ports: { port: number; wsPort: number }): HostLock {
  refuseIfServed(lockPath, statePath);
  const lock: HostLock = { pid: process.pid, ...ports, startedAt: new Date().toISOString() };
  mkdirSync(dirname(lockPath), { recursive: true });
  rmSync(lockPath, { force: true });
  try {
    writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx" });
  } catch (e) {
    if (errnoCode(e) !== "EEXIST") throw e;
    const winner = readLock(lockPath);
    throw winner !== undefined ? heldBy(winner, statePath) : new Error(`another wsp host just took ${lockPath}`);
  }
  return lock;
}

export function terminalInitIO(): InitIO {
  const os = platform();
  return {
    input: process.stdin,
    output: process.stdout,
    stderr: process.stderr,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    env: process.env,
    open: systemOpener(os),
    signals: process,
    exit: code => process.exit(code),
  };
}

/** The collector's ladder over this laptop, then everything else it left unclaimed; onRung lets the terminal count rows as each rung lands. */
function collectThisComputer(onRung: (rung: Rung, rows: number) => void, onNote: (note: string) => void): Promise<Manifest> {
  return collect(nodeHost(), { onRung, onNote, machine: nodeMachine() });
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

async function init(io: CliIO, opts: { port: number; wsPort: number; statePath: string }, flags: { yes: boolean; manifest?: string }): Promise<number> {
  const held = servingHost(opts.statePath);
  if (held !== undefined) {
    io.error(initRefusal(held, opts.statePath));
    return 1;
  }
  const screen = terminalInitIO();
  opening(screen, { command: "init", version: VERSION, yes: flags.yes });
  const keys = await loadKeys(io, undefined, { anthropic: false });
  const result = await runInit(
    {
      yes: flags.yes,
      ...(flags.manifest !== undefined ? { manifestPath: resolve(flags.manifest) } : {}),
      collect: collectThisComputer,
      keys,
      pricing: new SolariBackend({ apiKey: keys.solari }).pricing,
      statePath: opts.statePath,
      home: homedir(),
      secrets: keychainReader(),
      platform: platform() === "darwin" ? "darwin" : "linux",
      brew: () => readBrewTable(nodeHost()),
      runtime: recipe => makeRuntime(keys, opts.statePath, { ...recipe, deployDaemon: async machine => `node ${(await deployDaemon(machine)).node}` }),
      host: (rt, builder, hooks) => hostFor(rt, keys, { ...opts, builder, ...hooks }, io),
    },
    screen,
  );
  if (result.handle !== undefined) stopOnSignals(result.handle, io);
  return result.code;
}

export async function serve(
  io: CliIO,
  opts: { port: number; wsPort: number; statePath: string; webDir?: string; runtime?: Runtime; openUrl?: UrlOpener },
): Promise<HostHandle> {
  const keys = await loadKeys(io);
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath);
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
      webDir: opts.webDir ?? defaultWebDir(),
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
    const tokenPath = join(dirname(opts.statePath), "host-token");
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

export async function cli(argv: string[], io: CliIO = terminalIO()): Promise<number> {
  let values: { version?: boolean; help?: boolean; port?: string; "ws-port"?: string; state?: string; yes?: boolean; manifest?: string };
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
        manifest: { type: "string" },
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
    statePath: resolve(values.state ?? defaultStatePath()),
  };
  const [cmd] = positionals;
  switch (cmd) {
    case undefined:
      stopOnSignals(await serve(io, opts), io);
      return 0;
    case "init":
      return init(io, opts, { yes: values.yes === true, ...(values.manifest !== undefined ? { manifest: values.manifest } : {}) });
    case "doctor": {
      const keys = await loadKeys(io);
      const rt = makeRuntime(keys, opts.statePath);
      return doctor(rt, io, keys.anthropic !== undefined ? { envs: claudeEnvs(keys.anthropic) } : {});
    }
    default:
      io.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}
