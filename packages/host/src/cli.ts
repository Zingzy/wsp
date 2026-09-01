// SPDX-License-Identifier: AGPL-3.0-only
// wsp: local app entry. Embeds the runtime in-process and serves the status
// shell on loopback. There is no control plane; the Solari key is read here
// and used only for direct calls from this process to the machine API.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { SolariBackend, createRuntime, jsonFileStore, machineExecStream, type Runtime } from "@wsp/runtime";
import { doctor } from "./doctor.js";
import { startHost } from "./server.js";
import { TerminalInput } from "./terminal-input.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const CONFIG_DIR = "/root/.claude-cfg";

export const HELP = `wsp - local workspaces for coding agents

usage:
  wsp                start the runtime and the status shell on localhost
  wsp doctor         run the reach loop end to end against one live machine
  wsp --version      print the version

options:
  --port N           shell port (default 4400)
  --ws-port N        runtime websocket port (default 4410)
  --state PATH       state file (default ~/.wsp/state.json, or ./.wsp/state.json
                     when the current directory has a .env)

keys are read from the environment, then ./.env, then ~/.wsp/.env (WSP_HOME
overrides ~/.wsp). Missing keys are prompted for and can be saved to that file.
`;

export interface CliIO {
  log(line: string): void;
  error(line: string): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
}

interface Keys {
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

  if (anthropic === undefined) {
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

function claudeEnvs(anthropicKey: string): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: anthropicKey,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    IS_SANDBOX: "1",
    PATH: "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

function defaultStatePath(): string {
  // A .env in cwd marks a dev checkout; share its .wsp state with wspx.
  if (existsSync(join(process.cwd(), ".env"))) return join(process.cwd(), ".wsp", "state.json");
  return join(wspHome(), "state.json");
}

export function makeRuntime(keys: Keys, statePath: string): Runtime {
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
  });
}

async function serve(
  io: CliIO,
  opts: { port: number; wsPort: number; statePath: string },
): Promise<number> {
  const keys = await loadKeys(io);
  const rt = makeRuntime(keys, opts.statePath);
  const handle = await startHost({
    runtime: rt,
    port: opts.port,
    wsPort: opts.wsPort,
    ...(keys.anthropic !== undefined ? { workspaceEnvs: claudeEnvs(keys.anthropic) } : {}),
  });
  // The future UI reads the token from disk; the WS never sees it in a URL.
  const tokenPath = join(dirname(opts.statePath), "host-token");
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, handle.authToken, { mode: 0o600 });

  io.log(`shell       http://127.0.0.1:${handle.port}`);
  io.log(`runtime ws  ws://127.0.0.1:${handle.wsPort} (token: ${tokenPath})`);
  io.log(`state       ${opts.statePath}`);
  if (keys.anthropic === undefined) {
    io.log("note: no ANTHROPIC_API_KEY found; new workspaces fork without claude credentials");
  }
  return 0;
}

export async function cli(argv: string[], io: CliIO = terminalIO()): Promise<number> {
  let values: { version?: boolean; help?: boolean; port?: string; "ws-port"?: string; state?: string };
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
      return serve(io, opts);
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
