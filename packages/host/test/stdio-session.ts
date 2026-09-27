// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { FORWARD_ENV, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, TURN_TOKEN_ENV } from "@wsp/protocol";
import { expect, vi } from "vitest";

/** This process's environment less every variable that aims a line at a host, so a spawned wsp reaches the host this
 * case serves and no other. */
export const ownEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => ![HOST_URL_ENV, HOST_TOKEN_ENV, HOST_KEY_ENV, TURN_TOKEN_ENV, FORWARD_ENV, "WSP_HOST", "WSP_STARTED_BY"].includes(name)));

/** One stdio session with a tool server: each line written in turn, and the lines it printed once it has answered
 * every request among them; then its stdin closes and its code is read. */
export async function served(argv: readonly string[], env: NodeJS.ProcessEnv, lines: readonly Record<string, unknown>[]): Promise<{ out: string[]; code: number | null }> {
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["pipe", "pipe", "inherit"] });
  const out: string[] = [];
  let held = "";
  child.stdout.on("data", (chunk: Buffer) => {
    held += chunk.toString("utf8");
    for (let at = held.indexOf("\n"); at !== -1; at = held.indexOf("\n")) {
      out.push(held.slice(0, at));
      held = held.slice(at + 1);
    }
  });
  const exited = new Promise<number | null>(done => child.once("exit", code => done(code)));
  try {
    for (const line of lines) {
      const answered = out.length + ("id" in line ? 1 : 0);
      child.stdin.write(`${JSON.stringify(line)}\n`);
      await vi.waitFor(() => expect(out.length).toBe(answered), { timeout: 15_000, interval: 20 });
    }
    child.stdin.end();
    return { out, code: await exited };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
