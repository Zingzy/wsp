import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PtyManager } from "../src/pty-manager.js";

describe("PtyManager", () => {
  it("keeps a session alive across client detach and replays scrollback", async () => {
    const mgr = new PtyManager();
    const s = mgr.create({ cols: 80, rows: 24, shell: "bash" });
    const got: string[] = [];
    const un1 = s.attach(d => got.push(d));
    s.write("echo HELLO-$((1+1))\n");
    await new Promise(r => setTimeout(r, 300));
    un1(); // client goes away
    s.write("echo AFTER-DETACH\n");
    await new Promise(r => setTimeout(r, 300));
    const replay: string[] = [];
    s.attach(d => replay.push(d)); // new client gets buffered scrollback first
    await new Promise(r => setTimeout(r, 50));
    expect(replay.join("")).toContain("HELLO-2");
    expect(replay.join("")).toContain("AFTER-DETACH");
    mgr.destroyAll();
  });
});

describe("PtySession cwd", () => {
  async function pwdOf(opts: { cwd?: string }): Promise<string> {
    const mgr = new PtyManager();
    const s = mgr.create({ cols: 80, rows: 24, shell: "bash", ...opts });
    const got: string[] = [];
    s.attach(d => got.push(d));
    s.write("echo CWD=$PWD\n");
    await new Promise(r => setTimeout(r, 300));
    mgr.destroyAll();
    return got.join("");
  }

  it("starts in the home directory, not wherever the daemon runs", async () => {
    expect(await pwdOf({})).toContain(`CWD=${homedir()}\r`);
  });

  it("starts in the requested cwd when one is named", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wsp-pty-")));
    expect(await pwdOf({ cwd: dir })).toContain(`CWD=${dir}\r`);
  });
});
