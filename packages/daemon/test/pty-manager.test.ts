import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workScoreLine } from "@wsp/protocol";
import { PtyManager, ptyEnv, ptyLaunch } from "../src/pty-manager.js";

/** Above the 10 s wait budget, so the helper's error with the transcript is what a red run shows. */
const PTY_CASE_TIMEOUT_MS = 15_000;

const managers: PtyManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.destroyAll();
});
function manager(): PtyManager {
  const m = new PtyManager();
  managers.push(m);
  return m;
}

/** The budget is a ceiling: under a full gate bash has taken over a second to start and echo. */
async function until(read: () => string, marker: string, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!read().includes(marker)) {
    if (Date.now() >= deadline) throw new Error(`no ${JSON.stringify(marker)} within ${budgetMs} ms; output so far: ${JSON.stringify(read())}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

describe("PtyManager", () => {
  it("keeps a session alive across client detach and replays scrollback", async () => {
    const s = manager().create({ cols: 80, rows: 24, shell: "bash" });
    const got: string[] = [];
    const un1 = s.attach(d => got.push(d));
    s.write("echo HELLO-$((1+1))\n");
    await until(() => got.join(""), "HELLO-2");
    un1();
    s.write("echo AFTER-DETACH\n");
    const landed: string[] = [];
    const unLanded = s.attach(d => landed.push(d));
    await until(() => landed.join(""), "AFTER-DETACH");
    unLanded();
    const replay: string[] = [];
    s.attach(d => replay.push(d));
    expect(replay.join("")).toContain("HELLO-2");
    expect(replay.join("")).toContain("AFTER-DETACH");
  }, PTY_CASE_TIMEOUT_MS);
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
    const s = manager().create({ cols: 80, rows: 24, shell: "bash", cwd: tmpdir() });
    const got: string[] = [];
    s.attach(d => got.push(d));
    s.write("echo HOME=$HOME USER=$USER\n");
    await until(() => got.join(""), `HOME=${userInfo().homedir} USER=${userInfo().username}\r`);
    expect(got.join("")).toContain(`HOME=${userInfo().homedir} USER=${userInfo().username}\r`);
  }, PTY_CASE_TIMEOUT_MS);
});

describe("ptyLaunch", () => {
  const me = { homedir: "/root", username: "root", shell: "/usr/bin/zsh" };
  // Every shell starts behind this sh line: off the daemon's memory-killer score and priority, then exec'd into, so the pid is the shell's.
  const WRAP = `${workScoreLine()}; exec "$0" "$@"`;
  const saved = process.env["SHELL"];
  afterEach(() => {
    if (saved === undefined) delete process.env["SHELL"];
    else process.env["SHELL"] = saved;
  });

  it("with no shell named, runs the passwd row's shell as a login shell, and SHELL names it for what that shell spawns", () => {
    process.env["SHELL"] = "/bin/bash";
    const launch = ptyLaunch({}, me);
    expect(launch).toMatchObject({ file: "/bin/sh", args: ["-c", WRAP, "/usr/bin/zsh", "-l"] });
    expect(launch.env["SHELL"]).toBe("/usr/bin/zsh");
  });

  it("a row that names no shell falls back to bash as a login shell and leaves SHELL alone", () => {
    delete process.env["SHELL"];
    const launch = ptyLaunch({}, { ...me, shell: "" });
    expect(launch).toMatchObject({ file: "/bin/sh", args: ["-c", WRAP, "bash", "-l"] });
    expect(launch.env).not.toHaveProperty("SHELL");
  });

  it("a shell the request names runs as asked, not as a login shell, with SHELL as inherited", () => {
    process.env["SHELL"] = "/inherited/sh";
    const launch = ptyLaunch({ shell: "/bin/dash", env: { PS1: "" } }, me);
    expect(launch).toMatchObject({ file: "/bin/sh", args: ["-c", WRAP, "/bin/dash"] });
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
    const s = manager().create({ cols: 80, rows: 24, cwd: home, env: { HOME: home, ZDOTDIR: home, XDG_CONFIG_HOME: join(home, ".config") } });
    const got: string[] = [];
    s.attach(d => got.push(d));
    await until(() => got.join(""), "WSP-LOGIN-PROFILE");
    expect(got.join("")).toContain("WSP-LOGIN-PROFILE");
  }, PTY_CASE_TIMEOUT_MS);
});

describe("PtySession cwd", () => {
  async function pwdOf(opts: { cwd?: string }, expected: string): Promise<string> {
    const s = manager().create({ cols: 80, rows: 24, shell: "bash", ...opts });
    const got: string[] = [];
    s.attach(d => got.push(d));
    s.write("echo CWD=$PWD\n");
    await until(() => got.join(""), expected);
    return got.join("");
  }

  it("starts in the home directory, not wherever the daemon runs", async () => {
    expect(await pwdOf({}, `CWD=${homedir()}\r`)).toContain(`CWD=${homedir()}\r`);
  }, PTY_CASE_TIMEOUT_MS);

  it("starts in the requested cwd when one is named", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wsp-pty-")));
    expect(await pwdOf({ cwd: dir }, `CWD=${dir}\r`)).toContain(`CWD=${dir}\r`);
  }, PTY_CASE_TIMEOUT_MS);
});
