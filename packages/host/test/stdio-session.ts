// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_VERSION, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, TURN_TOKEN_ENV } from "@wsp/protocol";
import { expect, vi } from "vitest";

/** This process's environment less every variable that aims a line at a host, so a spawned wsp reaches the host this
 * case serves and no other. */
export const ownEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => ![HOST_URL_ENV, HOST_TOKEN_ENV, HOST_KEY_ENV, TURN_TOKEN_ENV, "WSP_HOST", "WSP_STARTED_BY"].includes(name)));

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** How long the binary has to say its version: a read at collection that never ends would hang every suite. */
const VERSION_READ_MS = 3_000;

/** The binary a tool server suite drives, off the path given (WSP_MCP_BIN, from the repository's top), or nothing where
 * none is named. One built from another version of this tree is refused here: it lacks what this tree's cases ask of
 * it, and every case would otherwise wait out its budget on a server that exited at its first flag. */
export function mcpBinNamed(named: string | undefined): string | undefined {
  if (named === undefined || named === "") return undefined;
  const bin = resolve(REPO, named);
  const refused = (said: string): Error => new Error(`WSP_MCP_BIN names ${bin}, ${said}, and this tree cuts ${DAEMON_VERSION}: build this tree's with cargo build -p wsp-daemon-bin --features mcp and name that one`);
  let version: string;
  try {
    version = execFileSync(bin, ["version"], { encoding: "utf8", timeout: VERSION_READ_MS, killSignal: "SIGKILL" }).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ETIMEDOUT") throw refused(`which did not say its version within ${VERSION_READ_MS / 1000} s`);
    throw e;
  }
  if (version !== String(DAEMON_VERSION)) throw refused(`a wsp-daemon of version ${version}`);
  return bin;
}

/** One stdio session with a tool server: each line written in turn, and the lines it printed once it has answered
 * every request among them; then its stdin closes and its code is read. A server that exits before an answer fails
 * the session at once with its code. */
export async function served(argv: readonly string[], env: NodeJS.ProcessEnv, lines: readonly Record<string, unknown>[], cwd?: string): Promise<{ out: string[]; code: number | null }> {
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["pipe", "pipe", "inherit"], ...(cwd !== undefined ? { cwd } : {}) });
  const out: string[] = [];
  let held = "";
  child.stdout.on("data", (chunk: Buffer) => {
    held += chunk.toString("utf8");
    for (let at = held.indexOf("\n"); at !== -1; at = held.indexOf("\n")) {
      out.push(held.slice(0, at));
      held = held.slice(at + 1);
    }
  });
  // Close rather than exit: by then everything the server printed has been read.
  let gone: number | null | undefined;
  const exited = new Promise<number | null>(done => child.once("close", code => done((gone = code))));
  try {
    for (const line of lines) {
      const answered = out.length + ("id" in line ? 1 : 0);
      child.stdin.write(`${JSON.stringify(line)}\n`);
      await vi.waitFor(() => gone === undefined && expect(out.length).toBe(answered), { timeout: 15_000, interval: 20 });
      if (out.length < answered) throw new Error(`${argv.slice(1).join(" ")}: the tool server exited with code ${gone} before it answered ${JSON.stringify(line)}`);
    }
    child.stdin.end();
    return { out, code: await exited };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
