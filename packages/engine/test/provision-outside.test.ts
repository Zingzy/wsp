// SPDX-License-Identifier: AGPL-3.0-only
// What a setup on a computer somebody owns writes outside the agents' homes:
// the binaries a road installs into /usr/local/bin, a go install's GOBIN, a
// cask's folder under /opt. The record and the leave are run by a real shell
// over a scratch root standing in for that computer's file system, since what
// they are for is telling a file wsp wrote from one the computer already had.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { TOOL_PREFIX } from "@wsp/protocol";
import { outsideAfterScript, outsideBeforeScript, outsideMarks, outsideSweepScript } from "../src/provision-files.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { newSetupRun, provisionStep, type ProvisionPlan } from "../src/provision.js";
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

const sh = (script: string): string => execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` } });

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** One install step as the setup brackets it: the listing before, what the step writes, the record after. */
function step(root: string, name: string, writes: () => void): void {
  sh(outsideBeforeScript(name, root));
  writes();
  sh(outsideAfterScript(name, root));
}

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
    expect(owned.ran[0]).toBe(outsideBeforeScript("floor"));
    expect(owned.ran.at(-1)).toBe(outsideAfterScript("floor"));
    const image = recording();
    await provisionStep(image.machine, plan(), "floor", newSetupRun(), () => {}, { home: "/root" });
    expect(image.ran).not.toContain(outsideBeforeScript("floor"));
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
