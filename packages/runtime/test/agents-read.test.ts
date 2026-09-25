// SPDX-License-Identifier: AGPL-3.0-only
import type { Machine } from "@wsp/engine";
import { nappingAgentsRefusal, nappingSignInRefusal, nappingToolsRefusal, noSignInRefusal, type AgentsTarget, type WorkspacePhase } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { agentsReads, pageReachOf, type AgentsActs, type AgentsOn, type AgentsWorkspace, type ServerToolsAsk, type SignInAsk } from "../src/agents-read.js";

const READ = { home: "/root", user: "root", agents: [], skills: [], servers: [], refused: [] };

function reads(phase: { now: WorkspacePhase }, local = false): { asked: AgentsOn[]; tools: ServerToolsAsk[]; api: ReturnType<typeof agentsReads<undefined>> } {
  const asked: AgentsOn[] = [];
  const tools: ServerToolsAsk[] = [];
  const machine = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as Machine;
  const api = agentsReads<undefined>({
    reader: { read: async on => (asked.push(on), READ), tools: async (on, ask) => (asked.push(on), tools.push(ask), { auth: "open", tools: [], readAt: "2026-09-24T12:00:00.000Z" }) },
    places: () => undefined,
    workspace: async (): Promise<AgentsWorkspace> => ({ name: "landing", phase: phase.now, local, machine, project: "/root/landing" }),
    channel: async () => {
      throw new Error("no channel on this road");
    },
    changed: () => undefined,
    now: () => Date.parse("2026-09-24T12:00:00Z"),
  });
  return { asked, tools, api };
}

describe("the agents in a workspace", () => {
  it("are read off its machine with its project, and a napping one answers the last report marked stale without being asked", async () => {
    const phase = { now: "running" as WorkspacePhase };
    const { asked, api } = reads(phase);
    const first = await api.read({ workspaceId: "ws_1" });
    expect(first).toMatchObject({ target: { workspaceId: "ws_1" }, readAt: "2026-09-24T12:00:00.000Z", ...READ });
    expect(asked).toEqual([{ kind: "machine", machine: expect.anything(), project: "/root/landing" }]);
    phase.now = "napping";
    expect(await api.read({ workspaceId: "ws_1" })).toEqual({ ...first, stale: "napping" });
    expect(asked).toHaveLength(1);
  });

  it("refuses a napping one it never read while it ran, and reads a workspace on this computer as this computer with its project", async () => {
    await expect(reads({ now: "napping" }).api.read({ workspaceId: "ws_2" })).rejects.toThrow(nappingAgentsRefusal("landing"));
    const here = reads({ now: "running" }, true);
    await here.api.read({ workspaceId: "ws_3" });
    expect(here.asked).toEqual([{ kind: "here", project: "/root/landing" }]);
  });

  it("say on the report where a page that returns to localhost reaches, off the one rule the sign-in plans by", async () => {
    const machine = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as Machine;
    const on = (local: boolean, relayed: boolean) =>
      agentsReads<undefined>({
        reader: { read: async () => READ, tools: async () => ({ auth: "open", readAt: "2026-09-24T12:00:00.000Z" }) },
        places: () => undefined,
        workspace: async (): Promise<AgentsWorkspace> => ({ name: "landing", phase: "running", local, machine, project: "/root/landing" }),
        channel: async () => {
          throw new Error("no channel on this road");
        },
        changed: () => undefined,
        relayed: () => relayed,
        now: () => Date.parse("2026-09-24T12:00:00Z"),
      });
    expect((await on(true, false).read({ workspaceId: "ws_1" })).reach).toBe("here");
    expect((await on(false, true).read({ workspaceId: "ws_1" })).reach).toBe("relay");
    expect((await on(false, false).read({ workspaceId: "ws_1" })).reach).toBe("none");
    expect((await on(false, false).read({ placeId: "here" })).reach).toBe("here");
    expect([pageReachOf({ kind: "here" }), pageReachOf({ kind: "machine", machine, relayed: true }), pageReachOf({ kind: "machine", machine }), pageReachOf({ kind: "box", machine, login: {} })]).toEqual(["here", "relay", "none", "none"]);
  });

  it("forgets a workspace's last report once the workspace is removed, so nothing holds it for the host's life", async () => {
    const phase = { now: "running" as WorkspacePhase };
    const { api } = reads(phase);
    await api.read({ workspaceId: "ws_4" });
    api.forget("ws_4");
    phase.now = "napping";
    await expect(api.read({ workspaceId: "ws_4" })).rejects.toThrow(nappingAgentsRefusal("landing"));
  });

  it("start a server for its tools on the workspace's own machine, keyed by the target, and never on a napping one", async () => {
    const phase = { now: "running" as WorkspacePhase };
    const { asked, tools, api } = reads(phase);
    expect(await api.tools({ workspaceId: "ws_5" }, { agent: "claude", name: "airtable" })).toEqual({ auth: "open", tools: [], readAt: "2026-09-24T12:00:00.000Z" });
    expect(asked).toEqual([{ kind: "machine", machine: expect.anything(), project: "/root/landing" }]);
    expect(tools).toEqual([{ key: JSON.stringify({ workspaceId: "ws_5" }), agent: "claude", name: "airtable" }]);
    phase.now = "napping";
    await expect(api.tools({ workspaceId: "ws_5" }, { agent: "claude", name: "airtable" })).rejects.toThrow(nappingToolsRefusal("landing"));
    expect(asked).toHaveLength(1);
  });
});

describe("the sign-ins on a computer or a workspace", () => {
  /** A channel whose frames are kept and whose events this test pushes. */
  function channel() {
    const frames: Record<string, unknown>[] = [];
    let push: (e: Record<string, unknown>) => void = () => {};
    let end: () => void = () => {};
    const closed = new Promise<{ code: number; reason: string }>(r => (end = () => r({ code: 1000, reason: "" })));
    let shut = 0;
    return {
      frames,
      push: (e: Record<string, unknown>) => push(e),
      get shut() {
        return shut;
      },
      open: async (onEvent: (e: Record<string, unknown>) => void) => {
        push = onEvent;
        return {
          send: async (frame: Record<string, unknown>) => (frames.push(frame), { ok: true, ptyId: "pty_1" }),
          close: () => void (shut++, end()),
          closed,
        } as never;
      },
    };
  }

  function acting(phase: { now: WorkspacePhase }, relayed?: boolean) {
    const ch = channel();
    const planned: { on: AgentsOn; ask: SignInAsk }[] = [];
    const changed: (AgentsTarget | undefined)[] = [];
    const codes: string[] = [];
    let finish: () => void = () => {};
    const acts: AgentsActs = {
      signInLine: async () => ({ command: "codex login --device-auth" }),
      signIn: async (on, ask) => {
        planned.push({ on, ask });
        if (ask.agent === "opencode") throw new Error("opencode asks you to pick");
        return async run => {
          // What the host's watched pty does: a frame down the link, an event back up, the code writer handed over.
          await run.link.op("pty.create", {});
          run.link.onEvent(e => run.emit({ state: "waiting", url: String(e["url"]) }));
          run.typing(async code => void codes.push(code));
          await Promise.race([new Promise<void>(r => (finish = r)), run.stop]);
          run.typing(undefined);
          run.emit({ state: "signed-in" });
        };
      },
      key: async () => undefined,
      addTools: async () => ({ file: "~/.codex/config.toml" }),
    };
    const machine = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as Machine;
    const forgot: string[] = [];
    const logged: string[] = [];
    const api = agentsReads<undefined>({
      reader: { read: async () => READ, tools: async () => ({ auth: "open", readAt: "2026-09-24T12:00:00.000Z" }), forget: key => void forgot.push(key) },
      log: line => void logged.push(line),
      ...(relayed === undefined ? {} : { relayed: () => relayed }),
      acts,
      places: () => undefined,
      workspace: async (): Promise<AgentsWorkspace> => ({ name: "landing", phase: phase.now, local: false, machine, project: "/root/landing" }),
      channel: async (_target, onEvent) => ch.open(onEvent),
      changed: target => void changed.push(target),
      now: () => Date.parse("2026-09-24T12:00:00Z"),
    });
    return { api, ch, planned, changed, codes, forgot, logged, finish: () => finish() };
  }

  it("tell the host a workspace's callback port is forwarded from here where the relay does, and nothing where it does not", async () => {
    for (const relayed of [true, false]) {
      const t = acting({ now: "running" }, relayed);
      const { leave } = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "claude", server: "notion" }, () => {});
      expect(t.planned[0]!.on).toEqual({ kind: "machine", machine: expect.anything(), project: "/root/landing", ...(relayed ? { relayed: true } : {}) });
      leave();
    }
  });

  it("drop what the reader kept for the target before saying it changed, and log each sign-in's start and end without its page or code", async () => {
    const t = acting({ now: "running" });
    const { signInId } = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "claude", server: "notion" }, () => {});
    await tick();
    t.ch.push({ url: "https://mcp.notion.com/authorize?code=SECRETCODE&state=x" });
    await t.api.signInCode(signInId, "SECRETCODE");
    t.finish();
    await tick();
    expect(t.forgot).toEqual([JSON.stringify({ workspaceId: "ws_1" })]);
    expect(t.changed).toEqual([{ workspaceId: "ws_1" }]);
    expect(t.logged).toEqual([`sign-in ${signInId} started: claude, server notion, on workspace ws_1`, `sign-in ${signInId} ended: claude, server notion, on workspace ws_1: signed-in`]);
    const stopped = await t.api.signIn({ placeId: "here" }, { agent: "codex" }, () => {});
    t.api.signInStop(stopped.signInId);
    await tick();
    expect(t.logged.at(-1)).toBe(`sign-in ${stopped.signInId} ended: codex, on computer here: stopped`);
    const refused = acting({ now: "running" });
    await expect(refused.api.signIn({ workspaceId: "ws_1" }, { agent: "opencode" }, () => {})).rejects.toThrow(/asks you to pick/);
    expect(refused.logged).toEqual(["sign-in refused: opencode, on workspace ws_1: opencode asks you to pick"]);
    expect(JSON.stringify([t.logged, refused.logged])).not.toContain("SECRETCODE");
  });

  it("log a sign-in's names with every control character taken out, so no name forges a line of the host's log", async () => {
    const t = acting({ now: "running" });
    await expect(t.api.signIn({ workspaceId: "ws_1" }, { agent: "opencode", server: "x\nsign-in si_forged ended: \x1b[2Kok\r" }, () => {})).rejects.toThrow(/asks you to pick/);
    expect(t.logged).toEqual(["sign-in refused: opencode, server xsign-in si_forged ended: [2Kok, on workspace ws_1: opencode asks you to pick"]);
  });

  it("run what the host planned over the target's own channel, push each step under the sign-in's id, take a code by that id and say the agents changed at the end", async () => {
    const t = acting({ now: "running" });
    const seen: Record<string, unknown>[] = [];
    const { signInId } = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void seen.push(e));
    expect(signInId).toMatch(/^si_[0-9a-f]{12}$/);
    expect(t.planned).toEqual([{ on: { kind: "machine", machine: expect.anything(), project: "/root/landing" }, ask: { agent: "codex" } }]);
    await tick();
    expect(t.ch.frames).toEqual([{ op: "pty.create" }]);
    t.ch.push({ url: "https://auth.openai.com/codex/device" });
    await t.api.signInCode(signInId, "ABCD-1234");
    expect(t.codes).toEqual(["ABCD-1234"]);
    t.finish();
    await tick();
    expect(seen).toEqual([
      { type: "agents.signIn", signInId, state: "waiting", url: "https://auth.openai.com/codex/device" },
      { type: "agents.signIn", signInId, state: "signed-in" },
    ]);
    expect(t.ch.shut).toBe(1);
    expect(t.changed).toEqual([{ workspaceId: "ws_1" }]);
    // Once it is over its code writer is gone with it.
    await expect(t.api.signInCode(signInId, "ABCD-1234")).rejects.toThrow(noSignInRefusal);
  });

  it("refuse a sign-in the host will not plan before any channel opens, never wake a napping workspace, and stop one whose asker went", async () => {
    const t = acting({ now: "running" });
    await expect(t.api.signIn({ workspaceId: "ws_1" }, { agent: "opencode" }, () => {})).rejects.toThrow(/asks you to pick/);
    expect(t.ch.frames).toEqual([]);
    const napping = acting({ now: "napping" });
    await expect(napping.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, () => {})).rejects.toThrow(nappingSignInRefusal("landing"));
    expect(napping.planned).toEqual([]);
    const seen: Record<string, unknown>[] = [];
    const { leave } = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void seen.push(e));
    leave();
    await tick();
    expect(t.ch.shut).toBe(1);
  });

  it("run one sign-in per agent or server on a target: a second start joins the running one, which ends once nobody follows it", async () => {
    const t = acting({ now: "running" });
    const a: Record<string, unknown>[] = [];
    const b: Record<string, unknown>[] = [];
    const [first, second] = await Promise.all([
      t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void a.push(e)),
      t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void b.push(e)),
    ]);
    expect(second.signInId).toBe(first.signInId);
    expect(t.planned).toHaveLength(1);
    await tick();
    t.ch.push({ url: "https://auth.openai.com/codex/device" });
    // One who joins late is shown where it stands.
    const c: Record<string, unknown>[] = [];
    const third = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void c.push(e));
    expect(third.signInId).toBe(first.signInId);
    expect(c).toEqual([{ type: "agents.signIn", signInId: first.signInId, state: "waiting", url: "https://auth.openai.com/codex/device" }]);
    expect([a, b].map(x => x.length)).toEqual([1, 1]);
    // Another server, or another target, is a sign-in of its own.
    const other = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "claude", server: "notion" }, () => {});
    expect(other.signInId).not.toBe(first.signInId);
    other.leave();
    first.leave();
    second.leave();
    await tick();
    expect(t.ch.shut).toBe(1);
    third.leave();
    await tick();
    expect(t.ch.shut).toBe(2);
  });

  it("stop a sign-in by its id for everyone following it, so the next start runs fresh, and refuse an id that is not running", async () => {
    const t = acting({ now: "running" });
    const seen: Record<string, unknown>[] = [];
    const first = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, e => void seen.push(e));
    const joined = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, () => {});
    t.api.signInStop(first.signInId);
    const fresh = await t.api.signIn({ workspaceId: "ws_1" }, { agent: "codex" }, () => {});
    expect(fresh.signInId).not.toBe(first.signInId);
    expect(t.planned).toHaveLength(2);
    await tick();
    expect(t.ch.shut).toBe(1);
    expect(seen.at(-1)).toMatchObject({ signInId: first.signInId, state: "signed-in" });
    expect(() => t.api.signInStop(first.signInId)).toThrow(noSignInRefusal);
    joined.leave();
    fresh.leave();
  });

  it("hand a key and the wsp tools to the host, and say what changed: every report for a key, the one target for the tools", async () => {
    const t = acting({ now: "running" });
    await t.api.key("claude", "sk-ant-oat01-x");
    expect(await t.api.addTools({ placeId: "here" }, "codex")).toEqual({ file: "~/.codex/config.toml" });
    expect(t.changed).toEqual([undefined, { placeId: "here" }]);
    expect(await t.api.signInLine({ placeId: "here" }, { agent: "codex" })).toEqual({ command: "codex login --device-auth" });
  });
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5));
