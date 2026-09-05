// SPDX-License-Identifier: AGPL-3.0-only
import type { ManifestEntry, ShellAlias } from "@wsp/collect";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { GUARD_PATH, GUARD_SOURCE_COMMENT, GUARD_SOURCE_LINE, aliasFate, aliasGuardFor, aliasLines } from "../src/init-aliases.js";

const tool = (id: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({ rung: "tools", id, label: id.slice(id.lastIndexOf("/") + 1), group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes", ...over });
const zshrc = (aliases: ShellAlias[], over: Partial<ManifestEntry> = {}): ManifestEntry => ({ rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 10, default: "bring", aliases, ...over });
const a = (name: string, runs: string, tool?: string, kind: ShellAlias["kind"] = "alias"): ShellAlias => ({ name, runs, kind, ...(tool !== undefined ? { tool } : {}) });

const TOOLS = [
  tool("tools/brew/eza"),
  tool("tools/brew/bat"),
  tool("tools/brew/llvm@21", { default: "skip" }),
  tool("tools/brew/glow", { default: "skip", reason: "no Linux bottle" }),
  tool("tools/brew/diskbloom", { default: "skip", linux: "unknown" }),
  tool("tools/cli/kubectl", { default: "skip" }),
];
const NONE = new Map();

describe("aliasFate", () => {
  it("a ticked tool is coming; an unticked one says why, in the tools screen's words; no row is unknown", () => {
    const ticks = new Set(["tools/brew/bat"]);
    expect(aliasFate(a("cat", "bat", "tools/brew/bat"), TOOLS, ticks, NONE)).toEqual({ fate: "coming" });
    expect(aliasFate(a("ls", "eza", "tools/brew/eza"), TOOLS, ticks, NONE)).toEqual({ fate: "missing", why: "unticked, tick to bring" });
    expect(aliasFate(a("cc", "clang", "tools/brew/llvm@21"), TOOLS, ticks, NONE)).toEqual({ fate: "missing", why: "skipped: 2.5 GB, tick to bring" });
    expect(aliasFate(a("md", "glow", "tools/brew/glow", "suffix"), TOOLS, ticks, NONE)).toEqual({ fate: "missing", why: "no Linux bottle" });
    expect(aliasFate(a("db", "diskbloom", "tools/brew/diskbloom"), TOOLS, ticks, NONE)).toEqual({ fate: "missing", why: "Linux build unknown, tick to try" });
    expect(aliasFate(a("o", "open"), TOOLS, ticks, NONE)).toEqual({ fate: "unknown" });
    expect(aliasFate(a("x", "gone", "tools/brew/gone"), TOOLS, ticks, NONE)).toEqual({ fate: "unknown" });
  });
});

describe("aliasLines", () => {
  const row = zshrc([
    a("ls", "eza", "tools/brew/eza"),
    a("ll", "eza", "tools/brew/eza"),
    a("la", "eza", "tools/brew/eza"),
    a("lt", "eza", "tools/brew/eza"),
    a("lsd", "eza", "tools/brew/eza"),
    a("cat", "bat", "tools/brew/bat"),
    a("k", "kubectl", "tools/cli/kubectl"),
    a("kx", "kubectl", "tools/cli/kubectl", "function"),
    a("y", "yazi", undefined, "function"),
    a("o", "open"),
    a("md", "glow", "tools/brew/glow", "suffix"),
  ]);

  it("one line per command, aliases whose tool is not coming first and the largest group first; a coming tool says nothing", () => {
    expect(aliasLines(row, [row, ...TOOLS], new Set(["tools/brew/bat"]), NONE, 10)).toEqual([
      "aliases ls, ll, la and 2 more point at eza, which is not coming (unticked, tick to bring)",
      "alias k and function kx point at kubectl, which is not coming (unticked, tick to bring)",
      "alias md points at glow, which is not coming (no Linux bottle)",
      "alias o points at open, which nothing here installs (kept on the machine only if it has open)",
      "function y points at yazi, which nothing here installs (kept on the machine only if it has yazi)",
    ]);
  });

  it("the lines are capped, the rest named by command; a row with nothing to say gets no lines", () => {
    const lines = aliasLines(row, [row, ...TOOLS], new Set(), NONE, 3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^aliases ls, ll, la and 2 more point at eza/);
    expect(lines[1]).toMatch(/^alias k and function kx point at kubectl/);
    expect(lines[2]).toBe("4 more: bat, glow, open, yazi");
    expect(aliasLines(zshrc([a("cat", "bat", "tools/brew/bat")]), TOOLS, new Set(["tools/brew/bat"]), NONE, 3)).toEqual([]);
    expect(aliasLines(tool("tools/brew/eza"), TOOLS, new Set(), NONE, 3)).toEqual([]);
  });

  it("a row whose listing came from the rc files says so first, outside the cap", () => {
    const files = zshrc([a("ls", "eza", "tools/brew/eza"), a("cat", "bat", "tools/brew/bat"), a("o", "open")], { aliasesFrom: "files" });
    expect(aliasLines(files, [files, ...TOOLS], new Set(), NONE, 2)).toEqual([
      "aliases read from the rc files: the shell listed none or did not finish in time",
      "alias cat points at bat, which is not coming (unticked, tick to bring)",
      "2 more: eza, open",
    ]);
    expect(aliasLines(zshrc([], { aliasesFrom: "files" }), TOOLS, new Set(), NONE, 3)).toEqual(["aliases read from the rc files: the shell listed none or did not finish in time"]);
    expect(aliasLines(zshrc([a("o", "open")], { aliasesFrom: "shell" }), TOOLS, new Set(), NONE, 3)).toEqual(["alias o points at open, which nothing here installs (kept on the machine only if it has open)"]);
  });

  it("up to four names are listed in full", () => {
    const four = zshrc([a("ls", "eza", "tools/brew/eza"), a("ll", "eza", "tools/brew/eza"), a("la", "eza", "tools/brew/eza"), a("lt", "eza", "tools/brew/eza")]);
    expect(aliasLines(four, [four, ...TOOLS], new Set(), NONE, 3)).toEqual(["aliases ls, ll, la and lt point at eza, which is not coming (unticked, tick to bring)"]);
  });
});

describe("aliasGuardFor", () => {
  const rows = (ticked: string[], aliases: ShellAlias[], shellTicked = true): ManifestEntry[] => [zshrc(aliases, { bring: shellTicked }), ...TOOLS.map(t => ({ ...t, bring: ticked.includes(t.id) }))];

  it("a PATH-only lookup per shell, one line per command with every alias behind it quoted after --, a comment naming them and why; a coming tool and a function get no line", () => {
    const guard = aliasGuardFor(rows(["tools/brew/bat"], [a("ls", "eza", "tools/brew/eza"), a("ll", "eza", "tools/brew/eza"), a("cat", "bat", "tools/brew/bat"), a("k", "kubectl", "tools/cli/kubectl"), a("kx", "kubectl", "tools/cli/kubectl", "function"), a("y", "yazi", undefined, "function"), a("o", "open"), a("L", "bat", "tools/brew/bat"), a("md", "glow", "tools/brew/glow", "suffix"), a("-", "open")]));
    expect(guard?.rc).toBe(".zshrc");
    expect(guard?.text.split("\n").filter(l => l !== "" && !l.startsWith("#"))).toEqual([
      'if [ -n "${ZSH_VERSION-}" ]; then _wsp_on_path() { whence -p -- "$1" >/dev/null 2>&1; }; else _wsp_on_path() { type -P -- "$1" >/dev/null 2>&1; }; fi',
      "_wsp_on_path 'eza' || unalias -- 'ls' 'll' 2>/dev/null",
      "_wsp_on_path 'kubectl' || unalias -- 'k' 2>/dev/null",
      "_wsp_on_path 'glow' || { [ -n \"${ZSH_VERSION-}\" ] && unalias -s -- 'md' 2>/dev/null; }",
      "_wsp_on_path 'open' || unalias -- 'o' '-' 2>/dev/null",
      "unset -f _wsp_on_path",
    ]);
    expect(guard?.text).toContain("# ls and ll point at eza: not coming (unticked, tick to bring)");
    expect(guard?.text).toContain("# k points at kubectl: not coming (unticked, tick to bring)");
    expect(guard?.text).toContain("# o and - point at open: nothing here installs it");
    expect(guard?.text).not.toContain("bat");
    expect(guard?.text).not.toContain("yazi");
    expect(guard?.text).not.toContain("command -v");
  });

  it("nothing when the shell row is unticked, has no aliases, or every alias's tool is coming", () => {
    expect(aliasGuardFor(rows(["tools/brew/eza"], [a("ls", "eza", "tools/brew/eza")], false))).toBeUndefined();
    expect(aliasGuardFor(rows([], []))).toBeUndefined();
    expect(aliasGuardFor(rows(["tools/brew/eza"], [a("ls", "eza", "tools/brew/eza")]))).toBeUndefined();
    expect(aliasGuardFor(rows([], [a("y", "yazi", undefined, "function")]))).toBeUndefined();
  });

  it("the rc file that sources the guard is the row's own, and the guard lands under .config/wsp", () => {
    const bashrc: ManifestEntry = { rung: "shell", id: "shell/bashrc", label: "~/.bashrc", paths: ["~/.bashrc"], bytes: 10, default: "bring", bring: true, aliases: [a("o", "open")] };
    expect(aliasGuardFor([bashrc])?.rc).toBe(".bashrc");
    expect(GUARD_PATH).toBe(".config/wsp/aliases.sh");
    expect(GUARD_SOURCE_LINE).toBe('[ -r "$HOME/.config/wsp/aliases.sh" ] && . "$HOME/.config/wsp/aliases.sh"');
  });
});

describe("the guard on a machine", () => {
  const guard = aliasGuardFor([zshrc([a("ls", "eza", "tools/brew/eza"), a("ll", "eza", "tools/brew/eza"), a("eza", "eza", "tools/brew/eza"), a("L", "bat", "tools/brew/bat"), a("md", "glow", "tools/brew/glow", "suffix"), a("o", "open")], { bring: true }), ...TOOLS.map(t => ({ ...t, bring: false }))])!;
  /** The rc file the guest reads, as the pack leaves it: the person's aliases, then the guard's source line. */
  const rcText = (zsh: boolean): string => ["alias ls=eza ll='eza -l' o=open", "alias eza='eza --icons'", ...(zsh ? ["alias -g L='| bat'", "alias -s md=glow"] : []), "", GUARD_SOURCE_COMMENT, GUARD_SOURCE_LINE, ""].join("\n");
  /** Runs the shell as the guest does, interactive over its rc file, and returns stdout: anything the guard printed, then the alias table. */
  const run = (shell: string, path: string): string => {
    const home = mkdtempSync(join(tmpdir(), "wsp-alias-guard-"));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const zsh = shell.endsWith("zsh");
    mkdirSync(join(home, ".config", "wsp"), { recursive: true });
    writeFileSync(join(home, ".config", "wsp", "aliases.sh"), guard.text);
    writeFileSync(join(home, zsh ? ".zshrc" : ".bashrc"), rcText(zsh));
    const report = zsh ? "alias; alias -s; whence -w _wsp_on_path" : "alias; type _wsp_on_path 2>&1";
    return execFileSync(shell, ["-ic", `echo ---; ${report}; true`], { encoding: "utf8", env: { PATH: path, HOME: home, ZDOTDIR: home }, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, killSignal: "SIGKILL" });
  };

  it.each(["/bin/zsh", "/bin/bash"])("%s drops every alias whose command is off PATH, a self-alias and a global alias included, keeps the rest and prints nothing", shell => {
    const bin = mkdtempSync(join(tmpdir(), "wsp-alias-bin-"));
    onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(join(bin, "open"), "#!/bin/sh\n", { mode: 0o755 });
    const out = run(shell, `${bin}:/usr/bin:/bin`);
    const [before, after] = out.split("---\n");
    expect(before).toBe("");
    expect(after).toContain("open");
    expect(after).not.toContain("eza");
    expect(after).not.toContain("bat");
    expect(after).not.toContain("glow");
    expect(after).toMatch(/_wsp_on_path: (none|not found)/);
    writeFileSync(join(bin, "eza"), "#!/bin/sh\n", { mode: 0o755 });
    const kept = run(shell, `${bin}:/usr/bin:/bin`);
    expect(kept).toContain("eza -l");
    expect(kept).toContain("eza --icons");
  });
});
