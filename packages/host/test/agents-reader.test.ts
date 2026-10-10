// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { catalogEntry, versionOf } from "@wsp/catalog";
import { nodeHost, type Host } from "@wsp/collect";
import type { ExecResult, Machine } from "@wsp/engine";
import { controlNameRefusal, placeProvisionPaths } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentHome, SECRET, type AgentHome } from "../../collect/test/agent-home.js";
import { READER_CLOSED, agentsReader, eachScript } from "../src/agents-reader.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): AgentHome & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-agents-"));
  roots.push(root);
  const at = agentHome(root);
  // runuser as a script on the login's PATH: it takes only the home's owner, and runs what it was handed.
  writeStub(join(at.bin, "runuser"), `#!/bin/bash\n[ "$1" = -u ] && [ "$2" = ada ] && [ "$3" = -- ] || exit 9\nshift 3\nexec "$@"\n`);
  return { ...at, root };
}

/** A computer's road that runs every line in bash with the fixture's home and PATH, keeping each line it ran. A root
 * daemon's probe is answered as a Linux box running as root would answer it, the home owned by ada. */
function road(at: AgentHome, o: { root?: boolean } = {}): { machine: Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">; lines: string[] } {
  const lines: string[] = [];
  const env = { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home };
  const machine = {
    id: "m_road",
    uploadUrl: () => Promise.reject(new Error("this backend mints no signed urls")),
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
function here(at: AgentHome, path = `${at.bin}:/usr/bin:/bin`): Host {
  const live = nodeHost();
  return { ...live, home: at.home, exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: path, HOME: at.home, ...o?.env } }) } };
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
    expect(read.runAs).toBe("ada");
    for (const line of lines.slice(1)) expect(line.startsWith("runuser -u 'ada' -- bash -c "), line.slice(0, 80)).toBe(true);
    expect(lines.join("\n")).not.toMatch(/-u 'root'|-u root\b/);
    const agent = (id: string) => read.agents.find(a => a.id === id)!;
    expect(agent("claude")).toMatchObject({ installed: true, version: "2.1.281", road: "own", signIn: "signed-in", signInRoad: "token", wspTools: true });
    expect(agent("codex")).toMatchObject({ installed: true, signIn: "none", signInRoad: "device", wspTools: true });
    expect(agent("codex").version).toBeUndefined();
    expect(agent("hermes")).toMatchObject({ installed: true, signIn: "unknown", signInRoad: "terminal" });
    expect(agent("gemini")).toMatchObject({ installed: false, road: "none", signIn: "none", signInRoad: "code" });
    const server = (agent: string, name: string) => read.servers.find(s => s.agent === agent && s.name === name)!;
    expect(server("claude", "airtable")).toEqual({ agent: "claude", name: "airtable", scope: "user", file: "~/.claude.json", transport: { kind: "stdio", line: "npx airtable-mcp-server" }, envNames: ["AIRTABLE_API_KEY"], auth: "open", enabled: true, inRecipe: true, signInLine: "claude mcp login 'airtable'" });
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

describe("what wsp put on a computer you own and on a workspace", () => {
  const box = (at: AgentHome, path = `${at.bin}:/usr/bin:/bin`) => ({ kind: "box" as const, machine: road(at, { root: true }).machine, login: { HOME: at.home, PATH: path } });

  it("lists the wsp server every launch there is handed, for each agent whose adapter takes one, and keeps a config row that names wsp", async () => {
    const at = fixture();
    const reader = agentsReader({ vault: () => ({}) });
    for (const read of [await reader.read(box(at)), await reader.read({ kind: "machine", machine: road(at).machine })]) {
      const wsp = read.servers.filter(s => s.name === "wsp");
      expect(wsp.find(s => s.agent === "codex")).toEqual({ agent: "codex", name: "wsp", scope: "user", launch: true, transport: { kind: "stdio", line: "wsp mcp" }, envNames: [], auth: "open", enabled: true });
      expect(wsp.filter(s => s.agent === "claude")).toEqual([expect.objectContaining({ file: "~/.claude.json", transport: { kind: "stdio", line: expect.stringContaining("wsp-bin/wsp") } })]);
      expect(wsp.filter(s => s.agent === "claude")[0]).not.toHaveProperty("launch");
      // Only the adapters that hand a launch its servers: OpenCode and Cursor run threads but take none.
      expect(wsp.filter(s => s.launch === true).map(s => s.agent)).toEqual(["codex"]);
      expect(read.agents.find(a => a.id === "codex")).toMatchObject({ wspTools: true });
    }
    // This computer's agents keep Add tools: a session the person starts outside wsp reads only the config.
    const mine = await agentsReader({ vault: () => ({}), here: () => here(at) }).read({ kind: "here" });
    expect(mine.servers.filter(s => s.launch === true)).toEqual([]);
    expect(mine.agents.find(a => a.id === "codex")).toMatchObject({ wspTools: false });
  });

  it("reads an agent the setup installed as wsp's wherever its manager put it, and one the computer already had as the person's", async () => {
    const at = fixture();
    const brew = join(at.root, "linuxbrew/.linuxbrew/bin");
    mkdirSync(brew, { recursive: true });
    writeStub(join(brew, "codex"), `#!/bin/sh\necho "codex-cli 0.155.1"\n`);
    const setupRows = [
      { id: "agents/codex", label: "Codex", outcome: "installed" as const },
      { id: "agents/claude", label: "Claude Code", outcome: "present" as const },
      { id: "agents/gemini", label: "Gemini CLI", outcome: "failed" as const },
    ];
    const read = await agentsReader({ vault: () => ({}) }).read({ ...box(at, `${brew}:${at.bin}:/usr/bin:/bin`), setupRows });
    const agent = (id: string) => read.agents.find(a => a.id === id)!;
    expect(agent("codex")).toMatchObject({ installed: true, road: "wsp", path: join(brew, "codex") });
    expect(agent("claude")).toMatchObject({ installed: true, road: "own" });
    expect(agent("hermes")).toMatchObject({ installed: true, road: "own" });
    expect(agent("gemini")).toMatchObject({ installed: false, road: "none" });
  });
});

describe("the agents report off this computer and off a workspace", () => {
  it("names only the variables servers.env holds, since a literal that reads like a reference would name its own value", async () => {
    const at = fixture();
    mkdirSync(join(at.home, ".gemini"), { recursive: true });
    writeFileSync(join(at.home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { lit: { httpUrl: "https://l.example", headers: { Authorization: "Bearer $ecret123", X: "${ACME_TOKEN}" } } } }));
    const read = await agentsReader({ vault: () => ({ ACME_TOKEN: "sk_TESTONLY_held" }), here: () => here(at) }).read({ kind: "here" });
    const row = read.servers.find(s => s.agent === "gemini" && s.name === "lit")!;
    expect(row.envNames).toEqual(["ACME_TOKEN"]);
    expect(JSON.stringify(read)).not.toContain("ecret123");
  });

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

  it("carries each agent's newest version as this host read it and the version the catalog installs, and a failed reading costs only the newest", async () => {
    const at = fixture();
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), latest: async () => ({ claude: "2.1.283", pi: "0.85.0" }) }).read({ kind: "here" });
    const agent = (id: string) => read.agents.find(a => a.id === id)!;
    expect(agent("claude")).toMatchObject({ version: "2.1.281", latest: "2.1.283", pinned: versionOf(catalogEntry("claude")!.installRoad) });
    expect(agent("pi")).toMatchObject({ installed: false, latest: "0.85.0", pinned: versionOf(catalogEntry("pi")!.installRoad) });
    expect(agent("codex").latest).toBeUndefined();
    // Hermes names no place its newest version is published, so its date-tagged pin is not set beside a semver.
    expect(agent("hermes").pinned).toBeUndefined();
    const failed = await agentsReader({ vault: () => ({}), here: () => here(at), latest: () => Promise.reject(new Error("offline")) }).read({ kind: "here" });
    expect(failed.refused).toEqual([]);
    expect(failed.agents.find(a => a.id === "claude")).toMatchObject({ version: "2.1.281", pinned: versionOf(catalogEntry("claude")!.installRoad) });
    expect(failed.agents.some(a => a.latest !== undefined)).toBe(false);
    let asked = 0;
    const off = await agentsReader({ vault: () => ({}), here: () => here(at), latest: async () => (asked++, { claude: "2.1.283" }) }).read({ kind: "here" }, { latest: false });
    expect(asked).toBe(0);
    expect(off.agents.some(a => a.latest !== undefined)).toBe(false);
  });

  it("an agent older than its vendor's newest carries the vendor's update command, and one current or not installed carries none", async () => {
    const at = fixture();
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), latest: async () => ({ claude: "2.1.290", codex: "0.155.1", pi: "0.85.0" }) }).read({ kind: "here" });
    const agent = (id: string) => read.agents.find(a => a.id === id)!;
    expect(agent("claude").update).toEqual({ to: "2.1.290", command: "claude update" });
    expect(agent("codex").update).toBeUndefined();
    expect(agent("pi").update).toBeUndefined();
  });

  it("names how a login stands in the status command's own words, and holds no value", async () => {
    const at = fixture();
    const read = await agentsReader({ vault: () => ({ OPENAI_API_KEY: "sk-x" }), here: () => here(at) }).read({ kind: "here" });
    const agent = (id: string) => read.agents.find(a => a.id === id)!;
    expect(agent("claude").signInDetail).toBe("OAuth credentials");
    // The fixture's browser sign-in names no plan, so it is plain OAuth with no plan word.
    expect(agent("claude").signInKind).toBe("oauth");
    expect(agent("claude").signInPlan).toBeUndefined();
    // Its key is the vault's, so its own status names no login and no kind.
    expect(agent("codex").signInDetail).toBeUndefined();
    expect(agent("codex").signInKind).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain("sk-x");
    writeStub(join(at.bin, "claude"), `#!/bin/sh\ncase "$1" in --version) echo "2.1.281 (Claude Code)";; auth) echo '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}';; *) exit 2;; esac\n`);
    const planned = (await agentsReader({ vault: () => ({}), here: () => here(at) }).read({ kind: "here" })).agents.find(a => a.id === "claude")!;
    expect(planned).toMatchObject({ signInKind: "subscription", signInPlan: "max" });
  });

  it("reads past a wrapper another app put first on the PATH to the binary behind it, and names the app", async () => {
    const at = fixture();
    const shims = join(at.root, "T", "cmux-cli-shims");
    mkdirSync(shims, { recursive: true });
    for (const [name, body] of [["claude", `exec ${join(at.bin, "claude")} "$@"`], ["gemini", 'echo "0.58.0"']] as const) {
      writeStub(join(shims, name), `#!/bin/sh\n${body}\n`);
    }
    const read = await agentsReader({ vault: () => ({}), here: () => here(at, `${shims}:${at.bin}:/usr/bin:/bin`) }).read({ kind: "here" });
    const agent = (id: string) => read.agents.find(a => a.id === id)!;
    expect(agent("claude")).toMatchObject({ installed: true, path: join(at.bin, "claude"), road: "own", via: "cmux", version: "2.1.281" });
    // Nothing behind the wrapper: no temporary path stands as where it is installed.
    expect(agent("gemini")).toMatchObject({ installed: true, road: "shim", via: "cmux" });
    expect(agent("gemini").path).toBeUndefined();
    expect(agent("codex").via).toBeUndefined();
  });

  it("names a dot-folder's wrapper without its dot", async () => {
    const at = fixture();
    const shims = join(at.root, ".asdf", "shims");
    mkdirSync(shims, { recursive: true });
    writeStub(join(shims, "claude"), `#!/bin/sh\nexec ${join(at.bin, "claude")} "$@"\n`);
    const read = await agentsReader({ vault: () => ({}), here: () => here(at, `${shims}:${at.bin}:/usr/bin:/bin`) }).read({ kind: "here" });
    expect(read.agents.find(a => a.id === "claude")).toMatchObject({ via: "asdf" });
  });

  it("leaves out a server whose name holds a control character and says which file named it", async () => {
    const at = fixture();
    const file = join(at.home, ".claude.json");
    const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
    config.mcpServers["notion\x15echo hi; #"] = { type: "http", url: "https://mcp.notion.com/mcp" };
    writeFileSync(file, JSON.stringify(config));
    const read = await agentsReader({ vault: () => ({}), here: () => here(at) }).read({ kind: "here" });
    expect(read.servers.filter(s => s.name.includes("\x15"))).toEqual([]);
    expect(read.servers.some(s => s.name === "notion")).toBe(true);
    expect(read.refused).toEqual([controlNameRefusal("~/.claude.json")]);
  });

  it("reads a workspace's machine with its project's own skills and servers, running as it is where the home is its own", async () => {
    const at = fixture();
    const { machine, lines } = road(at);
    const read = await agentsReader({ vault: () => ({}) }).read({ kind: "machine", machine, projects: [{ id: "pr_app", name: "app", path: at.project }] });
    expect(lines.slice(1).some(l => l.startsWith("runuser"))).toBe(false);
    expect(read.servers.filter(s => s.scope === "project")).toEqual([
      { agent: "claude", name: "project-db", scope: "project", file: "~/code/app/.mcp.json", transport: { kind: "stdio", line: "npx db-mcp" }, envNames: [], auth: "open", enabled: true, project: { id: "pr_app", name: "app", path: "~/code/app" }, signInLine: `cd '${at.project}' 2>/dev/null; claude mcp login 'project-db'` },
    ]);
    expect(read.skills.filter(s => s.scope === "project").map(s => s.name)).toEqual(["deploy", "lint"]);
    expect(read.agents.find(a => a.id === "claude")).toMatchObject({ signIn: "signed-in", version: "2.1.281" });
    nothingLeaked(at, read, lines);
  });

  it("asks each agent's status with the store its turns there read, so a login kept there reads as signed in", async () => {
    const at = fixture();
    const store = join(at.root, "logins", "codex");
    mkdirSync(store, { recursive: true });
    writeStub(join(at.bin, "codex"), `#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.155.1";; login) [ "$CODEX_HOME" = ${JSON.stringify(store)} ] && echo "Logged in using ChatGPT" && exit 0; echo "Not logged in"; exit 1;; *) exit 2;; esac\n`);
    const { machine } = road(at);
    const read = await agentsReader({ vault: () => ({}) }).read({ kind: "machine", machine, stores: { codex: store } });
    expect(read.agents.find(a => a.id === "codex")).toMatchObject({ signIn: "signed-in", signInKind: "subscription" });
  });

  it("reads every project a computer holds in one read, each project's rows naming it, and says which projects it covered", async () => {
    const at = fixture();
    const www = join(at.home, "code", "www");
    mkdirSync(join(www, ".claude/skills/ship"), { recursive: true });
    writeFileSync(join(www, ".claude/skills/ship/SKILL.md"), "---\nname: ship\ndescription: Ship www\n---\n");
    writeFileSync(join(www, ".mcp.json"), JSON.stringify({ mcpServers: { "project-db": { command: "npx", args: ["other-db"] } } }));
    const { machine, lines } = road(at);
    const app = { id: "pr_app", name: "app", path: at.project };
    const read = await agentsReader({ vault: () => ({}) }).read({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` }, projects: [app, { id: "pr_www", name: "www", path: www }] });
    expect(read.projects).toEqual([
      { id: "pr_app", name: "app", path: "~/code/app" },
      { id: "pr_www", name: "www", path: "~/code/www" },
    ]);
    expect(read.servers.filter(s => s.scope === "project").map(s => [s.name, s.project?.id, s.file, s.transport])).toEqual([
      ["project-db", "pr_app", "~/code/app/.mcp.json", { kind: "stdio", line: "npx db-mcp" }],
      ["project-db", "pr_www", "~/code/www/.mcp.json", { kind: "stdio", line: "npx other-db" }],
    ]);
    expect(read.skills.filter(s => s.scope === "project").map(s => [s.name, s.project?.id])).toEqual([
      ["deploy", "pr_app"],
      ["lint", "pr_app"],
      ["ship", "pr_www"],
    ]);
    expect(read.servers.filter(s => s.scope !== "project").every(s => s.project === undefined)).toBe(true);
    nothingLeaked(at, read, lines);
  });

  it("lists what a turn in a project gets: its local entry, each .mcp.json from the folder up, and Codex's project file only where Codex trusts it", async () => {
    const at = fixture();
    const own = JSON.parse(readFileSync(join(at.home, ".claude.json"), "utf8")) as { projects: Record<string, unknown> };
    own.projects[at.project] = { mcpServers: { "local-one": { command: "node", args: ["local.js"] } }, disabledMcpServers: ["parent-off"], disabledMcpjsonServers: ["parent-gone"] };
    writeFileSync(join(at.home, ".claude.json"), JSON.stringify(own));
    writeFileSync(join(at.home, "code", ".mcp.json"), JSON.stringify({ mcpServers: { "parent-one": { command: "npx", args: ["one"] }, "parent-off": { command: "npx", args: ["off"] }, "parent-gone": { command: "npx", args: ["gone"] } } }));
    mkdirSync(join(at.project, ".codex"), { recursive: true });
    writeFileSync(join(at.project, ".codex/config.toml"), '[mcp_servers.codex-proj]\ncommand = "npx"\nargs = ["p"]\n');
    const { machine } = road(at);
    const app = { id: "pr_app", name: "app", path: at.project };
    const rows = async () => (await agentsReader({ vault: () => ({}) }).read({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` }, projects: [app] })).servers.filter(s => s.project !== undefined).map(s => [s.agent, s.name, s.scope, s.file, s.enabled]);
    expect(await rows()).toEqual([
      ["claude", "local-one", "local", "~/.claude.json", true],
      ["claude", "parent-off", "project", "~/code/.mcp.json", false],
      ["claude", "parent-one", "project", "~/code/.mcp.json", true],
      ["claude", "project-db", "project", "~/code/app/.mcp.json", true],
    ]);
    writeFileSync(join(at.home, ".codex/config.toml"), `${readFileSync(join(at.home, ".codex/config.toml"), "utf8")}\n[projects."${at.project}"]\ntrust_level = "trusted"\n`);
    expect((await rows()).filter(r => r[0] === "codex")).toEqual([["codex", "codex-proj", "project", "~/code/app/.codex/config.toml", true]]);
  });

  it("lists an OpenCode project's servers from opencode.jsonc where that is the file the project keeps", async () => {
    const at = fixture();
    writeFileSync(join(at.project, "opencode.jsonc"), '{\n  // the project\'s own\n  "mcp": { "theirs": { "type": "local", "command": ["t"] } }\n}\n');
    const { machine } = road(at);
    const read = await agentsReader({ vault: () => ({}) }).read({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` }, projects: [{ id: "pr_app", name: "app", path: at.project }] });
    expect(read.servers.filter(s => s.agent === "opencode" && s.project !== undefined).map(s => [s.name, s.scope, s.file])).toEqual([["theirs", "project", "~/code/app/opencode.jsonc"]]);
  });

  it("reads a project recorded at a subfolder of its repository from the repository's top, for both agents", async () => {
    const at = fixture();
    // Both agents key a folder by its real path, which git answers; a temporary folder on a Mac sits behind a link.
    const top = realpathSync(at.project);
    const sub = join(top, "web");
    mkdirSync(join(sub, ".codex"), { recursive: true });
    mkdirSync(join(top, ".codex"), { recursive: true });
    execFileSync("git", ["init", "-q", top]);
    const own = JSON.parse(readFileSync(join(at.home, ".claude.json"), "utf8")) as { projects: Record<string, unknown> };
    own.projects[top] = { mcpServers: { "repo-local": { command: "node", args: ["r.js"] } } };
    own.projects[sub] = { mcpServers: { "sub-local": { command: "node", args: ["s.js"] } } };
    writeFileSync(join(at.home, ".claude.json"), JSON.stringify(own));
    writeFileSync(join(top, ".codex/config.toml"), '[mcp_servers.codex-top]\ncommand = "npx"\n');
    writeFileSync(join(sub, ".codex/config.toml"), '[mcp_servers.codex-sub]\ncommand = "npx"\n');
    writeFileSync(join(at.home, ".codex/config.toml"), `${readFileSync(join(at.home, ".codex/config.toml"), "utf8")}\n[projects."${top}"]\ntrust_level = "trusted"\n`);
    const { machine } = road(at);
    const read = await agentsReader({ vault: () => ({}) }).read({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` }, projects: [{ id: "pr_web", name: "web", path: sub }] });
    // Claude Code's local entry and Codex's project files; the .mcp.json files above are the other test's.
    const rows = read.servers.filter(s => s.project !== undefined && (s.agent === "codex" || s.scope === "local")).map(s => [s.agent, s.name, s.scope]);
    expect(rows).toEqual([
      ["claude", "repo-local", "local"],
      ["codex", "codex-sub", "project"],
      ["codex", "codex-top", "project"],
    ]);
  });

  it("says a server carried with a project is wsp's on a box, off the key the list beside the job keeps under the project's folder", async () => {
    const at = fixture();
    const own = JSON.parse(readFileSync(join(at.home, ".claude.json"), "utf8")) as { projects: Record<string, unknown> };
    own.projects[at.project] = { mcpServers: { carried: { command: "node", args: ["c.js"] }, theirs: { command: "node", args: ["t.js"] } } };
    writeFileSync(join(at.home, ".claude.json"), JSON.stringify(own));
    const landed = placeProvisionPaths(at.home).landed;
    mkdirSync(dirname(landed), { recursive: true });
    writeFileSync(landed, `agents/mcp/claude/@${encodeURIComponent(at.project)}/carried\tabc\tabc\n`);
    const { machine } = road(at);
    const read = await agentsReader({ vault: () => ({}) }).read({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` }, projects: [{ id: "pr_app", name: "app", path: at.project }] });
    expect(read.servers.filter(s => s.scope === "local").map(s => [s.name, s.inRecipe])).toEqual([["carried", true], ["theirs", false]]);
  });

  it("a project skills folder that links out of the repo is left out and said in one refusal line, which the agents panel lists under its rows", async () => {
    const at = fixture();
    const away = join(at.root, "away");
    mkdirSync(join(away, "grab"), { recursive: true });
    writeFileSync(join(away, "grab/SKILL.md"), "---\nname: grab\n---\n");
    rmSync(join(at.project, ".agents/skills"), { recursive: true, force: true });
    symlinkSync(away, join(at.project, ".agents/skills"));
    const { machine, lines } = road(at);
    const read = await agentsReader({ vault: () => ({}) }).read({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` }, projects: [{ id: "pr_app", name: "app", path: at.project }] });
    expect(read.skills.filter(s => s.scope === "project").map(s => s.name)).toEqual(["deploy"]);
    expect(read.refused).toEqual([`skills: ~/code/app/.agents/skills links out of the repo, to ${away}, so its skills are not read`]);
    nothingLeaked(at, read, lines);
  });

  it("a read that covers no project says so with an empty list, and one handed none says nothing of projects", async () => {
    const at = fixture();
    const reader = agentsReader({ vault: () => ({}), here: () => here(at) });
    expect((await reader.read({ kind: "here", projects: [] })).projects).toEqual([]);
    expect(await reader.read({ kind: "here" })).not.toHaveProperty("projects");
  });
});

describe("the probe batch on a computer with no timeout command, as a Mac is", () => {
  it("ends a probe that hangs at its own bound, its children with it, and keeps each quick probe's code and output", async () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-batch-"));
    roots.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["sh", "perl", "mktemp", "cat", "head", "rm", "sleep"]) symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
    const pids = join(root, "pids");
    const hung = `echo $$ >> '${pids}'; sh -c 'echo $$ >> ${pids}; exec sleep 30' & sleep 30; wait`;
    // The probe sleeps 30 s, past the test's own timeout, so the batch returns only where the bound ended it.
    const { stdout } = await promisify(execFile)(join(bin, "sh"), ["-c", eachScript(2), "sh", hung, "printf fast", "printf slow; exit 7"], { encoding: "utf8", env: { PATH: bin } });
    const records = stdout.split("\x1e").slice(1, 4).map(r => r.split("\x1f"));
    expect(records).toEqual([["137", ""], ["0", "fast"], ["7", "slow"]]);
    const alive = readFileSync(pids, "utf8").split("\n").filter(l => l !== "").filter(pid => {
      try {
        process.kill(Number(pid), 0);
        return true;
      } catch {
        return false;
      }
    });
    expect(alive).toEqual([]);
  });
});

describe("closing the agents reader", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (ok: () => boolean, what: string): Promise<void> => {
    for (const end = Date.now() + 2_000; !ok(); await new Promise(r => setTimeout(r, 20))) if (Date.now() > end) throw new Error(`never ${what}`);
  };

  it("ends every probe a read here started, one whose agent never answers among them, and refuses that read and every later one", async () => {
    const at = fixture();
    const pids = join(at.root, "pids");
    writeStub(join(at.bin, "claude"), `#!/bin/sh\necho $$ >> '${pids}'\nexec sleep 600\n`);
    // GNU timeout leads a group of its own; this one does the same on a computer that has none, as a Mac does.
    writeStub(join(at.bin, "timeout"), `#!/bin/sh\nshift\nexec perl -e 'setpgrp(0, 0); exec @ARGV' "$@"\n`);
    const started = (): number[] => (existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(l => l !== "").map(Number) : []);
    const reader = agentsReader({ vault: () => ({}), here: () => here(at) });
    const read = reader.read({ kind: "here" }, { latest: false });
    await until(() => started().length === 2, "asked claude for its version and its sign-in");
    try {
      reader.close();
      await expect(read).rejects.toThrow(READER_CLOSED);
      await expect(reader.read({ kind: "here" }, { latest: false })).rejects.toThrow(READER_CLOSED);
      await expect(reader.tools({ kind: "here" }, { key: "k", agent: "claude", name: "lit" })).rejects.toThrow(READER_CLOSED);
      await until(() => started().every(pid => !alive(pid)), "ended claude's probes");
    } finally {
      for (const pid of started().filter(alive)) process.kill(pid, "SIGKILL");
    }
  });
});
