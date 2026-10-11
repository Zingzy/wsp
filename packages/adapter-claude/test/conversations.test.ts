// SPDX-License-Identifier: AGPL-3.0-only
// Claude Code's own conversations read for a person picking one up, and the launch a copy of one runs: the store asks
// the computer's daemon for the transcripts and `claude agents --json` for what is open, and a copy rides the CLI's own
// `--resume <id> --fork-session` under a session id of wsp's.
import { describe, expect, it } from "vitest";
import type { AdapterEvent, ConversationRoad, ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createClaudeAdapter } from "../src/adapter.js";
import { keysFor, liveCommand, originOf, parseLive, PROGRAMMATIC_ENTRYPOINTS } from "../src/conversations.js";
import { buildCommand } from "../src/landmines.js";

const ID = "7414323d-e71b-4957-8b56-eefdf6bfa350";
const NEW = "77cae3d9-8a8b-46ee-8ce1-6dafa2a17db9";

/** A road whose daemon answers each op as given and whose shell answers every line with `stdout`, recording both. */
function road(answers: Record<string, Record<string, unknown>>, stdout = "[]"): ConversationRoad & { frames: Record<string, unknown>[]; lines: { command: string; env?: Readonly<Record<string, string>> }[] } {
  const frames: Record<string, unknown>[] = [];
  const lines: { command: string; env?: Readonly<Record<string, string>> }[] = [];
  return {
    frames,
    lines,
    ask: async frame => {
      frames.push(frame);
      const answer = answers[frame.op];
      if (answer === undefined) throw new Error(`unknown op: ${frame.op}`);
      return answer;
    },
    exec: async (command, env) => {
      lines.push({ command, ...(env !== undefined ? { env } : {}) });
      return stdout;
    },
  };
}

/** One launch recorded; the run prints nothing and ends at once. */
function recorded(): { factory: ExecStreamFactory; commands: string[] } {
  const commands: string[] = [];
  const factory: ExecStreamFactory = command => {
    commands.push(command);
    const stream: ExecStream = {
      lines: (async function* () {})(),
      teardown: () => {},
      kill: () => {},
      write: async () => "written",
      closeInput: () => {},
      exited: Promise.resolve(0),
    };
    return stream;
  };
  return { factory, commands };
}

describe("Claude Code's conversations in a folder", () => {
  it("come off transcripts.list under the store the turns read, in the folders' keys and the project's pinned one", async () => {
    const adapter = createClaudeAdapter({ exec: recorded().factory, configDir: "/home/dev/.config/claude/", projectDirName: "-work-acme-lab" });
    const r = road({
      "transcripts.list": {
        rows: [
          { id: ID, cwd: "/work/acme/lab", branch: "feat/x", entrypoint: "cli", title: "lab codewords", firstPrompt: "Remember ALPHA.", lastAt: 1_791_673_566_000, bytes: 209_753 },
          { id: NEW, cwd: "/work/acme/lab-wt", entrypoint: "sdk-cli", lastAt: 1_791_673_570_000, bytes: 1_024 },
        ],
      },
    });
    const rows = await adapter.conversations.list(["/work/acme/lab", "/work/acme/lab-wt"], r);
    expect(r.frames).toEqual([{ op: "transcripts.list", root: "/home/dev/.config/claude/projects", dirs: ["-work-acme-lab", "-work-acme-lab-wt"], cwds: ["/work/acme/lab", "/work/acme/lab-wt"] }]);
    expect(rows).toEqual([
      { id: ID, title: "lab codewords", firstPrompt: "Remember ALPHA.", branch: "feat/x", cwd: "/work/acme/lab", lastAt: 1_791_673_566_000, bytes: 209_753, origin: "terminal" },
      { id: NEW, title: NEW, cwd: "/work/acme/lab-wt", lastAt: 1_791_673_570_000, bytes: 1_024, origin: "script" },
    ]);
  });

  it("read as a script's where their first entrypoint is one Claude Code's own picker leaves out, and as a person's otherwise", () => {
    expect(PROGRAMMATIC_ENTRYPOINTS).toEqual(["sdk-cli", "sdk-ts", "sdk-py"]);
    for (const e of PROGRAMMATIC_ENTRYPOINTS) expect(originOf(e)).toBe("script");
    for (const e of ["cli", "claude-vscode", "claude-desktop", undefined]) expect(originOf(e)).toBe("terminal");
  });

  it("sit under each folder's own key, with the pinned key once", () => {
    expect(keysFor(["/work/acme/lab", "/work/acme/lab"], "-work-acme-lab")).toEqual(["-work-acme-lab"]);
    expect(keysFor(["/work/acme/lab.v2"], undefined)).toEqual(["-work-acme-lab-v2"]);
  });

  it("are open where `claude agents --json` names their session, run under the turn's environment", async () => {
    const adapter = createClaudeAdapter({ exec: recorded().factory, configDir: "/home/dev/.claude", baseEnv: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/dev/.claude" } });
    const agents = JSON.stringify([{ pid: 30886, cwd: "/work/acme/lab", kind: "interactive", startedAt: 1, sessionId: ID, name: "lab codewords", status: "idle" }]);
    const r = road({}, agents);
    expect(await adapter.conversations.live!(r)).toEqual(new Set([ID]));
    expect(r.lines[0]!.command).toBe(liveCommand());
    expect(r.lines[0]!.command).toMatch(/claude agents --json$/);
    expect(r.lines[0]!.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/home/dev/.claude" });
  });

  it("are none of them open where the command answers no list: a Claude Code too old for it, or a failed run", async () => {
    expect(parseLive("error: unknown command 'agents'")).toBeNull();
    expect(parseLive('{"not":"a list"}')).toBeNull();
    expect(parseLive("[]")).toEqual(new Set());
    const adapter = createClaudeAdapter({ exec: recorded().factory, configDir: "/home/dev/.claude" });
    const failing: ConversationRoad = { ask: async () => ({}), exec: () => Promise.reject(new Error("exit 127")) };
    expect(await adapter.conversations.live!(failing)).toBeNull();
  });

  it("read one conversation off transcripts.read, gone where no folder holds it", async () => {
    const adapter = createClaudeAdapter({ exec: recorded().factory, configDir: "/home/dev/.claude" });
    const found = road({ "transcripts.read": { found: true, cwd: "/work/acme/lab", title: "lab codewords", messages: [{ who: "person", text: "hi" }, { who: "tool", text: '{"command":"ls"}', tool: "Bash" }, { who: "agent", text: "done" }], earlier: 4 } });
    expect(await adapter.conversations.earlier(ID, { cwds: ["/work/acme/lab"], last: 200, probe: true }, found)).toEqual({
      cwd: "/work/acme/lab",
      title: "lab codewords",
      lines: [{ who: "person", text: "hi" }, { who: "tool", text: '{"command":"ls"}', tool: "Bash" }, { who: "agent", text: "done" }],
      earlier: 4,
    });
    expect(found.frames).toEqual([{ op: "transcripts.read", root: "/home/dev/.claude/projects", dirs: ["-work-acme-lab"], session: ID, last: 200 }]);
    expect(await adapter.conversations.earlier(ID, { cwds: ["/work/acme/lab"], last: 200, probe: true }, road({ "transcripts.read": { found: false, messages: [], earlier: 0 } }))).toBe("gone");
  });
});

describe("a copy of a Claude Code conversation", () => {
  it("is a new session the CLI starts off the original with --fork-session", () => {
    const line = buildCommand({ sessionId: NEW, copyOf: ID });
    expect(line).toContain(`--session-id ${NEW} --resume ${ID} --fork-session`);
    expect(() => buildCommand({ resume: ID, copyOf: NEW })).toThrow(/a copy opens a new session/);
    expect(() => buildCommand({ sessionId: NEW, copyOf: "x" })).toThrow(/a copy opens a new session/);
  });

  it("runs under an id of wsp's, never the original's, with no name and no saved spend read off the original", async () => {
    const exec = recorded();
    const adapter = createClaudeAdapter({ exec: exec.factory, configDir: "/home/dev/.claude" });
    const events: AdapterEvent[] = [];
    const session = adapter.start({ prompt: "go on", resume: ID, copy: true, onEvent: e => events.push(e) });
    await session.finished;
    const command = exec.commands[0]!;
    expect(command).toMatch(new RegExp(`--session-id ${session.localId} --resume ${ID} --fork-session`));
    expect(session.localId).not.toBe(ID);
    expect(command).not.toContain("--name");
    expect(command).not.toContain(`${ID}.jsonl`);
  });

  it("is never what a plain resume runs: that resumes the original by its id", async () => {
    const exec = recorded();
    await createClaudeAdapter({ exec: exec.factory, configDir: "/home/dev/.claude" }).start({ prompt: "go on", resume: ID, onEvent: () => {} }).finished;
    expect(exec.commands[0]).toContain(`--resume ${ID}`);
    expect(exec.commands[0]).not.toContain("--fork-session");
    expect(exec.commands[0]).not.toContain("--name");
  });
});
