// SPDX-License-Identifier: AGPL-3.0-only
// Signing an agent or one of its MCP servers in from the app: the line each
// target runs, the watched pty over a scripted link, the vault and the wsp
// tools. Nothing here reaches a real agent, a box or a vendor.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Machine } from "@wsp/engine";
import { HERE_PLACE_ID, addToolsHereRefusal, closedBeforeSignInLine, controlSignInRefusal, mintFailedLine, signInUncheckedLine, noVaultKeyRefusal, notTokenRefusal, serverNotSetUpLine, serverSignInCopyRefusal, shellQuote, signInTerminalRefusal, signInVaultRefusal, type AgentsSignInEvent } from "@wsp/protocol";
import type { AgentsOn, SignInForward } from "@wsp/runtime";
import { hostActs, pagesOnPty, planSignIn, terminalSignIn, watchSignIn } from "../src/agents-signin.js";
import { signInPrepareLine } from "../src/place-signin.js";
import { openerCommand } from "../src/relay.js";
import { CLI_VERBS, runVerb, type HostClient } from "../src/verbs.js";
import { fakePtyLink, type FakePty } from "./fake-pty-link.js";
import { captured } from "./verbs-fixture.js";
import { writeStub } from "../../protocol/test/stub-script.js";

/** A box whose daemon runs as root and whose home belongs to ada, answering the one probe of who its lines run as. */
const rootBox = (): AgentsOn => ({
  kind: "box",
  machine: { exec: async () => ({ exitCode: 0, stdout: "Linux\n0\nroot\nada\n1\n/root\n/usr/bin\n", stderr: "" }) } as unknown as Pick<Machine, "exec">,
  login: { HOME: "/home/ada", PATH: "/usr/local/bin:/usr/bin" },
  logins: "/wsp/logins",
});
const fork = (): AgentsOn => ({ kind: "machine", machine: { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as never, projects: [{ id: "pr_landing", name: "landing", path: "/root/landing" }] });
/** A workspace whose callback port this host forwards from this computer. */
const relayed = (): AgentsOn => ({ ...fork(), relayed: true }) as AgentsOn;
/** A joined computer whose daemon and home are root's, and whose callback port this host forwards from here. */
const relayedBox = (): AgentsOn => ({
  kind: "box",
  machine: { exec: async () => ({ exitCode: 0, stdout: "Linux\n0\nroot\nroot\n1\n/root\n/usr/bin\n", stderr: "" }) } as unknown as Pick<Machine, "exec">,
  login: { HOME: "/root", PATH: "/usr/bin" },
  relayed: true,
});

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
      env: { CODEX_HOME: "/wsp/logins/codex" },
      prepare: "mkdir -p '/wsp/logins/codex'",
      status: "codex login status",
    });
    // Off a box the same login is the tool's own, in the home.
    expect((await planSignIn(fork(), { agent: "codex" })).line).toEqual({ command: "codex login --device-auth", status: "codex login status" });
  });

  it("signs the GitHub CLI in on a box by its own web login, a tool with a login and not an agent", async () => {
    const plan = await planSignIn(relayedBox(), { agent: "gh" });
    expect(plan.line.command).toContain("gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key");
    expect(plan.line.status).toContain("gh auth status");
    // A tool with no login of its own is still no sign-in.
    await expect(planSignIn(relayedBox(), { agent: "jq" })).rejects.toThrow(/no agent jq/);
  });

  it("signs Claude Code in on a box by its own login, pointed at the store that box's threads read, its code pasted back", async () => {
    const plan = await planSignIn({ ...relayedBox(), stores: { claude: "/root/.local/share/wsp/claude" } } as AgentsOn, { agent: "claude" });
    expect(plan.line.command).toMatch(/export CLAUDE_CONFIG_DIR='\/root\/\.local\/share\/wsp\/claude'; claude auth login --claudeai$/);
    expect(plan.line.status).toMatch(/export CLAUDE_CONFIG_DIR='\/root\/\.local\/share\/wsp\/claude'; claude auth status$/);
    expect(plan.paste("https://claude.ai/oauth/authorize?code=true")).toBe(true);
    // Its login is a box's alone: a workspace and this computer take the token or the key.
    await expect(planSignIn(fork(), { agent: "claude" })).rejects.toThrow(signInVaultRefusal("Claude Code"));
  });

  it("refuses a token row and, for the app, a row that asks the person to pick; the person's terminal takes that one", async () => {
    await expect(planSignIn({ kind: "here" }, { agent: "claude" })).rejects.toThrow(signInVaultRefusal("Claude Code"));
    await expect(planSignIn({ kind: "here" }, { agent: "claude" }, { terminal: true, keep: () => {} })).rejects.toThrow(signInVaultRefusal("Claude Code"));
    await expect(planSignIn({ kind: "here" }, { agent: "opencode" })).rejects.toThrow(signInTerminalRefusal("OpenCode", "wsp agents signin opencode"));
    expect((await planSignIn({ kind: "here" }, { agent: "opencode" }, { terminal: true })).line.command).toBe("opencode auth login");
    await expect(planSignIn({ kind: "here" }, { agent: "nobody" })).rejects.toThrow(/no agent nobody/);
  });

  it("runs a server's sign-in by its harness's own command, as the login on a box, and hands back the line where the page cannot come back", async () => {
    const claude = await planSignIn(rootBox(), { agent: "claude", server: "notion" });
    expect(claude.line.command).toMatch(/^runuser -u 'ada' -- bash -c '.*claude mcp login '\\''notion'\\'' --no-browser'$/);
    expect(claude.line.status).toBeUndefined();
    expect(claude.line.env).toBeUndefined();
    expect(claude.paste("https://mcp.notion.com/authorize")).toBe(true);
    // Here the harness opens the page in this computer's browser and its own listener takes the redirect.
    const here = await planSignIn({ kind: "here" }, { agent: "claude", server: "notion" });
    expect(here.line).toEqual({ command: "claude mcp login 'notion'", env: { BROWSER: process.env["BROWSER"] || openerCommand() } });
    expect(here.paste("https://mcp.notion.com/authorize")).toBe(false);
    expect((await planSignIn({ kind: "here" }, { agent: "codex", server: "notion" })).line.command).toBe("codex mcp login 'notion'");
    await expect(planSignIn(rootBox(), { agent: "codex", server: "notion" })).rejects.toThrow(serverSignInCopyRefusal("Codex", "codex mcp login 'notion'", "callback"));
    await expect(planSignIn(fork(), { agent: "codex", server: "notion" })).rejects.toThrow(serverSignInCopyRefusal("Codex", "codex mcp login 'notion'", "callback"));
    // Where the relay carries the page here and its redirect back, every harness runs its own browser sign-in with the
    // workspace terminal's browser env: the daemon's shim as BROWSER behind the sign-in's own opener, and a DISPLAY for
    // a tool that asks for one.
    for (const [agent, command] of [["claude", "claude mcp login 'notion'"], ["codex", "codex mcp login 'notion'"], ["opencode", "opencode mcp auth 'notion'"]] as const) {
      const plan = await planSignIn(relayed(), { agent, server: "notion" });
      expect(plan.line).toEqual({ command: pagesOnPty(command), env: { DISPLAY: ":0" } });
      expect(plan.paste("https://mcp.notion.com/authorize")).toBe(false);
    }
    await expect(planSignIn({ kind: "here" }, { agent: "gemini", server: "notion" })).rejects.toThrow(serverSignInCopyRefusal("Gemini CLI", "/mcp auth notion", "inside"));
  });

  it("runs every harness's browser sign-in on a joined computer the relay reaches, with that computer's own shim as BROWSER", async () => {
    for (const [agent, command] of [["claude", "claude mcp login 'notion'"], ["codex", "codex mcp login 'notion'"], ["opencode", "opencode mcp auth 'notion'"]] as const) {
      const plan = await planSignIn(relayedBox(), { agent, server: "notion" });
      expect(plan.line.command).toBe(`export HOME='/root' PATH='/usr/bin'; cd "$HOME" 2>/dev/null; ${pagesOnPty(command)}`);
      expect(plan.line.env).toEqual({ DISPLAY: ":0", BROWSER: "/root/.local/bin/wsp-open" });
      expect(plan.paste("https://mcp.notion.com/authorize")).toBe(false);
    }
    // A line handed to another login can open neither the pty's device nor the root daemon's socket, so the page there
    // never reaches this computer: Claude Code keeps the pasted address and the others the line to run there.
    const handedOn = { ...rootBox(), relayed: true } as AgentsOn;
    expect((await planSignIn(handedOn, { agent: "claude", server: "notion" })).line.command).toContain("--no-browser");
    await expect(planSignIn(handedOn, { agent: "codex", server: "notion" })).rejects.toThrow(serverSignInCopyRefusal("Codex", "codex mcp login 'notion'", "callback"));
  });

  it("runs a server's sign-in on a joined computer with the store its threads there read, as their agent reads its servers", async () => {
    const stores = { claude: "/root/.claude", codex: "/wsp/logins/codex" };
    for (const [agent, line] of [["claude", "export CLAUDE_CONFIG_DIR='/root/.claude'; claude mcp login 'axiom'"], ["codex", "export CODEX_HOME='/wsp/logins/codex'; codex mcp login 'axiom'"]] as const) {
      const plan = await planSignIn({ ...relayedBox(), stores } as AgentsOn, { agent, server: "axiom" });
      expect(plan.line.command).toBe(`export HOME='/root' PATH='/usr/bin'; cd "$HOME" 2>/dev/null; ${pagesOnPty(line)}`);
    }
    const pasted = await planSignIn({ ...rootBox(), stores } as AgentsOn, { agent: "claude", server: "cloudflare" });
    expect(pasted.line.command).toBe(`runuser -u 'ada' -- bash -c ${shellQuote(`export HOME='/home/ada' PATH='/usr/local/bin:/usr/bin'; cd "$HOME" 2>/dev/null; export CLAUDE_CONFIG_DIR='/root/.claude'; claude mcp login 'cloudflare' --no-browser`)}`);
  });

  it("hands the person a Codex server's sign-in line on a box with the store its threads read, where the page cannot come back", async () => {
    const stores = { codex: "/wsp/logins/codex", claude: "/root/.claude" };
    await expect(planSignIn({ ...rootBox(), relayed: true, stores } as AgentsOn, { agent: "codex", server: "axiom" })).rejects.toThrow(
      serverSignInCopyRefusal("Codex", "export CODEX_HOME='/wsp/logins/codex'; codex mcp login 'axiom'", "callback"),
    );
    await expect(planSignIn({ ...rootBox(), stores } as AgentsOn, { agent: "codex", server: "axiom" })).rejects.toThrow("export CODEX_HOME='/wsp/logins/codex'; codex mcp login 'axiom'");
  });

  it("runs a project's server sign-in in that project's folder, and an agent's own login and status with its store", async () => {
    const stores = { codex: "/wsp/logins/codex", claude: "/root/.claude" };
    const projects = [{ id: "pr_lab", name: "lab", path: "/root/lab" }];
    const plan = await planSignIn({ ...relayedBox(), stores, projects } as AgentsOn, { agent: "claude", server: "docs", scope: "project", project: "pr_lab" });
    expect(plan.line.command).toBe(`export HOME='/root' PATH='/usr/bin'; cd "$HOME" 2>/dev/null; ${pagesOnPty("cd '/root/lab' 2>/dev/null; export CLAUDE_CONFIG_DIR='/root/.claude'; claude mcp login 'docs'")}`);
    const own = await planSignIn({ ...rootBox(), stores } as AgentsOn, { agent: "codex" });
    expect(own.line).toMatchObject({ command: "export CODEX_HOME='/wsp/logins/codex'; codex login --device-auth", status: "export CODEX_HOME='/wsp/logins/codex'; codex login status" });
  });

  it("refuses a server or agent named with a control character before anything is planned or dialled", async () => {
    let probed = 0;
    const box = rootBox();
    const counted: AgentsOn = { ...box, machine: { exec: async (...a: Parameters<Pick<Machine, "exec">["exec"]>) => (probed++, (box as { machine: Pick<Machine, "exec"> }).machine.exec(...a)) } } as AgentsOn;
    for (const ask of [{ agent: "claude", server: "notion\x15echo hi; #" }, { agent: "claude", server: "notion\r" }, { agent: "codex\x03" }]) {
      await expect(planSignIn(counted, ask)).rejects.toThrow(controlSignInRefusal);
      await expect(planSignIn(counted, ask, { terminal: true })).rejects.toThrow(controlSignInRefusal);
    }
    expect(probed).toBe(0);
  });
});

describe("a sign-in in the person's own terminal", () => {
  const run = async (plan: Awaited<ReturnType<typeof planSignIn>>, status: () => boolean) => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (!line.includes("WSP_STATUS")) return;
      link.data(pty, `${status() ? "1 credentials" : "0 credentials"}\r\nWSP_STATUS 0\r\n`);
      link.exit(pty, 0);
    };
    const steps: Omit<AgentsSignInEvent, "type" | "signInId">[] = [];
    let stop: () => void = () => {};
    const done = terminalSignIn(plan, { link, emit: s => void steps.push(s), typing: () => {}, stop: new Promise<void>(r => (stop = r)) }, { capMs: 5_000 });
    await new Promise(r => setTimeout(r, 10));
    return { link, steps, done, stop: () => stop() };
  };

  it("runs a login that asks the person to pick in a pty there whose id it names, as the pty's own command, and reads its status once it ends", async () => {
    let signedIn = false;
    const plan = await planSignIn(rootBox(), { agent: "opencode" }, { terminal: true });
    const t = await run(plan, () => signedIn);
    const [login] = t.link.ptys;
    // The line is the pty's own, so nothing of how it runs is typed onto the person's screen.
    expect(login!.created).toMatchObject({ shell: "bash", run: plan.line.command });
    expect(login!.writes).toEqual([]);
    expect(login!.attached).toBe(true);
    expect(t.steps).toEqual([{ state: "running", ptyId: login!.id }]);
    signedIn = true;
    t.link.exit(login!, 0);
    await t.done;
    expect(t.steps.at(-1)).toEqual({ state: "signed-in" });
    expect(login!.killed).toBe(true);
  });

  it("ends failed where the person left the tool without signing in, and where the sign-in was stopped", async () => {
    const plan = await planSignIn(rootBox(), { agent: "opencode" }, { terminal: true });
    const left = await run(plan, () => false);
    left.link.exit(left.link.ptys[0]!, 1);
    await left.done;
    // What happened in the person's words: they left OpenCode, which no exit code says.
    expect(left.steps.at(-1)).toEqual({ state: "failed", said: closedBeforeSignInLine("OpenCode") });
    const stopped = await run(plan, () => false);
    stopped.stop();
    await stopped.done;
    expect(stopped.steps.at(-1)?.state).toBe("failed");
    expect(stopped.link.ptys[0]!.killed).toBe(true);
  });

  it("says the sign-in could not be checked, not that the person left, where its status read could not run there", async () => {
    const plan = await planSignIn(rootBox(), { agent: "opencode" }, { terminal: true });
    const t = await run(plan, () => true);
    const op = t.link.op.bind(t.link);
    // The link drops as the login ends: the status read opens no terminal there.
    t.link.op = async (name, extra) => (name === "pty.create" ? Promise.reject(new Error("daemon connection closed 1006")) : op(name, extra));
    t.link.exit(t.link.ptys[0]!, 0);
    await t.done;
    expect(t.steps.at(-1)).toEqual({ state: "failed", said: signInUncheckedLine("OpenCode") });
  });

  it("a refused or failed step before the login ends the sign-in failed with one sentence naming the computer, and never opens the pty", async () => {
    const plan = await planSignIn({ ...rootBox(), name: "hetzner" } as AgentsOn, { agent: "codex" }, { terminal: true });
    expect(plan.line.prepare).toBe("mkdir -p '/wsp/logins/codex'");
    for (const [reply, said] of [
      [{ ok: false, error: "exec is not served on this channel" }, "exec is not served on this channel"],
      [{ ok: true, exitCode: 1, stdout: "", stderr: "mkdir: cannot create directory '/wsp/logins/codex': Permission denied\n", truncated: false }, "mkdir: cannot create directory '/wsp/logins/codex': Permission denied"],
    ] as const) {
      const link = fakePtyLink();
      link.answerExec = () => reply;
      const steps: Omit<AgentsSignInEvent, "type" | "signInId">[] = [];
      await terminalSignIn(plan, { link, emit: s => void steps.push(s), typing: () => {}, stop: new Promise<void>(() => {}) }, { capMs: 5_000 });
      expect(steps).toEqual([{ state: "failed", said: signInPrepareLine("hetzner", said) }]);
      expect(link.ops.filter(o => o.op === "pty.create")).toEqual([]);
    }
  });

  it("is the road the host's sign-in takes when the app asks for its terminal, where a watched one refuses that login", async () => {
    const acts = hostActs({ vaultFile: "/nowhere/.env", home: () => "/nowhere", wspServer: () => ({ command: "wsp", args: [] }) });
    await expect(acts.signIn(rootBox(), { agent: "opencode" })).rejects.toThrow(signInTerminalRefusal("OpenCode", "wsp agents signin opencode"));
    const go = await acts.signIn(rootBox(), { agent: "opencode", terminal: true });
    const link = fakePtyLink();
    const steps: Omit<AgentsSignInEvent, "type" | "signInId">[] = [];
    let stop: () => void = () => {};
    const done = go({ link, emit: s => void steps.push(s), typing: () => {}, stop: new Promise<void>(r => (stop = r)) });
    await new Promise(r => setTimeout(r, 10));
    expect(steps[0]).toEqual({ state: "running", ptyId: link.ptys[0]!.id });
    stop();
    await done;
  });
});

describe("a watched sign-in", () => {
  const run = async (script: (link: ReturnType<typeof fakePtyLink>, pty: FakePty, line: string) => void, plan: Awaited<ReturnType<typeof planSignIn>>, banner?: string, forward?: SignInForward) => {
    const link = fakePtyLink();
    if (banner !== undefined) link.banner = banner;
    link.script = (pty, line) => script(link, pty, line);
    const steps: Omit<AgentsSignInEvent, "type" | "signInId">[] = [];
    let type: ((code: string) => Promise<void>) | undefined;
    let stop: () => void = () => {};
    const done = watchSignIn(plan, { link, emit: s => void steps.push(s), typing: w => (type = w), stop: new Promise<void>(r => (stop = r)), ...(forward !== undefined ? { forward } : {}) }, { pollMs: 20, graceMs: 10, flushMs: 10 });
    return { link, steps, done, type: (code: string) => type?.(code), stop: () => stop() };
  };

  it("a refused or failed step before the command ends the sign-in failed with one sentence naming the computer, and never opens the pty", async () => {
    const plan = await planSignIn({ ...rootBox(), name: "hetzner" } as AgentsOn, { agent: "codex" });
    for (const [reply, said] of [
      [{ ok: false, error: "exec is not served on this channel" }, "exec is not served on this channel"],
      [{ ok: true, exitCode: 1, stdout: "", stderr: "mkdir: cannot create directory '/wsp/logins/codex': Permission denied\n", truncated: false }, "mkdir: cannot create directory '/wsp/logins/codex': Permission denied"],
    ] as const) {
      const link = fakePtyLink();
      link.answerExec = () => reply;
      const steps: Omit<AgentsSignInEvent, "type" | "signInId">[] = [];
      await watchSignIn(plan, { link, emit: s => void steps.push(s), typing: () => {}, stop: new Promise<void>(() => {}) }, { pollMs: 20, graceMs: 10, flushMs: 10 });
      expect(steps).toEqual([{ state: "failed", said: `the sign-in on hetzner did not start, since the step before it failed: ${said}` }]);
      expect(link.ops.filter(o => o.op === "pty.create")).toEqual([]);
    }
  });

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
    expect(t.link.ops[0]).toEqual({ op: "exec", extra: { cmd: "mkdir -p '/wsp/logins/codex'" } });
    const [flow] = t.link.ptys;
    expect(flow!.created["env"]).toEqual({ CODEX_HOME: "/wsp/logins/codex" });
    expect(flow!.ran).toBe("codex login --device-auth");
    expect(t.steps[0]).toEqual({ state: "running" });
    expect(t.steps).toContainEqual({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", paste: false });
    expect(t.steps.at(-1)).toEqual({ state: "signed-in" });
    // Every status ran with the same store as the flow.
    expect(t.link.ptys.slice(1).every(p => (p.created["env"] as Record<string, string>)["CODEX_HOME"] === "/wsp/logins/codex")).toBe(true);
    expect(flow!.killed).toBe(true);
  });

  it("makes Claude Code's token on this computer, keeps it in the vault off what the command printed, and never says it", async () => {
    const token = `sk-ant-oat01-${"Fake_token-".repeat(8)}`;
    for (const [exit, kept] of [[0, [["CLAUDE_CODE_OAUTH_TOKEN", token]]], [1, []]] as const) {
      const keeps: [string, string][] = [];
      const plan = await planSignIn({ kind: "here" }, { agent: "claude" }, { keep: (name, value) => void keeps.push([name, value]) });
      const t = await run((l, pty, line) => {
        if (!line.includes("setup-token")) return;
        l.data(pty, `Browser didn't open? Use the url below to sign in:\r\nhttps://claude.ai/oauth/authorize?code=true\r\n\x1b[32m✓\x1b[0m Long-lived authentication token created:\r\n${token}\r\n`);
        l.exit(pty, exit);
      }, plan);
      await t.done;
      expect(t.link.ptys[0]!.ran).toBe("claude setup-token");
      expect(keeps).toEqual(kept);
      expect(t.steps.at(-1)).toEqual(exit === 0 ? { state: "signed-in" } : { state: "failed", said: mintFailedLine("claude setup-token") });
      expect(JSON.stringify(t.steps)).not.toContain(token);
    }
  });

  it("says a fixed line when setup-token ends well with no token it reads, never what it printed last", async () => {
    const moved = `sk-ant-oat02-${"Fake_token-".repeat(8)}`;
    const keeps: [string, string][] = [];
    const plan = await planSignIn({ kind: "here" }, { agent: "claude" }, { keep: (name, value) => void keeps.push([name, value]) });
    const t = await run((l, pty, line) => {
      if (!line.includes("setup-token")) return;
      l.data(pty, `Long-lived authentication token created:\r\n${moved}\r\n`);
      l.exit(pty, 0);
    }, plan);
    await t.done;
    expect(keeps).toEqual([]);
    expect(t.steps.at(-1)).toEqual({ state: "failed", said: mintFailedLine("claude setup-token") });
    expect(JSON.stringify(t.steps)).not.toContain(moved);
  });

  it("reads the page and the code from the tool alone, never from what the shell printed before it started", async () => {
    let signedIn = false;
    const plan = await planSignIn(rootBox(), { agent: "codex" });
    const t = await run((l, pty, line) => {
      if (line.includes("WSP_STATUS")) {
        l.data(pty, `${signedIn ? "Logged in using ChatGPT" : "Not logged in"}\r\nWSP_STATUS ${signedIn ? 0 : 1}\r\n`);
        l.exit(pty, 0);
        return;
      }
      l.data(pty, "Open https://auth.openai.com/codex/device\r\nEnter this one-time code\r\n   ABCD-12345\r\n");
      setTimeout(() => (signedIn = true), 40);
    }, plan, "Last login: see https://evil.example/login and enter EVIL-99999\r\n");
    await t.done;
    expect(t.steps.filter(s => s.state === "waiting")).toEqual([{ state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", paste: false }]);
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
    const plan = await planSignIn(fork(), { agent: "claude", server: "notion" });
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
    const bad = await run((l, pty, line) => {
      if (!line.includes("claude mcp login")) return;
      l.data(pty, "Authentication failed: the server refused the redirect\r\n");
      l.exit(pty, 1);
    }, plan);
    await bad.done;
    expect(bad.steps.at(-1)).toEqual({ state: "failed", said: "Authentication failed: the server refused the redirect" });
  });

  it("says a server its harness does not have is not set up there, in one plain line and never the harness's own words", async () => {
    for (const [agent, name, said] of [
      ["codex", "axiom", "WARNING: proceeding, even though we could not create PATH aliases\r\nError: No MCP server named 'axiom' found.\r\n"],
      ["claude", "cloudflare", 'No MCP server named "cloudflare". Configured servers: plugin:context7:context7, plugin:vercel:vercel\r\n'],
      ["claude", "cloudflare", 'No MCP server named "cloudflare". Run `claude mcp add` to add one.\r\n'],
    ] as const) {
      const plan = await planSignIn(relayed(), { agent, server: name });
      const t = await run((l, pty, line) => {
        if (!line.includes(" mcp login ")) return;
        l.data(pty, said);
        l.exit(pty, 1);
      }, plan);
      await t.done;
      expect(t.steps.at(-1)).toEqual({ state: "failed", said: serverNotSetUpLine(agent === "codex" ? "Codex" : "Claude Code", name) });
    }
  });

  it("offers only the page the sign-in's own opener wrote on its terminal, never a browser.open from anything else on the workspace", async () => {
    const plan = await planSignIn(relayed(), { agent: "claude", server: "notion" });
    const page = "https://mcp.notion.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A43117%2Fcallback";
    const t = await run((l, pty, line) => {
      if (!line.includes("claude mcp login")) return;
      l.emit({ type: "browser.open", url: "https://evil.example/authorize", port: 43118 });
      setTimeout(() => l.data(pty, `${page}\r\n`), 10);
      setTimeout(() => l.exit(pty, 0), 40);
    }, plan);
    await t.done;
    expect(t.link.ptys[0]!.ran).toBe(pagesOnPty("claude mcp login 'notion'"));
    expect(t.steps.filter(s => s.state === "waiting")).toEqual([{ state: "waiting", url: page, paste: false }]);
    expect(t.steps.at(-1)).toEqual({ state: "signed-in" });
  });

  it("writes the page a tool hands its browser onto the sign-in's own terminal, then opens it with the browser the terminal had", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-pages-"));
    const opened = join(dir, "opened");
    const shim = join(dir, "shim");
    writeStub(shim, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(opened)}\n`);
    const page = "https://mcp.test/authorize?state=x&redirect_uri=http%3A%2F%2Flocalhost%3A43117%2Fcallback";
    // The tool hands the page to its browser with no terminal of its own, as a detached opener does.
    const line = pagesOnPty(`"$BROWSER" '${page}' < /dev/null > /dev/null 2>&1; echo done`);
    const args = process.platform === "darwin" ? ["-q", "/dev/null", "bash", "-c", line] : ["-qec", `bash -c ${shellQuote(line)}`, "/dev/null"];
    const out = execFileSync("script", args, { env: { PATH: "/usr/bin:/bin", BROWSER: shim }, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toContain(`${page}\r\n`);
    expect(readFileSync(opened, "utf8")).toBe(page);
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes the escape bytes out of a page before it reaches the sign-in's terminal", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-pages-"));
    const shim = join(dir, "shim");
    writeStub(shim, "#!/bin/sh\nexit 0\n");
    const line = pagesOnPty(`"$BROWSER" "$(printf 'https://mcp.test/a\\033]0;x\\007b\\033[2Jc')" < /dev/null > /dev/null 2>&1; echo done`);
    const args = process.platform === "darwin" ? ["-q", "/dev/null", "bash", "-c", line] : ["-qec", `bash -c ${shellQuote(line)}`, "/dev/null"];
    const out = execFileSync("script", args, { env: { PATH: "/usr/bin:/bin", BROWSER: shim }, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toContain("https://mcp.test/a]0;xb[2Jc\r\n");
    expect(out).not.toMatch(/[\x07\x1b]/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("arms the relay's forward for the page's callback port, and where this computer cannot listen on it carries the landed address there instead", async () => {
    const page = "https://mcp.notion.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A43117%2Fcallback";
    const plan = await planSignIn(relayedBox(), { agent: "codex", server: "notion" });
    for (const bound of [true, false]) {
      const armed: string[] = [];
      const delivered: string[] = [];
      const forward: SignInForward = { arm: async url => (armed.push(url), bound), deliver: async landed => void delivered.push(landed), close: () => {} };
      let finish: () => void = () => {};
      const t = await run(
        (l, pty, line) => {
          if (!line.includes("codex mcp login")) return;
          l.data(pty, `Authorize by opening this URL: ${page}\r\n`);
          finish = () => l.exit(pty, 0);
        },
        plan,
        undefined,
        forward,
      );
      await new Promise(r => setTimeout(r, 60));
      expect(armed).toEqual([page]);
      const waiting = t.steps.filter(s => s.state === "waiting");
      if (bound) expect(waiting).toEqual([{ state: "waiting", url: page, paste: false }]);
      else {
        expect(waiting).toEqual([
          { state: "waiting", url: page, paste: false },
          { state: "waiting", url: page, paste: true },
        ]);
        await t.type("http://localhost:43117/callback?code=LANDED");
        expect(delivered).toEqual(["http://localhost:43117/callback?code=LANDED"]);
        expect(t.link.ptys[0]!.writes.join("")).not.toContain("LANDED");
      }
      finish();
      await t.done;
      expect(t.steps.at(-1)).toEqual({ state: "signed-in" });
    }
  });

  it("waits on the browser here, with the page offered and nothing to paste, and runs with this computer's own opener", async () => {
    const plan = await planSignIn({ kind: "here" }, { agent: "claude", server: "notion" });
    const t = await run((l, pty, line) => {
      if (!line.includes("claude mcp login")) return;
      l.data(pty, "Opening your browser to https://mcp.notion.com/authorize?client_id=x\r\n");
      setTimeout(() => l.exit(pty, 0), 40);
    }, plan);
    await t.done;
    expect(t.link.ptys[0]!.ran).toBe("claude mcp login 'notion'");
    expect(t.link.ptys[0]!.created["env"]).toEqual({ BROWSER: process.env["BROWSER"] || openerCommand() });
    expect(t.steps).toContainEqual({ state: "waiting", url: "https://mcp.notion.com/authorize?client_id=x", paste: false });
    expect(t.steps.at(-1)).toEqual({ state: "signed-in" });
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
    await expect(a.key("gemini", "   ")).rejects.toThrow("The key for Gemini CLI is empty.");
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

  it("refuses the wsp tools for an agent with no MCP config before writing anything", async () => {
    const { home, acts: a } = acts();
    await expect(a.addTools({ kind: "here" }, "pi")).rejects.toThrow("Pi has no MCP config wsp knows, so the wsp tools were not written");
    expect(readdirSync(home)).toEqual([]);
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
    expect(link.ptys[0]!.ran).toBe("gemini --skip-trust");
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
