// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { nodeHost, type Host } from "@wsp/collect";
import type { ExecResult, Machine } from "@wsp/engine";
import { placeProvisionPaths } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentHome, SECRET, type AgentHome } from "../../collect/test/agent-home.js";
import { agentsReader } from "../src/agents-reader.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): AgentHome & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-agents-"));
  roots.push(root);
  const at = agentHome(root);
  // runuser as a script on the login's PATH: it takes only the home's owner, and runs what it was handed.
  writeFileSync(join(at.bin, "runuser"), `#!/bin/bash\n[ "$1" = -u ] && [ "$2" = ada ] && [ "$3" = -- ] || exit 9\nshift 3\nexec "$@"\n`);
  chmodSync(join(at.bin, "runuser"), 0o755);
  return { ...at, root };
}

/** A computer's road that runs every line in bash with the fixture's home and PATH, keeping each line it ran. A root
 * daemon's probe is answered as a Linux box running as root would answer it, the home owned by ada. */
function road(at: AgentHome, o: { root?: boolean } = {}): { machine: Pick<Machine, "exec">; lines: string[] } {
  const lines: string[] = [];
  const env = { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home };
  const machine = {
    exec: (cmd: string): Promise<ExecResult> => {
      lines.push(cmd);
      if (o.root === true && cmd.startsWith("uname -s;")) return Promise.resolve({ exitCode: 0, stdout: ["Linux", "0", "root", "ada", "1", "/root", "/usr/bin:/bin", ""].join("\n"), stderr: "" });
      return new Promise(resolve =>
        execFile("/bin/bash", ["-c", cmd], { env, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }, (e, stdout, stderr) =>
          resolve({ exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : 1, stdout: String(stdout), stderr: String(stderr) }),
        ),
      );
    },
  };
  return { machine, lines };
}

/** This computer's own Host over the fixture: the node readers, with the fixture's home and PATH. */
function here(at: AgentHome): Host {
  const live = nodeHost();
  return { ...live, home: at.home, exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home, ...o?.env } }) } };
}

const nothingLeaked = (at: AgentHome, report: unknown, lines: readonly string[] = []): void => {
  expect(JSON.stringify(report)).not.toContain(SECRET);
  expect(existsSync(join(at.home, "SPAWNED")), "a server command ran").toBe(false);
  for (const line of lines) expect(line).not.toMatch(/auth\.json|\.credentials\.json|oauth_creds/);
};

describe("the agents report off a computer you own whose daemon runs as root", () => {
  it("runs every line as the owner of the home, never root, and reads agents, servers and skills off config and presence alone", async () => {
    const at = fixture();
    const landed = placeProvisionPaths(at.home).landed;
    mkdirSync(dirname(landed), { recursive: true });
    writeFileSync(landed, "agents/mcp/claude/airtable\tabc\tabc\nagents/mcp/claude/notion\t-\t-\n");
    const { machine, lines } = road(at, { root: true });
    const read = await agentsReader({ vault: () => ({}) }).read({
      kind: "box",
      machine,
      login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` },
      signIns: { claude: "signed-in", codex: "none" },
      versions: { claude: "2.1.281 (Claude Code)" },
    });
    expect(read.refused).toEqual([]);
    expect(read.user).toBe("ada");
    for (const line of lines.slice(1)) expect(line.startsWith("runuser -u 'ada' -- bash -c "), line.slice(0, 80)).toBe(true);
    expect(lines.join("\n")).not.toMatch(/-u 'root'|-u root\b/);
    const agent = (id: string) => read.agents.find(a => a.id === id)!;
    expect(agent("claude")).toMatchObject({ installed: true, version: "2.1.281", road: "own", signIn: "signed-in", signInRoad: "token", wspTools: true });
    expect(agent("codex")).toMatchObject({ installed: true, signIn: "none", signInRoad: "device", wspTools: false });
    expect(agent("codex").version).toBeUndefined();
    expect(agent("hermes")).toMatchObject({ installed: true, signIn: "unknown", signInRoad: "terminal" });
    expect(agent("gemini")).toMatchObject({ installed: false, road: "none", signIn: "none", signInRoad: "code" });
    const server = (agent: string, name: string) => read.servers.find(s => s.agent === agent && s.name === name)!;
    expect(server("claude", "airtable")).toEqual({ agent: "claude", name: "airtable", scope: "user", file: "~/.claude.json", transport: { kind: "stdio", line: "npx airtable-mcp-server" }, envNames: ["AIRTABLE_API_KEY"], auth: "open", enabled: true, inRecipe: true });
    expect(server("claude", "notion")).toMatchObject({ transport: { kind: "http", host: "mcp.notion.com" }, auth: "unknown", inRecipe: false });
    expect(server("claude", "local")).toMatchObject({ scope: "home" });
    expect(server("codex", "linear")).toMatchObject({ file: "~/.codex/config.toml", transport: { kind: "http", host: "mcp.linear.app" }, auth: "open" });
    expect(server("codex", "old")).toMatchObject({ enabled: false });
    expect(server("gemini", "fs").transport).toEqual({ kind: "stdio", line: "npx @example/fs --token=…" });
    expect(server("opencode", "ctx")).toMatchObject({ enabled: false, auth: "unknown" });
    expect(read.skills.map(s => s.name)).toEqual(["frontend-design", "pdf", "plan", "review", "sql"]);
    // The box's report stood in for the version and sign-in reads, so no agent's own command ran there.
    expect(lines.join("\n")).not.toMatch(/--version|auth status|login status/);
    nothingLeaked(at, read, lines);
  });

  it("answers thirty servers in under ten round trips", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
    for (let i = 0; i < 24; i++) config.mcpServers[`server-${i}`] = { command: "npx", args: ["-y", `pkg-${i}`], env: { [`KEY_${i}`]: SECRET } };
    writeFileSync(file, JSON.stringify(config));
    const { machine, lines } = road(at, { root: true });
    const read = await agentsReader({ vault: () => ({}) }).read({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` } });
    expect(read.servers.length).toBeGreaterThanOrEqual(30);
    expect(lines.length).toBeLessThan(10);
    nothingLeaked(at, read, lines);
  });
});

describe("the agents report off this computer and off a workspace", () => {
  it("asks each agent's own status and version here, falls back to the vault's word, and starts nothing", async () => {
    const at = fixture();
    const read = await agentsReader({ vault: () => ({ OPENAI_API_KEY: "sk-x" }), here: () => here(at) }).read({ kind: "here" });
    expect(read.refused).toEqual([]);
    expect(read.user).toBe(userInfo().username);
    expect(read.home).toBe(at.home);
    const agent = (id: string) => read.agents.find(a => a.id === id)!;
    expect(agent("claude")).toMatchObject({ version: "2.1.281", signIn: "signed-in" });
    expect(agent("codex")).toMatchObject({ version: "0.155.1", signIn: "vault-key" });
    expect(agent("hermes")).toMatchObject({ version: "0.20.0", signIn: "signed-in" });
    expect(read.servers.every(s => s.inRecipe === undefined)).toBe(true);
    nothingLeaked(at, read);
  });

  it("reads a workspace's machine with its project's own skills and servers, running as it is where the home is its own", async () => {
    const at = fixture();
    const { machine, lines } = road(at);
    const read = await agentsReader({ vault: () => ({}) }).read({ kind: "machine", machine, project: at.project });
    expect(lines.slice(1).some(l => l.startsWith("runuser"))).toBe(false);
    expect(read.servers.filter(s => s.scope === "project")).toEqual([
      { agent: "claude", name: "project-db", scope: "project", file: "~/code/app/.mcp.json", transport: { kind: "stdio", line: "npx db-mcp" }, envNames: [], auth: "open", enabled: true },
    ]);
    expect(read.skills.filter(s => s.scope === "project").map(s => s.name)).toEqual(["deploy", "lint"]);
    expect(read.agents.find(a => a.id === "claude")).toMatchObject({ signIn: "signed-in", version: "2.1.281" });
    nothingLeaked(at, read, lines);
  });
});
