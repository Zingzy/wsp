// SPDX-License-Identifier: AGPL-3.0-only
// The questions a harness is asked outside a turn (its catalog, a thread's
// title) run with the variables the person set for the agent on that computer.
// On a computer somebody owns a command line is one every login there can
// read, so those values ride the exec's input and never its text.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalBackend, type Machine } from "@wsp/engine";
import { HERE_PLACE_ID } from "@wsp/protocol";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { copyingFake, stubBackend, tempRepo, testPlatform } from "./stub-backend.js";
import { until } from "./until.js";

const BARE_PATH = "/usr/bin:/bin";

/** Every exec the machine is handed, its text and its input, the commands still run for real. */
function recorded(backend: LocalBackend, execs: { cmd: string; stdin: string }[]): LocalBackend {
  const watch = (machine: Machine): Machine =>
    new Proxy(machine, {
      get: (target, key) =>
        key === "exec"
          ? (cmd: string, opts?: { timeoutMs?: number; stdin?: Uint8Array }) => {
              execs.push({ cmd, stdin: opts?.stdin === undefined ? "" : Buffer.from(opts.stdin).toString("utf8") });
              return target.exec(cmd, opts);
            }
          : Reflect.get(target, key),
    });
  return new Proxy(backend, {
    get: (target, key) => {
      const value = Reflect.get(target, key) as unknown;
      if (key !== "get" && key !== "create") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return async (...args: unknown[]) => watch(await (value as (...a: unknown[]) => Promise<Machine>).apply(target, args));
    },
  });
}

describe("a harness's questions outside a turn", () => {
  it("carry a key the person set for the agent on the exec's input, and no exec text holds it", async () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-question-env-"));
    const folder = tempRepo();
    execFileSync("git", ["-C", folder, "commit", "-q", "--allow-empty", "-m", "first"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    const key = `sk-x-${randomBytes(8).toString("hex")}`;
    const execs: { cmd: string; stdin: string }[] = [];
    const titles: (string | null)[] = [];
    // The real adapter's catalog probe and title question, built on the context the runtime hands it; the turn itself
    // is a stand-in that announces a session and ends.
    const claude: HarnessAdapterFactory = ctx => {
      const real = HARNESS_ADAPTERS.claude(ctx);
      return {
        steers: false,
        ...(real.probeCatalog !== undefined ? { probeCatalog: real.probeCatalog.bind(real) } : {}),
        titleFor: (turn, exec) => real.titleFor!(turn, exec).then(t => (titles.push(t), t)),
        start: o => {
          o.onEvent({ type: "session.start", sessionId: "11111111-1111-4111-8111-111111111111" });
          const result = { status: "completed" as const, text: "ok" };
          o.onEvent({ type: "turn.done", sessionId: "11111111-1111-4111-8111-111111111111", result });
          o.onEvent({ type: "session.end", sessionId: "11111111-1111-4111-8111-111111111111", exitCode: 0, sawResult: true });
          return { localId: "l", finished: Promise.resolve(result), interrupt: async () => {} };
        },
      };
    };
    const row = { id: "claude", name: "Claude Code", installed: true, road: "own", signIn: "signed-in", signInRoad: "terminal", wspTools: false };
    try {
      const rt = createRuntime({
        backend: stubBackend(),
        store: memoryStore(),
        adapters: { claude },
        local: {
          // A PATH with no agent on it: nothing here may start the real binary this computer might have.
          backend: recorded(new LocalBackend({ root, env: { PATH: BARE_PATH, HOME: root } }), execs),
          execStream: () =>
            Object.assign(() => {
              throw new Error("no turn runs a process here");
            }),
          home: id => join(root, `.${id}`),
          homeDir: root,
          rootsPath: join(root, "roots"),
          env: () => ({ PATH: BARE_PATH }),
          platform: testPlatform(),
          copier: copyingFake(),
        },
        agentsReader: { read: async () => ({ home: root, user: "maya", agents: [row], skills: [], servers: [], refused: [] }) as never, tools: async () => ({ auth: "open", readAt: "2026-10-07T00:00:00.000Z" }) as never },
      });
      await rt.agents.setup(HERE_PLACE_ID, "claude", { env: { CLAUDE_GATEWAY_TOKEN: key } });
      const project = await rt.projects.add({ source: folder });
      const here = await rt.workspaces.create({ project: project.id, name: "here" });
      await (await rt.sessions.start(here.id, { prompt: "make a server" })).finished;

      // No claude on this computer's PATH answers, so the title comes back as none; the question still went out.
      await until(() => titles.length === 1);
      const probes = execs.filter(e => e.cmd.includes("claude --version"));
      const asked = execs.filter(e => e.cmd.includes("claude -p --safe-mode"));
      expect([probes.length > 0, asked.length > 0]).toEqual([true, true]);
      const questions = [...probes, ...asked];
      expect(execs.filter(e => e.cmd.includes(key))).toEqual([]);
      for (const q of questions) expect(q.stdin.split("\0")).toContain(`CLAUDE_GATEWAY_TOKEN=${key}`);
    } finally {
      for (const at of [root, folder]) rmSync(at, { recursive: true, force: true });
    }
  });
});
