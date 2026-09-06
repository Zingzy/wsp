// SPDX-License-Identifier: AGPL-3.0-only
// The session readers over fixtures shaped like each agent's own store, and
// the command parser that turns a shell line into the names of what it ran.
import { describe, expect, it } from "vitest";
import { HISTORY_READERS, claudeSession, codexReader, commandNames, hermesReader, installNames, readHistories, splitCommands, tally, withoutHeredocs } from "../src/history/index.js";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { fakeHost } from "./fake-host.js";

const line = (o: unknown): string => JSON.stringify(o);
const claudeLine = (sessionId: string, tools: { name: string; input: unknown }[]): string =>
  line({ type: "assistant", cwd: "/Users/dev/proj", sessionId, message: { role: "assistant", content: tools.map(t => ({ type: "tool_use", id: "toolu_1", name: t.name, input: t.input })) } });
const userLine = (text: string): string => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] } });

describe("command names", () => {
  it("takes the first word of each command across pipes, ands, semicolons and subshells", () => {
    expect(commandNames("git log --oneline | head -5 && gh pr view; (cd x && pnpm test) || echo no")).toEqual(["git", "head", "gh", "pnpm"]);
    expect(commandNames("for f in *.ts; do wc -l \"$f\"; done")).toEqual(["wc"]);
    expect(commandNames("VAR=1 sudo -u me env FOO=bar /usr/local/bin/python3 -c 1")).toEqual(["python3"]);
    expect(commandNames("time nohup node server.js &")).toEqual(["node"]);
    expect(commandNames("echo $(git rev-parse HEAD) > `which out`")).toEqual(["git", "which"]);
    expect(commandNames("2>/dev/null ls; > out.txt cat in; curl -s x >/dev/null 2>&1")).toEqual(["ls", "cat", "curl"]);
    expect(commandNames("2>&1 ls; >&2 echo x; &>/dev/null cat")).toEqual(["ls", "cat"]);
    expect(commandNames("./node_modules/.bin/tsc --noEmit")).toEqual(["tsc"]);
  });

  it("keeps an unquoted variable inside the word it sits in", () => {
    expect(commandNames("echo ${HOME}/go/bin/x")).toEqual([]);
    expect(commandNames("echo ${HOME}/bin; ls ${PWD}")).toEqual(["ls"]);
    expect(commandNames("${HOME}/go/bin/x --version && $BIN/y ${FLAGS:-${MORE}} z")).toEqual(["x", "y"]);
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
    const usage = await tally(HISTORY_READERS["claude-jsonl"].read(host, "/Users/dev/.claude/projects"));
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
    const usage = await tally(codexReader.read(host, "/Users/dev/.codex/sessions"));
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
  const rows = JSON.stringify([
    { session_id: "h1", tool_calls: JSON.stringify([{ type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "docker ps", timeout: 30 }) } }]) },
    { session_id: "h1", tool_calls: JSON.stringify([{ type: "function", function: { name: "skill_view", arguments: { name: "github" } } }, { type: "function", function: { name: "browser_exec", arguments: "{}" } }]) },
    { session_id: "h2", tool_calls: JSON.stringify([{ type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "docker compose up" }) } }]) },
  ]);

  it("asks sqlite3 read-only for the two columns and reads the terminal calls out of the JSON", async () => {
    const host = fakeHost({ files: { "~/.hermes/state.db": 4096 }, exec: { [`sqlite3 -readonly -json ${db} ${query}`]: rows } });
    const usage = await tally(hermesReader.read(host, db));
    expect(usage).toMatchObject({ sessions: 2, calls: 4 });
    expect([...usage.commands]).toEqual([["docker", { sessions: 2, calls: 2 }]]);
    expect(host.calls).toEqual([`run sqlite3 -readonly -json ${db} ${query}`]);
  });

  it("reads nothing when there is no database, and throws when the database is there but sqlite3 does not answer", async () => {
    expect(await tally(hermesReader.read(fakeHost(), db))).toMatchObject({ sessions: 0, calls: 0 });
    await expect(tally(hermesReader.read(fakeHost({ files: { "~/.hermes/state.db": 4096 } }), db))).rejects.toThrow("could not be read");
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
    ]);
  });
});
