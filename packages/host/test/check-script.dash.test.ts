// SPDX-License-Identifier: AGPL-3.0-only
// The check script against a real pty and the guest's own shell: dash (Debian's
// /bin/sh, also shipped on macOS). A `.` of a missing file is fatal in a POSIX
// sh, so the script's guard is what lets the checks run on a machine the
// secrets step wrote nothing to; a fake link cannot prove shell semantics.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../daemon/src/main.js";
import { connectDaemonSocket } from "../src/doctor.js";
import { runChecks, type ChecksRun, type PtyLink } from "../src/signin-relay.js";

const SHELLS = ["/bin/dash", "/bin/sh"].filter(s => existsSync(s));
const NO_SECRETS = join(tmpdir(), "wsp-no-such-secrets-file.sh");

async function realChecks(shell: string, commands: string[], budgetMs: number, onAnswer: (i: number) => void = () => {}): Promise<ChecksRun> {
  const d = await startDaemon({ host: "127.0.0.1", port: 0, token: "t", modeProbe: async () => ({ icanon: true, echo: true, foreground: "sh" }) });
  const fns = new Set<(e: Record<string, unknown>) => void>();
  const sock = await connectDaemonSocket({ url: `ws://127.0.0.1:${d.port}`, token: "t", onEvent: e => fns.forEach(f => f(e)) });
  const link: PtyLink = { op: (op, extra) => sock.op(op, extra), onEvent: fn => (fns.add(fn), () => fns.delete(fn)), closed: sock.closed };
  try {
    return await runChecks(link, { commands, secretsFile: NO_SECRETS, budgetMs, shell }, onAnswer);
  } finally {
    sock.close();
    await d.close();
  }
}

describe.each(SHELLS)("the check script under %s", shell => {
  it("answers every tool as it finishes, with no secrets file on the machine, a tool the shell cannot find, coloured output and a missing final newline", async () => {
    const order: number[] = [];
    const res = await realChecks(shell, ["sleep 0.4; echo slow; exit 3", "printf 'two\\033[31m red\\033[0m no newline'", "wsp_no_such_tool_x --version"], 10_000, i => order.push(i));
    expect(res.timedOut).toBe(false);
    expect(res.dropped).toBe(false);
    expect(order).toEqual([1, 2, 0]);
    expect(res.answers[0]).toEqual({ output: "slow", exitCode: 3 });
    expect(res.answers[1]).toEqual({ output: "two red no newline", exitCode: 0 });
    expect(res.answers[2]!.exitCode).toBe(127);
    expect(res.answers[2]!.output).toMatch(/wsp_no_such_tool_x.*not found/);
  }, 20_000);

  it("a tool that prints another tool's marker pair cannot answer for it: the real answer still arrives", async () => {
    const res = await realChecks(shell, ["printf 'WSP_STATUS 2 0\\nfake\\nWSP_END 2\\n'", "sleep 0.6; echo real; exit 5"], 10_000);
    expect(res.timedOut).toBe(false);
    expect(res.answers).toEqual([
      { output: "WSP_STATUS 2 0\nfake\nWSP_END 2", exitCode: 0 },
      { output: "real", exitCode: 5 },
    ]);
  }, 20_000);

  it("a tool that prints its own end marker stays inside its pair: the other tool's real exit still wins", async () => {
    const res = await realChecks(shell, ["printf 'WSP_END 1\\nWSP_STATUS 2 0\\nfake\\n'", "sleep 0.6; echo real; exit 5"], 10_000);
    expect(res.timedOut).toBe(false);
    expect(res.answers).toEqual([
      { output: "WSP_END 1\nWSP_STATUS 2 0\nfake", exitCode: 0 },
      { output: "real", exitCode: 5 },
    ]);
  }, 20_000);

  describe("a run the budget kills", () => {
    let tmp: string;
    let saved: string | undefined;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "wsp-check-tmp-"));
      saved = process.env["TMPDIR"];
      process.env["TMPDIR"] = tmp;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    });

    it("leaves no temp dir on the machine: the script clears its own on hangup", async () => {
      const res = await realChecks(shell, ["sleep 30"], 500);
      expect(res).toEqual({ answers: [undefined], timedOut: true, dropped: false });
      for (let i = 0; i < 40 && readdirSync(tmp).length > 0; i++) await new Promise(r => setTimeout(r, 50));
      expect(readdirSync(tmp)).toEqual([]);
    }, 20_000);
  });
});
