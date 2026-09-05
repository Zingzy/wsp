import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PtyManager, ptyEnv, ptyLaunch } from "../src/pty-manager.js";

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

describe("ptyLaunch", () => {
  const me = { homedir: "/root", username: "root", shell: "/usr/bin/zsh" };
  const saved = process.env["SHELL"];
  afterEach(() => {
    if (saved === undefined) delete process.env["SHELL"];
    else process.env["SHELL"] = saved;
  });

  it("with no shell named, runs the passwd row's shell as a login shell, and SHELL names it for what that shell spawns", () => {
    process.env["SHELL"] = "/bin/bash";
    const launch = ptyLaunch({}, me);
    expect(launch).toMatchObject({ file: "/usr/bin/zsh", args: ["-l"] });
    expect(launch.env["SHELL"]).toBe("/usr/bin/zsh");
  });

  it("a row that names no shell falls back to bash as a login shell and leaves SHELL alone", () => {
    delete process.env["SHELL"];
    const launch = ptyLaunch({}, { ...me, shell: "" });
    expect(launch).toMatchObject({ file: "bash", args: ["-l"] });
    expect(launch.env).not.toHaveProperty("SHELL");
  });

  it("a shell the request names runs as asked, not as a login shell, with SHELL as inherited", () => {
    process.env["SHELL"] = "/inherited/sh";
    const launch = ptyLaunch({ shell: "/bin/sh", env: { PS1: "" } }, me);
    expect(launch).toMatchObject({ file: "/bin/sh", args: [] });
    expect(launch.env).toMatchObject({ SHELL: "/inherited/sh", PS1: "" });
  });

  it("a SHELL the request's own env names wins over the passwd row", () => {
    expect(ptyLaunch({ env: { SHELL: "/opt/fish" } }, me).env["SHELL"]).toBe("/opt/fish");
  });

  it("the shell it spawns is a login shell: it reads the profile of the home it is given", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wsp-pty-home-")));
    for (const rc of [".profile", ".bash_profile", ".zprofile"]) writeFileSync(join(home, rc), "echo WSP-LOGIN-PROFILE\n");
    mkdirSync(join(home, ".config", "fish"), { recursive: true });
    writeFileSync(join(home, ".config", "fish", "config.fish"), "status is-login; and echo WSP-LOGIN-PROFILE\n");
    const mgr = new PtyManager();
    const s = mgr.create({ cols: 80, rows: 24, cwd: home, env: { HOME: home, ZDOTDIR: home, XDG_CONFIG_HOME: join(home, ".config") } });
    const got: string[] = [];
    s.attach(d => got.push(d));
    const deadline = Date.now() + 5_000;
    while (!got.join("").includes("WSP-LOGIN-PROFILE") && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    mgr.destroyAll();
    expect(got.join("")).toContain("WSP-LOGIN-PROFILE");
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
