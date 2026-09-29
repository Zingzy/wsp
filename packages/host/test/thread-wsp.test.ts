// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localWiring, makeRuntime, servingWiring } from "../src/cli.js";
import type { RunningWsp } from "../src/mcp-install.js";
import { threadBinDir, writeThreadWsp } from "../src/shim.js";
import { threadTarget, type HostClient } from "../src/verbs.js";

describe("the wsp a thread's shell runs on this computer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-thread-bin-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a script beside the state file that runs the command this host was started as, with every word the shell gave it", () => {
    const statePath = join(dir, "home", "state.json");
    const echo = join(dir, "echo argv.mjs");
    writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const at = writeThreadWsp(statePath, { command: process.execPath, args: [echo] });
    expect(at).toBe(threadBinDir(statePath));
    expect(threadBinDir(statePath)).toBe(join(dir, "home", "thread-bin"));
    expect(statSync(join(at, "wsp")).mode & 0o111).not.toBe(0);
    expect(JSON.parse(execFileSync(join(at, "wsp"), ["threads", "a 'b' c", "--json"], { encoding: "utf8" }))).toEqual(["threads", "a 'b' c", "--json"]);
    // Written again over itself, so a host restarted on another build points the folder at that build.
    writeThreadWsp(statePath, { command: process.execPath, args: [echo, "run"] });
    expect(JSON.parse(execFileSync(join(at, "wsp"), ["x"], { encoding: "utf8" }))).toEqual(["run", "x"]);
  });

  it("comes first on the PATH a turn here is launched with, ahead of any wsp the person's own PATH holds", () => {
    const statePath = join(dir, "state.json");
    const bin = threadBinDir(statePath);
    const wiring = localWiring(dir, { PATH: `/usr/bin${delimiter}/bin` }, undefined, statePath, undefined, () => {}, bin);
    expect(wiring.env()["PATH"]).toBe(`${bin}${delimiter}/usr/bin${delimiter}/bin`);
    // A wiring for a line that serves no turn leaves the PATH it was given alone.
    expect(localWiring(dir, { PATH: "/usr/bin" }, undefined, statePath, undefined, () => {}).env()["PATH"]).toBe("/usr/bin");
  });

  /** A host started as node on its script, which is the one road that needs the script written rather than found. */
  const started = (script: string): RunningWsp => ({ execPath: process.execPath, execArgv: [], argv: [process.execPath, script], version: "0.0.0", PATH: "" });

  it("a host that turns reach writes its own wsp and puts it first on their PATH; one that turns do not reach writes nothing", () => {
    const statePath = join(dir, "home", "state.json");
    const served = servingWiring(statePath, { here: {}, run: started("/opt/wsp/dist/bin.js") }, dir, { PATH: "/usr/bin" });
    expect(served.env()["PATH"]).toBe(`${threadBinDir(statePath)}${delimiter}/usr/bin`);
    expect(readFileSync(join(threadBinDir(statePath), "wsp"), "utf8")).toContain("/opt/wsp/dist/bin.js");
    const other = join(dir, "other", "state.json");
    expect(servingWiring(other, undefined, dir, { PATH: "/usr/bin" }).env()["PATH"]).toBe("/usr/bin");
    expect(existsSync(threadBinDir(other))).toBe(false);
  });

  it("is what a runtime built to serve turns wires, with no wiring handed in", async () => {
    const statePath = join(dir, "served", "state.json");
    const rt = makeRuntime({}, statePath, undefined, {}, { here: {}, run: started("/opt/wsp/dist/bin.js") });
    try {
      expect(readFileSync(join(threadBinDir(statePath), "wsp"), "utf8")).toContain("/opt/wsp/dist/bin.js");
    } finally {
      await rt.close();
    }
  });

  it("names its own workspace from the copy it runs in, asking only for what a thread may read", async () => {
    const copy = join(dir, "proj-lead");
    execFileSync("git", ["init", "-q", copy]);
    const lead = { id: "ws_lead", name: "lead", home: dir, project: { id: "pr_1", name: "proj", path: join(dir, "proj"), computer: "here" }, copy: { path: copy } };
    const asked: string[] = [];
    const client = {
      request: async (op: string) => {
        asked.push(op);
        if (op === "workspaces.list") return { workspaces: [lead] };
        throw new Error(`${op} is not a thread's to ask for`);
      },
    } as unknown as HostClient;
    expect((await threadTarget(client, undefined, join(copy), "workspace")).workspace).toBe(lead);
    expect(asked).toEqual(["workspaces.list"]);
  });
});
