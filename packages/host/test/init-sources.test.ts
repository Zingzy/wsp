// SPDX-License-Identifier: AGPL-3.0-only
import type { ManifestEntry } from "@wsp/collect";
import { guardSources } from "@wsp/collect";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { sourceLines } from "../src/init-sources.js";

const zshrc = (sources: string[]): ManifestEntry => ({ rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 10, default: "bring", sources });
const ROWS: ManifestEntry[] = [
  { rung: "shell", id: "shell/aliases", label: "~/.aliases", paths: ["~/.aliases"], bytes: 10, default: "bring" },
  { rung: "toolchains", id: "toolchains/rustup", label: "rustup default toolchain", paths: ["~/.rustup/settings.toml", "~/.cargo/config.toml"], bytes: 10, default: "bring" },
  { rung: "everything", id: "everything/.nvm", label: ".nvm", paths: ["~/.nvm"], excludes: ["~/.nvm/versions"], bytes: 10, default: "skip" },
  { rung: "everything", id: "everything/.zsh", label: ".zsh", paths: ["~/.zsh"], bytes: 10, default: "bring" },
];

describe("sourceLines", () => {
  const row = zshrc(["~/.cargo/env", "~/.nvm/nvm.sh", "~/.nvm/versions/node/v22/etc/bash_completion", "~/.aliases", "~/.zsh/functions.zsh", "~/.deno/env", "/opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh"]);

  it("one line per sourced file no ticked row carries: the carrying row named when there is one, else nothing here brings it; a path outside home says so; a carried file says nothing", () => {
    const coming = new Set(["shell/aliases", "everything/.zsh"]);
    expect(sourceLines(row, [row, ...ROWS], coming, 10)).toEqual([
      "sources ~/.cargo/env, which nothing here brings; the machine skips that line",
      "sources ~/.nvm/nvm.sh, which is not coming (.nvm unticked, tick to bring); the machine skips that line",
      "sources ~/.nvm/versions/node/v22/etc/bash_completion, which nothing here brings; the machine skips that line",
      "sources ~/.deno/env, which nothing here brings; the machine skips that line",
      "sources /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh, a path outside your home; the machine skips that line when it has no such file",
    ]);
  });

  it("a ticked carrier quiets its line; the lines are capped with the rest named; a row with nothing to say gets none", () => {
    const all = sourceLines(row, [row, ...ROWS], new Set(["shell/aliases", "everything/.zsh", "everything/.nvm"]), 10);
    expect(all.map(l => l.split(",")[0])).toEqual(["sources ~/.cargo/env", "sources ~/.nvm/versions/node/v22/etc/bash_completion", "sources ~/.deno/env", "sources /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh"]);
    const capped = sourceLines(row, [row, ...ROWS], new Set(), 2);
    expect(capped).toHaveLength(2);
    expect(capped[0]).toMatch(/^sources ~\/\.cargo\/env/);
    expect(capped[1]).toBe("6 more: ~/.nvm/nvm.sh, ~/.nvm/versions/node/v22/etc/bash_completion, ~/.aliases, ~/.zsh/functions.zsh, ~/.deno/env, /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh");
    expect(sourceLines(zshrc(["~/.aliases"]), [zshrc(["~/.aliases"]), ...ROWS], new Set(["shell/aliases"]), 3)).toEqual([]);
    expect(sourceLines(ROWS[0]!, ROWS, new Set(), 3)).toEqual([]);
  });
});

describe("the guarded rc file on a machine", () => {
  const RC = ['. "$HOME/.cargo/env"', "source ~/.present/env", 'source "$HOME/.zsh/gone.zsh"  # local functions', "source ~/.gone/aliases", "source /opt/homebrew/share/gone/gone.zsh", "alias g=git", ""].join("\n");
  /** bash -i without a terminal says so once; the guest's shell has one and never prints it. */
  const NO_TTY = "bash: no job control in this shell";

  /** Runs the shell as the guest does, interactive over its rc file, from a scratch home holding only .present/env. */
  const run = (shell: string, rc: string): { stdout: string; stderr: string[] } => {
    const home = mkdtempSync(join(tmpdir(), "wsp-source-guard-"));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const zsh = shell.endsWith("zsh");
    mkdirSync(join(home, ".present"));
    writeFileSync(join(home, ".present", "env"), "export WSP_PRESENT=yes\n");
    writeFileSync(join(home, zsh ? ".zshrc" : ".bashrc"), rc);
    const res = spawnSync(shell, ["-ic", "echo present=$WSP_PRESENT; alias g; true"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, ZDOTDIR: home }, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL" });
    expect(res.status).toBe(0);
    return { stdout: res.stdout, stderr: res.stderr.split("\n").filter(l => l !== "" && l !== NO_TTY) };
  };

  it.each(["/bin/zsh", "/bin/bash"])("%s: the bare line names the missing file at every start; the guarded one is silent and the present file is still read", shell => {
    const bare = run(shell, RC);
    expect(bare.stdout).toContain("present=yes");
    expect(bare.stderr.join("\n")).toMatch(/\.cargo\/env/);
    expect(bare.stderr.join("\n")).toMatch(/\.zsh\/gone\.zsh/);
    expect(bare.stderr.join("\n")).toMatch(/\.gone\/aliases/);
    expect(bare.stderr.join("\n")).toMatch(/\/opt\/homebrew\/share\/gone\/gone\.zsh/);
    // Every line wrapped, the present one too, so the wrapped form is what proves a present file is still read.
    const guarded = guardSources(RC, "/Users/nobody", () => false);
    expect(guarded).toBe(['[ -r "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"', "[ -r ~/.present/env ] && source ~/.present/env", '[ -r "$HOME/.zsh/gone.zsh" ] && source "$HOME/.zsh/gone.zsh" # local functions', "[ -r ~/.gone/aliases ] && source ~/.gone/aliases", "[ -r /opt/homebrew/share/gone/gone.zsh ] && source /opt/homebrew/share/gone/gone.zsh", "alias g=git", ""].join("\n"));
    const quiet = run(shell, guarded);
    expect(quiet.stderr).toEqual([]);
    expect(quiet.stdout).toContain("present=yes");
    expect(quiet.stdout).toMatch(/g=.?git/);
  });
});
