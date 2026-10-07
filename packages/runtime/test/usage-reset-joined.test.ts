// SPDX-License-Identifier: AGPL-3.0-only
// A banked reset spent on a computer the person joined: the script runs as its
// daemon's bash -c, whose command line every login there can read, so the
// variables the person set for the agent ride the exec's own input.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, type TurnResult } from "@wsp/protocol";
import type { HarnessAdapterFactory } from "../src/runtime.js";
import { report } from "./place-join.js";
import { code, ctx, join, serving } from "./places-fixture.js";

const idle: HarnessAdapterFactory = () => ({
  steers: false,
  start: () => ({ localId: "s", finished: Promise.resolve({ status: "completed", text: "" } as TurnResult), interrupt: async () => {} }),
});

describe("a reset on a computer the person joined", () => {
  it("hands the person's launch variables to the script on its input, and no exec text holds them", async () => {
    const key = `sk-x-${randomBytes(8).toString("hex")}`;
    const row = { id: "codex", name: "Codex", installed: true, road: "own", signIn: "signed-in", signInRoad: "terminal", wspTools: false };
    const read = { home: "/home/maya", user: "maya", agents: [row], skills: [], servers: [], refused: [] };
    const { hostKey } = await serving({ adapters: { codex: idle }, agentsReader: { read: async () => read as never, tools: async () => ({ auth: "open", readAt: "2026-10-07T00:00:00.000Z" }) as never } });
    const execs: { cmd: string; stdin: string }[] = [];
    const { placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as { id?: number; op?: string; cmd?: string; stdin?: string };
          if (frame.op !== "exec") return;
          const cmd = frame.cmd ?? "";
          execs.push({ cmd, stdin: Buffer.from(frame.stdin ?? "", "base64").toString("utf8") });
          // The config folder's own read: the folder resolved, then the home.
          const stdout = cmd.includes("pwd -P") ? "/home/maya/.codex-work\n/home/maya\n" : "";
          c.say({ id: frame.id, ok: true, exitCode: 0, stdout, stderr: "", truncated: false });
        }),
    });
    const rt = ctx.runtime!;
    await rt.agents.setup(placeId, "codex", { configDir: "/home/maya/.codex-work", env: { CODEX_GATEWAY_TOKEN: key } });

    // The fake answers the read with nothing, so the reset stops there; the read is what carried the variables.
    await expect(rt.usage.reset({ account: `codex@${placeId}` })).rejects.toThrow();
    const resets = execs.filter(e => e.cmd.includes("app-server"));
    expect(resets).toHaveLength(1);
    expect(execs.filter(e => e.cmd.includes(key))).toEqual([]);
    expect(resets[0]!.stdin.split("\0")).toContain(`CODEX_GATEWAY_TOKEN=${key}`);
  });
});
