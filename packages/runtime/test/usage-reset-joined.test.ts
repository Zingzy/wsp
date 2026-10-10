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

describe("a fresh read of the accounts", () => {
  it("asks Codex on a joined computer for its limits now, files the answer under its account, and asks again only after a minute", async () => {
    const row = { id: "codex", name: "Codex", installed: true, road: "own", signIn: "signed-in", signInRoad: "terminal", wspTools: false };
    const read = { home: "/home/maya", user: "maya", agents: [row], skills: [], servers: [], refused: [] };
    const { hostKey } = await serving({ adapters: { codex: idle }, agentsReader: { read: async () => read as never, tools: async () => ({ auth: "open", readAt: "2026-10-07T00:00:00.000Z" }) as never } });
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
    const answer = [
      { id: 1, result: {} },
      { id: 2, result: { account: { type: "chatgpt", email: "dev@example.com", planType: "plus" } } },
      { id: 3, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt }, secondary: null, planType: "plus" }, accountId: "acct_7f3a" } },
    ]
      .map(line => JSON.stringify(line))
      .join("\n");
    let reads = 0;
    const { placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION, agents: ["codex"], logins: ["codex/auth.json"] }),
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as { id?: number; op?: string; cmd?: string };
          if (frame.op !== "exec") return;
          const cmd = frame.cmd ?? "";
          if (cmd.includes("app-server")) reads += 1;
          const stdout = cmd.includes("app-server") ? `${answer}\n` : cmd.includes("pwd -P") ? "/home/maya/.codex\n/home/maya\n" : "";
          c.say({ id: frame.id, ok: true, exitCode: 0, stdout, stderr: "", truncated: false });
        }),
    });
    const rt = ctx.runtime!;
    await rt.agents.setup(placeId, "codex", { configDir: "/home/maya/.codex" });

    expect((await rt.usage.accounts()).accounts.find(a => a.key === "codex:acct_7f3a")).toBeUndefined();
    expect(reads).toBe(0);
    const all = (await rt.usage.accounts({ fresh: true })).accounts;
    const fresh = all.find(a => a.key === "codex:acct_7f3a");
    expect(fresh).toEqual(expect.objectContaining({ label: "Codex with ChatGPT Plus", windows: [{ kind: "session", usedPercent: 12, resetsAt: resetsAt * 1000 }], computers: ["srv"] }));
    await rt.usage.accounts({ fresh: true });
    expect(reads).toBe(1);
  });
});
