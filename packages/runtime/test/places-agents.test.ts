// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { describe, expect, it } from "vitest";
import { PLACES_TICKET_REFUSAL, deviceHeldRefusal, noSignInRefusal, SIGN_IN_LINE_REFUSAL, AGENTS_KEY_REFUSAL, DAEMON_VERSION, HERE_PLACE_ID, noSuchPlaceRefusal, providerAgentsRefusal, type AgentsSignInEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { newPlaceKeyPair } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { NO_AGENTS_READER, type AgentsActs, type AgentsOn, type AgentsReader, type ServerIcons, type ServersActs, type SkillsActs } from "../src/agents-read.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, placesOf, KEEPS_NO_IMAGE, HOLDS_PROJECTS, forks } from "./places-fixture.js";

describe("the agents on a computer you own", () => {
  const READ = { home: "/home/maya", user: "maya", agents: [], skills: [], servers: [], refused: [] };

  /** A reader that keeps where it was asked to read and runs one line there, as the host's readers do. */
  const reading = (asked: AgentsOn[], said: string[]): AgentsReader => ({
    read: async on => {
      asked.push(on);
      if (on.kind !== "here") said.push((await on.machine.exec("id -un")).stdout);
      return READ;
    },
    tools: async (on, ask) => {
      asked.push(on);
      // The bytes a run hands its command ride the frame's stdin to the computer, which is the road a server's
      // variables take there.
      const out = on.kind === "here" ? "" : (await on.machine.exec("cat", { stdin: Buffer.from("A=1") })).stdout;
      return { auth: "open", tools: [{ name: `${ask.key} ${ask.agent} ${ask.name} ${ask.refresh === true} ${out}` }], readAt: "2026-09-24T12:00:00.000Z" };
    },
  });

  it("cover every project recorded on that computer, each at its folder there, and an act names one of them", async () => {
    const asked: AgentsOn[] = [];
    const { hostKey } = await serving({ agentsReader: { read: async on => (asked.push(on), READ), tools: async on => (asked.push(on), { auth: "open", readAt: "2026-09-25T12:00:00.000Z" }) }, vault: {} });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }), answers: c => forks(c, undefined, undefined, HOLDS_PROJECTS) });
    sockets.push(client.ws);
    const project = await ctx.runtime!.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "srv", name: "landing" });
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    expect((await c.request("agents.read", { target: { placeId } })).ok).toBe(true);
    const tools = await c.request("servers.tools", { target: { placeId, project: project.id }, agent: "claude", name: "db" });
    expect(tools.ok, String(tools["error"])).toBe(true);
    const at = { id: project.id, name: "landing", path: project.path };
    expect(asked.map(on => on.projects)).toEqual([[at], [at]]);
    expect(project.path).toBe("/home/maya/landing");
  });

  it("are read over that computer's link with the login, sign-ins and versions its report carries, and answered stamped", async () => {
    const asked: AgentsOn[] = [];
    const said: string[] = [];
    const { hostKey } = await serving({ agentsReader: reading(asked, said), vault: {} });
    const lines: string[] = [];
    const sent = report("srv", { daemonVersion: DAEMON_VERSION, agents: ["claude"], agentVersions: { claude: "2.1.281 (Claude Code)" }, logins: [] });
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: sent,
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (frame["op"] !== "exec") return;
          lines.push(String(frame["cmd"]));
          c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: "maya", stderr: "", truncated: false });
        }),
    });
    sockets.push(client.ws);
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    const answered = await c.request("agents.read", { target: { placeId } });
    expect(answered.ok, String(answered["error"])).toBe(true);
    expect(answered["report"]).toMatchObject({ ...READ, target: { placeId } });
    expect(typeof (answered["report"] as { readAt: unknown }).readAt).toBe("string");
    expect(asked).toEqual([{ kind: "box", name: "srv", machine: expect.anything(), login: { HOME: "/home/maya", PATH: "/usr/bin" }, signIns: { claude: "none" }, versions: { claude: "2.1.281 (Claude Code)" }, projects: [], stores: { claude: "/home/maya/.claude-cfg", codex: "/home/maya/.codex" } }]);
    expect(lines).toEqual(["id -un"]);
    expect(said).toEqual(["maya"]);
    expect((await c.request("agents.read", { target: { placeId: HERE_PLACE_ID } })).ok).toBe(true);
    expect(asked.at(-1)).toEqual({ kind: "here", projects: [] });
  });

  it("hand the reader the rows that computer's last setup came to, which say the agents wsp installed there", async () => {
    const asked: AgentsOn[] = [];
    const { hostKey, store } = await serving({ agentsReader: { read: async on => (asked.push(on), READ), tools: async () => ({ auth: "open", readAt: "2026-10-07T12:00:00.000Z" }) }, vault: {} });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    const rows = [{ id: "agents/codex", label: "Codex", outcome: "installed" as const }, { id: "agents/claude", label: "Claude Code", outcome: "present" as const }];
    const record = (await store.get("places", placeId)) as Record<string, unknown>;
    await store.put("places", placeId, { ...record, applied: { hash: "h", at: "2026-10-07T12:00:00.000Z", rows } });
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    expect((await c.request("agents.read", { target: { placeId } })).ok).toBe(true);
    expect(asked.at(-1)).toMatchObject({ kind: "box", setupRows: rows });
  });

  it("keep an agent's config folder under that computer's own home, read on that computer with its links followed", async () => {
    const boxHome = mkdtempSync(joinPath(tmpdir(), "wsp-box-home-"));
    try {
      symlinkSync(tmpdir(), joinPath(boxHome, "out"));
      mkdirSync(joinPath(boxHome, ".wsp"));
      const idle: HarnessAdapterFactory = () => ({ steers: false, start: () => ({ localId: "s", finished: new Promise(() => {}), interrupt: async () => {} }) });
      const claude = { id: "claude", name: "Claude Code", installed: true, road: "own" as const, signIn: "signed-in" as const, signInRoad: "device" as const, wspTools: false };
      const reader: AgentsReader = { read: async () => ({ ...READ, agents: [claude] }), tools: async () => ({ auth: "open", readAt: "2026-10-01T12:00:00.000Z" }) };
      const { hostKey, store } = await serving({ agentsReader: reader, vault: {}, adapters: { claude: idle } });
      const { client, placeId } = await join(hostKey, {
        code: await code(),
        name: "srv",
        report: report("srv", { daemonVersion: DAEMON_VERSION }),
        answers: c =>
          c.onFrame(raw => {
            const frame = raw as unknown as Record<string, unknown>;
            if (frame["op"] !== "exec") return;
            // The box runs the line in its own shell, under its own home.
            const stdout = execFileSync("/bin/bash", ["-c", String(frame["cmd"])], { env: { HOME: boxHome, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
            c.say({ id: frame["id"], ok: true, exitCode: 0, stdout, stderr: "", truncated: false });
          }),
      });
      sockets.push(client.ws);
      const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
      sockets.push(c.ws);
      for (const dir of ["/tmp/x", "/etc/x", `${boxHome}/../x`, joinPath(boxHome, "out", "x"), joinPath(boxHome, ".wsp", "c"), boxHome]) {
        const refused = await c.request("agents.setup", { placeId, agent: "claude", configDir: dir });
        expect(refused, dir).toMatchObject({ ok: false, kind: "usage" });
      }
      expect(await store.list("agentSetups")).toEqual([]);
      const kept = await c.request("agents.setup", { placeId, agent: "claude", configDir: joinPath(boxHome, "claude-wsp") });
      expect(kept, String(kept["error"])).toMatchObject({ ok: true });
    } finally {
      rmSync(boxHome, { recursive: true, force: true });
    }
  });

  it("read an agent's config folder again on that computer before each launch there, and refuse one that now leads out of its home", async () => {
    const boxHome = mkdtempSync(joinPath(tmpdir(), "wsp-box-home-"));
    const outside = mkdtempSync(joinPath(tmpdir(), "wsp-outside-"));
    let flaky = false;
    try {
      mkdirSync(joinPath(boxHome, "real"));
      const starts: string[] = [];
      const factory: HarnessAdapterFactory = ctx => ({
        steers: false,
        start: ({ onEvent }) => {
          starts.push(ctx.home("claude") ?? "");
          const result: TurnResult = { status: "completed", text: "ok" };
          onEvent({ type: "session.start", sessionId: randomUUID() });
          onEvent({ type: "turn.done", sessionId: "s", result });
          return { localId: "s", finished: Promise.resolve(result), interrupt: async () => {} };
        },
      });
      const claude = { id: "claude", name: "Claude Code", installed: true, road: "own" as const, signIn: "signed-in" as const, signInRoad: "device" as const, wspTools: false };
      const reader: AgentsReader = { read: async () => ({ ...READ, agents: [claude] }), tools: async () => ({ auth: "open", readAt: "2026-10-01T12:00:00.000Z" }) };
      const hostKey = newPlaceKeyPair();
      ctx.runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, placeLinks: wiring(hostKey), agentsReader: reader });
      ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
      const { client, placeId } = await join(hostKey, {
        code: await code(),
        report: report("srv", { agents: ["claude"], login: { HOME: boxHome, USER: "root", PATH: "/usr/bin:/bin" } }),
        answers: c => {
          forks(c, undefined, undefined, KEEPS_NO_IMAGE).swallow.add("exec");
          c.onFrame(raw => {
            const frame = raw as unknown as Record<string, unknown>;
            if (frame["op"] !== "exec") return;
            if (flaky) return c.say({ id: frame["id"], ok: true, exitCode: 1, stdout: "", stderr: "realpath: no such folder", truncated: false });
            // The box was joined as root, the one login a thread there runs as, whoever runs this test.
            if (String(frame["cmd"]).includes("command -v runuser")) return c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: `Linux\n0\nroot\nroot\n1\n${boxHome}\n/usr/bin:/bin\n`, stderr: "", truncated: false });
            // Root's login shell answers its PATH there, never through this computer's getent, which a Mac lacks.
            if (String(frame["cmd"]).includes("-ilc")) return c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: "/usr/bin:/bin", stderr: "", truncated: false });
            // The add's clone reaches no remote from a test: the folder it claimed stands for the checkout.
            if (String(frame["cmd"]).includes("git clone")) return c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false });
            const stdout = execFileSync("/bin/bash", ["-c", String(frame["cmd"])], { env: { HOME: boxHome, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
            c.say({ id: frame["id"], ok: true, exitCode: 0, stdout, stderr: "", truncated: false });
          });
        },
      });
      sockets.push(client.ws);
      const ws = await createOn(ctx.runtime, { name: "x", on: "srv" });
      const kept = joinPath(realpathSync(boxHome), "real", "c");
      symlinkSync(joinPath(boxHome, "real"), joinPath(boxHome, "in"));
      expect((await ctx.runtime.agents.setup(placeId, "claude", { configDir: joinPath(boxHome, "in", "c") })).setup?.configDir).toBe(kept);
      await (await ctx.runtime.sessions.start(ws.id, { prompt: "one", harness: "claude" })).finished;
      expect(starts).toEqual([kept]);
      rmSync(joinPath(boxHome, "real"), { recursive: true });
      symlinkSync(outside, joinPath(boxHome, "real"));
      await expect(ctx.runtime.sessions.start(ws.id, { prompt: "two", harness: "claude" })).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`Claude Code does not start with its config folder ${kept}: Claude Code's config folder has to be under the home folder ${realpathSync(boxHome)}`) });
      expect(starts).toHaveLength(1);
      const row = (await ctx.runtime.sessions.list(ws.id))[0]!;
      await expect(ctx.runtime.sessions.rename(row.id, "named")).rejects.toMatchObject({ kind: "usage", message: expect.stringContaining(`Claude Code does not start with its config folder ${kept}`) });
      expect((await ctx.runtime.harnesses.list(ws.id)).find(c => c.harness === "claude")?.refusal).toContain(`Claude Code does not start with its config folder ${kept}`);
      // The box answering that it could not read the folder is its own word, kept as it said it.
      flaky = true;
      expect((await ctx.runtime.harnesses.list(ws.id)).find(c => c.harness === "claude")?.refusal).toBe(`srv did not say where ${kept} is: realpath: no such folder`);
      // A link that drops under the check is the computer's state, never the agent's refusal: the row answers wsp's own
      // lists and the app says the computer from its own reading of it.
      client.ws.close();
      await until(async () => (await placesOf()).find(p => p.id === placeId)?.present === false);
      const unread = (await ctx.runtime.harnesses.list(ws.id)).find(c => c.harness === "claude");
      expect(unread?.refusal).toBeUndefined();
      expect(unread?.source).toBe("table");
    } finally {
      rmSync(boxHome, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("hand one server's tools ask to the reader over that computer's link, its stdin riding the frame, and refuse it on a ticket", async () => {
    const asked: AgentsOn[] = [];
    const { hostKey } = await serving({ agentsReader: reading(asked, []), vault: {} });
    const frames: Record<string, unknown>[] = [];
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (frame["op"] !== "exec") return;
          frames.push(frame);
          c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: Buffer.from(String(frame["stdin"] ?? ""), "base64").toString(), stderr: "", truncated: false });
        }),
    });
    sockets.push(client.ws);
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    const answered = await c.request("servers.tools", { target: { placeId }, agent: "claude", name: "airtable", refresh: true });
    expect(answered.ok, String(answered["error"])).toBe(true);
    expect(answered["answer"]).toEqual({ auth: "open", tools: [{ name: `${JSON.stringify({ placeId })} claude airtable true A=1` }], readAt: "2026-09-24T12:00:00.000Z" });
    expect(asked).toEqual([expect.objectContaining({ kind: "box" })]);
    expect(frames.map(f => f["cmd"])).toEqual(["cat"]);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(ctx.srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    expect(await ticketed.request("servers.tools", { target: { placeId }, agent: "claude", name: "airtable" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(asked).toHaveLength(1);
  });

  it("are refused on a cloud account, on a place nobody holds, on a socket let in on a ticket, and on a runtime with no reader", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 }, agentsReader: reading([], []) });
    const { client } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    const rows = await ctx.runtime!.places!.list(Date.now());
    const provider = rows.find(p => p.kind !== "computer")!;
    expect(await c.request("agents.read", { target: { placeId: provider.id } })).toMatchObject({ ok: false, error: providerAgentsRefusal(provider.name), kind: "usage" });
    expect(await c.request("agents.read", { target: { placeId: "pl_nobody" } })).toMatchObject({ ok: false, error: noSuchPlaceRefusal("pl_nobody", rows.map(p => p.name)), kind: "usage" });
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(ctx.srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    expect(await ticketed.request("agents.read", { target: { placeId: HERE_PLACE_ID } })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    for (const ws of sockets.splice(0)) ws.close();
    await ctx.srv!.close();
    ctx.srv = undefined;
    await ctx.runtime!.close();
    ctx.runtime = undefined;
    await serving();
    const bare = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(bare.ws);
    expect(await bare.request("agents.read", { target: { placeId: HERE_PLACE_ID } })).toMatchObject({ ok: false, error: NO_AGENTS_READER });
  });
  it("search, read, preview, add, turn off and remove skills from the host's own socket alone, each on the computer named", async () => {
    const asked: string[] = [];
    const acts: SkillsActs = {
      search: async (q, limit) => (asked.push(`search ${q} ${limit}`), [{ id: "a/b/pdf", source: "a/b", skillId: "pdf", name: "pdf", installs: 3 }]),
      get: async skill => (asked.push(`get ${skill}`), { text: "# pdf", size: 5 }),
      preview: async (on, ask) => (asked.push(`preview ${on.kind} ${ask.name}`), { text: "# pdf", size: 5 }),
      add: async (on, ask) => (asked.push(`add ${on.kind} ${ask.skill} ${(ask.agents ?? []).join(",")} ${ask.project === true}`), { path: "~/.agents/skills/pdf", agents: [{ agent: "claude", path: "~/.claude/skills/pdf" }] }),
      remove: async (on, ask) => (asked.push(`remove ${on.kind} ${ask.name}`), { removed: ["~/.agents/skills/pdf"] }),
      toggle: async (on, ask) => (asked.push(`toggle ${on.kind} ${ask.name} ${ask.on}`), { paths: ["~/.agents/skills/pdf"] }),
    };
    const { hostKey } = await serving({ agentsReader: reading([], []), skillsActs: acts });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    await c.request("events.subscribe");
    const box = { placeId };
    expect(await c.request("skills.search", { q: "pdf" })).toMatchObject({ ok: true, skills: [{ id: "a/b/pdf" }] });
    expect(await c.request("skills.get", { skill: "a/b/pdf" })).toMatchObject({ ok: true, preview: { text: "# pdf", size: 5 } });
    expect(await c.request("skills.preview", { target: box, name: "pdf" })).toMatchObject({ ok: true, preview: { size: 5 } });
    expect(await c.request("skills.add", { target: { placeId: HERE_PLACE_ID }, skill: "a/b/pdf", agents: ["claude"] })).toMatchObject({ ok: true, added: { path: "~/.agents/skills/pdf" } });
    expect(await c.request("skills.toggle", { target: box, name: "pdf", on: false })).toMatchObject({ ok: true, paths: ["~/.agents/skills/pdf"] });
    expect(await c.request("skills.remove", { target: box, name: "pdf" })).toMatchObject({ ok: true, removed: ["~/.agents/skills/pdf"] });
    expect(asked).toEqual(["search pdf 20", "get a/b/pdf", "preview box pdf", "add here a/b/pdf claude false", "toggle box pdf false", "remove box pdf"]);
    await until(() => c.events.filter(e => e.type === "agents.changed").length === 3);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(ctx.srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    const redeemer = await WsClient.connect(ctx.srv!.port);
    sockets.push(redeemer.ws);
    const device = await WsClient.connect(ctx.srv!.port, { token: String((await redeemer.request("pair.redeem", { code: await code(), name: "the phone" }))["deviceToken"]) });
    sockets.push(device.ws);
    for (const [op, extra] of [
      ["skills.search", { q: "pdf" }],
      ["skills.get", { skill: "a/b/pdf" }],
      ["skills.preview", { target: box, name: "pdf" }],
      ["skills.add", { target: box, skill: "a/b/pdf" }],
      ["skills.toggle", { target: box, name: "pdf", on: true }],
      ["skills.remove", { target: box, name: "pdf" }],
    ] as const) {
      expect(await ticketed.request(op, extra), op).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
      expect(await device.request(op, extra), op).toMatchObject({ ok: false, error: deviceHeldRefusal(op) });
    }
    expect(asked).toHaveLength(6);
  });

  it("asks for a server's icon from the host's own socket alone, and asks nothing and forgets every icon once the person turns server icons off", async () => {
    const asked: string[] = [];
    let forgot = 0;
    let on: (() => Promise<boolean>) | undefined;
    const icons: ServerIcons = { folder: "/nowhere/icons", icon: async (host, refresh, stillOn) => (asked.push(`${host} ${refresh === true}`), (on = stillOn), "data:image/png;base64,AA=="), forget: () => void (forgot += 1) };
    await serving({ serverIcons: icons });
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    expect(await c.request("servers.icon", { host: "mcp.notion.com" })).toMatchObject({ ok: true, icon: "data:image/png;base64,AA==" });
    expect(await c.request("servers.icon", { host: "mcp.notion.com", refresh: true })).toMatchObject({ ok: true, icon: "data:image/png;base64,AA==" });
    expect(asked).toEqual(["mcp.notion.com false", "mcp.notion.com true"]);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(ctx.srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    expect(await ticketed.request("servers.icon", { host: "mcp.notion.com" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
    const redeemer = await WsClient.connect(ctx.srv!.port);
    sockets.push(redeemer.ws);
    const device = await WsClient.connect(ctx.srv!.port, { token: String((await redeemer.request("pair.redeem", { code: await code(), name: "the phone" }))["deviceToken"]) });
    sockets.push(device.ws);
    expect(await device.request("servers.icon", { host: "mcp.notion.com" })).toMatchObject({ ok: false, error: deviceHeldRefusal("servers.icon") });
    expect(await c.request("preferences.set", { patch: { theme: "dark" } })).toMatchObject({ ok: true });
    expect(forgot).toBe(0);
    expect(await c.request("preferences.set", { patch: { serverIcons: false } })).toMatchObject({ ok: true, preferences: { serverIcons: false } });
    expect(forgot).toBe(1);
    // An ask started before the switch went off reads it again before it keeps anything.
    expect(await on?.()).toBe(false);
    expect(await c.request("servers.icon", { host: "mcp.sentry.dev", refresh: true })).toMatchObject({ ok: true, icon: null });
    expect(asked).toHaveLength(2);
  });

  it("add, turn off and remove a server from the host's own socket alone, each on the computer named, and never log the values an add carried", async () => {
    const asked: string[] = [];
    const acts: ServersActs = {
      add: async (on, ask) => {
        asked.push(`add ${on.kind} ${ask.agent} ${ask.name} ${ask.url ?? ask.command} ${ask.project === true}`);
        if (ask.name === "echo") throw Object.assign(new Error(`refused ${JSON.stringify(ask.headers)} ${JSON.stringify(ask.env)}`), { kind: "usage" });
        return { file: "~/.claude.json" };
      },
      remove: async (on, ask) => (asked.push(`remove ${on.kind} ${ask.agent} ${ask.name} ${ask.scope}`), { file: "~/.claude.json" }),
      toggle: async (on, ask) => (asked.push(`toggle ${on.kind} ${ask.agent} ${ask.name} ${ask.on}`), { file: "~/.codex/config.toml" }),
    };
    const lines: string[] = [];
    const { hostKey } = await serving({ agentsReader: reading([], []), serversActs: acts }, { log: line => void lines.push(line) });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    await c.request("events.subscribe");
    const box = { placeId };
    expect(await c.request("servers.add", { target: { placeId: HERE_PLACE_ID }, agent: "claude", name: "acme", url: "https://mcp.acme.example/mcp", headers: { Authorization: "Bearer tok-acme-x" } })).toMatchObject({ ok: true, file: "~/.claude.json" });
    expect(await c.request("servers.toggle", { target: box, agent: "codex", name: "acme", on: false })).toMatchObject({ ok: true, file: "~/.codex/config.toml" });
    expect(await c.request("servers.remove", { target: box, agent: "claude", name: "acme", scope: "home" })).toMatchObject({ ok: true, file: "~/.claude.json" });
    expect(asked).toEqual(["add here claude acme https://mcp.acme.example/mcp false", "toggle box codex acme false", "remove box claude acme home"]);
    await until(() => c.events.filter(e => e.type === "agents.changed").length === 3);
    expect(await c.request("servers.add", { target: box, agent: "claude", name: "echo", command: "npx", env: { ACME_KEY: "sk-acme-env-x" }, headers: { Authorization: "Bearer tok-acme-hdr-x" } })).toMatchObject({ ok: false });
    const refused = lines.filter(l => l.startsWith("refused servers.add"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).not.toContain("sk-acme-env-x");
    expect(refused[0]).not.toContain("tok-acme-hdr-x");
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(ctx.srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    const redeemer = await WsClient.connect(ctx.srv!.port);
    sockets.push(redeemer.ws);
    const device = await WsClient.connect(ctx.srv!.port, { token: String((await redeemer.request("pair.redeem", { code: await code(), name: "the phone" }))["deviceToken"]) });
    sockets.push(device.ws);
    for (const [op, extra] of [
      ["servers.add", { target: box, agent: "claude", name: "acme", command: "npx" }],
      ["servers.toggle", { target: box, agent: "codex", name: "acme", on: true }],
      ["servers.remove", { target: box, agent: "claude", name: "acme" }],
    ] as const) {
      expect(await ticketed.request(op, extra), op).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
      expect(await device.request(op, extra), op).toMatchObject({ ok: false, error: deviceHeldRefusal(op) });
    }
    expect(asked).toHaveLength(4);
  });

  it("run a sign-in over that computer's link, push its steps to the asking socket alone, type its code, keep it going when that socket goes, and keep keys to the host's own socket", async () => {
    const typed: string[] = [];
    const keys: string[] = [];
    let ended = 0;
    const acts: AgentsActs = {
      signInLine: async () => ({ command: "codex login --device-auth" }),
      signIn: async on => async run => {
        expect(on).toMatchObject({ kind: "box" });
        const made = await run.link.op("pty.create", { cols: 200, rows: 50 });
        run.typing(async code => void typed.push(code));
        run.emit({ state: "waiting", url: "https://auth.openai.com/codex/device", code: String(made["ptyId"]), paste: false });
        await run.stop;
        ended += 1;
      },
      key: async (agent, key) => void keys.push(`${agent} ${key}`),
      addTools: async () => ({ file: "~/.codex/config.toml" }),
    };
    const { hostKey } = await serving({ agentsReader: reading([], []), agentsActs: acts, vault: {} });
    const frames: string[] = [];
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION, logins: [] }),
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (typeof frame["op"] !== "string") return;
          frames.push(String(frame["op"]));
          c.say({ id: frame["id"], ok: true, ptyId: "pty_7" });
        }),
    });
    sockets.push(client.ws);
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    const other = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws, other.ws);
    expect((await other.request("events.subscribe")).ok).toBe(true);
    const started = await c.request("agents.signIn", { target: { placeId }, agent: "codex" });
    expect(started.ok, String(started["error"])).toBe(true);
    const signInId = String(started["signInId"]);
    await until(() => c.events.some(e => e.type === "agents.signIn"));
    expect(c.events.find(e => e.type === "agents.signIn")).toEqual({ type: "agents.signIn", signInId, state: "waiting", url: "https://auth.openai.com/codex/device", code: "pty_7", paste: false });
    expect(frames).toContain("pty.create");
    expect((await c.request("agents.signInCode", { signInId, code: "ABCD-1234" })).ok).toBe(true);
    expect(typed).toEqual(["ABCD-1234"]);
    // Asking again from the same socket joins the one it already follows, and its steps still come once.
    expect(await c.request("agents.signIn", { target: { placeId }, agent: "codex" })).toMatchObject({ ok: true, signInId });
    await new Promise(r => setTimeout(r, 20));
    expect(c.events.filter(e => e.type === "agents.signIn")).toHaveLength(1);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(ctx.srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    for (const [op, extra] of [
      ["agents.signIn", { target: { placeId }, agent: "codex" }],
      ["agents.signInCode", { signInId, code: "x" }],
      ["agents.signInStop", { signInId }],
      ["agents.signInLine", { target: { placeId }, agent: "codex" }],
      ["agents.addTools", { target: { placeId: HERE_PLACE_ID }, agent: "codex" }],
    ] as const) {
      expect(await ticketed.request(op, extra), op).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
    }
    expect(await ticketed.request("agents.key", { agent: "claude", key: "sk-ant-oat01-x" })).toMatchObject({ ok: false, error: AGENTS_KEY_REFUSAL });
    expect((await c.request("agents.key", { agent: "claude", key: "sk-ant-oat01-x" })).ok).toBe(true);
    expect(keys).toEqual(["claude sk-ant-oat01-x"]);
    // The change goes on the one stream every socket follows; the page and the code went to the asker alone.
    await until(() => other.events.some(e => e.type === "agents.changed"));
    expect(other.events.some(e => e.type === "agents.signIn")).toBe(false);
    // Only a socket following the sign-in types into it or stops it; its stop ends it at once.
    expect(await other.request("agents.signInCode", { signInId, code: "x" })).toMatchObject({ ok: false, error: noSignInRefusal });
    expect(await other.request("agents.signInStop", { signInId })).toMatchObject({ ok: false, error: noSignInRefusal });
    expect(ended).toBe(0);
    expect((await c.request("agents.signInStop", { signInId })).ok).toBe(true);
    await until(() => ended === 1);
    // A paired computer asks for neither a key nor a sign-in's line; the host's own socket asks for the line.
    const redeemer = await WsClient.connect(ctx.srv!.port);
    sockets.push(redeemer.ws);
    const redeemed = await redeemer.request("pair.redeem", { code: await code(), name: "the phone" });
    const device = await WsClient.connect(ctx.srv!.port, { token: String(redeemed["deviceToken"]) });
    sockets.push(device.ws);
    expect(await device.request("agents.key", { agent: "claude", key: "sk-ant-oat01-y" })).toMatchObject({ ok: false, error: deviceHeldRefusal("agents.key") });
    expect(await device.request("agents.signInLine", { target: { placeId }, agent: "codex" })).toMatchObject({ ok: false, error: deviceHeldRefusal("agents.signInLine") });
    // The owner's own browser on this computer is a device too: the line and the key are the host's alone.
    const hereCode = String((await c.request("pair.issue", { here: true }))["code"]);
    const browserRedeem = await WsClient.connect(ctx.srv!.port);
    sockets.push(browserRedeem.ws);
    const browser = await WsClient.connect(ctx.srv!.port, { token: String((await browserRedeem.request("pair.redeem", { code: hereCode, name: "this Mac's browser" }))["deviceToken"]) });
    sockets.push(browser.ws);
    expect(await browser.request("agents.signInLine", { target: { placeId }, agent: "codex" })).toMatchObject({ ok: false, error: SIGN_IN_LINE_REFUSAL });
    expect(await browser.request("agents.key", { agent: "claude", key: "sk-ant-oat01-z" })).toMatchObject({ ok: false, error: AGENTS_KEY_REFUSAL });
    expect(keys).toEqual(["claude sk-ant-oat01-x"]);
    expect((await c.request("agents.signInLine", { target: { placeId }, agent: "codex" }))["line"]).toEqual({ command: "codex login --device-auth" });
    // A window that goes leaves what it alone followed running, and another window joins it where it stands.
    const left = await c.request("agents.signIn", { target: { placeId }, agent: "codex" });
    expect(left.ok).toBe(true);
    c.close();
    await new Promise(r => setTimeout(r, 50));
    expect(ended).toBe(1);
    // A window that comes back lists the run with the step it missed and follows it from the list alone, and the
    // stopped one is listed as ended; a ticket's socket lists nothing.
    const back = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(back.ws);
    const missed = { type: "agents.signIn", signInId: left["signInId"], state: "waiting", url: "https://auth.openai.com/codex/device", code: "pty_7", paste: false };
    expect(await back.request("agents.signIns")).toMatchObject({
      ok: true,
      runs: [
        { signInId: left["signInId"], target: { placeId }, agent: "codex", last: missed },
        { signInId, target: { placeId }, agent: "codex", ended: true },
      ],
    });
    await until(() => back.events.some(e => e.type === "agents.signIn"));
    expect(back.events.filter(e => e.type === "agents.signIn")).toEqual([missed]);
    expect((await back.request("agents.signInCode", { signInId: left["signInId"], code: "EFGH-5678" })).ok).toBe(true);
    expect(typed.at(-1)).toBe("EFGH-5678");
    expect((await back.request("agents.signIns"))["runs"]).toHaveLength(2);
    // Listing again follows nothing twice: the one step it holds came once.
    await new Promise(r => setTimeout(r, 20));
    expect(back.events.filter(e => e.type === "agents.signIn")).toHaveLength(1);
    expect(await ticketed.request("agents.signIns")).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
    expect(await other.request("agents.signIn", { target: { placeId }, agent: "codex" })).toMatchObject({ ok: true, signInId: left["signInId"] });
    expect((await other.request("agents.signInStop", { signInId: left["signInId"] })).ok).toBe(true);
    await until(() => ended === 2);
    expect((await back.request("agents.signIns"))["runs"]).toMatchObject([{ signInId, ended: true }, { signInId: left["signInId"], ended: true }]);
    // A server's sign-in is listed with the row it was started from: where that server's config sits.
    const server = await back.request("servers.signIn", { target: { placeId }, agent: "codex", name: "notion", scope: "project", project: "pr_1" });
    expect(server.ok, String(server["error"])).toBe(true);
    expect(await other.request("agents.signIns")).toMatchObject({ ok: true, runs: [{ signInId: server["signInId"], target: { placeId }, agent: "codex", server: "notion", scope: "project", project: "pr_1" }, {}, {}] });
    expect((await back.request("agents.signInStop", { signInId: server["signInId"] })).ok).toBe(true);
    await until(() => ended === 3);
  });

  it("read an agent whose login lives on that computer as signed in once its sign-in there lands, on the row and the next read, without waiting for a redial", async () => {
    const asked: AgentsOn[] = [];
    const ends: Record<string, AgentsSignInEvent["state"]> = { codex: "signed-in", claude: "signed-in" };
    const acts: AgentsActs = {
      signInLine: async () => ({ command: "codex login --device-auth" }),
      signIn: async (_on, ask) => async run => void run.emit({ state: ends[ask.agent]! }),
      key: async () => {},
      addTools: async () => ({ file: "~/.codex/config.toml" }),
    };
    const { hostKey } = await serving({ agentsReader: reading(asked, []), agentsActs: acts, vault: {} });
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: [] }),
      answers: c =>
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (typeof frame["op"] === "string") c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: "maya", stderr: "", truncated: false });
        }),
    });
    sockets.push(client.ws);
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    const landed = async (agent: string): Promise<void> => {
      const before = c.events.filter(e => e.type === "agents.changed").length;
      expect((await c.request("agents.signIn", { target: { placeId }, agent })).ok).toBe(true);
      await until(() => c.events.filter(e => e.type === "agents.changed").length > before);
    };
    expect((await c.request("events.subscribe")).ok).toBe(true);
    // A failed sign-in and a login kept in the home of that computer's login, which no workspace shares, change no word.
    ends["codex"] = "failed";
    await landed("codex");
    await landed("claude");
    expect((await placesOf()).find(p => p.id === placeId)!.signIns).toEqual({ claude: "none", codex: "none" });
    ends["codex"] = "signed-in";
    await landed("codex");
    expect((await placesOf()).find(p => p.id === placeId)!.signIns).toEqual({ claude: "none", codex: "signed-in" });
    expect((await c.request("agents.read", { target: { placeId } })).ok).toBe(true);
    expect(asked.at(-1)).toMatchObject({ kind: "box", signIns: { claude: "none", codex: "signed-in" } });
  });

  it("closes the reader with the runtime, which is what ends the agents' commands still running", async () => {
    let closed = 0;
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, agentsReader: { ...reading([], []), close: () => closed++ } });
    await rt.close();
    expect(closed).toBe(1);
  });
});
