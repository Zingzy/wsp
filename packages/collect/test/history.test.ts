// SPDX-License-Identifier: AGPL-3.0-only
// The session readers over fixtures shaped like each agent's own store, and
// the command parser that turns a shell line into the names of what it ran.
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HISTORY_READERS, PARSE_VERSION, claudeSession, codexReader, commandNames, fileHistoryCache, fileUsageCache, hermesReader, installNames, readHistories, readLogUsage, readStore, splitCommands, withoutHeredocs } from "../src/history/index.js";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { MTIME, fakeHost } from "./fake-host.js";

const line = (o: unknown): string => JSON.stringify(o);
const claudeLine = (sessionId: string, tools: { name: string; input: unknown }[]): string =>
  line({ type: "assistant", cwd: "/Users/dev/proj", sessionId, message: { role: "assistant", content: tools.map(t => ({ type: "tool_use", id: "toolu_1", name: t.name, input: t.input })) } });
const claudeLineNoCwd = (sessionId: string, command: string): string =>
  line({ type: "assistant", sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] } });
const userLine = (text: string): string => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] } });

describe("command names", () => {
  it("takes the first word of each command across pipes, ands, semicolons and subshells", () => {
    expect(commandNames("git log --oneline | head -5 && gh pr view; (cd x && pnpm test) || echo no")).toEqual(["git", "head", "gh", "pnpm"]);
    expect(commandNames("for f in *.ts; do wc -l \"$f\"; done")).toEqual(["wc"]);
    expect(commandNames("VAR=1 sudo -u me env FOO=bar /usr/local/bin/python3 -c 1")).toEqual(["python3"]);
    expect(commandNames("time nohup node server.js &")).toEqual(["node"]);
    // A comment ends the line's commands; a quoted # is text; a substitution inside double quotes still runs its command.
    expect(commandNames('ls # list\ngit commit -m "fix #12"\ncat "$(mktemp)"')).toEqual(["ls", "git", "cat", "mktemp"]);
    expect(commandNames("echo $(git rev-parse HEAD) > `which out`")).toEqual(["git"]);
    expect(commandNames("2>/dev/null ls; > out.txt cat in; curl -s x >/dev/null 2>&1")).toEqual(["ls", "cat", "curl"]);
    expect(commandNames("2>&1 ls; >&2 echo x; &>/dev/null cat")).toEqual(["ls", "cat"]);
    expect(commandNames("./node_modules/.bin/tsc --noEmit")).toEqual(["tsc"]);
  });

  it("a version check is not a use: --version, -v, which and command -v run nothing the agent works with", () => {
    expect(commandNames("gh --version && vercel -v; which java; command -v aws")).toEqual([]);
    expect(commandNames("java -version; python3 -V; pip -V && node -v")).toEqual([]);
    expect(commandNames("node --version | head -1; grep -v foo x.txt; pytest -v tests")).toEqual(["head", "grep", "pytest"]);
    expect(commandNames("command -v gh >/dev/null 2>&1 || brew install gh")).toEqual(["brew"]);
    expect(installNames("command -v gh || npm i -g vercel")).toEqual([{ via: "npm", name: "vercel" }]);
  });

  it("keeps an unquoted variable inside the word it sits in", () => {
    expect(commandNames("echo ${HOME}/go/bin/x")).toEqual([]);
    expect(commandNames("echo ${HOME}/bin; ls ${PWD}")).toEqual(["ls"]);
    expect(commandNames("${HOME}/go/bin/x --help && $BIN/y ${FLAGS:-${MORE}} z")).toEqual(["x", "y"]);
    expect(splitCommands("a ${b|c} d")).toEqual(["a ${b|c} d"]);
  });

  it("never splits inside quotes and never reads a heredoc body", () => {
    expect(commandNames("git commit -m 'fix: a | b && c'")).toEqual(["git"]);
    expect(commandNames('sh -c "ls | wc"')).toEqual(["sh"]);
    expect(commandNames("python3 - <<'EOF'\nimport os; os.system('rm -rf /')\nEOF\ngit status")).toEqual(["python3", "git"]);
    expect(withoutHeredocs("cat <<EOF > x\nbrew install evil\nEOF")).toBe("cat <<EOF > x");
    expect(splitCommands("a 'b|c' d")).toEqual(["a b|c d"]);
  });

  it("reads the packages an installer was asked for, versions off, one-shot runners under their own name", () => {
    expect(installNames("brew install gh jq && npm install -g agent-browser@0.31.1 wrangler")).toEqual([
      { via: "brew", name: "gh" },
      { via: "brew", name: "jq" },
      { via: "npm", name: "agent-browser" },
      { via: "npm", name: "wrangler" },
    ]);
    expect(installNames("npm install typescript")).toEqual([]);
    expect(installNames("uv tool install aider-chat==0.86.2 && pipx install ruff && cargo install ripgrep")).toEqual([
      { via: "uv", name: "aider-chat" },
      { via: "pipx", name: "ruff" },
      { via: "cargo", name: "ripgrep" },
    ]);
    expect(installNames("go install github.com/cli/cli/v2/cmd/gh@latest")).toEqual([{ via: "go", name: "gh" }]);
    expect(installNames("npx -y @anthropic-ai/claude-code@1.0 --version; sudo apt-get install -y ffmpeg")).toEqual([{ via: "npx", name: "@anthropic-ai/claude-code" }, { via: "apt", name: "ffmpeg" }]);
  });

  it("never reads a redirection target as a package", () => {
    expect(installNames("brew install foo >/dev/null 2>&1 && npm i -g bar > out.txt 2> err.txt < in.txt")).toEqual([
      { via: "brew", name: "foo" },
      { via: "npm", name: "bar" },
    ]);
    expect(installNames("brew install 2>&1 foo; brew install foo &>/dev/null; brew install foo >&2 bar")).toEqual([
      { via: "brew", name: "foo" },
      { via: "brew", name: "foo" },
      { via: "brew", name: "foo" },
      { via: "brew", name: "bar" },
    ]);
  });
});

describe("Claude Code reader", () => {
  it("keys a transcript to its top-level session, nested and cleared ones included", () => {
    expect(claudeSession("-Users-dev-proj/abc.jsonl")).toBe("abc");
    expect(claudeSession("-Users-dev-proj/abc/subagents/agent-1.jsonl")).toBe("abc");
    expect(claudeSession("-Users-dev-proj/_cleared_sessions/old.jsonl")).toBe("old");
    expect(claudeSession("-Users-dev-proj")).toBeUndefined();
  });

  it("counts a session once across its sub-agent transcripts and keeps names and counts only", async () => {
    const host = fakeHost({
      files: {
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": [
          userLine("export TOKEN=sk-ant-x-secret-value"),
          claudeLine("s1", [{ name: "Bash", input: { command: "gh pr list | head -3" } }, { name: "Read", input: { file_path: "/x" } }]),
          claudeLine("s1", [{ name: "Skill", input: { skill: "unslop" } }, { name: "mcp__zoho-mail__zoho_list_emails", input: {} }]),
          "not json at all",
        ].join("\n"),
        "~/.claude/projects/-Users-dev-proj/s1/subagents/agent-a.jsonl": claudeLine("s1", [{ name: "Bash", input: { command: "gh api repos/x && npm install -g agent-browser" } }]),
        "~/.claude/projects/-Users-dev-other/s2.jsonl": claudeLine("s2", [{ name: "Bash", input: { command: "git status" } }]),
        "~/.claude/projects/-Users-dev-other/memory/MEMORY.md": "# notes",
      },
    });
    const usage = await readStore(host, HISTORY_READERS["claude-jsonl"], "/Users/dev/.claude/projects");
    expect(usage.sessions).toBe(2);
    expect(usage.calls).toBe(6);
    expect([...usage.commands]).toEqual([
      ["gh", { sessions: 1, calls: 2 }],
      ["git", { sessions: 1, calls: 1 }],
      ["head", { sessions: 1, calls: 1 }],
      ["npm", { sessions: 1, calls: 1 }],
    ]);
    expect([...usage.installs]).toEqual([["npm agent-browser", { sessions: 1, calls: 1 }]]);
    // gh ran twice in one session and is one tool; npm is Node's; the install names agent-browser.
    expect([...usage.tools]).toEqual([
      ["gh", { sessions: 1, calls: 2 }],
      ["agent-browser", { sessions: 1, calls: 1 }],
      ["git", { sessions: 1, calls: 1 }],
      ["node", { sessions: 1, calls: 1 }],
    ]);
    expect(JSON.stringify([...usage.commands, ...usage.installs, ...usage.tools])).not.toContain("sk-ant-x");
  });

  it("counts a session once when two project folders hold its files, by the folder whose newest call is latest", async () => {
    const at = (m: number) => `2026-09-06T10:${String(m).padStart(2, "0")}:00.000Z`;
    const call = (session: string, m: number, cwd: string, command: string) =>
      line({ type: "assistant", cwd, sessionId: session, timestamp: at(m), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] } });
    const HOME = "/Users/dev/wsp";
    const COPY = "/private/tmp/wsp-test/export-dev/wsp";
    const host = fakeHost({
      files: {
        "~/.claude/projects/-Users-dev-wsp/s1.jsonl": [call("s1", 1, HOME, "gh pr view"), call("s1", 2, HOME, "gh pr list"), call("s1", 50, HOME, "cargo build")].join("\n"),
        "~/.claude/projects/-Users-dev-wsp/s1/subagents/agent-a.jsonl": call("s1", 3, HOME, "jq ."),
        "~/.claude/projects/-private-tmp-wsp-test-export-dev-wsp/s1.jsonl": [call("s1", 1, COPY, "gh pr view"), call("s1", 2, COPY, "gh pr list")].join("\n"),
        "~/.claude/projects/-private-tmp-wsp-test-export-dev-wsp/s1/subagents/agent-a.jsonl": call("s1", 3, COPY, "jq ."),
        "~/.claude/projects/-private-tmp-wsp-test-export-dev-wsp/s2.jsonl": call("s2", 5, COPY, "gh auth status"),
      },
    });
    const usage = await readStore(host, HISTORY_READERS["claude-jsonl"], "/Users/dev/.claude/projects");
    expect(usage.sessions).toBe(2);
    expect(usage.calls).toBe(5);
    expect([...usage.commands]).toEqual([
      ["gh", { sessions: 2, calls: 3 }],
      ["cargo", { sessions: 1, calls: 1 }],
      ["jq", { sessions: 1, calls: 1 }],
    ]);
    const home = await readStore(host, HISTORY_READERS["claude-jsonl"], "/Users/dev/.claude/projects", { folders: [HOME] });
    expect(home).toMatchObject({ sessions: 1, calls: 4 });
  });
});

describe("Codex reader", () => {
  it("reads exec_command and the older shell array out of a rollout's function calls", async () => {
    const rollout = [
      line({ type: "session_meta", payload: { id: "t1", cwd: "/Users/dev/proj" } }),
      line({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "cargo build && cargo test", workdir: "/x" }) } }),
      line({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "ls"] }) } }),
      line({ type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: "{\"plan\":[]}" } }),
      line({ type: "response_item", payload: { type: "function_call_output", output: "secret output" } }),
      line({ type: "event_msg", payload: { type: "token_count" } }),
    ].join("\n");
    const host = fakeHost({ files: { "~/.codex/sessions/2026/06/01/rollout-2026-06-01T10-00-00-t1.jsonl": rollout } });
    const usage = await readStore(host, codexReader, "/Users/dev/.codex/sessions");
    expect(usage).toMatchObject({ sessions: 1, calls: 3 });
    expect([...usage.commands]).toEqual([
      ["cargo", { sessions: 1, calls: 2 }],
      ["bash", { sessions: 1, calls: 1 }],
    ]);
    expect([...usage.tools]).toEqual([["rust", { sessions: 1, calls: 2 }]]);
  });
});

describe("Hermes reader", () => {
  const db = "/Users/dev/.hermes/state.db";
  const query = "select session_id, tool_calls from messages where tool_calls is not null";
  const joined = "select m.session_id, m.tool_calls, s.cwd from messages m left join sessions s on s.id = m.session_id where m.tool_calls is not null";
  const call = (session: string, command: string) => ({ session_id: session, tool_calls: JSON.stringify([{ type: "function", function: { name: "terminal", arguments: JSON.stringify({ command }) } }]) });
  const rows = JSON.stringify([
    { session_id: "h1", tool_calls: JSON.stringify([{ type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "docker ps", timeout: 30 }) } }]) },
    { session_id: "h1", tool_calls: JSON.stringify([{ type: "function", function: { name: "skill_view", arguments: { name: "github" } } }, { type: "function", function: { name: "browser_exec", arguments: "{}" } }]) },
    { session_id: "h2", tool_calls: JSON.stringify([{ type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "docker compose up" }) } }]) },
  ]);

  it("asks sqlite3 read-only for its columns and the folder each session ran in, and reads the terminal calls out of the JSON", async () => {
    const host = fakeHost({ files: { "~/.hermes/state.db": 4096 }, exec: { [`sqlite3 -readonly -json ${db} ${joined}`]: rows } });
    const usage = await readStore(host, hermesReader, db);
    expect(usage).toMatchObject({ sessions: 2, calls: 4 });
    expect([...usage.commands]).toEqual([["docker", { sessions: 2, calls: 2 }]]);
    expect(host.calls).toEqual([`run sqlite3 -readonly -json ${db} ${joined}`]);
  });

  it("falls back to the columns alone on a database with no sessions table, and counts nothing for a project then", async () => {
    const host = fakeHost({ files: { "~/.hermes/state.db": 4096 }, exec: { [`sqlite3 -readonly -json ${db} ${query}`]: rows } });
    expect(await readStore(host, hermesReader, db)).toMatchObject({ sessions: 2, calls: 4 });
    expect(host.calls).toEqual([`run sqlite3 -readonly -json ${db} ${joined}`, `run sqlite3 -readonly -json ${db} ${query}`]);
    const known = fakeHost({ files: { "~/.hermes/state.db": 4096 }, exec: { [`sqlite3 -readonly -json ${db} ${joined}`]: JSON.stringify([{ ...call("h1", "docker ps"), cwd: "/Users/dev/proj" }, { ...call("h2", "go build"), cwd: "/Users/dev/other" }]) } });
    expect([...(await readStore(known, hermesReader, db, { folders: ["/Users/dev/proj"] })).commands]).toEqual([["docker", { sessions: 1, calls: 1 }]]);
  });

  it("reads nothing when there is no database, and throws when the database is there but sqlite3 does not answer", async () => {
    expect(await readStore(fakeHost(), hermesReader, db)).toMatchObject({ sessions: 0, calls: 0 });
    await expect(readStore(fakeHost({ files: { "~/.hermes/state.db": 4096 } }), hermesReader, db)).rejects.toThrow("could not be read");
  });
});

describe("weighing by project", () => {
  it("counts only the sessions that ran at a named folder or under it, whatever the store", async () => {
    const host = fakeHost({
      files: {
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", [{ name: "Bash", input: { command: "pnpm test" } }]),
        "~/.claude/projects/-Users-dev-proj-web/s2.jsonl": line({ type: "assistant", cwd: "/Users/dev/proj/web", sessionId: "s2", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "gh pr view" } }] } }),
        "~/.claude/projects/-Users-dev-other/s3.jsonl": line({ type: "assistant", cwd: "/Users/dev/other", sessionId: "s3", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "go build" } }] } }),
      },
    });
    const all = await readStore(host, HISTORY_READERS["claude-jsonl"], "/Users/dev/.claude/projects");
    expect([...all.commands].map(([name]) => name).sort()).toEqual(["gh", "go", "pnpm"]);
    const one = await readStore(host, HISTORY_READERS["claude-jsonl"], "/Users/dev/.claude/projects", { folders: ["/Users/dev/proj"] });
    expect([...one.commands].map(([name]) => name).sort()).toEqual(["gh", "pnpm"]);
    expect(one.sessions).toBe(2);
    // A sibling folder that shares the prefix is not inside it.
    expect((await readStore(host, HISTORY_READERS["claude-jsonl"], "/Users/dev/.claude/projects", { folders: ["/Users/dev/pro"] })).sessions).toBe(0);
  });

  it("takes a codex session's folder from the session_meta the rollout opens with", async () => {
    const rollout = (id: string, cwd: string, cmd: string) =>
      [line({ type: "session_meta", payload: { id, cwd } }), line({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }) } })].join("\n");
    const host = fakeHost({
      files: {
        "~/.codex/sessions/2026/06/01/rollout-a-t1.jsonl": rollout("t1", "/Users/dev/proj", "cargo build"),
        "~/.codex/sessions/2026/06/01/rollout-b-t2.jsonl": rollout("t2", "/Users/dev/other", "go build"),
      },
    });
    expect([...(await readStore(host, codexReader, "/Users/dev/.codex/sessions", { folders: ["/Users/dev/proj"] })).commands]).toEqual([["cargo", { sessions: 1, calls: 1 }]]);
  });

  it("counts nothing from a session whose store never recorded a folder", async () => {
    const host = fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLineNoCwd("s1", "pnpm test") } });
    expect((await readStore(host, HISTORY_READERS["claude-jsonl"], "/Users/dev/.claude/projects", { folders: ["/Users/dev/proj"] })).sessions).toBe(0);
    expect((await readStore(host, HISTORY_READERS["claude-jsonl"], "/Users/dev/.claude/projects")).sessions).toBe(1);
  });
});

describe("readHistories", () => {
  it("names every catalog agent: read with counts, empty, unreadable, or no reader for its format", async () => {
    const host = fakeHost({
      files: {
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", [{ name: "Bash", input: { command: "gh auth status" } }]),
        "~/.hermes/state.db": 4096,
      },
    });
    const out = await readHistories(host, CATALOG_AGENTS);
    expect(out.map(h => [h.agent, h.state, h.sessions, h.calls])).toEqual([
      ["claude", "read", 1, 1],
      ["codex", "empty", 0, 0],
      ["gemini", "no-reader", 0, 0],
      ["opencode", "no-reader", 0, 0],
      ["pi", "no-reader", 0, 0],
      ["hermes", "unreadable", 0, 0],
      ["crush", "no-reader", 0, 0],
      ["qwen", "no-reader", 0, 0],
      ["goose", "no-reader", 0, 0],
      ["amp", "no-reader", 0, 0],
      ["cursor", "no-reader", 0, 0],
    ]);
  });
});

describe("the session cache", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  const cachePath = (): string => {
    const d = mkdtempSync(join(tmpdir(), "wsp-history-"));
    dirs.push(d);
    return join(d, "history-cache.json");
  };

  const CLAUDE = CATALOG_AGENTS.filter(a => a.id === "claude");
  /** PARSE_VERSION and what the files that fill a bucket hashed to when it was last bumped. */
  const FINGERPRINT = "2:8d7258f9d6375eff";
  const S1 = "~/.claude/projects/-Users-dev-proj/s1.jsonl";
  const S2 = "~/.claude/projects/-Users-dev-proj/s2.jsonl";
  const FIRST = [claudeLine("s1", [{ name: "Bash", input: { command: "gh pr view" } }]), claudeLine("s1", [{ name: "Read", input: { file_path: "/x" } }])].join("\n");
  const SECOND = claudeLine("s2", [{ name: "Bash", input: { command: "pnpm test && npm install -g agent-browser" } }]);
  const LAPTOP = { files: { [S1]: FIRST, [S2]: SECOND } };
  const sessionPath = (name: string): string => `/Users/dev/.claude/projects/-Users-dev-proj/${name}.jsonl`;
  /** The session files a run opened, in order; the fake host records every read of a transcript. */
  const opened = (host: { calls: string[] }): string[] => host.calls.filter(c => c.startsWith("lines ")).map(c => c.slice("lines ".length));

  it("a second run over an unchanged history opens no session file and comes to the same counts", async () => {
    const cache = cachePath();
    const first = fakeHost(LAPTOP);
    const one = await readHistories(first, CLAUDE, { cache: fileHistoryCache(cache) });
    expect(opened(first)).toEqual([sessionPath("s1"), sessionPath("s2")]);
    expect(one[0]).toMatchObject({ state: "read", sessions: 2, calls: 3 });

    const again = fakeHost(LAPTOP);
    const two = await readHistories(again, CLAUDE, { cache: fileHistoryCache(cache) });
    expect(opened(again)).toEqual([]);
    expect(two).toEqual(one);
  });

  it("re-reads the one file whose stamp moved, whether its time or its size changed, and leaves the rest cached", async () => {
    const cache = cachePath();
    await readHistories(fakeHost(LAPTOP), CLAUDE, { cache: fileHistoryCache(cache) });

    // Same bytes, later mtime: the file is read again and the counts stand.
    const touched = fakeHost({ ...LAPTOP, mtimes: { [S2]: MTIME + 1 } });
    const after = await readHistories(touched, CLAUDE, { cache: fileHistoryCache(cache) });
    expect(opened(touched)).toEqual([sessionPath("s2")]);
    expect(after[0]).toMatchObject({ sessions: 2, calls: 3 });

    // Same mtime, more lines: the size says it moved, and the new command is counted.
    const grown = fakeHost({ files: { [S1]: FIRST, [S2]: `${SECOND}\n${claudeLine("s2", [{ name: "Bash", input: { command: "cargo build" } }])}` } });
    const last = await readHistories(grown, CLAUDE, { cache: fileHistoryCache(cache) });
    expect(opened(grown)).toEqual([sessionPath("s2")]);
    expect(last[0]).toMatchObject({ sessions: 2, calls: 4 });
    expect([...last[0]!.usage.commands]).toEqual([
      ["cargo", { sessions: 1, calls: 1 }],
      ["gh", { sessions: 1, calls: 1 }],
      ["npm", { sessions: 1, calls: 1 }],
      ["pnpm", { sessions: 1, calls: 1 }],
    ]);
  });

  it("counts every session file off as it lands, so a first run can be counted out loud", async () => {
    const progress: string[] = [];
    await readHistories(fakeHost(LAPTOP), CLAUDE, { onProgress: p => progress.push(`${p.agent} ${p.read}/${p.files}`) });
    expect(progress).toEqual(["claude 1/2", "claude 2/2"]);
  });

  it("drops a session file that is gone from the cache, and reads everything again when the cache itself cannot be read", async () => {
    const cache = cachePath();
    await readHistories(fakeHost(LAPTOP), CLAUDE, { cache: fileHistoryCache(cache) });
    const cleared = { files: { [S1]: FIRST } };
    await readHistories(fakeHost(cleared), CLAUDE, { cache: fileHistoryCache(cache) });
    expect(Object.keys((JSON.parse(readFileSync(cache, "utf8")) as { files: Record<string, unknown> }).files)).toEqual([sessionPath("s1")]);

    writeFileSync(cache, "{ half a file");
    const cold = fakeHost(LAPTOP);
    const out = await readHistories(cold, CLAUDE, { cache: fileHistoryCache(cache) });
    expect(opened(cold).length).toBe(2);
    expect(out[0]).toMatchObject({ sessions: 2, calls: 3 });
  });

  it("reads everything again when another parse version filled the file, so no run hands back an older parser's counts", async () => {
    const cache = cachePath();
    await readHistories(fakeHost(LAPTOP), CLAUDE, { cache: fileHistoryCache(cache) });
    const written = JSON.parse(readFileSync(cache, "utf8")) as Record<string, unknown>;
    expect(written["parse"]).toBe(PARSE_VERSION);

    // The same stamps, the same shape, one parse version on: the stamps say nothing moved and the file is still refused whole.
    writeFileSync(cache, JSON.stringify({ ...written, parse: PARSE_VERSION + 1 }));
    const cold = fakeHost(LAPTOP);
    const out = await readHistories(cold, CLAUDE, { cache: fileHistoryCache(cache) });
    expect(opened(cold)).toEqual([sessionPath("s1"), sessionPath("s2")]);
    expect(out[0]).toMatchObject({ sessions: 2, calls: 3 });
  });

  it("puts the new cache in place with a rename, so a second wsp over one state folder never reads a half-written file", async () => {
    const cache = cachePath();
    await readHistories(fakeHost(LAPTOP), CLAUDE, { cache: fileHistoryCache(cache) });
    const before = readFileSync(cache, "utf8");
    // What another process holding the old file sees: an in-place write moves under it, a rename leaves it whole.
    const held = `${cache}.held`;
    linkSync(cache, held);

    const grown = { files: { [S1]: FIRST, [S2]: `${SECOND}\n${claudeLine("s2", [{ name: "Bash", input: { command: "cargo build" } }])}` } };
    await readHistories(fakeHost(grown), CLAUDE, { cache: fileHistoryCache(cache) });
    expect(readFileSync(cache, "utf8")).not.toBe(before);
    expect(readFileSync(held, "utf8")).toBe(before);
  });

  it("bumps PARSE_VERSION when the code that fills a bucket changes", () => {
    const h = createHash("sha256");
    for (const f of ["claude.ts", "codex.ts", "commands.ts", "hermes.ts", "reader.ts", "tally.ts"]) h.update(readFileSync(new URL(`../src/history/${f}`, import.meta.url)));
    // Bump PARSE_VERSION in reader.ts and put the digest this prints here: every cache filled by the old code is then re-read.
    expect(`${PARSE_VERSION}:${h.digest("hex").slice(0, 16)}`).toBe(FINGERPRINT);
  });
});

describe("what each agent's own logs say was used", () => {
  const usageLine = (o: { id: string; session: string; at: string; model: string; cwd?: string; usage: Record<string, number> }) =>
    line({ type: "assistant", sessionId: o.session, timestamp: o.at, requestId: `req_${o.id}`, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), message: { id: o.id, model: o.model, role: "assistant", content: [{ type: "text", text: "x" }], usage: o.usage } });

  it("reads Claude's tokens once per message, though every block of a message repeats its usage, by session, day and model", async () => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 50 };
    const text = [
      usageLine({ id: "msg_1", session: "s1", at: "2026-09-29T10:00:00.000Z", model: "claude-opus-5", cwd: "/Users/dev/proj", usage }),
      usageLine({ id: "msg_1", session: "s1", at: "2026-09-29T10:00:01.000Z", model: "claude-opus-5", cwd: "/Users/dev/proj", usage }),
      usageLine({ id: "msg_2", session: "s1", at: "2026-09-29T10:05:00.000Z", model: "claude-opus-5", cwd: "/Users/dev/proj", usage: { input_tokens: 10, output_tokens: 5 } }),
      userLine("a tool's result is not usage"),
    ].join("\n");
    const host = fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": text } });
    const read = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "claude"), { day: at => new Date(at).toISOString().slice(0, 10) });
    expect(read).toEqual([
      { agent: "claude", session: "s1", day: "2026-09-29", at: Date.parse("2026-09-29T10:05:00.000Z"), model: "claude-opus-5", folder: "/Users/dev/proj", tokens: { input: 1_112, output: 55, cached: 1_000, cacheWrite: 100, reasoning: 0 } },
    ]);
  });

  it("counts a session once when two project folders hold its files, by the folder whose newest message is latest", async () => {
    const at = (m: number) => `2026-09-06T10:${String(m).padStart(2, "0")}:00.000Z`;
    const msg = (id: string, m: number, cwd: string, input: number) => usageLine({ id, session: "s1", at: at(m), model: "claude-opus-5", cwd, usage: { input_tokens: input, output_tokens: 1 } });
    const HOME = "/Users/dev/wsp";
    // An export rewrites cwd on every line it copies, so a copy is longer than the lines it came from.
    const COPY = "/private/tmp/wsp-test/export-dev/wsp";
    const copied = (cwd: string) => Array.from({ length: 30 }, (_, i) => msg(`msg_${i + 1}`, i + 1, cwd, 100));
    const original = [...copied(HOME), msg("msg_grown", 50, HOME, 1_000)].join("\n");
    const copy = copied(COPY).join("\n");
    expect(copy.length).toBeGreaterThan(original.length);
    const host = fakeHost({
      files: {
        "~/.claude/projects/-Users-dev-wsp/s1.jsonl": original,
        "~/.claude/projects/-Users-dev-wsp/s1/subagents/agent-a.jsonl": msg("msg_sub", 31, HOME, 5),
        "~/.claude/projects/-private-tmp-wsp-test-export-dev-wsp/s1.jsonl": copy,
        "~/.claude/projects/-private-tmp-wsp-test-export-dev-wsp/s1/subagents/agent-a.jsonl": msg("msg_sub", 31, COPY, 5),
        "~/.claude/projects/-private-tmp-wsp-test-export-dev-wsp/s2.jsonl": usageLine({ id: "msg_9", session: "s2", at: at(5), model: "claude-opus-5", cwd: COPY, usage: { input_tokens: 7, output_tokens: 1 } }),
      },
    });
    const read = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "claude"), { day: d => new Date(d).toISOString().slice(0, 10) });
    const summed = new Map<string, [string, string | undefined, number, number]>();
    for (const r of read) {
      const key = `${r.session} ${r.folder}`;
      const [, , input, output] = summed.get(key) ?? [r.session, r.folder, 0, 0];
      summed.set(key, [r.session, r.folder, input + r.tokens.input, output + r.tokens.output]);
    }
    expect([...summed.values()]).toEqual([
      ["s1", HOME, 4_005, 32],
      ["s2", COPY, 7, 1],
    ]);
  });

  it("reads a Codex rollout's last total under the thread id its session_meta names, with its model and folder", async () => {
    const tc = (at: string, input: number, output: number) =>
      line({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 400, output_tokens: output, reasoning_output_tokens: 7, total_tokens: input + output }, last_token_usage: {}, model_context_window: 258_400 }, rate_limits: {} } });
    const text = [
      line({ timestamp: "2026-09-29T09:00:00.000Z", type: "session_meta", payload: { id: "01a0e365-72f3-77e3-ba3a-3d18e12e9b95", cwd: "/Users/dev/proj" } }),
      line({ timestamp: "2026-09-29T09:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.5", cwd: "/Users/dev/proj" } }),
      tc("2026-09-29T09:01:00.000Z", 1_000, 20),
      tc("2026-09-29T09:02:00.000Z", 3_000, 90),
    ].join("\n");
    const host = fakeHost({ files: { "~/.codex/sessions/2026/09/29/rollout-2026-09-29T09-00-00-01a0e365.jsonl": text } });
    const read = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "codex"), { day: at => new Date(at).toISOString().slice(0, 10) });
    expect(read).toEqual([
      { agent: "codex", session: "01a0e365-72f3-77e3-ba3a-3d18e12e9b95", day: "2026-09-29", at: Date.parse("2026-09-29T09:02:00.000Z"), model: "gpt-5.5", folder: "/Users/dev/proj", tokens: { input: 3_000, output: 90, cached: 400, cacheWrite: 0, reasoning: 7 } },
    ]);
  });

  it("files a long Claude session at each half hour it worked in, not all of it at its last moment", async () => {
    const text = [
      usageLine({ id: "msg_1", session: "s1", at: "2026-09-29T10:00:00.000Z", model: "claude-opus-5", usage: { input_tokens: 100, output_tokens: 10 } }),
      usageLine({ id: "msg_2", session: "s1", at: "2026-09-29T10:20:00.000Z", model: "claude-opus-5", usage: { input_tokens: 50, output_tokens: 5 } }),
      usageLine({ id: "msg_3", session: "s1", at: "2026-09-29T13:40:00.000Z", model: "claude-opus-5", usage: { input_tokens: 7, output_tokens: 1 } }),
    ].join("\n");
    const host = fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": text } });
    const read = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "claude"), { day: at => new Date(at).toISOString().slice(0, 10) });
    expect(read.map(r => [new Date(r.at).toISOString(), r.tokens.input, r.tokens.output])).toEqual([
      ["2026-09-29T10:20:00.000Z", 150, 15],
      ["2026-09-29T13:40:00.000Z", 7, 1],
    ]);
  });

  it("files a Codex rollout's use at each token count that grew its total, across hours and days, under the model then running", async () => {
    const tc = (at: string, input: number, cached: number, output: number) =>
      line({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } }, rate_limits: {} } });
    const text = [
      line({ timestamp: "2026-09-29T09:00:00.000Z", type: "session_meta", payload: { id: "01a0e365-72f3-77e3-ba3a-3d18e12e9b95", cwd: "/Users/dev/proj" } }),
      line({ timestamp: "2026-09-29T09:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
      tc("2026-09-29T09:01:00.000Z", 1_000, 400, 20),
      tc("2026-09-29T14:02:00.000Z", 3_000, 2_000, 90),
      line({ timestamp: "2026-09-30T00:59:00.000Z", type: "turn_context", payload: { model: "gpt-5.5-mini" } }),
      tc("2026-09-30T01:00:00.000Z", 3_500, 2_100, 100),
    ].join("\n");
    const host = fakeHost({ files: { "~/.codex/sessions/2026/09/29/rollout-2026-09-29T09-00-00-01a0e365.jsonl": text } });
    const read = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "codex"), { day: at => new Date(at).toISOString().slice(0, 10) });
    expect(read.map(r => [r.day, new Date(r.at).toISOString(), r.model, r.tokens.input, r.tokens.cached, r.tokens.output])).toEqual([
      ["2026-09-29", "2026-09-29T09:01:00.000Z", "gpt-5.5", 1_000, 400, 20],
      ["2026-09-29", "2026-09-29T14:02:00.000Z", "gpt-5.5", 2_000, 1_600, 70],
      ["2026-09-30", "2026-09-30T01:00:00.000Z", "gpt-5.5-mini", 500, 100, 10],
    ]);
  });

  it("keeps a Codex rollout's cache writes, and leaves out the lines Claude Code writes under no model", async () => {
    const text = [
      line({ timestamp: "2026-09-29T09:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.5" } }),
      line({ timestamp: "2026-09-29T09:01:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1_000, cached_input_tokens: 400, cache_write_input_tokens: 300, output_tokens: 20, reasoning_output_tokens: 0 } } } }),
    ].join("\n");
    const claude = [
      usageLine({ id: "msg_1", session: "s1", at: "2026-09-29T10:00:00.000Z", model: "<synthetic>", usage: { input_tokens: 5, output_tokens: 1 } }),
      usageLine({ id: "msg_2", session: "s1", at: "2026-09-29T10:01:00.000Z", model: "claude-opus-5", usage: { input_tokens: 7, output_tokens: 1 } }),
    ].join("\n");
    const host = fakeHost({ files: { "~/.codex/sessions/2026/09/29/rollout-2026-09-29T09-00-00-01a0e365.jsonl": text, "~/.claude/projects/-Users-dev-proj/s1.jsonl": claude } });
    const read = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "codex" || a.id === "claude"), { day: at => new Date(at).toISOString().slice(0, 10) });
    expect(read.map(r => [r.agent, r.model, r.tokens.input, r.tokens.cacheWrite])).toEqual([
      ["claude", "claude-opus-5", 7, 0],
      ["codex", "gpt-5.5", 1_000, 300],
    ]);
  });

  it("reads again every file a cache from before the half-hour pieces holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-usage-cache-"));
    try {
      const path = join(dir, "usage-cache.json");
      const text = usageLine({ id: "msg_1", session: "s1", at: "2026-09-29T10:00:00.000Z", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } });
      const host = fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": text } });
      await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "claude"), { cache: fileUsageCache(path) });
      const held = JSON.parse(readFileSync(path, "utf8")) as { version: number; files: Record<string, { stamp: string; pieces: { tokens: { input: number } }[] }> };
      for (const file of Object.values(held.files)) file.pieces[0]!.tokens.input = 999;
      writeFileSync(path, JSON.stringify({ ...held, version: 1 }));
      const read = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "claude"), { cache: fileUsageCache(path) });
      expect(read.map(r => r.tokens.input)).toEqual([1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads OpenCode's own per-session totals and cost out of its database, read-only", async () => {
    const db = "/Users/dev/.local/share/opencode/opencode.db";
    const query = "select id, directory, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated from session";
    const rows = JSON.stringify([
      { id: "ses_1", directory: "/Users/dev/proj", model: '{"providerID":"anthropic","modelID":"claude-sonnet-4-5"}', cost: 0.12, tokens_input: 900, tokens_output: 40, tokens_reasoning: 0, tokens_cache_read: 300, tokens_cache_write: 10, time_updated: Date.parse("2026-09-29T11:00:00.000Z") },
      { id: "ses_2", directory: "/Users/dev/other", model: "gpt-5.5", cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, time_updated: Date.parse("2026-09-29T11:00:00.000Z") },
    ]);
    const host = fakeHost({ files: { "~/.local/share/opencode/opencode.db": 8192 }, exec: { [`sqlite3 -readonly -json ${db} ${query}`]: rows } });
    const read = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "opencode"), { day: at => new Date(at).toISOString().slice(0, 10) });
    // OpenCode's input leaves the cache out, so the cached and written parts are added in to match every other agent's.
    expect(read).toEqual([
      { agent: "opencode", session: "ses_1", day: "2026-09-29", at: Date.parse("2026-09-29T11:00:00.000Z"), model: "anthropic/claude-sonnet-4-5", folder: "/Users/dev/proj", tokens: { input: 1_210, output: 40, cached: 300, cacheWrite: 10, reasoning: 0 }, cost: 0.12 },
    ]);
  });

  it("keeps what each file came to and reads again only a file whose stamp moved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-usage-cache-"));
    try {
      const text = usageLine({ id: "msg_1", session: "s1", at: "2026-09-29T10:00:00.000Z", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } });
      const host = fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": text } });
      const cache = fileUsageCache(join(dir, "usage-cache.json"));
      const first = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "claude"), { day: at => new Date(at).toISOString().slice(0, 10), cache });
      const reads = host.calls.length;
      const again = await readLogUsage(host, CATALOG_AGENTS.filter(a => a.id === "claude"), { day: at => new Date(at).toISOString().slice(0, 10), cache: fileUsageCache(join(dir, "usage-cache.json")) });
      expect(again).toEqual(first);
      expect(host.calls.filter(c => c.startsWith("lines")).length).toBe(host.calls.slice(0, reads).filter(c => c.startsWith("lines")).length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
