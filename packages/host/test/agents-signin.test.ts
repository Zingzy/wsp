// SPDX-License-Identifier: AGPL-3.0-only
// Signing an agent or one of its MCP servers in from the app: the line each
// target runs, the watched pty over a scripted link, the vault and the wsp
// tools. Nothing here reaches a real agent, a box or a vendor.
import { mkdtempSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Machine } from "@wsp/engine";
import { HERE_PLACE_ID, addToolsHereRefusal, noVaultKeyRefusal, notTokenRefusal, serverSignInCopyRefusal, signInTerminalRefusal, signInVaultRefusal, type AgentsSignInEvent } from "@wsp/protocol";
import type { AgentsOn } from "@wsp/runtime";
import { hostActs, planSignIn, watchSignIn } from "../src/agents-signin.js";
import { CLI_VERBS, runVerb, type HostClient } from "../src/verbs.js";
import { fakePtyLink, type FakePty } from "./fake-pty-link.js";
import { captured } from "./verbs-fixture.js";

/** A box whose daemon runs as root and whose home belongs to ada, answering the one probe of who its lines run as. */
const rootBox = (): AgentsOn => ({
  kind: "box",
  machine: { exec: async () => ({ exitCode: 0, stdout: "Linux\n0\nroot\nada\n1\n/root\n/usr/bin\n", stderr: "" }) } as unknown as Pick<Machine, "exec">,
  login: { HOME: "/home/ada", PATH: "/usr/local/bin:/usr/bin" },
  logins: "/var/lib/wsp/logins",
});
const fork = (): AgentsOn => ({ kind: "machine", machine: { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as never, project: "/root/landing" });

describe("the line a sign-in runs where it stands", () => {
  it("runs a login that is not shared as the owner of the home on a root box, with no DISPLAY anywhere so the tool takes its paste road", async () => {
    const box = await planSignIn(rootBox(), { agent: "gemini" });
    expect(box.line.command).toMatch(/^runuser -u 'ada' -- bash -c '.*gemini --skip-trust'$/);
    expect(box.line.command).toContain("export HOME='\\''/home/ada'\\''");
    expect(box.line.status).toMatch(/^runuser -u 'ada' -- bash -c /);
    expect(box.line.env).toBeUndefined();
    const onFork = await planSignIn(fork(), { agent: "gemini" });
    expect(onFork.line).toEqual({ command: "gemini --skip-trust", status: expect.stringContaining("oauth_creds.json") });
    const here = await planSignIn({ kind: "here" }, { agent: "gemini" });
    expect(here.line.command).toBe("gemini --skip-trust");
    expect(JSON.stringify([box.line, onFork.line, here.line])).not.toContain("DISPLAY");
  });

  it("points a shared login's store at the box's logins folder, made first, and runs its device flow as the daemon that owns that folder", async () => {
    const plan = await planSignIn(rootBox(), { agent: "codex" });
    expect(plan.line).toEqual({
      command: "codex login --device-auth",
      env: { CODEX_HOME: "/var/lib/wsp/logins/codex" },
      prepare: "mkdir -p '/var/lib/wsp/logins/codex'",
      status: "codex login status",
    });
    // Off a box the same login is the tool's own, in the home.
    expect((await planSignIn(fork(), { agent: "codex" })).line).toEqual({ command: "codex login --device-auth", status: "codex login status" });
  });

  it("refuses a token row and, for the app, a row that asks the person to pick; the person's terminal takes that one", async () => {
    await expect(planSignIn({ kind: "here" }, { agent: "claude" })).rejects.toThrow(signInVaultRefusal("Claude Code"));
    await expect(planSignIn({ kind: "here" }, { agent: "opencode" })).rejects.toThrow(signInTerminalRefusal("OpenCode", "wsp agents signin opencode"));
    expect((await planSignIn({ kind: "here" }, { agent: "opencode" }, { terminal: true })).line.command).toBe("opencode auth login");
    await expect(planSignIn({ kind: "here" }, { agent: "nobody" })).rejects.toThrow(/no agent nobody/);
  });

  it("runs a server's sign-in by its harness's own command, as the login on a box, and hands back the line where the page cannot come back", async () => {
    const claude = await planSignIn(rootBox(), { agent: "claude", server: "notion" });
    expect(claude.line.command).toMatch(/^runuser -u 'ada' -- bash -c '.*claude mcp login '\\''notion'\\'' --no-browser'$/);
    expect(claude.line.status).toBeUndefined();
    expect((await planSignIn({ kind: "here" }, { agent: "codex", server: "notion" })).line.command).toBe("codex mcp login 'notion'");
    await expect(planSignIn(rootBox(), { agent: "codex", server: "notion" })).rejects.toThrow(serverSignInCopyRefusal("Codex", "codex mcp login 'notion'", "callback"));
    await expect(planSignIn({ kind: "here" }, { agent: "gemini", server: "notion" })).rejects.toThrow(serverSignInCopyRefusal("Gemini CLI", "/mcp auth notion", "inside"));
  });
});

describe("a watched sign-in", () => {
  const run = async (script: (link: ReturnType<typeof fakePtyLink>, pty: FakePty, line: string) => void, plan: Awaited<ReturnType<typeof planSignIn>>) => {
    const link = fakePtyLink();
    link.script = (pty, line) => script(link, pty, line);
    const steps: Omit<AgentsSignInEvent, "type" | "signInId">[] = [];
    let type: ((code: string) => Promise<void>) | undefined;
    let stop: () => void = () => {};
    const done = watchSignIn(plan, { link, emit: s => void steps.push(s), typing: w => (type = w), stop: new Promise<void>(r => (stop = r)) }, { pollMs: 20, graceMs: 10, flushMs: 10 });
    return { link, steps, done, type: (code: string) => type?.(code), stop: () => stop() };
  };

  it("shows the page and the code the device flow printed, asks the tool's own status beside it, and ends signed in", async () => {
    let signedIn = false;
    const plan = await planSignIn(rootBox(), { agent: "codex" });
    const t = await run((l, pty, line) => {
      if (line.includes("WSP_STATUS")) {
        l.data(pty, `${signedIn ? "Logged in using ChatGPT" : "Not logged in"}\r\nWSP_STATUS ${signedIn ? 0 : 1}\r\n`);
        l.exit(pty, 0);
        return;
      }
      l.data(pty, "1. Open this link in your browser and sign in to your account\r\n   https://auth.openai.com/codex/device\r\n2. Enter this one-time code (expires in 15 minutes)\r\n   ABCD-12345\r\n");
      setTimeout(() => (signedIn = true), 40);
    }, plan);
    await t.done;
    expect(t.link.ops[0]).toEqual({ op: "exec", extra: { cmd: "mkdir -p '/var/lib/wsp/logins/codex'" } });
    const [flow] = t.link.ptys;
    expect(flow!.created["env"]).toEqual({ CODEX_HOME: "/var/lib/wsp/logins/codex" });
    expect(flow!.writes[0]).toBe("exec codex login --device-auth || exit\r");
    expect(t.steps[0]).toEqual({ state: "running" });
    expect(t.steps).toContainEqual({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", paste: false });
    expect(t.steps.at(-1)).toEqual({ state: "signed-in" });
    // Every status ran with the same store as the flow.
    expect(t.link.ptys.slice(1).every(p => (p.created["env"] as Record<string, string>)["CODEX_HOME"] === "/var/lib/wsp/logins/codex")).toBe(true);
    expect(flow!.killed).toBe(true);
  });

  it("types what the page hands back into the tool with the Enter the person would press, and says what the tool said when it did not land", async () => {
    const plan = await planSignIn(fork(), { agent: "gemini" });
    const t = await run((l, pty, line) => {
      if (line.includes("WSP_STATUS")) {
        l.data(pty, "WSP_STATUS 1\r\n");
        l.exit(pty, 0);
        return;
      }
      if (line === "4/0AbCd") {
        l.data(pty, "Authentication failed: invalid code\r\n");
        l.exit(pty, 1);
        return;
      }
      if (line.includes("gemini")) l.data(pty, "How would you like to authenticate for this project?\r\nGo to https://accounts.google.com/o/oauth2/v2/auth?x=1 and paste the code\r\n");
    }, plan);
    await new Promise(r => setTimeout(r, 60));
    // The row answers the tool's own question with an Enter; nobody else typed.
    expect(t.link.typed(t.link.ptys[0]!, "\r")).toBe(true);
    expect(t.steps).toContainEqual({ state: "waiting", url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", paste: true });
    await t.type("4/0AbCd");
    await t.done;
    expect(t.link.ptys[0]!.writes).toContain("4/0AbCd\r");
    expect(t.steps.at(-1)).toEqual({ state: "failed", said: "Authentication failed: invalid code" });
    // A tool that ends saying nothing of its own is read by its exit, never by the pty's echo of the line or the code.
    const quiet = await run((l, pty, line) => {
      if (line.includes("WSP_STATUS")) {
        l.data(pty, "WSP_STATUS 1\r\n");
        l.exit(pty, 0);
        return;
      }
      if (line === "4/0AbCd") l.exit(pty, 1);
    }, plan);
    await new Promise(r => setTimeout(r, 40));
    await quiet.type("4/0AbCd");
    await quiet.done;
    expect(quiet.steps.at(-1)).toEqual({ state: "failed", said: "it ended with exit 1" });
  });

  it("ends when whoever started it stops it, killing the pty, and reads a server's sign-in by its own exit", async () => {
    const plan = await planSignIn({ kind: "here" }, { agent: "claude", server: "notion" });
    const t = await run((l, pty, line) => {
      if (line.includes("claude mcp login")) l.data(pty, "Open https://claude.ai/oauth/authorize?code=true\r\nPaste the redirect URL: ");
    }, plan);
    await new Promise(r => setTimeout(r, 40));
    expect(t.steps).toContainEqual({ state: "waiting", url: "https://claude.ai/oauth/authorize?code=true", paste: true });
    t.stop();
    await t.done;
    expect(t.link.ptys[0]!.killed).toBe(true);
    expect(t.steps.at(-1)).toMatchObject({ state: "failed" });
    const ok = await run((l, pty, line) => {
      if (line.includes("claude mcp login")) l.exit(pty, 0);
    }, plan);
    await ok.done;
    expect(ok.steps.at(-1)).toEqual({ state: "signed-in" });
  });
});

describe("the host's acts that write", () => {
  const acts = () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-acts-"));
    const home = mkdtempSync(join(tmpdir(), "wsp-acts-home-"));
    return { dir, home, acts: hostActs({ vaultFile: join(dir, ".env"), home: () => home, wspServer: () => ({ command: "/usr/local/bin/wsp", args: ["mcp", "--state", join(dir, "state.json")] }) }) };
  };

  it("keeps a token the row's shape vouches for, a key under the variable the row reads, and nothing else", async () => {
    const { dir, acts: a } = acts();
    await expect(a.key("claude", "sk-ant-api03-not-a-token")).rejects.toThrow(notTokenRefusal("Claude Code"));
    await a.key("claude", "  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz  ");
    await a.key("gemini", "AIzaFake");
    await expect(a.key("pi", "x")).rejects.toThrow(noVaultKeyRefusal("Pi"));
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\n");
    expect(env).toContain("GEMINI_API_KEY=AIzaFake");
  });

  it("writes the wsp server into an agent's config on this computer, the entry an install writes, and nowhere else", async () => {
    const { home, acts: a } = acts();
    expect(await a.addTools({ kind: "here" }, "codex")).toEqual({ file: "~/.codex/config.toml" });
    const config = readFileSync(join(home, ".codex/config.toml"), "utf8");
    expect(config).toContain("[mcp_servers.wsp]");
    expect(config).toContain('"/usr/local/bin/wsp"');
    await expect(a.addTools(rootBox(), "codex")).rejects.toThrow(addToolsHereRefusal);
  });
});

describe("the sign-in lines at the person's terminal", () => {
  /** A host whose daemon channel is a scripted pty link, and which plans each line as the host would name it. */
  function host(link: ReturnType<typeof fakePtyLink>) {
    const asked: { op: string; params: Record<string, unknown> }[] = [];
    const frames = new Set<(f: Record<string, unknown>) => void>();
    link.onEvent(event => frames.forEach(read => read({ type: "daemon.event", channel: "ch1", event })));
    const client: HostClient = {
      request: async (op, params = {}) => {
        asked.push({ op, params });
        if (op === "agents.signInLine") return { line: { command: params["name"] === undefined ? "gemini --skip-trust" : `claude mcp login ${String(params["name"])} --no-browser`, status: "false" } } as never;
        if (op === "daemon.open") return { channel: "ch1" } as never;
        if (op === "daemon.send") {
          const { op: inner, ...extra } = params["frame"] as Record<string, unknown>;
          return { reply: await link.op(String(inner), extra) } as never;
        }
        if (op === "places.list") return { places: [{ id: "p_1", kind: "computer", name: "spoo", default: true }] } as never;
        if (op === "agents.key") return {} as never;
        return {} as never;
      },
      events: async () => undefined,
      onFrame: fn => {
        frames.add(fn);
        return () => frames.delete(fn);
      },
      closed: new Promise<void>(() => undefined),
      closeWords: () => "",
      close: () => undefined,
      terminate: () => undefined,
    };
    return { client, asked };
  }
  const terminal = () => ({ input: new PassThrough() as never, output: Object.assign(new PassThrough(), { columns: 100, rows: 30 }) as never });

  it("wsp agents signin runs the line the host planned for this computer in this terminal, and says it did not land", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(pty, "WSP_STATUS 1\r\n");
        link.exit(pty, 0);
        return;
      }
      link.exit(pty, 1);
    };
    const { client, asked } = host(link);
    const io = captured();
    const verb = CLI_VERBS.find(v => v.name === "agents signin")!;
    expect(await runVerb(verb, ["agents", "signin", "gemini"], io, () => "/tmp/state.json", { env: {}, dial: async () => client, terminal: terminal(), open: async () => false })).toBe(1);
    expect(asked.find(a => a.op === "agents.signInLine")?.params).toEqual({ target: { placeId: HERE_PLACE_ID }, agent: "gemini" });
    expect(asked.find(a => a.op === "daemon.open")?.params).toEqual({ placeId: HERE_PLACE_ID });
    expect(link.ptys[0]!.writes[0]).toBe("exec gemini --skip-trust || exit\r");
    expect(io.lines).toEqual(["Gemini CLI is not signed in on this computer."]);
  });

  it("wsp servers signin runs one server's line where it is set up and reads it by its exit; wsp agents key takes the paste at a terminal alone", async () => {
    const link = fakePtyLink();
    link.script = pty => link.exit(pty, 0);
    const { client, asked } = host(link);
    const io = captured();
    const verb = CLI_VERBS.find(v => v.name === "servers signin")!;
    expect(await runVerb(verb, ["servers", "signin", "notion", "--agent", "claude", "--on", "spoo"], io, () => "/tmp/state.json", { env: {}, dial: async () => client, terminal: terminal(), open: async () => false })).toBe(0);
    expect(asked.find(a => a.op === "agents.signInLine")?.params).toEqual({ target: { placeId: "p_1" }, agent: "claude", name: "notion" });
    expect(io.lines).toEqual(["notion is signed in on spoo."]);
    const key = CLI_VERBS.find(v => v.name === "agents key")!;
    const off = captured();
    expect(await runVerb(key, ["agents", "key", "claude"], off, () => "/tmp/state.json", { env: {}, dial: async () => client })).toBe(3);
    expect(off.errors[0]).toContain("nobody is at this terminal");
    const at = { ...captured(), isTTY: true, askSecret: async (q: string) => (expect(q).toContain("claude setup-token"), "sk-ant-oat01-typed") };
    expect(await runVerb(key, ["agents", "key", "claude"], at, () => "/tmp/state.json", { env: {}, dial: async () => client })).toBe(0);
    expect(asked.find(a => a.op === "agents.key")?.params).toEqual({ agent: "claude", key: "sk-ant-oat01-typed" });
  });
});
