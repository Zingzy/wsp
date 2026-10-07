// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENV_FROM_INPUT } from "@wsp/protocol";
import type { ExecResult, Machine } from "../src/machine.js";
import { envExec, harnessExec } from "../src/run-env.js";

/** This computer's bash as a machine's exec, every command's text kept; `stdin` hands it the input, as a computer you
 * own does, and without it the input is dropped, as a provider's exec drops it. */
function bashMachine(stdin: boolean): { machine: Pick<Machine, "exec" | "takesStdin">; texts: string[] } {
  const texts: string[] = [];
  const machine = {
    ...(stdin ? { takesStdin: true as const } : {}),
    exec: (cmd: string, opts?: { stdin?: Uint8Array }) =>
      new Promise<ExecResult>(resolve => {
        texts.push(cmd);
        const child = execFile("bash", ["-c", cmd], { env: { PATH: "/usr/bin:/bin", CLAUDE_CODE_ENTRYPOINT: "cli" } }, (e, stdout, stderr) => resolve({ exitCode: e === null ? 0 : 1, stdout, stderr }));
        child.stdin?.end(stdin && opts?.stdin !== undefined ? Buffer.from(opts.stdin) : undefined);
      }),
  };
  return { machine, texts };
}

describe("a command that reads its variables off its input", () => {
  // Inherited marks are dropped first and the command's own read after, so a variable of that family it was handed
  // stands, which a read ahead of the command would lose to the command's own unset.
  const command = `unset \${!CLAUDE_CODE_@}; ${ENV_FROM_INPUT}; printf '%s|%s|%s\\n' "$GATEWAY_TOKEN" "$CLAUDE_CODE_AUTO_CONNECT_IDE" "\${CLAUDE_CODE_ENTRYPOINT-gone}"`;

  it.each([
    { road: "on the exec's input, where the machine takes it, and no exec text holds the value", stdin: true },
    { road: "piped in from the exec's text, on a machine whose exec drops its input", stdin: false },
  ])("gets them $road", async ({ stdin }) => {
    const key = `tok-${randomBytes(6).toString("hex")}`;
    const value = "it's a \"value\"\nover two lines";
    const { machine, texts } = bashMachine(stdin);
    const res = await envExec(machine, command, { GATEWAY_TOKEN: key, CLAUDE_CODE_AUTO_CONNECT_IDE: "0", ODD: value });
    expect(res.stdout).toBe(`${key}|0|gone\n`);
    if (stdin) expect(texts.filter(t => t.includes(key))).toEqual([]);
  });

  it("reads nothing and waits on nothing when it is handed none, on either road", async () => {
    for (const stdin of [true, false]) {
      const { machine } = bashMachine(stdin);
      expect((await harnessExec(machine, 5_000)(command, {})).trim()).toBe("||gone");
    }
  });
});
