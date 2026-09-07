// SPDX-License-Identifier: AGPL-3.0-only
// The hook carry of an agent's settings file: every hook command that names a
// script gets the script's guest path from the host's placer, and a hook whose
// script the placer refuses comes out of the copy, listed by the path as it was
// written. The placer is a fake here; the host owns the disk.
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS, CLAUDE_HOOKS, CLAUDE_SETTINGS_FILE, catalogEntry, onMachine, type AgentEntry } from "../src/index.js";

const HOME = "/Users/dev";
const HERE = new Map([
  [`${HOME}/.claude/hooks/remind`, "/root/.claude-cfg/hooks/remind"],
  [`${HOME}/.codync/notify.sh`, "/root/.codync/notify.sh"],
  [`${HOME}/bin/say it`, "/root/bin/say it"],
  [`${HOME}/x.sh`, "/root/x.sh"],
]);
const place = (abs: string): string | undefined => HERE.get(abs);
const text = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

describe("the catalog's hook carries", () => {
  it("are registered on the agent entries whose settings run hooks, each naming a file among the entry's own config paths", () => {
    const carriers = CATALOG_AGENTS.filter((a): a is AgentEntry & { hooks: NonNullable<AgentEntry["hooks"]> } => a.hooks !== undefined);
    expect(carriers.map(a => a.id)).toEqual(["claude"]);
    for (const a of carriers) expect(a.configPaths, a.id).toContain(a.hooks.file);
    expect(CLAUDE_HOOKS.file).toBe(CLAUDE_SETTINGS_FILE);
    expect((catalogEntry("codex") as AgentEntry).hooks).toBeUndefined();
  });
});

describe("Claude Code's hooks", () => {
  it("rewrites every path word the placer knows, written as ~/, $HOME/, ${HOME}/ or in full, quotes kept, and lists each script once", () => {
    const before = {
      model: "opus",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "~/.claude/hooks/remind" }, { type: "command", command: `${HOME}/.codync/notify.sh --quiet`, timeout: 10 }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "$HOME/.codync/notify.sh done" }, { type: "command", command: 'bash "${HOME}/bin/say it" now' }] }],
      },
    };
    const out = CLAUDE_HOOKS.carry(text(before), HOME, place);
    expect(JSON.parse(out.text)).toEqual({
      model: "opus",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/root/.claude-cfg/hooks/remind" }, { type: "command", command: "/root/.codync/notify.sh --quiet", timeout: 10 }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "/root/.codync/notify.sh done" }, { type: "command", command: 'bash "/root/bin/say it" now' }] }],
      },
    });
    expect(out.carried).toEqual([
      { from: `${HOME}/.claude/hooks/remind`, to: "/root/.claude-cfg/hooks/remind" },
      { from: `${HOME}/.codync/notify.sh`, to: "/root/.codync/notify.sh" },
      { from: `${HOME}/bin/say it`, to: "/root/bin/say it" },
    ]);
    expect(out.left).toEqual([]);
  });

  it("takes out a hook whose script the placer refuses, by the path as written; an emptied group and an emptied event go with it, and a settings file left with no hooks loses the key", () => {
    const before = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "~/.claude/hooks/remind" }, { type: "command", command: "/opt/homebrew/bin/terminal-notifier -title done" }] },
          { matcher: "resume", hooks: [{ type: "command", command: "~/.claude/hooks/gone" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: `${HOME}/.claude/hooks/gone --now` }] }],
      },
    };
    const out = CLAUDE_HOOKS.carry(text(before), HOME, place);
    expect(JSON.parse(out.text)).toEqual({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/root/.claude-cfg/hooks/remind" }] }] } });
    expect(out.left).toEqual(["/opt/homebrew/bin/terminal-notifier", "~/.claude/hooks/gone", `${HOME}/.claude/hooks/gone`]);
    expect(out.carried).toEqual([{ from: `${HOME}/.claude/hooks/remind`, to: "/root/.claude-cfg/hooks/remind" }]);
    const only = CLAUDE_HOOKS.carry(text({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "~/.claude/hooks/gone" }] }] } }), HOME, place);
    expect(only.text).toBe('{\n  "model": "opus"\n}\n');
    expect(only.left).toEqual(["~/.claude/hooks/gone"]);
  });

  it("a path the machine has passes through unchanged and is never asked of the placer; a plain file under home is carried; any other absolute path is dropped", () => {
    const asked: string[] = [];
    const placer = (abs: string): string | undefined => {
      asked.push(abs);
      return place(abs);
    };
    const before = {
      hooks: {
        Stop: [
          { hooks: [
            { type: "command", command: "/usr/bin/env jq -r .tool_input" },
            { type: "command", command: "/bin/sh -c 'echo done'" },
            { type: "command", command: "/usr/local/bin/notify done" },
            { type: "command", command: "/usr/sbin/logger done" },
            { type: "command", command: "~/.claude/hooks/remind" },
            { type: "command", command: "/Users/dev/.codync/notify.sh" },
            { type: "command", command: "/opt/homebrew/bin/terminal-notifier -title done" },
            { type: "command", command: "/Applications/Say.app/Contents/MacOS/say done" },
            { type: "command", command: "/Users/other/bin/ping" },
          ] },
        ],
      },
    };
    const out = CLAUDE_HOOKS.carry(text(before), HOME, placer);
    expect((JSON.parse(out.text) as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop[0]!.hooks.map(h => h.command)).toEqual([
      "/usr/bin/env jq -r .tool_input",
      "/bin/sh -c 'echo done'",
      "/usr/local/bin/notify done",
      "/usr/sbin/logger done",
      "/root/.claude-cfg/hooks/remind",
      "/root/.codync/notify.sh",
    ]);
    expect(out.left).toEqual(["/opt/homebrew/bin/terminal-notifier", "/Applications/Say.app/Contents/MacOS/say", "/Users/other/bin/ping"]);
    expect(asked).toEqual([`${HOME}/.claude/hooks/remind`, `${HOME}/.codync/notify.sh`, "/opt/homebrew/bin/terminal-notifier", "/Applications/Say.app/Contents/MacOS/say", "/Users/other/bin/ping"]);
    expect(onMachine("/usr/bin/env")).toBe(true);
    expect(onMachine("/usr/bin")).toBe(false);
    expect(onMachine("/usr/binx/y")).toBe(false);
    expect(onMachine("/opt/homebrew/bin/jq")).toBe(false);
  });

  it("asks the placer about the first word of each simple command only: redirect targets, arguments and the words after &&, ||, ; or | pass through, and a script handed to an interpreter is carried", () => {
    const asked: string[] = [];
    const placer = (abs: string): string | undefined => {
      asked.push(abs);
      return place(abs);
    };
    const before = {
      hooks: {
        Stop: [
          { hooks: [
            { type: "command", command: "~/.claude/hooks/remind > /dev/null 2>&1" },
            { type: "command", command: "~/.claude/hooks/remind >> /tmp/hooks.log" },
            { type: "command", command: "/usr/bin/env bash ~/x.sh" },
            { type: "command", command: "cd /opt/homebrew && ~/.codync/notify.sh; jq . /Users/dev/.claude/x.json | /usr/bin/tee /tmp/out || ~/.codync/notify.sh" },
            { type: "command", command: "FOO=1 ~/.claude/hooks/remind --flag /Users/dev/.claude/hooks/gone" },
            { type: "command", command: "node ~/.claude/hooks/gone" },
          ] },
        ],
      },
    };
    const out = CLAUDE_HOOKS.carry(text(before), HOME, placer);
    expect((JSON.parse(out.text) as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop[0]!.hooks.map(h => h.command)).toEqual([
      "/root/.claude-cfg/hooks/remind > /dev/null 2>&1",
      "/root/.claude-cfg/hooks/remind >> /tmp/hooks.log",
      "/usr/bin/env bash /root/x.sh",
      "cd /opt/homebrew && /root/.codync/notify.sh; jq . /Users/dev/.claude/x.json | /usr/bin/tee /tmp/out || /root/.codync/notify.sh",
      "FOO=1 /root/.claude-cfg/hooks/remind --flag /Users/dev/.claude/hooks/gone",
    ]);
    expect(out.left).toEqual(["~/.claude/hooks/gone"]);
    expect(out.carried).toEqual([
      { from: `${HOME}/.claude/hooks/remind`, to: "/root/.claude-cfg/hooks/remind" },
      { from: `${HOME}/x.sh`, to: "/root/x.sh" },
      { from: `${HOME}/.codync/notify.sh`, to: "/root/.codync/notify.sh" },
    ]);
    expect(asked).toEqual([`${HOME}/.claude/hooks/remind`, `${HOME}/.claude/hooks/remind`, `${HOME}/x.sh`, `${HOME}/.codync/notify.sh`, `${HOME}/.codync/notify.sh`, `${HOME}/.claude/hooks/remind`, `${HOME}/.claude/hooks/gone`]);
  });

  it("leaves a command that names no file, a prompt hook, a file that is not JSON or has no hooks object exactly as written", () => {
    const plain = '{"model": "opus", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "jq -r .tool_input.command"}, {"type": "prompt", "prompt": "check it"}]}]}}';
    expect(CLAUDE_HOOKS.carry(plain, HOME, place)).toEqual({ text: plain, carried: [], left: [] });
    for (const t of ['{"model": "opus"}', "{not json", '{"hooks": "none"}', "[]"]) expect(CLAUDE_HOOKS.carry(t, HOME, place)).toEqual({ text: t, carried: [], left: [] });
  });
});
