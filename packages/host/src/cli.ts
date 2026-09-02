// SPDX-License-Identifier: AGPL-3.0-only
// wsp: local app entry. Embeds the runtime in-process and serves the web app
// on loopback. There is no control plane; the Solari key is read here
// and used only for direct calls from this process to the machine API.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import {
  SolariBackend,
  createRuntime,
  jsonFileStore,
  machineExecStream,
  type GoldenBuilderView,
  type GoldenRecipe,
  type Machine,
  type Runtime,
} from "@wsp/runtime";
import { CONFIG_DIR, GOLDEN_SETUP, GOLDEN_SMOKE, claudeEnvs, deployDaemon, doctor } from "./doctor.js";
import { runInit, type InitIO } from "./init.js";
import type { ChecklistItem, Manifest } from "./init-recipe.js";
import { startHost, type HostHandle } from "./server.js";
import { TerminalInput } from "./terminal-input.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export const HELP = `wsp - local workspaces for coding agents

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
  --yes              init: take every default and ask nothing (required off a terminal)
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
  ask(question: string): Promise<string>;
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

export function wspHome(): string {
  return process.env["WSP_HOME"] ?? join(homedir(), ".wsp");
}

export function terminalIO(): CliIO {
  const input = new TerminalInput(process.stdin, process.stdout);
  return {
    log: line => console.log(line),
    error: line => console.error(line),
    ask: q => input.ask(q),
    askSecret: q => input.askSecret(q),
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

  io.log(`No SOLARI_API_KEY in the environment, ./.env, or ${homeEnv}.`);
  solari = (await io.askSecret("Solari API key: ")).trim();
  if (!solari) throw new Error("cannot start without a Solari API key");
  const set: Record<string, string> = { SOLARI_API_KEY: solari };

  if (anthropic === undefined && ask.anthropic) {
    io.log(
      "An Anthropic API key is optional. On a Claude subscription, press enter to skip and sign in with /login inside your machine later, so wsp never sees that credential.",
    );
    const typed = (await io.askSecret("Anthropic API key (enter to skip): ")).trim();
    if (typed) {
      anthropic = typed;
      set["ANTHROPIC_API_KEY"] = typed;
    }
  }

  const save = (await io.ask(`Save to ${homeEnv} (mode 600) so wsp stops asking? [y/N] `)).trim().toLowerCase();
  if (save === "y" || save === "yes") {
    writeEnvFile(homeEnv, set);
    io.log(`saved ${homeEnv}`);
  }
  return { solari, ...(anthropic !== undefined ? { anthropic } : {}) };
}

/** What every golden the wizard seals is made of: the harness install and its
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
          configDir: CONFIG_DIR,
        }),
    },
    goldenRecipe: recipe,
  });
}

interface HostLock {
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

/** Runs a short-lived helper and reports whether it exited clean. */
function runQuiet(cmd: string, args: string[], stdin?: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("exit", code => resolve(code === 0));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

export function terminalInitIO(): InitIO {
  const os = platform();
  return {
    input: process.stdin,
    output: process.stdout,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    env: process.env,
    open: url => runQuiet(os === "darwin" ? "open" : os === "win32" ? "explorer" : "xdg-open", [url]),
    copy: async text => {
      if (os === "darwin") return runQuiet("pbcopy", [], text);
      if (os === "win32") return runQuiet("clip", [], text);
      return (await runQuiet("wl-copy", [], text)) || runQuiet("xclip", ["-selection", "clipboard"], text);
    },
  };
}

/** Until the collector package lands, this machine reads as empty; --manifest
 * carries the list instead. */
async function collectNothing(): Promise<Manifest> {
  return { entries: [] };
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

async function init(io: CliIO, opts: { port: number; wsPort: number; statePath: string }, flags: { yes: boolean; manifest?: string }): Promise<number> {
  refuseIfServed(lockPathFor(opts.statePath), opts.statePath);
  const keys = await loadKeys(io, undefined, { anthropic: false });
  const result = await runInit(
    {
      yes: flags.yes,
      ...(flags.manifest !== undefined ? { manifestPath: resolve(flags.manifest) } : {}),
      collect: collectNothing,
      keys,
      statePath: opts.statePath,
      runtime: recipe => makeRuntime(keys, opts.statePath, { ...recipe, deployDaemon: async machine => `node ${(await deployDaemon(machine)).node}` }),
      host: (rt, builder, checklist) => hostFor(rt, keys, { ...opts, builder, checklist }, io),
    },
    terminalInitIO(),
  );
  if (result.handle !== undefined) stopOnSignals(result.handle, io);
  return result.code;
}

export async function serve(
  io: CliIO,
  opts: { port: number; wsPort: number; statePath: string; webDir?: string; runtime?: Runtime },
): Promise<HostHandle> {
  const keys = await loadKeys(io);
  const rt = opts.runtime ?? makeRuntime(keys, opts.statePath);
  return hostFor(rt, keys, opts, io);
}

async function hostFor(
  rt: Runtime,
  keys: Keys,
  opts: { port: number; wsPort: number; statePath: string; webDir?: string; builder?: GoldenBuilderView; checklist?: ChecklistItem[] },
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
      keys: { anthropic: keys.anthropic !== undefined },
      ...(opts.builder !== undefined ? { builder: opts.builder } : {}),
      ...(opts.checklist !== undefined ? { checklist: opts.checklist } : {}),
      ...(keys.anthropic !== undefined ? { workspaceEnvs: claudeEnvs(keys.anthropic) } : {}),
      log: line => io.log(line),
    });
    writeFileSync(lockPath, JSON.stringify({ ...lock, port: handle.port, wsPort: handle.wsPort }));
    // Other local tools read the token from disk; the WS never sees it in a URL.
    const tokenPath = join(dirname(opts.statePath), "host-token");
    writeFileSync(tokenPath, handle.authToken, { mode: 0o600 });

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
