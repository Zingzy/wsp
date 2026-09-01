// SPDX-License-Identifier: AGPL-3.0-only
// wsp: local app entry. Embeds the runtime in-process and serves the status
// shell on loopback. There is no control plane; the Solari key is read here
// and used only for direct calls from this process to the machine API.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { SolariBackend, createRuntime, jsonFileStore, machineExecStream, type Runtime } from "@wsp/runtime";
import { doctor } from "./doctor.js";
import { startHost } from "./server.js";

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
`;

export interface CliIO {
  log(line: string): void;
  error(line: string): void;
}

interface Keys {
  solari: string;
  anthropic?: string;
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

async function loadKeys(io: CliIO): Promise<Keys> {
  const file = parseEnvFile(join(process.cwd(), ".env"));
  let solari = process.env["SOLARI_API_KEY"] ?? file["SOLARI_API_KEY"];
  const anthropic = process.env["ANTHROPIC_API_KEY"] ?? file["ANTHROPIC_API_KEY"];
  if (!solari) {
    io.log("No SOLARI_API_KEY in the environment or ./.env.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    solari = (await rl.question("Solari API key (kept in memory only): ")).trim();
    rl.close();
    if (!solari) throw new Error("cannot start without a Solari API key");
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
  return join(homedir(), ".wsp", "state.json");
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

export async function cli(argv: string[], io: CliIO = console): Promise<number> {
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
