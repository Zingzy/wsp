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
  { rung: "everything", id: "everything/.sdkman", label: ".sdkman", paths: ["~/.sdkman"], bytes: 10, default: "skip", reason: "over 1 GB" },
];
const NONE = new Map();

describe("sourceLines", () => {
  const row = zshrc(["~/.cargo/env", "~/.nvm/nvm.sh", "~/.nvm/versions/node/v22/etc/bash_completion", "~/.aliases", "~/.zsh/functions.zsh", "~/.deno/env", "/opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh", "~/.sdkman/bin/sdkman-init.sh"]);

  it("one line per sourced file no ticked row carries: the carrying row named with the reason its own screen gives, else nothing here brings it; a path outside home says so; a carried file says nothing", () => {
    const coming = new Set(["shell/aliases", "everything/.zsh"]);
    expect(sourceLines(row, [row, ...ROWS], coming, NONE, 10)).toEqual([
      "sources ~/.cargo/env, which nothing here brings; the machine skips that line",
      "sources ~/.nvm/nvm.sh, which is not coming (.nvm unticked, tick to bring); the machine skips that line",
      "sources ~/.nvm/versions/node/v22/etc/bash_completion, which nothing here brings; the machine skips that line",
      "sources ~/.deno/env, which nothing here brings; the machine skips that line",
      "sources /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh, a path outside your home; the machine skips that line when it has no such file",
      "sources ~/.sdkman/bin/sdkman-init.sh, which is not coming (.sdkman over 1 GB); the machine skips that line",
    ]);
  });

  it("a ticked carrier quiets its line; the lines are capped with the rest named; a row with nothing to say gets none", () => {
    const all = sourceLines(row, [row, ...ROWS], new Set(["shell/aliases", "everything/.zsh", "everything/.nvm"]), NONE, 10);
    expect(all.map(l => l.split(",")[0])).toEqual(["sources ~/.cargo/env", "sources ~/.nvm/versions/node/v22/etc/bash_completion", "sources ~/.deno/env", "sources /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh", "sources ~/.sdkman/bin/sdkman-init.sh"]);
    const capped = sourceLines(row, [row, ...ROWS], new Set(), NONE, 2);
    expect(capped).toHaveLength(2);
    expect(capped[0]).toMatch(/^sources ~\/\.cargo\/env/);
    expect(capped[1]).toBe("7 more: ~/.nvm/nvm.sh, ~/.nvm/versions/node/v22/etc/bash_completion, ~/.aliases, ~/.zsh/functions.zsh, ~/.deno/env, /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh, ~/.sdkman/bin/sdkman-init.sh");
    expect(sourceLines(zshrc(["~/.aliases"]), [zshrc(["~/.aliases"]), ...ROWS], new Set(["shell/aliases"]), NONE, 3)).toEqual([]);
    expect(sourceLines(ROWS[0]!, ROWS, new Set(), NONE, 3)).toEqual([]);
  });
});

describe("the guarded rc file on a machine", () => {
  /** The rc names the laptop's home literally in three quotings; the scratch home stands in for the machine's. */
  const LAPTOP = "/Users/nobody";
  const RC = ['. "$HOME/.cargo/env"', "source ~/.present/env", 'source "$HOME/.zsh/gone.zsh"  # local functions', "source ~/.gone/aliases", "source /opt/homebrew/share/gone/gone.zsh", `. "${LAPTOP}/.present/dq"`, `source ${LAPTOP}/.present/bare`, `source '${LAPTOP}/.present/sq'  # fns`, "alias g=git", ""].join("\n");
  /** bash -i without a terminal says so once; the guest's shell has one and never prints it. */
  const NO_TTY = "bash: no job control in this shell";

  /** Runs the shell as the guest does, interactive over its rc file, from a scratch home holding only .present/env. */
  const run = (shell: string, rc: string): { stdout: string; stderr: string[] } => {
    const home = mkdtempSync(join(tmpdir(), "wsp-source-guard-"));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const zsh = shell.endsWith("zsh");
    mkdirSync(join(home, ".present"));
    for (const [name, mark] of [["env", "PRESENT"], ["dq", "DQ"], ["bare", "BARE"], ["sq", "SQ"]] as const) writeFileSync(join(home, ".present", name), `export WSP_${mark}=yes\n`);
    writeFileSync(join(home, zsh ? ".zshrc" : ".bashrc"), rc);
    const res = spawnSync(shell, ["-ic", "echo present=$WSP_PRESENT dq=$WSP_DQ bare=$WSP_BARE sq=$WSP_SQ; alias g; true"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, ZDOTDIR: home }, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL" });
    expect(res.status).toBe(0);
    return { stdout: res.stdout, stderr: res.stderr.split("\n").filter(l => l !== "" && l !== NO_TTY) };
  };

  it.each(["/bin/zsh", "/bin/bash"])("%s: the bare line names the missing file at every start; the guarded one is silent, the present file is still read, and a file named by the laptop's home is read from the machine's", shell => {
    const bare = run(shell, RC);
    expect(bare.stdout).toContain("present=yes dq= bare= sq=");
    expect(bare.stderr.join("\n")).toMatch(/\.cargo\/env/);
    expect(bare.stderr.join("\n")).toMatch(/\.zsh\/gone\.zsh/);
    expect(bare.stderr.join("\n")).toMatch(/\.gone\/aliases/);
    expect(bare.stderr.join("\n")).toMatch(/\/opt\/homebrew\/share\/gone\/gone\.zsh/);
    expect(bare.stderr.join("\n")).toMatch(/\/Users\/nobody\/\.present\/dq/);
    // Every line wrapped, the present one too, so the wrapped form is what proves a present file is still read.
    const guarded = guardSources(RC, LAPTOP, () => false);
    expect(guarded).toBe(['[ -r "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"', "[ -r ~/.present/env ] && source ~/.present/env", '[ -r "$HOME/.zsh/gone.zsh" ] && source "$HOME/.zsh/gone.zsh" # local functions', "[ -r ~/.gone/aliases ] && source ~/.gone/aliases", "[ -r /opt/homebrew/share/gone/gone.zsh ] && source /opt/homebrew/share/gone/gone.zsh", '[ -r "$HOME/.present/dq" ] && . "$HOME/.present/dq"', '[ -r "$HOME"/.present/bare ] && source "$HOME"/.present/bare', `[ -r "$HOME"'/.present/sq' ] && source "$HOME"'/.present/sq' # fns`, "alias g=git", ""].join("\n"));
    const quiet = run(shell, guarded);
    expect(quiet.stderr).toEqual([]);
    expect(quiet.stdout).toContain("present=yes dq=yes bare=yes sq=yes");
    expect(quiet.stdout).toMatch(/g=.?git/);
  });
});
