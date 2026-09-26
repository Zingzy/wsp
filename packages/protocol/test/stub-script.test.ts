// SPDX-License-Identifier: AGPL-3.0-only
// macOS checks a file written moments ago at its first exec: 110 ms to 460 ms on
// an idle Mac, seconds beside a loaded suite, which outran tests' own waits. So a
// test never writes a script and runs it. writeStub puts a link at the path to a
// runner that has run before, and the runner hands the script to its interpreter
// to read, which no check stops.
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT, testFiles } from "./source-files.js";
import { STUB_RUNNER, writeStub } from "./stub-script.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-stub-"));
  dirs.push(dir);
  return dir;
}

describe("a stub", () => {
  it("is a link to the runner, and runs as the script it was given with its arguments, stdin and exit code", () => {
    const at = join(scratch(), "tool");
    expect(writeStub(at, '#!/bin/sh\necho "args: $*"\ncat\nexit 7\n')).toBe(at);
    expect(lstatSync(at).isSymbolicLink()).toBe(true);
    expect(readlinkSync(at)).toBe(STUB_RUNNER);
    const run = spawnSync(at, ["a", "b c"], { input: "typed\n", encoding: "utf8" });
    expect([run.stdout, run.status]).toEqual(["args: a b c\ntyped\n", 7]);
  });

  it("runs under the interpreter its first line names, and under sh when it names none", () => {
    const dir = scratch();
    writeStub(join(dir, "bashy"), '#!/bin/bash\nwords=(one two)\necho "${words[1]}"\n');
    writeStub(join(dir, "enved"), `#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join("+"))\n`);
    writeStub(join(dir, "plain"), "echo plain\n");
    expect(execFileSync(join(dir, "bashy"), { encoding: "utf8" })).toBe("two\n");
    expect(execFileSync(join(dir, "enved"), ["x", "y"], { encoding: "utf8" })).toBe("x+y\n");
    expect(execFileSync(join(dir, "plain"), { encoding: "utf8" })).toBe("plain\n");
  });

  it("is found on a PATH by its name, and a script beside it is found from its own folder", () => {
    const dir = scratch();
    writeStub(join(dir, "next"), "#!/bin/sh\necho next got $1\n");
    writeStub(join(dir, "first"), '#!/bin/sh\nexec "$(dirname "$0")/next" "$@"\n');
    expect(execFileSync("/bin/sh", ["-c", "first hop"], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" })).toBe("next got hop\n");
  });

  it("written again at the same path runs the new script and leaves the runner as it was", () => {
    const at = join(scratch(), "tool");
    const runner = readFileSync(STUB_RUNNER, "utf8");
    writeStub(at, "#!/bin/sh\necho one\n");
    writeStub(at, "#!/bin/sh\necho two\n");
    expect(execFileSync(at, { encoding: "utf8" })).toBe("two\n");
    expect(readFileSync(STUB_RUNNER, "utf8")).toBe(runner);
  });

  it("takes the place of a file already at its path", () => {
    const at = join(scratch(), "tool");
    writeFileSync(at, "was here\n");
    writeStub(at, "#!/bin/sh\necho stub\n");
    expect(execFileSync(at, { encoding: "utf8" })).toBe("stub\n");
  });
});

/** A call's arguments as written, split at its top level commas, so a path is compared by its text. */
function callArgs(text: string, names: string): { name: string; args: string[]; line: number }[] {
  const out: { name: string; args: string[]; line: number }[] = [];
  for (const m of text.matchAll(new RegExp(`\\b(${names})\\(`, "g"))) {
    const args: string[] = [];
    let cur = "";
    let depth = 1;
    let quote: string | null = null;
    for (let i = m.index + m[0].length; i < text.length && depth > 0; i++) {
      const c = text[i]!;
      if (quote !== null) {
        cur += c;
        if (c === "\\") cur += text[++i] ?? "";
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      if (depth === 1 && c === ",") {
        args.push(cur.trim());
        cur = "";
      } else if (depth > 0) cur += c;
    }
    args.push(cur.trim());
    out.push({ name: m[1]!, args, line: text.slice(0, m.index).split("\n").length });
  }
  return out;
}

const ownerRuns = (mode: string | undefined): boolean => {
  const m = /0o([0-7])[0-7]{2}/.exec(mode ?? "");
  return m !== null && (Number(m[1]) & 1) === 1;
};

/** Each file an executable mode is written onto outside writeStub, as file:line and the path's text. A chmod on a
 * path the same file made with mkdir or mkdtemp, or on a folder above one it made, is a folder's mode, not a script's. */
function executablesWritten(rel: string, text = readFileSync(join(ROOT, rel), "utf8")): { at: string; path: string }[] {
  const folders = new Set([...callArgs(text, "mkdirSync|mkdir").map(c => c.args[0]), ...[...text.matchAll(/(?:const|let) (\w+) = mkdtempSync\(/g)].map(m => m[1])]);
  const found: { at: string; path: string }[] = [];
  for (const c of callArgs(text, "writeFileSync|writeFile")) if (ownerRuns(c.args.slice(2).join(","))) found.push({ at: `${rel}:${c.line}`, path: c.args[0]! });
  const isFolder = (path: string): boolean => [...folders].some(f => f === path || (path.endsWith(")") && f?.startsWith(`${path.slice(0, -1)},`)));
  for (const c of callArgs(text, "chmodSync|chmod")) if (ownerRuns(c.args[1]) && !isFolder(c.args[0]!)) found.push({ at: `${rel}:${c.line}`, path: c.args[0]! });
  return found;
}

/** The helper and this file, which write the runner's mode and the cases above. */
const HOME = ["packages/protocol/test/stub-script.ts", "packages/protocol/test/stub-script.test.ts"];

/** Executables a test writes and nothing runs, by file and the path's text as written, each with why. */
const NEVER_RUN: Record<string, Record<string, string>> = {
  "packages/engine/test/ssh-backend.test.ts": { dir: "the ssh control folder, loosened for the code under test to tighten" },
  "packages/runtime/test/store.test.ts": { wide: "the state folders an older build left wider, for the store to repair" },
  "packages/host/test/connector.test.ts": { 'join(made, "cloudflared")': "packed into a release archive the unpack is tested on, and read back for its bytes and mode" },
  "packages/host/test/doctor.test.ts": { "daemonBinaryIn(daemon, triple)": "a stand-in daemon staged into a bundle as bytes" },
  "packages/host/test/places.test.ts": { "daemonBinaryIn(daemonDir, target.triple)": "a stand-in daemon staged into a bundle as bytes" },
  "packages/host/test/ssh-daemon-place.test.ts": { "daemonBinaryIn(dir, target.triple)": "a stand-in daemon staged into a bundle as bytes" },
  "packages/host/test/hooks-path.test.ts": {
    'join(dir, ".githooks", hook)': "committed to a throwaway repository, whose hook folder the prepare script builds from the commit",
    'join(dir, ".githooks", "pre-commit")': "committed to a throwaway repository, whose hook folder the prepare script builds from the commit",
  },
  "packages/host/test/init-import.test.ts": {
    'join(home, ".oh-my-zsh", "custom", "plugins", "x", "x.zsh")': "a file the import copies, its mode what is read",
    'join(home, ".claude", "hooks", "remind")': "a hook the import copies, its mode what is read",
    'join(home, ".codync", "notify.sh")': "a hook the import copies, its mode what is read",
    'join(home, ".claude", "hooks", "fine")': "a hook the import copies, its mode what is read",
    'join(home, "bin", "notify.sh")': "a hook the import copies, its mode what is read",
    'join(home, ".codex", "computer-use", "SkyComputerUseClient")': "a binary the import copies, its mode what is read",
    'join(home, ".codex", "notify.py")': "a hook the import copies, its mode what is read",
  },
};

describe("every script a test runs is a stub", () => {
  it("no test writes an executable mode onto a file outside writeStub, unless it is listed as never run", () => {
    const offenders = testFiles()
      .filter(rel => !HOME.includes(rel))
      .flatMap(rel => executablesWritten(rel).filter(w => NEVER_RUN[rel]?.[w.path] === undefined).map(w => `${w.at} ${w.path}`));
    expect(offenders).toEqual([]);
  });

  it("every never-run entry still names an executable its file writes, so a moved or deleted one leaves the list", () => {
    const stale = Object.entries(NEVER_RUN).flatMap(([rel, paths]) => {
      const written = new Set(executablesWritten(rel).map(w => w.path));
      return Object.keys(paths).filter(p => !written.has(p)).map(p => `${rel} ${p}`);
    });
    expect(stale).toEqual([]);
  });

  it("finds a script written executable either way, and passes a folder's mode", () => {
    const text = [
      'writeFileSync(join(bin, "curl"), "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });',
      'writeFileSync(bin, body);\nchmodSync(bin, 0o700);',
      'mkdirSync(join(home, ".config"));\nchmodSync(join(home, ".config"), 0o755);',
      'mkdirSync(join(home, "Library", "Caches", "x"), { recursive: true });\nchmodSync(join(home, "Library"), 0o700);',
      'writeFileSync(env, "A=1\\n", { mode: 0o600 });',
      'const scratch = mkdtempSync(join(tmpdir(), "x-"));\nchmodSync(scratch, 0o755);',
    ].join("\n");
    expect(executablesWritten("case.test.ts", text).map(w => w.path)).toEqual(['join(bin, "curl")', "bin"]);
  });
});
