// SPDX-License-Identifier: AGPL-3.0-only
// The check script against a real pty and the guest's own shell: dash (Debian's
// /bin/sh, also shipped on macOS). A `.` of a missing file is fatal in a POSIX
// sh, so the script's guard is what lets the checks run on a machine the
// secrets step wrote nothing to; a fake link cannot prove shell semantics.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startDaemon } from "../../daemon/src/main.js";
import { connectDaemonSocket } from "../src/doctor.js";
import { runChecks, type PtyLink } from "../src/signin-relay.js";

const SHELLS = ["/bin/dash", "/bin/sh"].filter(s => existsSync(s));

describe.each(SHELLS)("the check script under %s", shell => {
  it("answers every tool as it finishes, with no secrets file on the machine, a tool the shell cannot find, coloured output and a missing final newline", async () => {
    const d = await startDaemon({ host: "127.0.0.1", port: 0, token: "t", modeProbe: async () => ({ icanon: true, echo: true, foreground: "sh" }) });
    const fns = new Set<(e: Record<string, unknown>) => void>();
    const sock = await connectDaemonSocket({ url: `ws://127.0.0.1:${d.port}`, token: "t", onEvent: e => fns.forEach(f => f(e)) });
    const link: PtyLink = { op: (op, extra) => sock.op(op, extra), onEvent: fn => (fns.add(fn), () => fns.delete(fn)), closed: sock.closed };
    const order: number[] = [];
    try {
      const commands = ["sleep 0.4; echo slow; exit 3", "printf 'two\\033[31m red\\033[0m no newline'", "wsp_no_such_tool_x --version"];
      const res = await runChecks(link, { commands, secretsFile: join(tmpdir(), "wsp-no-such-secrets-file.sh"), budgetMs: 10_000, shell }, i => order.push(i));
      expect(res.timedOut).toBe(false);
      expect(res.dropped).toBe(false);
      expect(order).toEqual([1, 2, 0]);
      expect(res.answers[0]).toEqual({ output: "slow", exitCode: 3 });
      expect(res.answers[1]).toEqual({ output: "two red no newline", exitCode: 0 });
      expect(res.answers[2]!.exitCode).toBe(127);
      expect(res.answers[2]!.output).toMatch(/wsp_no_such_tool_x.*not found/);
    } finally {
      sock.close();
      await d.close();
    }
  }, 20_000);
});
