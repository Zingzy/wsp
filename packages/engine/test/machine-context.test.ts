// SPDX-License-Identifier: AGPL-3.0-only
// The machine context over fixtures: the probe's lines parsed, the facts
// folded, the document rendered, each agent's hook rendered or refused, and
// the fallbacks per agent, and the guest scripts run under this machine's
// shells against a temp root and a fake home.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALIAS_PROBES,
  BROWSER_SHIM_PATH,
  CONTEXT_AGENTS,
  CONTEXT_MARKER,
  agentFiles,
  applyMachineContext,
  boundedCommand,
  contextLine,
  contextPath,
  mergeFacts,
  parseProbe,
  probeCommand,
  renderMachineContext,
  renderShortContext,
  renderSkill,
  skillPath,
  writeCommand,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  type BuildFacts,
  type ContextAgent,
  type ContextProbe,
  type GuestFile,
} from "../src/machine-context.js";
import type { ImportResult } from "../src/golden.js";
import type { ExecResult, Machine } from "../src/machine.js";

const bash = promisify(execFile);

const FACTS: BuildFacts = {
  tools: [{ id: "tools/brew-cask/raycast", label: "raycast", note: "macOS app, no Linux build" }],
  agents: [{ id: "agents/zed", label: "Zed", note: "no installer known" }],
  files: [{ path: "~/.ssh/id_ed25519", note: "private key, never copied" }],
};

const PROBE_OUT = [
  "some rc noise",
  "WSP_CTX",
  "KERNEL 6.6.30",
  "DISK 20466256 11720704",
  "OVERLAY no",
  "HAS tmux",
  "HAS fish",
  "HAS brew",
  "HAS golden-path",
  "HAS wsp-open",
  "AGENT claude",
  "AGENT codex",
  "AGENT gemini",
  "AGENT opencode",
  "AGENT pi",
  "AGENT hermes",
  "SECRET OPENAI_API_KEY",
  "SECRET GH_TOKEN",
  "SHELL zsh",
  "ALIAS o open",
  "ALIAS rc code",
  `FACTS ${Buffer.from(JSON.stringify(FACTS)).toString("base64")}`,
  "WSP_CTX_END",
  "",
].join("\n");

function probeOf(over: Partial<ContextProbe> = {}): ContextProbe {
  return {
    kernel: "6.6.30",
    disk: { sizeBytes: 20466256 * 1024, freeBytes: 11720704 * 1024 },
    overlay: false,
    has: new Set(["tmux", "fish", "brew", "golden-path", "wsp-open"]),
    agents: [...CONTEXT_AGENTS],
    secrets: ["OPENAI_API_KEY", "GH_TOKEN"],
    shell: "zsh",
    aliases: [
      { name: "o", word: "open" },
      { name: "rc", word: "code" },
    ],
    conflicts: new Set(),
    ...over,
  };
}

const GOLDEN = { version: 3, createdAt: "2026-09-05T14:02:11.000Z", setupSha: "9f2a7c1d4e5b6a7f8091a2b3c4d5e6f7" };

describe("the probe", () => {
  it("parses every line kind between the markers and ignores the rest", () => {
    const probe = parseProbe(PROBE_OUT)!;
    expect(probe.kernel).toBe("6.6.30");
    expect(probe.disk).toEqual({ sizeBytes: 20466256 * 1024, freeBytes: 11720704 * 1024 });
    expect(probe.overlay).toBe(false);
    expect([...probe.has]).toEqual(["tmux", "fish", "brew", "golden-path", "wsp-open"]);
    expect(probe.agents).toEqual([...CONTEXT_AGENTS]);
    expect(probe.secrets).toEqual(["OPENAI_API_KEY", "GH_TOKEN"]);
    expect(probe.shell).toBe("zsh");
    expect(probe.aliases).toEqual([
      { name: "o", word: "open" },
      { name: "rc", word: "code" },
    ]);
    expect(probe.conflicts.size).toBe(0);
    expect(probe.facts).toEqual(FACTS);
  });

  it("is nothing without both markers, and tolerates empty reads", () => {
    expect(parseProbe("")).toBeUndefined();
    expect(parseProbe("WSP_CTX\nKERNEL 1\n")).toBeUndefined();
    const probe = parseProbe("WSP_CTX\nKERNEL \nDISK \nOVERLAY yes\nSHELL \nCONFLICT gemini\nCONFLICT nobody\nSECRET not a name\nWSP_CTX_END\n")!;
    expect(probe.kernel).toBeUndefined();
    expect(probe.disk).toBeUndefined();
    expect(probe.overlay).toBe(true);
    expect(probe.shell).toBe("bash");
    expect([...probe.conflicts]).toEqual(["gemini"]);
    expect(probe.secrets).toEqual([]);
    expect(probe.facts).toBeUndefined();
  });
});

describe("the facts", () => {
  const result = (over: Partial<ImportResult>): ImportResult => ({ recipeHash: "h", tools: [], agents: [], ...over });

  it("adds what did not install, drops what did, and keeps the rest", () => {
    const next = mergeFacts(FACTS, result({
      tools: [
        { id: "tools/brew/jq", label: "jq", outcome: "installed" },
        { id: "tools/brew/x", label: "x", outcome: "failed", note: "Error: no bottle" },
        { id: "tools/brew-cask/raycast", label: "Raycast", outcome: "skipped", note: "macOS app, no Linux build" },
      ],
      agents: [{ id: "agents/zed", name: "Zed", outcome: "installed" }],
      files: { bytes: 1, skipped: [{ id: "f", path: "~/.netrc", note: ".netrc is never copied; sign in on the machine" }] },
    }));
    expect(next.tools).toEqual([
      { id: "tools/brew-cask/raycast", label: "Raycast", note: "macOS app, no Linux build" },
      { id: "tools/brew/x", label: "x", note: "Error: no bottle" },
    ]);
    expect(next.agents).toEqual([]);
    expect(next.files).toEqual([
      { path: "~/.ssh/id_ed25519", note: "private key, never copied" },
      { path: "~/.netrc", note: ".netrc is never copied; sign in on the machine" },
    ]);
  });

  it("a removal takes its row out, and no result leaves the facts as they were", () => {
    const next = mergeFacts(FACTS, result({ removed: [{ what: "tool", id: "tools/brew-cask/raycast", label: "raycast", outcome: "removed" }, { what: "agent", id: "agents/zed", label: "Zed", outcome: "failed", note: "x" }] }));
    expect(next.tools).toEqual([]);
    expect(next.agents).toEqual(FACTS.agents);
    expect(mergeFacts(FACTS, undefined)).toEqual(FACTS);
    expect(mergeFacts(undefined, undefined)).toEqual({ tools: [], agents: [], files: [] });
  });
});

describe("the document", () => {
  it("renders a workspace on a sealed golden", () => {
    const doc = renderMachineContext({ workspace: { name: "task-1" }, golden: GOLDEN, probe: probeOf(), facts: FACTS });
    expect(doc.startsWith(`${CONTEXT_MARKER}\n`)).toBe(true);
    expect(doc).toContain("- Workspace: task-1.");
    expect(doc).toContain("- Golden: v3, sealed 2026-09-05, setup 9f2a7c1d4e5b.");
    expect(doc).toContain("- Disk: 19.5 GiB root disk, 11.2 GiB free when this file was written. wsp keeps 2.0 GiB free");
    expect(doc).toContain("- Every agent session starts in the thread's folder; terminal panes open in the home folder.");
    expect(doc).toContain("- Work in a folder: cd <dir> && <cmd> on one line, or absolute paths.");
    expect(doc).not.toContain("does not move the thread");
    expect(doc).not.toContain("persists across");
    const claude = renderMachineContext({ workspace: { name: "task-1" }, golden: GOLDEN, probe: probeOf(), facts: FACTS, agent: "claude" });
    expect(claude).toContain("- Every agent session starts in the thread's folder; terminal panes open in the home folder. A cd moves your own shell, which persists across your tool calls, not the thread's folder, and the files pane follows that shell's folder unless you pinned the panes.");
    expect(claude).toContain("- Work in a folder: cd <dir> in your shell and it stays there across your tool calls; the thread's folder does not move. Absolute paths work from anywhere.");
    expect(claude).not.toContain("open in the home folder.\n");
    expect(renderMachineContext({ workspace: { name: "task-1" }, golden: GOLDEN, probe: probeOf(), facts: FACTS, agent: "codex" })).toBe(doc);
    expect(doc).toContain("- Sign-ins go through wsp: BROWSER is /usr/local/bin/wsp-open");
    expect(doc).toContain("run wsp-open <url>");
    expect(doc).toContain("- Ask for a sign-in: run the tool's own login command");
    expect(doc).toContain("- Secrets set in /etc/profile.d/wsp-secrets.sh: OPENAI_API_KEY, GH_TOKEN.");
    expect(doc).toContain("- Tools that did not install: raycast (macOS app, no Linux build).");
    expect(doc).toContain("- Aliases whose command is not here: o runs open; rc runs code.");
    expect(doc).toContain("Containers do not run here: the kernel has no overlayfs, and Docker and Podman are not installed.");
    expect(doc).toContain("or tmux new -d -s <name> '<cmd>'");
    expect(doc).not.toMatch(/\u2014/);
    expect(doc).toMatchSnapshot();
  });

  it("renders a builder before the seal, with nothing missing and no tmux, brew or fish", () => {
    const probe = probeOf({ has: new Set(), overlay: true, secrets: [], aliases: [], disk: undefined, kernel: undefined });
    const doc = renderMachineContext({ probe, facts: { tools: [], agents: [], files: [] } });
    expect(doc).toContain("- This machine is a golden builder, not a workspace yet.");
    expect(doc).toContain("- Golden: not sealed yet.");
    expect(doc).toContain("- Disk: size unknown when this file was written.");
    expect(doc).toContain("- Secrets set in /etc/profile.d/wsp-secrets.sh: none.");
    expect(doc).toContain("- Tools that did not install: none.");
    expect(doc).toContain("- Aliases whose command is not here: none.");
    expect(doc).toContain("- Docker and Podman are not installed.");
    expect(doc).not.toContain("overlayfs");
    expect(doc).not.toContain("tmux");
    expect(doc).not.toContain("Homebrew");
    expect(doc).not.toContain("wsp-secrets.fish");
    expect(doc).not.toContain("wsp-open");
    expect(doc).not.toContain("sign-in");
    expect(doc).not.toContain("Sign-ins");
    expect(doc).toContain("- Linux, user root, home /root.");
    expect(doc).toMatchSnapshot();
  });

  it("the short always-loaded text carries the facts an agent must not get wrong and points at the skill", () => {
    const short = renderShortContext({ workspace: { name: "task-1" }, golden: GOLDEN, probe: probeOf(), facts: FACTS });
    expect(short.startsWith(`${CONTEXT_MARKER}\n`)).toBe(true);
    expect(short).toContain("The wsp-machine skill has the full picture");
    expect(short).toContain("dies when that tool call ends. Detach it: setsid nohup <cmd> > /tmp/<name>.log 2>&1 < /dev/null &, or tmux new -d -s <name> '<cmd>'.");
    expect(short).toContain("- Every agent session starts in the thread's folder; terminal panes open in the home folder.");
    expect(short).not.toContain("lasts for that command only");
    expect(short).not.toContain("persists across");
    expect(renderShortContext({ workspace: { name: "task-1" }, golden: GOLDEN, probe: probeOf(), facts: FACTS, agent: "claude" })).toContain("- Every agent session starts in the thread's folder; terminal panes open in the home folder. A cd moves your own shell, which persists across your tool calls, not the thread's folder, and the files pane follows that shell's folder unless you pinned the panes.");
    expect(renderShortContext({ workspace: { name: "task-1" }, golden: GOLDEN, probe: probeOf(), facts: FACTS, agent: "gemini" })).toBe(short);
    expect(short).toContain("- Sign-ins go through wsp: run the tool's own login command");
    expect(short).toContain("bind 0.0.0.0, not 127.0.0.1");
    expect(short).toContain("- Containers do not run here: the kernel has no overlayfs, and Docker and Podman are not installed.");
    expect(short).toContain("- Disk: 19.5 GiB root disk, 11.2 GiB free when this file was written. wsp keeps 2.0 GiB free.");
    expect(short).toContain("- Secrets are exported by /etc/profile.d/wsp-secrets.sh. Use them by name ($NAME); never print, log or commit a value");
    expect(short).not.toContain("OPENAI_API_KEY");
    expect(short).not.toContain("raycast");
    expect(short.split("\n").length).toBeLessThan(16);
    expect(short).toMatchSnapshot();
    const bare = renderShortContext({ probe: probeOf({ has: new Set(), overlay: true, disk: undefined }), facts: FACTS });
    expect(bare).not.toContain("tmux");
    expect(bare).toContain("- Docker and Podman are not installed.");
    expect(bare).toContain("- Disk: size unknown when this file was written. wsp keeps 2.0 GiB free.");
    expect(bare).not.toContain("Sign-ins");
  });

  it("the skill is the full document under a name and a one-line description every agent's parser reads", () => {
    const doc = renderMachineContext({ workspace: { name: "task-1" }, golden: GOLDEN, probe: probeOf(), facts: FACTS });
    const skill = renderSkill(doc);
    expect(skill).toBe(`---\nname: wsp-machine\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${doc}`);
    expect(SKILL_DESCRIPTION.length).toBeLessThan(1024);
    expect(SKILL_DESCRIPTION).not.toMatch(/[\n:"#\u2014]/);
    expect(SKILL_NAME).toMatch(/^[a-z0-9-]{1,64}$/);
  });
});

describe("each agent's hooks", () => {
  const input = { workspace: { name: "task-1" }, golden: GOLDEN, probe: probeOf(), facts: FACTS };
  const short = renderShortContext(input);
  const skill = renderSkill(renderMachineContext(input));
  const shortFor = (agent: ContextAgent) => renderShortContext({ ...input, agent });
  const skillFor = (agent: ContextAgent) => renderSkill(renderMachineContext({ ...input, agent }));
  const paths = (out: { files: GuestFile[] }) => out.files.map(f => f.path);
  const content = (out: { files: GuestFile[] }, path: string) => out.files.find(f => f.path === path)!.content;

  it("writes the short text through each always-loaded hook and the skill into each global skills directory", () => {
    const out = Object.fromEntries(CONTEXT_AGENTS.map(a => [a, agentFiles(a, shortFor(a), skillFor(a), probeOf())])) as Record<string, ReturnType<typeof agentFiles>>;
    for (const a of CONTEXT_AGENTS) expect(out[a]!.outcome).toBe("written");
    expect(paths(out["claude"]!)).toEqual(["/etc/claude-code/CLAUDE.md", "/etc/claude-code/.claude/skills/wsp-machine/SKILL.md"]);
    expect(paths(out["codex"]!)).toEqual(["/etc/codex/requirements.toml", "/etc/codex/skills/wsp-machine/SKILL.md"]);
    expect(paths(out["gemini"]!)).toEqual(["/etc/gemini-cli/system-defaults.json", "/root/.gemini/WSP-MACHINE.md", "/root/.gemini/skills/wsp-machine/SKILL.md"]);
    expect(paths(out["opencode"]!)).toEqual(["/etc/opencode/opencode.json", "/root/.config/opencode/skills/wsp-machine/SKILL.md"]);
    expect(paths(out["pi"]!)).toEqual(["/root/.pi/agent/APPEND_SYSTEM.md", "/root/.pi/agent/skills/wsp-machine/SKILL.md"]);
    expect(paths(out["hermes"]!)).toEqual(["/etc/profile.d/wsp-machine.sh", "/etc/fish/conf.d/wsp-machine.fish", "/root/.hermes/skills/wsp-machine/SKILL.md"]);
    for (const a of CONTEXT_AGENTS) {
      const o = out[a]!;
      for (const f of o.files) expect(f.mode).toBe(0o644);
      expect(o.skill).toBe(o.files.at(-1)!.path);
      expect(o.files.at(-1)!.content).toBe(a === "claude" ? skillFor("claude") : skill);
      expect(o.path).toBe(o.files[0]!.path === "/etc/gemini-cli/system-defaults.json" ? "/root/.gemini/WSP-MACHINE.md" : o.files[0]!.path);
      expect(o.files.map(f => `${f.path}\n${f.content}`).join("\n----\n")).toMatchSnapshot(a);
    }
    expect(content(out["claude"]!, "/etc/claude-code/CLAUDE.md")).toBe(shortFor("claude"));
    expect(content(out["claude"]!, "/etc/claude-code/CLAUDE.md")).toContain("persists across your tool calls");
    expect(content(out["gemini"]!, "/root/.gemini/WSP-MACHINE.md")).toBe(short);
    expect(content(out["pi"]!, "/root/.pi/agent/APPEND_SYSTEM.md")).toBe(short);
  });

  it("the Codex string is a literal that TOML reads back as the short text, under the additive requirements key, and falls back when the text would end it", () => {
    const toml = content(agentFiles("codex", short, skill, probeOf()), "/etc/codex/requirements.toml");
    const m = /^# [^\n]*\nadditional_developer_instructions = '''\n([\s\S]*)'''\n$/.exec(toml);
    expect(m?.[1]).toBe(short);
    expect(toml).not.toContain("\ndeveloper_instructions");
    const odd = content(agentFiles("codex", "a '''b", skill, probeOf()), "/etc/codex/requirements.toml");
    expect(odd).toContain(`additional_developer_instructions = ${JSON.stringify("a '''b")}`);
  });

  it("Gemini and OpenCode get JSON that names ours and nothing of the person's", () => {
    expect(JSON.parse(content(agentFiles("gemini", short, skill, probeOf()), "/etc/gemini-cli/system-defaults.json"))).toEqual({ context: { fileName: ["GEMINI.md", "WSP-MACHINE.md"] } });
    expect(JSON.parse(content(agentFiles("opencode", short, skill, probeOf()), "/etc/opencode/opencode.json"))).toEqual({ instructions: ["/etc/wsp/machine-context.md"] });
  });

  it("Hermes reads the short text into its hint, through fish too only when fish is there", () => {
    const out = agentFiles("hermes", short, skill, probeOf({ has: new Set() }));
    expect(paths(out)).toEqual(["/etc/profile.d/wsp-machine.sh", "/root/.hermes/skills/wsp-machine/SKILL.md"]);
    expect(out.files[0]!.content).toContain('export HERMES_ENVIRONMENT_HINT="$(cat /etc/wsp/machine-context.md)"');
  });

  it("falls back when the person's own file sets the key: a Gemini extension, a Pi extension, nothing for Hermes; Codex is additive and never falls back", () => {
    const all = probeOf({ conflicts: new Set(CONTEXT_AGENTS) });
    const codex = agentFiles("codex", short, skill, all);
    expect(codex.outcome).toBe("written");
    expect(paths(codex)).toEqual(["/etc/codex/requirements.toml", "/etc/codex/skills/wsp-machine/SKILL.md"]);
    expect(codex.files.map(f => f.path)).not.toContain("/etc/codex/config.toml");

    const gemini = agentFiles("gemini", short, skill, all);
    expect(gemini.outcome).toBe("fallback");
    expect(gemini.path).toBe("/root/.gemini/extensions/wsp-machine");
    expect(gemini.note).toBe("~/.gemini/settings.json sets context.fileName");
    expect(paths(gemini)).toEqual(["/root/.gemini/extensions/wsp-machine/gemini-extension.json", "/root/.gemini/extensions/wsp-machine/WSP-MACHINE.md", "/root/.gemini/skills/wsp-machine/SKILL.md"]);
    expect(JSON.parse(content(gemini, "/root/.gemini/extensions/wsp-machine/gemini-extension.json"))).toEqual({ name: "wsp-machine", version: "1.0.0", contextFileName: "WSP-MACHINE.md" });
    expect(content(gemini, "/root/.gemini/extensions/wsp-machine/WSP-MACHINE.md")).toBe(short);
    expect(paths(gemini)).not.toContain("/etc/gemini-cli/system-defaults.json");

    const pi = agentFiles("pi", short, skill, all);
    expect(pi.outcome).toBe("fallback");
    expect(pi.path).toBe("/root/.pi/agent/extensions/wsp-machine.ts");
    expect(pi.note).toBe("~/.pi/agent/APPEND_SYSTEM.md already exists");
    expect(paths(pi)).toEqual(["/root/.pi/agent/extensions/wsp-machine.ts", "/root/.pi/agent/skills/wsp-machine/SKILL.md"]);
    const ext = content(pi, "/root/.pi/agent/extensions/wsp-machine.ts");
    expect(ext).toContain('pi.on("before_agent_start"');
    expect(ext).toContain('readFileSync("/etc/wsp/machine-context.md", "utf8")');
    expect(ext).toMatchSnapshot();

    const hermes = agentFiles("hermes", short, skill, all);
    expect(hermes.outcome).toBe("not-loaded");
    expect(hermes.note).toBe("~/.hermes/config.yaml sets agent.environment_hint");
    expect(paths(hermes)).toEqual(["/root/.hermes/skills/wsp-machine/SKILL.md"]);

    expect(agentFiles("claude", short, skill, all).outcome).toBe("written");
    expect(agentFiles("opencode", short, skill, all).outcome).toBe("written");

    expect(contextLine({ agent: "claude", outcome: "written", path: "/etc/claude-code/CLAUDE.md", skill: "/etc/claude-code/.claude/skills/wsp-machine/SKILL.md" })).toBe("context.claude: /etc/claude-code/CLAUDE.md; skill /etc/claude-code/.claude/skills/wsp-machine/SKILL.md");
    expect(contextLine({ agent: "gemini", outcome: "fallback", path: gemini.path!, note: gemini.note!, skill: gemini.skill })).toBe("context.gemini: fallback /root/.gemini/extensions/wsp-machine, ~/.gemini/settings.json sets context.fileName; skill /root/.gemini/skills/wsp-machine/SKILL.md");
    expect(contextLine({ agent: "hermes", outcome: "not-loaded", note: hermes.note!, skill: hermes.skill })).toBe("context.hermes: not loaded, ~/.hermes/config.yaml sets agent.environment_hint; only the wsp-machine skill's description is in the prompt; skill /root/.hermes/skills/wsp-machine/SKILL.md");
  });

  it("never names the two paths that would replace a file of the person's", () => {
    for (const a of CONTEXT_AGENTS) {
      for (const probe of [probeOf(), probeOf({ conflicts: new Set(CONTEXT_AGENTS) })]) {
        for (const f of agentFiles(a, short, skill, probe).files) expect(f.path).not.toMatch(/\.codex\/AGENTS\.override\.md$|\.config\/opencode\/AGENTS\.md$/);
      }
    }
  });
});

describe("the guest scripts on a local bash", () => {
  const tmps: string[] = [];
  const fakeGuest = () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-ctx-"));
    tmps.push(root);
    const roots = { etc: join(root, "etc"), home: join(root, "home") };
    mkdirSync(roots.etc, { recursive: true });
    mkdirSync(roots.home, { recursive: true });
    return roots;
  };
  afterEach(() => {
    for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
  });
  const run = async (script: string): Promise<ExecResult> => {
    try {
      const { stdout, stderr } = await bash("bash", ["-c", script], { maxBuffer: 4 * 1024 * 1024 });
      return { exitCode: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { exitCode: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };

  it("lands every file with its mode, each text once and copied to the hooks that share it", async () => {
    const roots = fakeGuest();
    const input = { workspace: { name: "task-1" }, golden: GOLDEN, probe: probeOf(), facts: FACTS };
    const short = renderShortContext(input);
    const skill = renderSkill(renderMachineContext(input));
    const files: GuestFile[] = [{ path: contextPath(roots), mode: 0o644, content: short }, { path: skillPath(roots), mode: 0o644, content: skill }];
    for (const a of CONTEXT_AGENTS) files.push(...agentFiles(a, short, skill, probeOf(), roots).files);
    const cmd = writeCommand(files);
    expect(cmd.match(/base64 --decode/g)).toHaveLength(7);
    expect(cmd.match(/^install -m 644 /gm)).toHaveLength(9);
    const res = await run(cmd);
    expect(res.exitCode, res.stderr).toBe(0);
    for (const f of files) {
      expect(readFileSync(f.path, "utf8")).toBe(f.content);
      expect(statSync(f.path).mode & 0o777).toBe(0o644);
    }
    expect(readFileSync(join(roots.etc, "claude-code/CLAUDE.md"), "utf8")).toBe(short);
    expect(readFileSync(join(roots.home, ".hermes/skills/wsp-machine/SKILL.md"), "utf8")).toBe(skill);
  }, 30_000);

  it("the probe prints its markers, the kernel and the disk, and names each hook the person's file claims", async () => {
    const roots = fakeGuest();
    let probe = parseProbe((await run(probeCommand(roots))).stdout)!;
    expect(probe).toBeDefined();
    expect(probe.kernel).toBeTruthy();
    expect(probe.disk?.sizeBytes).toBeGreaterThan(0);
    expect(probe.has.has("wsp-open")).toBe(existsSync(BROWSER_SHIM_PATH));
    expect(probe.conflicts.size).toBe(0);
    expect(probe.facts).toBeUndefined();

    mkdirSync(join(roots.home, ".codex"), { recursive: true });
    writeFileSync(join(roots.home, ".codex/config.toml"), 'model = "x"\n# developer_instructions = "commented"\n[mcp_servers.a]\ndeveloper_instructions = "in a table"\n');
    mkdirSync(join(roots.home, ".gemini"), { recursive: true });
    writeFileSync(join(roots.home, ".gemini/settings.json"), '{\n  // a comment\n  "context": { "fileName": "CUSTOM.md" }\n}\n');
    mkdirSync(join(roots.home, ".pi/agent"), { recursive: true });
    writeFileSync(join(roots.home, ".pi/agent/APPEND_SYSTEM.md"), `${CONTEXT_MARKER}\nours\n`);
    mkdirSync(join(roots.home, ".hermes"), { recursive: true });
    writeFileSync(join(roots.home, ".hermes/config.yaml"), 'model:\n  environment_hint: "not the agent block"\nagent:\n  environment_hint: ""\n');
    mkdirSync(join(roots.etc, "wsp"), { recursive: true });
    writeFileSync(join(roots.etc, "wsp/machine-context.json"), JSON.stringify(FACTS));
    mkdirSync(join(roots.etc, "profile.d"), { recursive: true });
    writeFileSync(join(roots.etc, "profile.d/wsp-secrets.sh"), "export GH_TOKEN='sk-ant-x'\nexport BAD-NAME='x'\n");
    probe = parseProbe((await run(probeCommand(roots))).stdout)!;
    expect([...probe.conflicts]).toEqual(["gemini"]);
    expect(probe.facts).toEqual(FACTS);
    expect(probe.secrets).toEqual(["GH_TOKEN"]);

    writeFileSync(join(roots.home, ".codex/config.toml"), 'developer_instructions = """\ntheirs\n"""\n');
    writeFileSync(join(roots.home, ".pi/agent/APPEND_SYSTEM.md"), "the person's own\n");
    writeFileSync(join(roots.home, ".hermes/config.yaml"), "agent:\n  model: x\n  environment_hint: 'set by them'\n");
    writeFileSync(join(roots.home, ".gemini/settings.json"), '{ "theme": "dark" }\n');
    probe = parseProbe((await run(probeCommand(roots))).stdout)!;
    expect([...probe.conflicts].sort()).toEqual(["hermes", "pi"]);
  }, 30_000);

  const shellOf = (name: string): string | undefined => ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map(d => join(d, name)).find(p => existsSync(p));
  const ALIASES = [
    ["g", "git"],
    ["ll", "ls -la"],
    ["o", "open-not-here"],
    ["s", "sudo not-here-either"],
    ["e", "FOO=1 not-here-third"],
    ["q", "\\not-here-fourth --flag"],
    ["kca", "_kca(){ kubectl \"$@\" --all-namespaces; unset -f _kca; }; _kca"],
    ["grp", "{ grep -rn . ; }"],
    ["abs", "/Applications/Nowhere.app/Contents/MacOS/nowhere"],
  ] as const;
  const MISSING = [
    { name: "e", word: "not-here-third" },
    { name: "o", word: "open-not-here" },
    { name: "q", word: "not-here-fourth" },
    { name: "s", word: "not-here-either" },
  ];
  /** The aliases as a POSIX rc file, plus one whose body starts on a new line, the shape of oh-my-zsh's deprecation wrappers. */
  const SH_RC = `${ALIASES.map(([k, v]) => `alias ${k}='${v.replace(/'/g, "'\\''")}'`).join("\n")}\nalias cb=$'\\n  echo deprecated >&2\\n  git_current_branch'\n`;
  const aliasLines = (stdout: string) => parseProbe(`WSP_CTX\n${stdout}WSP_CTX_END\n`)!.aliases;
  const runIn = async (shell: string, args: string[], env: Record<string, string>): Promise<string> => {
    const { stdout } = await bash(shell, args, { env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  };

  it.skipIf(shellOf("zsh") === undefined)("the zsh alias probe names only aliases whose first word is a missing command, run on this machine's zsh", async () => {
    const roots = fakeGuest();
    writeFileSync(join(roots.home, ".zshrc"), SH_RC);
    writeFileSync(join(roots.home, ".zshenv"), "");
    const out = await runIn(shellOf("zsh")!, ["-lic", ALIAS_PROBES.zsh!], { ZDOTDIR: roots.home, HOME: roots.home });
    expect(aliasLines(out)).toEqual(MISSING);
  }, 30_000);

  it.skipIf(shellOf("bash") === undefined)("the bash alias probe does the same on this machine's bash, from a fake home's profile", async () => {
    const roots = fakeGuest();
    writeFileSync(join(roots.home, ".bash_profile"), SH_RC);
    const out = await runIn(shellOf("bash")!, ["-lic", ALIAS_PROBES.bash!], { HOME: roots.home });
    expect(aliasLines(out)).toEqual(MISSING);
  }, 30_000);

  it.skipIf(shellOf("fish") === undefined)("the fish alias probe does the same on this machine's fish, from a fake config dir", async () => {
    const roots = fakeGuest();
    mkdirSync(join(roots.home, ".config/fish"), { recursive: true });
    writeFileSync(join(roots.home, ".config/fish/config.fish"), `${ALIASES.filter(([, v]) => !v.includes("{")).map(([k, v]) => `alias ${k} '${v.replace(/'/g, "\\'")}'`).join("\n")}\n`);
    const out = await runIn(shellOf("fish")!, ["-lic", ALIAS_PROBES.fish!], { HOME: roots.home, XDG_CONFIG_HOME: join(roots.home, ".config") });
    expect(aliasLines(out)).toEqual(MISSING);
  }, 30_000);

  it("a bounded command is killed at its bound and the script goes on", async () => {
    const started = Date.now();
    const res = await run(`${boundedCommand(1, "sleep 20")}\necho after`);
    expect(res.stdout).toBe("after\n");
    expect(Date.now() - started).toBeLessThan(6_000);
    expect((await run(`${boundedCommand(5, "echo quick")}\necho after`)).stdout).toBe("quick\nafter\n");
  }, 30_000);
});

describe("applyMachineContext on a fake guest", () => {
  function machine(answer: (cmd: string) => ExecResult | Promise<ExecResult>) {
    const execs: string[] = [];
    const m = {
      id: "m1",
      kind: "sandbox",
      async exec(cmd: string) {
        execs.push(cmd);
        return answer(cmd);
      },
    } as unknown as Machine;
    return { m, execs };
  }
  const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
  const decoded = (write: string, path: string): string => {
    const m = new RegExp(`printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 --decode > '${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}'`).exec(write);
    return Buffer.from(m?.[1] ?? "", "base64").toString("utf8");
  };

  it("probes, renders with the facts folded in, writes every hook and skill, and records each agent", async () => {
    const { m, execs } = machine(cmd => (cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: PROBE_OUT, stderr: "" } : ok));
    const result: ImportResult = { recipeHash: "h", tools: [{ id: "tools/brew/x", label: "x", outcome: "failed", note: "boom" }], agents: [] };
    const out = await applyMachineContext(m, { workspace: { name: "task-1" }, golden: GOLDEN, result });
    expect(out.failure).toBeUndefined();
    expect(out.context).toEqual(CONTEXT_AGENTS.map(agent => ({ agent, outcome: "written", path: expect.any(String), skill: expect.stringMatching(/\/wsp-machine\/SKILL\.md$/) })));
    expect(out.summary).toBe("written for Claude Code, Codex, Gemini CLI, OpenCode, Pi, Hermes Agent");
    expect(execs).toHaveLength(2);
    const short = decoded(execs[1]!, "/etc/wsp/machine-context.md");
    expect(short).toContain("The wsp-machine skill has the full picture");
    expect(short).toContain("terminal panes open in the home folder.\n");
    expect(short).not.toContain("persists across");
    const skill = decoded(execs[1]!, "/etc/wsp/skills/wsp-machine/SKILL.md");
    expect(skill).toContain("- Workspace: task-1.");
    expect(skill).not.toContain("persists across");
    expect(decoded(execs[1]!, "/etc/claude-code/CLAUDE.md")).toContain("persists across your tool calls");
    expect(decoded(execs[1]!, "/etc/claude-code/.claude/skills/wsp-machine/SKILL.md")).toContain("persists across your tool calls");
    expect(execs[1]).toContain("install -m 644 '/etc/wsp/machine-context.md' '/root/.gemini/WSP-MACHINE.md'");
    expect(execs[1]).toContain("install -m 644 '/etc/wsp/skills/wsp-machine/SKILL.md' '/etc/codex/skills/wsp-machine/SKILL.md'");
    expect(skill).toContain("- Tools that did not install: raycast (macOS app, no Linux build); x (boom).");
    for (const path of ["/etc/wsp/machine-context.json", "/etc/claude-code/CLAUDE.md", "/etc/claude-code/.claude/skills/wsp-machine/SKILL.md", "/etc/codex/requirements.toml", "/etc/codex/skills/wsp-machine/SKILL.md", "/root/.gemini/WSP-MACHINE.md", "/root/.gemini/skills/wsp-machine/SKILL.md", "/etc/opencode/opencode.json", "/root/.config/opencode/skills/wsp-machine/SKILL.md", "/root/.pi/agent/APPEND_SYSTEM.md", "/root/.pi/agent/skills/wsp-machine/SKILL.md", "/etc/profile.d/wsp-machine.sh", "/root/.hermes/skills/wsp-machine/SKILL.md"]) {
      expect(execs[1]).toContain(`'${path}'`);
    }
  });

  it("takes the fallback for a claimed hook, the skill alone for Hermes, and skips agents that are not installed", async () => {
    const stdout = "WSP_CTX\nAGENT claude\nAGENT gemini\nAGENT hermes\nCONFLICT gemini\nCONFLICT hermes\nWSP_CTX_END\n";
    const { m, execs } = machine(cmd => (cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout, stderr: "" } : ok));
    const out = await applyMachineContext(m);
    expect(out.context).toEqual([
      { agent: "claude", outcome: "written", path: "/etc/claude-code/CLAUDE.md", skill: "/etc/claude-code/.claude/skills/wsp-machine/SKILL.md" },
      { agent: "gemini", outcome: "fallback", path: "/root/.gemini/extensions/wsp-machine", note: "~/.gemini/settings.json sets context.fileName", skill: "/root/.gemini/skills/wsp-machine/SKILL.md" },
      { agent: "hermes", outcome: "not-loaded", note: "~/.hermes/config.yaml sets agent.environment_hint", skill: "/root/.hermes/skills/wsp-machine/SKILL.md" },
    ]);
    expect(out.summary).toBe("written for Claude Code; Gemini CLI by its fallback (~/.gemini/settings.json sets context.fileName); Hermes Agent not loaded (~/.hermes/config.yaml sets agent.environment_hint), skill only");
    expect(execs[1]).not.toContain("/etc/gemini-cli/system-defaults.json");
    expect(execs[1]).toContain("'/root/.gemini/extensions/wsp-machine/gemini-extension.json'");
    expect(execs[1]).not.toContain("/etc/profile.d/wsp-machine.sh");
    expect(execs[1]).toContain("'/root/.hermes/skills/wsp-machine/SKILL.md'");
    expect(execs[1]).not.toContain("/etc/opencode/");
    expect(decoded(execs[1]!, "/etc/wsp/skills/wsp-machine/SKILL.md")).toContain("- This machine is a golden builder, not a workspace yet.");
  });

  it("reports a guest that does not answer and writes nothing", async () => {
    const silent = machine(() => ok);
    expect(await applyMachineContext(silent.m)).toEqual({ context: [], summary: "not written (probe answered exit 0 without its markers)", failure: "probe answered exit 0 without its markers" });
    expect(silent.execs).toHaveLength(1);
    const gone = machine(() => Promise.reject(new Error("machine paused")));
    expect((await applyMachineContext(gone.m)).failure).toBe("probe failed: machine paused");
    const refused = machine(cmd => (cmd.includes("echo WSP_CTX") ? { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "bash: line 3: /etc/wsp: Read-only file system\n" }));
    const out = await applyMachineContext(refused.m);
    expect(out.failure).toBe("write exited 1: bash: line 3: /etc/wsp: Read-only file system");
    expect(out.context).toEqual([]);
  });
});
