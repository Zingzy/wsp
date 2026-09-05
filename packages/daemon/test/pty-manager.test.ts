import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PtyManager, ptyEnv } from "../src/pty-manager.js";

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

describe("ptyEnv", () => {
  const saved = { HOME: process.env["HOME"], USER: process.env["USER"], __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: process.env["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"] };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("fills HOME and USER from the passwd row of the daemon's uid when the daemon was started without them", () => {
    delete process.env["HOME"];
    process.env["USER"] = "";
    const env = ptyEnv();
    expect(env["HOME"]).toBe(userInfo().homedir);
    expect(env["USER"]).toBe(userInfo().username);
    expect(env).not.toHaveProperty("DISPLAY");
  });

  it("keeps the HOME and USER it inherited, and lets a caller's env win over both", () => {
    process.env["HOME"] = "/srv/elsewhere";
    process.env["USER"] = "someone";
    expect(ptyEnv()).toMatchObject({ HOME: "/srv/elsewhere", USER: "someone" });
    expect(ptyEnv({ HOME: "/tmp/h", USER: "u" })).toMatchObject({ HOME: "/tmp/h", USER: "u" });
  });

  it("what the daemon was started with reaches every pty: the preview host allowance the deploy script exports rides along", () => {
    process.env["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"] = ".preview.example.com";
    expect(ptyEnv()["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"]).toBe(".preview.example.com");
  });

  it("a shell it spawns sees HOME even when the daemon has none", async () => {
    delete process.env["HOME"];
    const mgr = new PtyManager();
    const s = mgr.create({ cols: 80, rows: 24, shell: "bash", cwd: tmpdir() });
    const got: string[] = [];
    s.attach(d => got.push(d));
    s.write("echo HOME=$HOME USER=$USER\n");
    await new Promise(r => setTimeout(r, 300));
    mgr.destroyAll();
    expect(got.join("")).toContain(`HOME=${userInfo().homedir} USER=${userInfo().username}\r`);
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
