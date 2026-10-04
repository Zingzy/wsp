// SPDX-License-Identifier: AGPL-3.0-only
// What a setup on a computer somebody owns writes outside the agents' homes:
// the binaries a road installs into /usr/local/bin, a go install's GOBIN, a
// cask's folder under /opt. The record and the leave are run by a real shell
// over a scratch root standing in for that computer's file system, since what
// they are for is telling a file wsp wrote from one the computer already had.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { TOOL_PREFIX } from "@wsp/protocol";
import { outsideAfterScript, outsideBeforeScript, outsideMarks, outsideSweepScript } from "../src/provision-files.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { newSetupRun, outsideRoots, provisionStep, type ProvisionPlan } from "../src/provision.js";
import type { ToolInstall } from "../src/golden-import.js";
import { writeStub } from "../../protocol/test/stub-script.js";
import { TOOLS_PATH } from "../src/golden-import.js";
import { FREE_KB_CMD } from "../src/golden-tools.js";
import { sha256sumBin } from "./sha256sum-bin.js";

const bin = sha256sumBin();
const roots: string[] = [];
afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A computer's file system under /tmp, read by its real path: the leave reads each folder on the way physically, and
 * /tmp on a Mac is a link. */
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-outside-")));
  roots.push(root);
  mkdirSync(join(root, "usr/local/bin"), { recursive: true });
  mkdirSync(join(root, "opt"), { recursive: true });
  return root;
}

const sh = (script: string, first?: string): string =>
  execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${first === undefined ? "" : `${first}:`}${bin}:${process.env["PATH"]}` } });

/** A folder holding one stand-in command, put first on PATH for one run: how a run killed part way is made. */
function stubbed(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-outside-stub-"));
  roots.push(dir);
  writeStub(join(dir, name), `#!/bin/sh\n${body}\n`);
  return dir;
}

const EVERYWHERE = ["/usr/local", "/opt"];

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** One install step as the setup brackets it: the listing before, what the step writes, the record after. */
function step(root: string, name: string, writes: () => void, walked: readonly string[] = EVERYWHERE): void {
  sh(outsideBeforeScript(name, walked, root));
  writes();
  sh(outsideAfterScript(name, walked, root));
}

const listed = (root: string): string[] => (existsSync(join(root, TOOL_PREFIX, "landed")) ? ledger(root).trim().split("\n").filter(l => l !== "").map(line => line.split("\t")[1]!) : []);

const ledger = (root: string): string => readFileSync(join(root, TOOL_PREFIX, "landed"), "utf8");

describe("what a setup writes outside the home", () => {
  it("writes down every path an install step made under /usr/local and /opt, and nothing the computer had before", () => {
    const root = scratch();
    put(join(root, "usr/local/bin/jq"), "the box's own jq\n");
    put(join(root, "usr/local/bin/claude"), "the box's own claude\n");
    step(root, "agents", () => {
      // An install over a file the box already had writes it, and the file is still the box's.
      put(join(root, "usr/local/bin/claude"), "claude 2.1.280\n");
      put(join(root, "usr/local/bin/gopls"), "gopls from go install\n");
      put(join(root, "opt/cursor-agent/cursor-agent"), "cursor\n");
      symlinkSync(join(root, "opt/cursor-agent/cursor-agent"), join(root, "usr/local/bin/cursor-agent"));
      // wsp's own folder goes whole on a leave and is never listed file by file.
      put(join(root, TOOL_PREFIX, "go/bin/x"), "x\n");
    });
    const paths = ledger(root).trim().split("\n").map(line => line.split("\t")[1]);
    expect(paths.sort()).toEqual(
      [join(root, "opt/cursor-agent"), join(root, "opt/cursor-agent/cursor-agent"), join(root, "usr/local/bin/cursor-agent"), join(root, "usr/local/bin/gopls")].sort(),
    );
    // The step's own listing goes with it.
    expect(readFileSync(join(root, TOOL_PREFIX, "landed"), "utf8")).not.toContain(".landing");
    expect(existsSync(join(root, TOOL_PREFIX, ".landing-agents.before"))).toBe(false);
  });

  it("leaves off a path a package put there, which is dpkg's to take", () => {
    const root = scratch();
    put(join(root, "var/lib/dpkg/info/vendor.list"), "/.\n/opt\n/opt/vendor\n/opt/vendor/bin\n/opt/vendor/bin/v\n");
    step(root, "clis", () => {
      put(join(root, "opt/vendor/bin/v"), "a deb's file\n");
      put(join(root, "usr/local/bin/gopls"), "gopls\n");
    });
    expect(ledger(root).trim().split("\n").map(line => line.split("\t")[1])).toEqual([join(root, "usr/local/bin/gopls")]);
  });

  it("takes off exactly what the list names as wsp left it, and every folder it made once nothing is left in it", () => {
    const root = scratch();
    put(join(root, "usr/local/bin/jq"), "the box's own jq\n");
    put(join(root, "usr/local/bin/claude"), "the box's own claude\n");
    step(root, "clis", () => {
      put(join(root, "usr/local/bin/claude"), "claude 2.1.280\n");
      put(join(root, "usr/local/bin/gopls"), "gopls\n");
      put(join(root, "opt/gcloud/bin/gcloud"), "gcloud\n");
      put(join(root, "opt/gcloud/lib/core.py"), "core\n");
      put(join(root, "opt/cursor-agent/cursor-agent"), "cursor\n");
      symlinkSync(join(root, "opt/gcloud/bin/gcloud"), join(root, "usr/local/bin/gcloud"));
    });
    // What the person did since: their own bytes over one of wsp's files, and a file of theirs in a folder wsp made.
    writeFileSync(join(root, "opt/cursor-agent/cursor-agent"), "the person's own build\n");
    put(join(root, "opt/gcloud/lib/mine.txt"), "theirs\n");
    const swept = outsideMarks(sh(outsideSweepScript(root)));
    expect(swept.sort()).toEqual(
      [join(root, "usr/local/bin/gopls"), join(root, "usr/local/bin/gcloud"), join(root, "opt/gcloud/bin/gcloud"), join(root, "opt/gcloud/bin"), join(root, "opt/gcloud/lib/core.py")].sort(),
    );
    expect(readFileSync(join(root, "usr/local/bin/claude"), "utf8")).toBe("claude 2.1.280\n");
    expect(readFileSync(join(root, "usr/local/bin/jq"), "utf8")).toBe("the box's own jq\n");
    expect(readFileSync(join(root, "opt/cursor-agent/cursor-agent"), "utf8")).toBe("the person's own build\n");
    expect(readFileSync(join(root, "opt/gcloud/lib/mine.txt"), "utf8")).toBe("theirs\n");
    expect(existsSync(join(root, "usr/local/bin"))).toBe(true);
  });

  it("writes a file down again at the bytes a later run left in it, and leaves the old line's bytes behind", () => {
    const root = scratch();
    step(root, "agents", () => put(join(root, "usr/local/bin/claude"), "claude 2.1.270\n"));
    step(root, "agents", () => put(join(root, "usr/local/bin/claude"), "claude 2.1.280\n"));
    expect(outsideMarks(sh(outsideSweepScript(root)))).toEqual([join(root, "usr/local/bin/claude")]);
    expect(existsSync(join(root, "usr/local/bin/claude"))).toBe(false);
  });

  it("takes nothing a line names outside /usr/local and /opt, under wsp's own folder, or past a folder that is a link", () => {
    const root = scratch();
    const digest = (path: string): string => sh(`sha256sum < '${path}' | cut -c1-64`).trim();
    put(join(root, "etc/passwd"), "root:x:0:0\n");
    put(join(root, "usr/bin/env"), "env\n");
    put(join(root, TOOL_PREFIX, "keep"), "wsp's own\n");
    put(join(root, "opt/real/tool"), "theirs\n");
    symlinkSync(join(root, "opt/real"), join(root, "opt/via"));
    const forged = [join(root, "etc/passwd"), join(root, "usr/bin/env"), join(root, TOOL_PREFIX, "keep"), join(root, "opt/via/tool"), `${join(root, "usr/local/bin")}/../../bin/env`];
    const ledgerPath = join(root, TOOL_PREFIX, "landed");
    writeFileSync(ledgerPath, forged.map(p => `${digest(existsSync(p) ? p : join(root, "usr/bin/env"))}\t${p}\n`).join(""));
    expect(outsideMarks(sh(outsideSweepScript(root)))).toEqual([]);
    for (const p of [join(root, "etc/passwd"), join(root, "usr/bin/env"), join(root, TOOL_PREFIX, "keep"), join(root, "opt/real/tool")]) expect(existsSync(p), p).toBe(true);
  });

  it("reads nothing off a list that sits in a prefix that is a link", () => {
    const root = scratch();
    const elsewhere = join(root, "elsewhere");
    put(join(root, "usr/local/bin/gopls"), "gopls\n");
    put(join(elsewhere, "landed"), `${sh(`sha256sum < '${join(root, "usr/local/bin/gopls")}' | cut -c1-64`).trim()}\t${join(root, "usr/local/bin/gopls")}\n`);
    symlinkSync(elsewhere, join(root, TOOL_PREFIX));
    expect(outsideMarks(sh(outsideSweepScript(root)))).toEqual([]);
    expect(existsSync(join(root, "usr/local/bin/gopls"))).toBe(true);
  });

  it("records nothing when the listing before the step was cut short, so the box's own files are never claimed", () => {
    const root = scratch();
    put(join(root, "usr/local/bin/jq"), "the box's own jq\n");
    put(join(root, "opt/vendor/tool"), "the box's own tool\n");
    // A find killed after its first line, as the daemon's bound kills a listing of a big /opt.
    const killed = stubbed("find", 'echo "$2"; kill -KILL $$');
    sh(outsideBeforeScript("clis", EVERYWHERE, root), killed);
    put(join(root, "usr/local/bin/claude"), "claude\n");
    sh(outsideAfterScript("clis", EVERYWHERE, root));
    expect(listed(root)).toEqual([]);
    // A list that stops before its end line, whatever cut it, is read the same way.
    sh(outsideBeforeScript("clis", EVERYWHERE, root));
    const before = join(root, TOOL_PREFIX, ".landing-clis.before");
    writeFileSync(before, readFileSync(before, "utf8").split("\n").slice(0, 2).join("\n") + "\n");
    put(join(root, "usr/local/bin/gopls"), "gopls\n");
    sh(outsideAfterScript("clis", EVERYWHERE, root));
    expect(listed(root)).toEqual([]);
    expect(outsideMarks(sh(outsideSweepScript(root)))).toEqual([]);
    expect(existsSync(join(root, "usr/local/bin/jq")) && existsSync(join(root, "opt/vendor/tool"))).toBe(true);
    expect(readdirSync(join(root, TOOL_PREFIX)).filter(n => n.startsWith(".landing"))).toEqual([]);
  });

  it("records and takes four thousand files well inside the leave's sixty seconds", () => {
    const root = scratch();
    const started = Date.now();
    step(root, "clis", () => {
      for (let i = 0; i < 4000; i++) put(join(root, "opt/gcloud", `d${i % 40}`, `f${i}`), `file ${i}\n`);
    });
    const recorded = Date.now() - started;
    expect(listed(root)).toHaveLength(4041);
    const sweeping = Date.now();
    const swept = outsideMarks(sh(outsideSweepScript(root)));
    const took = Date.now() - sweeping;
    expect(swept).toHaveLength(4041);
    expect(existsSync(join(root, "opt/gcloud"))).toBe(false);
    expect(recorded, `the record took ${recorded} ms`).toBeLessThan(20_000);
    expect(took, `the sweep took ${took} ms`).toBeLessThan(20_000);
  }, 60_000);

  it("keeps the list when the leave is cut short, and a second leave finishes it", () => {
    const root = scratch();
    step(root, "agents", () => {
      put(join(root, "usr/local/bin/claude"), "claude\n");
      put(join(root, "opt/cursor/cursor"), "cursor\n");
    });
    // The shell running the leave killed while it removes, as the leave's bound kills it.
    const cut = stubbed("xargs", "kill -KILL $PPID");
    try {
      sh(outsideSweepScript(root), cut);
    } catch {
      // The shell died, which is the point.
    }
    expect(existsSync(join(root, TOOL_PREFIX, "landed"))).toBe(true);
    expect(outsideMarks(sh(outsideSweepScript(root))).sort()).toEqual([join(root, "opt/cursor"), join(root, "opt/cursor/cursor"), join(root, "usr/local/bin/claude")]);
    expect(existsSync(join(root, TOOL_PREFIX, "landed"))).toBe(false);
  });

  it("walks only the folders the step's roads write, so a file somebody else puts elsewhere meanwhile stays theirs", () => {
    const root = scratch();
    step(
      root,
      "clis",
      () => {
        put(join(root, "usr/local/bin/rg"), "rg from its release\n");
        put(join(root, "opt/theirs/tool"), "installed by somebody else meanwhile\n");
        put(join(root, "usr/local/lib/theirs.so"), "theirs too\n");
      },
      ["/usr/local/bin"],
    );
    expect(listed(root)).toEqual([join(root, "usr/local/bin/rg")]);
  });

  it("never writes down the person's bytes when a later step only touches a file of wsp's they wrote over", () => {
    const root = scratch();
    step(root, "agents", () => put(join(root, "usr/local/bin/claude"), "claude 2.1.280\n"));
    writeFileSync(join(root, "usr/local/bin/claude"), "the person's own build\n");
    step(root, "clis", () => chmodSync(join(root, "usr/local/bin/claude"), 0o755));
    expect(outsideMarks(sh(outsideSweepScript(root)))).toEqual([]);
    expect(readFileSync(join(root, "usr/local/bin/claude"), "utf8")).toBe("the person's own build\n");
  });

  it("answers only the mark's own lines, each an absolute path", () => {
    expect(outsideMarks("wsp-outside\t/usr/local/bin/claude\nsomething else\nwsp-outside\trelative\nwsp-outside\t\n")).toEqual(["/usr/local/bin/claude"]);
  });
});

describe("the setup brackets every install step on a computer somebody owns", () => {
  function recording(): { machine: Machine; ran: string[] } {
    const ran: string[] = [];
    const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
    const machine = {
      id: "spoo",
      kind: "sandbox",
      exec: async (cmd: string) => {
        ran.push(cmd);
        return cmd === FREE_KB_CMD ? { exitCode: 0, stdout: "9000000\n", stderr: "" } : ok;
      },
      run: async (script: string) => {
        ran.push(script);
        return ok;
      },
    } as unknown as Machine;
    return { machine, ran };
  }
  const plan = (prefix?: string): ProvisionPlan => ({ recipeAt: "x", path: TOOLS_PATH, steps: [], skipped: [], agents: 0, compiler: false, ...(prefix === undefined ? {} : { prefix }) });

  it("lists the folders before the floor and writes down what it made after, under wsp's prefix only", async () => {
    const owned = recording();
    await provisionStep(owned.machine, plan(TOOL_PREFIX), "floor", newSetupRun(), () => {}, { home: "/root" });
    const walked = outsideRoots(plan(TOOL_PREFIX), "floor");
    expect(owned.ran[0]).toBe(outsideBeforeScript("floor", walked));
    expect(owned.ran.at(-1)).toBe(outsideAfterScript("floor", walked));
    const image = recording();
    await provisionStep(image.machine, plan(), "floor", newSetupRun(), () => {}, { home: "/root" });
    expect(image.ran).not.toContain(outsideBeforeScript("floor", walked));
  });

  it("walks the folders each road of the step writes under /usr/local and /opt, wsp's own folder left out", () => {
    const tool = (manager: ToolInstall["manager"], bins?: string[]): ToolInstall => ({ id: `tools/${manager}`, label: manager, manager, cmd: "true", ...(bins === undefined ? {} : { bins }) });
    const with_ = (steps: ToolInstall[]): ProvisionPlan => ({ ...plan(TOOL_PREFIX), steps, agents: 0 });
    expect(outsideRoots(with_([tool("release")]), "clis")).toEqual(["/usr/local/bin"]);
    // go's own folder is under wsp's prefix, and GOBIN is the links folder, which is where its commands answer.
    expect(outsideRoots(with_([tool("go", ["/usr/local/bin"])]), "clis")).toEqual(["/usr/local/bin"]);
    expect(outsideRoots(with_([tool("npm")]), "clis")).toEqual(["/usr/local/bin", "/usr/local/lib/node_modules"]);
    expect(outsideRoots(with_([tool("vendor")]), "clis")).toEqual(["/opt", "/usr/local/bin"]);
    expect(outsideRoots(with_([tool("script")]), "clis")).toEqual(["/opt", "/usr/local"]);
    expect(outsideRoots(with_([]), "clis")).toEqual([]);
  });

  it("leaves a step that installs nothing outside the home alone", async () => {
    const owned = recording();
    await provisionStep(owned.machine, plan(TOOL_PREFIX), "skills", newSetupRun(), () => {}, { home: "/root" });
    expect(owned.ran).toEqual([]);
  });
});

describe("the leave outside the home as the daemon on that computer renders it", () => {
  const CONTRACT = fileURLToPath(new URL("../../../daemon/fixtures/contract/", import.meta.url));
  const SCRIPT_ROOT = "{root}";

  it("landed-outside.sh equals its regeneration, so the twin the daemon carries is this script", () => {
    const text = `${outsideSweepScript(SCRIPT_ROOT)}\n`;
    const regenerated = join(tmpdir(), "wsp-contract-landed-outside.sh");
    writeFileSync(regenerated, text);
    const path = join(CONTRACT, "landed-outside.sh");
    expect(existsSync(path), `daemon/fixtures/contract/landed-outside.sh is missing. The regenerated file is at ${regenerated}: copy it there and commit it`).toBe(true);
    expect(readFileSync(path, "utf8"), `daemon/fixtures/contract/landed-outside.sh is behind the engine. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
  });
});
