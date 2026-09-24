// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeHost, type Host } from "@wsp/collect";
import type { ExecResult, Machine } from "@wsp/engine";
import { serverToolsLateRefusal } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentsReader } from "../src/agents-reader.js";
import { noSuchServerRefusal } from "../src/server-tools.js";

const SECRET = "sk-x-fake-secret-value";

// A stdio MCP server as a script: it counts its starts, answers initialize only after a second in which nothing
// else may arrive, refusing a tools/list sent before that answer, and names the length of the variable it was
// handed, never its value.
const SERVER = `#!/bin/bash
echo $$ >> "$HOME/starts"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      if read -r -t 1 early; then echo "tools/list came before initialize was answered" >&2; exit 3; fi
      printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"1"}}}' ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"list_records","description":"List records in a base","inputSchema":{"type":"object"}},{"name":"token_%s"}]}}\\n' "\${#FAKE_TOKEN}" ;;
  esac
done
`;

/** A server that takes its lines and never answers, keeping its pid where the test can look. */
const MUTE = `#!/bin/bash\necho $$ > "$HOME/mute.pid"\nsleep 60 & wait\n`;
const CRASH = `#!/bin/bash\necho "airtable: AIRTABLE_API_KEY is not set" >&2\nexit 1\n`;
/** Starts a grandchild in a session of its own, out of the server's process group, then runs as \`server\` or \`mute\`. */
const ESCAPE = `#!/bin/bash
${JSON.stringify(process.execPath)} -e 'const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" }); require("fs").appendFileSync(process.env.HOME + "/escaped.pid", c.pid + "\\n"); c.unref()'
exec "$(dirname "$0")/$1"
`;
/** Says eight megabytes of nothing on stdout, then waits out the deadline. */
const FLOOD = `#!/bin/bash\nhead -c 8000000 /dev/zero | tr '\\0' x\nsleep 60 & wait\n`;
/** Claude Code's single-server check as its words read, for a server whose sign-in it holds. */
const CLAUDE = `#!/bin/bash\n[ "$1 $2 $3" = "mcp get linear" ] || exit 9\necho asked >> "$HOME/claude-asks"\nprintf 'linear:\\n  Scope: User config (available in all your projects)\\n  Status: ⚠ Needs authentication\\n'\n`;


const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) {
    const pids = existsSync(join(r, "home", "escaped.pid")) ? readFileSync(join(r, "home", "escaped.pid"), "utf8").trim().split("\n") : [];
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
    rmSync(r, { recursive: true, force: true });
  }
  await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))));
});

/** An MCP server over http: initialize names a session, tools/list answers as an event stream, and every post without
 * the key header is turned away; `/oauth` turns everything away. */
async function remote(): Promise<{ url: string; posts: string[] }> {
  const posts: string[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      posts.push(`${req.url} ${req.headers["mcp-session-id"] ?? "-"} ${body.includes("tools/list") ? "list" : body.includes("initialized") ? "initialized" : "initialize"}`);
      if (req.url === "/oauth" || req.headers["x-key"] !== SECRET) return void res.writeHead(401).end();
      if (body.includes('"method":"initialize"')) return void res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      if (body.includes("notifications/initialized")) return void res.writeHead(202).end();
      res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search", description: "Search the workspace" }] } })}\n\n`);
    });
  });
  servers.push(srv);
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, posts };
}

interface Fixture {
  root: string;
  home: string;
  bin: string;
  config: (servers: Record<string, unknown>) => void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "wsp-tools-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(root, "tmp"));
  for (const [name, text] of Object.entries({ server: SERVER, mute: MUTE, crash: CRASH, claude: CLAUDE, escape: ESCAPE, flood: FLOOD })) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  return { root, home, bin, config: servers => writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers })) };
}

/** This computer's own Host over the fixture's home, PATH and temp folder. */
function here(f: Fixture): Host {
  const live = nodeHost();
  return { ...live, home: f.home, exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, TMPDIR: join(f.root, "tmp"), ...o?.env } }) } };
}

/** A fork, or a workspace on a box: every line runs in bash with the fixture's home, its stdin is never handed to the
 * line, and bytes land by the backend's own road. The lines, the paths landed and the modes the landed file and its
 * folder had when the server's line ran are kept. */
function fork(f: Fixture): { machine: Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">; lines: string[]; landed: string[]; modes: string[] } {
  const lines: string[] = [];
  const landed: string[] = [];
  const modes: string[] = [];
  const machine = {
    id: "m_fork",
    uploadUrl: () => Promise.reject(new Error("this backend mints no signed urls")),
    putBytes: (path: string, bytes: Uint8Array): Promise<void> => {
      landed.push(path);
      writeFileSync(path, bytes);
      return Promise.resolve();
    },
    exec: (cmd: string): Promise<ExecResult> => {
      lines.push(cmd);
      for (const path of landed) if (cmd.includes(join(f.bin, "server")) && existsSync(path)) modes.push(`${(statSync(dirname(path)).mode & 0o777).toString(8)} ${(statSync(path).mode & 0o777).toString(8)}`);
      return new Promise(resolve => {
        const child = spawn("/bin/bash", ["-c", cmd], { env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", c => (stdout += c));
        child.stderr.on("data", c => (stderr += c));
        child.on("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
        child.stdin.end();
      });
    },
  };
  return { machine, lines, landed, modes };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const escaped = (f: Fixture): number[] => readFileSync(join(f.home, "escaped.pid"), "utf8").trim().split("\n").map(Number);

/** A computer you joined whose daemon runs as root: every line through the root road's probe answer, then bash with
 * the fixture's home, the frame's stdin handed to it; the lines are kept. */
function box(f: Fixture): { machine: Pick<Machine, "exec">; lines: string[] } {
  const lines: string[] = [];
  writeFileSync(join(f.bin, "runuser"), `#!/bin/bash\n[ "$1" = -u ] && [ "$2" = ada ] && [ "$3" = -- ] || exit 9\nshift 3\nexec "$@"\n`);
  chmodSync(join(f.bin, "runuser"), 0o755);
  const machine = {
    exec: (cmd: string, o?: { stdin?: Uint8Array }): Promise<ExecResult> => {
      lines.push(cmd);
      if (cmd.startsWith("uname -s;")) return Promise.resolve({ exitCode: 0, stdout: ["Linux", "0", "root", "ada", "1", f.home, `${f.bin}:/usr/bin:/bin`, ""].join("\n"), stderr: "" });
      return new Promise(resolve => {
        const child = spawn("/bin/bash", ["-c", cmd], { env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", c => (stdout += c));
        child.stderr.on("data", c => (stderr += c));
        child.on("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
        child.stdin.end(o?.stdin ?? Buffer.alloc(0));
      });
    },
  };
  return { machine, lines };
}

const starts = (f: Fixture): number => (existsSync(join(f.home, "starts")) ? readFileSync(join(f.home, "starts"), "utf8").trim().split("\n").length : 0);

describe("one MCP server's tools, on the person's ask", () => {
  it("starts a command server once with its own variables, sends tools/list only after initialize is answered, and keeps the answer an hour", async () => {
    const f = fixture();
    f.config({ airtable: { command: join(f.bin, "server"), args: ["--base", "app1"], env: { FAKE_TOKEN: SECRET } } });
    let now = Date.parse("2026-09-24T12:00:00Z");
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), now: () => now });
    const ask = { key: "here", agent: "claude", name: "airtable" };
    const first = await reader.tools({ kind: "here" }, ask);
    expect(first).toEqual({ auth: "open", tools: [{ name: "list_records", description: "List records in a base" }, { name: `token_${SECRET.length}` }], readAt: "2026-09-24T12:00:00.000Z" });
    expect(starts(f)).toBe(1);
    now += 59 * 60_000;
    expect(await reader.tools({ kind: "here" }, ask)).toEqual(first);
    expect(starts(f)).toBe(1);
    expect((await reader.tools({ kind: "here" }, { ...ask, refresh: true })).readAt).toBe("2026-09-24T12:59:00.000Z");
    expect(starts(f)).toBe(2);
    // An edited entry is another definition and is started again.
    f.config({ airtable: { command: join(f.bin, "server"), args: ["--base", "app2"], env: { FAKE_TOKEN: SECRET } } });
    await reader.tools({ kind: "here" }, ask);
    expect(starts(f)).toBe(3);
    now += 61 * 60_000;
    await reader.tools({ kind: "here" }, ask);
    expect(starts(f)).toBe(4);
  }, 30_000);

  it("stops a server that has not answered when the time is up, with its process group, and asks it again on the next click", async () => {
    const f = fixture();
    f.config({ mute: { command: join(f.bin, "mute"), args: [] }, crash: { command: join(f.bin, "crash"), args: [] } });
    const logged: string[] = [];
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), toolsMs: 2_000, log: line => logged.push(line) });
    const late = await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "mute" });
    expect(late).toMatchObject({ auth: "failed", refused: serverToolsLateRefusal(2_000) });
    expect(late.tools).toBeUndefined();
    const pid = Number(readFileSync(join(f.home, "mute.pid"), "utf8"));
    expect(() => process.kill(pid, 0), "the server outlived its deadline").toThrow();
    rmSync(join(f.home, "mute.pid"));
    await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "mute" });
    expect(existsSync(join(f.home, "mute.pid")), "a refused answer was kept").toBe(true);
    // What a server said on stderr can carry its own key: it goes to the host's log, never onto the page.
    const crashed = await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "crash" });
    expect(crashed).toMatchObject({ auth: "failed", refused: "it exited with 1 before it answered" });
    expect(JSON.stringify(crashed)).not.toContain("AIRTABLE_API_KEY");
    expect(logged.join("\n")).toContain("airtable: AIRTABLE_API_KEY is not set");
    await expect(reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "nobody" })).rejects.toThrow(noSuchServerRefusal("nobody", "Claude Code"));
  }, 20_000);

  it("asks an address over curl with its headers from a private file, and a server behind a sign-in the harness holds for the harness's word alone", async () => {
    const f = fixture();
    const { url, posts } = await remote();
    f.config({ notion: { type: "http", url: `${url}/mcp`, headers: { "X-Key": SECRET } }, linear: { type: "http", url: `${url}/oauth` } });
    const reader = agentsReader({ vault: () => ({}), here: () => here(f) });
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "notion" })).toMatchObject({ auth: "open", tools: [{ name: "search", description: "Search the workspace" }] });
    expect(posts.slice(0, 3)).toEqual(["/mcp - initialize", "/mcp s-1 initialized", "/mcp s-1 list"]);
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "linear" })).toMatchObject({ auth: "needs-sign-in", holder: "claude" });
    // The harness's word is not kept: the person may sign in there between two clicks.
    await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "linear" });
    expect(readFileSync(join(f.home, "claude-asks"), "utf8").trim().split("\n")).toHaveLength(2);
    mkdirSync(join(f.home, ".codex"));
    writeFileSync(join(f.home, ".codex", "config.toml"), `[mcp_servers.linear]\nurl = "${url}/oauth"\n`);
    writeFileSync(join(f.bin, "codex"), `#!/bin/bash\necho asked >> "$HOME/codex-asks"\n`);
    chmodSync(join(f.bin, "codex"), 0o755);
    expect(await reader.tools({ kind: "here" }, { key: "here", agent: "codex", name: "linear" })).toEqual({ auth: "unknown", holder: "codex", readAt: expect.any(String) });
    expect(existsSync(join(f.home, "codex-asks")), "Codex was asked for its servers").toBe(false);
  });

  it("says curl's last words for an address that did not answer, with any query string in a URL cut off", async () => {
    const f = fixture();
    writeFileSync(join(f.bin, "curl"), `#!/bin/bash\necho "curl: (7) Failed to connect to https://mcp.example.test/sse?token=${SECRET}&x=1 port 443" >&2\nprintf 000\nexit 7\n`);
    chmodSync(join(f.bin, "curl"), 0o755);
    f.config({ notion: { type: "http", url: `https://mcp.example.test/sse?token=${SECRET}` } });
    const answer = await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "notion" });
    expect(answer).toMatchObject({ auth: "failed", refused: "curl: (7) Failed to connect to https://mcp.example.test/sse port 443" });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("cuts a user and password out of a URL in curl's last words", async () => {
    const f = fixture();
    writeFileSync(join(f.bin, "curl"), `#!/bin/bash\necho "curl: (7) Failed to connect to https://ada:${SECRET}@mcp.example.test/sse port 443" >&2\nprintf 000\nexit 7\n`);
    chmodSync(join(f.bin, "curl"), 0o755);
    f.config({ notion: { type: "http", url: `https://ada:${SECRET}@mcp.example.test/sse` } });
    const answer = await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "notion" });
    expect(answer).toMatchObject({ auth: "failed", refused: "curl: (7) Failed to connect to https://mcp.example.test/sse port 443" });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  it("on a computer whose daemon runs as root, runs as the home's owner and hands the variables over stdin, never on a line", async () => {
    const f = fixture();
    const { url } = await remote();
    f.config({ airtable: { command: join(f.bin, "server"), args: [], env: { FAKE_TOKEN: SECRET } }, notion: { type: "http", url: `${url}/mcp`, headers: { "X-Key": SECRET } } });
    const { machine, lines } = box(f);
    const reader = agentsReader({ vault: () => ({}) });
    const on = { kind: "box" as const, machine, login: { HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin` } };
    expect(await reader.tools(on, { key: "p_srv", agent: "claude", name: "airtable" })).toMatchObject({ auth: "open", tools: [{ name: "list_records" }, { name: `token_${SECRET.length}` }] });
    expect(await reader.tools(on, { key: "p_srv", agent: "claude", name: "notion" })).toMatchObject({ auth: "open", tools: [{ name: "search" }] });
    for (const line of lines.filter(l => !l.startsWith("uname -s;"))) {
      expect(line).toMatch(/^runuser -u 'ada' -- /);
      expect(line).not.toContain(SECRET);
    }
  }, 20_000);
  it("on a fork or a workspace on a box, hands the variables over in a private file the line reads as data and removes", async () => {
    const f = fixture();
    f.config({ airtable: { command: join(f.bin, "server"), args: [], env: { FAKE_TOKEN: SECRET } } });
    const { machine, lines, landed, modes } = fork(f);
    const reader = agentsReader({ vault: () => ({}) });
    expect(await reader.tools({ kind: "machine", machine }, { key: "w_1", agent: "claude", name: "airtable" })).toMatchObject({ auth: "open", tools: [{ name: "list_records" }, { name: `token_${SECRET.length}` }] });
    expect(landed).toHaveLength(1);
    expect(modes).toEqual(["700 600"]);
    expect(existsSync(dirname(landed[0]!)), "the variables' folder outlived the run").toBe(false);
    for (const line of lines) expect(line).not.toContain(SECRET);
  }, 20_000);

  it("refuses a variable whose name is not a shell name before anything runs, on every road", async () => {
    const f = fixture();
    const hostile = `A=1; touch "$HOME/pwned"; B`;
    f.config({ airtable: { command: join(f.bin, "server"), args: [], env: { [hostile]: "x", FAKE_TOKEN: SECRET } } });
    const { machine, lines, landed } = fork(f);
    const reader = agentsReader({ vault: () => ({}), here: () => here(f) });
    for (const on of [{ kind: "machine" as const, machine }, { kind: "here" as const }]) {
      const answer = await reader.tools(on, { key: on.kind, agent: "claude", name: "airtable" });
      expect(answer).toMatchObject({ auth: "failed", refused: `its variable ${JSON.stringify(hostile)} is not a name a shell takes, so it was not started` });
    }
    expect(starts(f)).toBe(0);
    expect(existsSync(join(f.home, "pwned"))).toBe(false);
    expect(landed).toEqual([]);
    for (const line of lines) expect(line).not.toContain(join(f.bin, "server"));
  }, 20_000);

  it("stops a child that left the server's process group, when the server answered and when the time ran out", async () => {
    const f = fixture();
    f.config({ answers: { command: join(f.bin, "escape"), args: ["server"] }, silent: { command: join(f.bin, "escape"), args: ["mute"] } });
    expect(await agentsReader({ vault: () => ({}), here: () => here(f) }).tools({ kind: "here" }, { key: "here", agent: "claude", name: "answers" })).toMatchObject({ auth: "open" });
    const late = agentsReader({ vault: () => ({}), here: () => here(f), toolsMs: 2_000 });
    expect(await late.tools({ kind: "here" }, { key: "here", agent: "claude", name: "silent" })).toMatchObject({ refused: serverToolsLateRefusal(2_000) });
    const pids = escaped(f);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(alive(pid), `the escaped child ${pid} outlived the run`).toBe(false);
  }, 20_000);

  it("keeps what a server says on stdout under a cap on the target while it runs", async () => {
    const f = fixture();
    f.config({ flood: { command: join(f.bin, "flood"), args: [] } });
    const reader = agentsReader({ vault: () => ({}), here: () => here(f), toolsMs: 2_000 });
    let most = 0;
    const tmp = join(f.root, "tmp");
    const watch = setInterval(() => {
      for (const d of readdirSync(tmp)) {
        try {
          most = Math.max(most, statSync(join(tmp, d, "out")).size);
        } catch {}
      }
    }, 20);
    try {
      await reader.tools({ kind: "here" }, { key: "here", agent: "claude", name: "flood" });
    } finally {
      clearInterval(watch);
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(4 * 1024 * 1024);
  }, 20_000);
});
