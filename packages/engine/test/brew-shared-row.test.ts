// SPDX-License-Identifier: AGPL-3.0-only
// The shared Homebrew step's row when it fails: what its check found, or which formula its install left behind,
// read off the plan's own scripts run in this machine's bash with su and brew stubbed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { BREW } from "@wsp/catalog";
import { toolInstallsFor, type RecipeEntry } from "../src/golden-import.js";
import { installTools } from "../src/golden-tools.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const row = (formula: string): RecipeEntry => ({ rung: "tools", id: `tools/brew/${formula}`, label: formula, paths: [], bytes: 0, default: "bring", bring: true, linux: "yes" });
const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
/** Every awk this computer has: Debian's mawk and gawk on Linux, the BSD one on a Mac. */
const AWKS = [...new Set(["/usr/bin/mawk", "/usr/bin/gawk", "/usr/bin/awk"].filter(a => existsSync(a)).map(a => realpathSync(a)))];

/** The hetzner box of the report: of the dependencies zig and cargo-zigbuild share, llvm@21 is not installed. `install`
 * is what the stub brew's install does: exit 0, or fail on llvm@21 the way a child process failure reads. `awk` is the
 * one the scripts find first, since mawk, gawk and the BSD awk read the same program differently. */
function box(install: "lands" | "fails", awk = AWKS[0]!): { machine: Machine; log: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-brew-shared-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(awk, join(dir, "awk"));
  writeStub(join(dir, "su"), '#!/bin/sh\nshell=/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -s) shell="$2"; shift 2 ;; -c) script="$2"; shift 2 ;; --) shift; break ;; *) shift ;; esac; done\nexec "$shell" -c "$script" "$@"\n');
  const failing = install === "fails" ? `echo "==> Pouring z3"; echo "Error: An exception occurred within a child process:" >&2; echo "  BuildError: llvm@21 failed to pour" >&2; exit 1` : "exit 0";
  writeStub(
    join(dir, "brew"),
    `#!/bin/sh\ncase "$1" in\n  deps) printf '%s\\n' 'zig: llvm@21 z3 zstd' 'cargo-zigbuild: llvm@21 z3 zstd zig' 'gh:' ;;\n  list) printf '%s\\n' 'z3 4.15.3' 'zstd 1.5.7'; exit 1 ;;\n  install) ${failing} ;;\nesac\nexit 0\n`,
  );
  const real = (cmd: string): ExecResult => {
    const r = spawnSync("bash", ["-c", cmd.replaceAll(BREW, join(dir, "brew")).replaceAll("export PATH=", `export PATH=${dir}:`)], { encoding: "utf8" });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  const machine = {
    id: "hetzner",
    kind: "sandbox",
    exec: async (cmd: string) => (cmd.includes("wsp-check") && cmd.includes("deps --for-each") ? real(cmd) : cmd.startsWith("df ") ? { exitCode: 0, stdout: "9000000\n", stderr: "" } : ok),
    run: async (script: string) => (script.includes("deps --for-each") ? real(script) : ok),
  } as unknown as Machine;
  return { machine, log: [] };
}

const plan = () => toolInstallsFor([row("zig"), row("cargo-zigbuild"), row("gh")]).installs;

it.each(AWKS)("a failed shared check names the formula that is missing and the recipe's tools that need it, never its shell (%s)", async awk => {
  const { machine, log } = box("lands", awk);
  const steps = plan();
  const { tools } = await installTools(machine, steps, (_at, detail) => log.push(detail ?? ""));
  const shared = tools.find(t => t.id === "tools/brew-shared")!;
  expect(shared).toMatchObject({ outcome: "failed", note: "llvm@21 is not installed; zig and cargo-zigbuild need it." });
  // The command the check ran is the setup log's, whole.
  const check = steps.find(t => t.id === "tools/brew-shared")!.check!;
  expect(log.some(l => l.includes(check))).toBe(true);
});

it("a failed shared install names the formula it left behind and the last line brew printed for it", async () => {
  const { machine } = box("fails");
  const { tools } = await installTools(machine, plan(), () => {});
  expect(tools.find(t => t.id === "tools/brew-shared")).toMatchObject({ outcome: "failed", note: "Error: llvm@21 did not install: BuildError: llvm@21 failed to pour" });
});
