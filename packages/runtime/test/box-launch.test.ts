// SPDX-License-Identifier: AGPL-3.0-only
// A box thread's turn as its launch reaches the box: run the way a box's daemon runs an exec frame, bash -c on the
// command with the frame's stdin and the frame held to the daemon's schema, against this computer's own shells.
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlaceFolderMachine, spawnSyncFed } from "@wsp/engine";
import { DaemonExecRequest, cgroupJoinLine, placeDaemonPaths, threadCgroup } from "@wsp/protocol";
import { writeStub } from "../../protocol/test/stub-script.js";
import { machineExecStream } from "../src/machine-exec.js";
import { LINUX_SHELL_PRELUDE } from "./linux-shell.js";

const CGROUP = threadCgroup("thread-1");
/** Root on Linux, where runuser hands a turn to another login as the box's daemon does; a Mac has no runuser. */
const ROOT = process.platform === "linux" && process.getuid?.() === 0;
/** The login nobody signs in as, which every Linux computer has: a box's login that is not root, where this suite is. */
const NOBODY = 65534;
/** The PATH a box's login shell gives it with a few toolchains installed, which every launch line carries, answered
 * here for the login's own shell so a frame measures the same on any computer this suite runs on. */
const LOGIN_PATH = "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/root/go/bin:/root/.cargo/bin:/root/.local/share/pnpm:/root/.bun/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** A box's daemon answering the exec frame: the frame parsed as the daemon parses it, so a command past its cap is
 * refused, the login shell's PATH read as `loginPath` however runuser quoted the read, and bash -c on anything else
 * with the frame's stdin. The line that stands the launch in the thread's cgroup is left out, since as root here it
 * would move this suite's shell into one. */
function daemonLink(home: string, loginPath = LOGIN_PATH) {
  return {
    request: async (op: string, params: Record<string, unknown> = {}) => {
      const frame = DaemonExecRequest.parse({ id: "1", op, ...params });
      if (frame.cmd.includes("-ilc ") && frame.cmd.includes(`printf %s "$PATH"`)) return { exitCode: 0, stdout: loginPath, stderr: "", truncated: false };
      const cmd = frame.cmd.replace(`${cgroupJoinLine(CGROUP)}\n`, "");
      const stdin = frame.stdin !== undefined ? Buffer.from(frame.stdin, "base64") : new Uint8Array();
      const ran = spawnSyncFed("bash", ["-c", `${LINUX_SHELL_PRELUDE}${cmd}`], stdin, { encoding: "utf8", cwd: home, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, timeout: 15_000 });
      return { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr, truncated: false };
    },
  };
}

const onPath = (name: string): string | undefined => (process.env["PATH"] ?? "").split(delimiter).filter(d => d !== "").map(d => join(d, name)).find(p => existsSync(p));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wsp-box-launch-"));
});
afterEach(() => {
  if (existsSync(placeDaemonPaths(home).guestBin)) chmodSync(placeDaemonPaths(home).guestBin, 0o755);
  rmSync(home, { recursive: true, force: true });
});

const turn = async (command: string, input?: string[], o: { loginPath?: string; follow?: string } = {}): Promise<string[]> => {
  const at = placeDaemonPaths(home);
  const machine = new PlaceFolderMachine(daemonLink(home, o.loginPath), { id: "hetzner", home });
  const stream = machineExecStream(machine, { pollMs: 20, runDir: at.runDir, launchOn: machine.inCgroup(CGROUP, at.guestBin) })(command, { env: {}, ...(input !== undefined ? { input } : {}) });
  if (o.follow !== undefined) expect(await stream.write(o.follow)).toBe("written");
  const lines: string[] = [];
  for await (const line of stream.lines) lines.push(line);
  expect(await stream.exited).toBe(0);
  return lines;
};

/** The wsp the box's daemon writes for its threads, an older one in the login's own folder, and the login's own
 * startup files, whose profile rebuilds PATH with the older one first, as a login shell on hetzner does. */
const box = (): string => {
  const at = placeDaemonPaths(home);
  mkdirSync(placeDaemonPaths(home).guestBin, { recursive: true });
  writeStub(join(at.guestBin, "wsp"), "#!/bin/sh\necho thread\n");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeStub(join(home, ".local", "bin", "wsp"), "#!/bin/sh\necho older\n");
  const profile = 'export PATH="$HOME/.local/bin:/usr/bin:/bin"; export PROFILE_RAN=1\n';
  for (const file of [".bash_profile", ".zprofile"]) writeFileSync(join(home, file), profile);
  writeFileSync(join(home, ".zshenv"), "export ZSHENV_RAN=1\n");
  return join(at.guestBin, "wsp");
};

describe("a login shell inside a box thread's turn", () => {
  it("finds the box's own wsp first under bash -lc, as Codex runs every command, and under bash -c", async () => {
    const wsp = box();
    expect(await turn(`bash -lc 'command -v wsp; echo "$PROFILE_RAN"'; bash -c 'command -v wsp'`)).toEqual([wsp, "1", wsp]);
  });

  it.skipIf(onPath("zsh") === undefined)("finds the box's own wsp first under zsh -lc, after the login's own zsh files ran", async () => {
    const wsp = box();
    expect(await turn(`zsh -lc 'command -v wsp; echo "$PROFILE_RAN $ZSHENV_RAN"'`)).toEqual([wsp, "1 1"]);
  });

  // The daemon makes the folder as root, so a login that is not root cannot write into it: as root here the turn runs
  // as nobody with the folder root's, and anywhere else the folder is one its own login cannot write.
  it("keeps the login's own startup files where it cannot write the box's folder", async () => {
    box();
    if (ROOT) {
      chmodSync(tmpdir(), statSync(tmpdir()).mode | 0o011);
      chownSync(home, NOBODY, NOBODY);
      for (const file of [".bash_profile", ".zprofile", ".zshenv"]) chownSync(join(home, file), NOBODY, NOBODY);
      chownSync(placeDaemonPaths(home).wsp, NOBODY, NOBODY);
      chmodSync(placeDaemonPaths(home).guestBin, 0o755);
    } else chmodSync(placeDaemonPaths(home).guestBin, 0o555);
    const zsh = onPath("zsh") === undefined ? [] : [`zsh -lc 'echo "$PROFILE_RAN $ZSHENV_RAN \${ZDOTDIR-none}"'`];
    expect(await turn([`bash -lc 'echo "$PROFILE_RAN \${BASH_ENV-none}"'`, ...zsh].join("; "))).toEqual(["1 none", ...(zsh.length > 0 ? ["1 1 none"] : [])]);
  });
});

describe("a box thread's launch", () => {
  // Every frame the launch sends, its pieces included, carries the line that stands it in the thread's cgroup and
  // writes the shells' startup files, and the daemon refuses a frame past its cap however the frame was cut.
  for (const length of [11_000, 30_000]) {
    it(`starts with a first message of ${length} characters, every frame under the daemon's cap`, async () => {
      box();
      expect(await turn(`head -c ${length} | wc -c | tr -d ' '`, ["x".repeat(length)])).toEqual([String(length)]);
    });
  }
});

describe("a message sent into a running box turn", () => {
  // A login PATH of 701 characters, as a box with two dozen toolchains gives one, which every frame of the write carries.
  const longPath = [...Array.from({ length: 24 }, (_, i) => `/opt/toolchains/tool-${String(i).padStart(2, "0")}/bin`), "/usr/sbin:/usr/bin:/sbin:/bin"].join(":");
  const follow = (length: number): string => "say 'it' \"whole\" $HOME é ".repeat(Math.ceil(length / 25)).slice(0, length);
  const sha = (text: string): string => createHash("sha256").update(`${text}\n`).digest("hex");
  // Handing the turn to another login takes root, as the box's daemon has.
  const logins = [
    { as: "the login the daemon runs as", owner: undefined },
    { as: "another login under runuser", owner: NOBODY },
  ];
  for (const { as, owner } of logins) {
    for (const length of [30_000, 100_000]) {
      it.skipIf(owner !== undefined && !ROOT)(`reaches the agent whole at ${length} characters, as ${as}, every frame under the daemon's cap`, async () => {
        if (owner !== undefined) {
          chmodSync(tmpdir(), statSync(tmpdir()).mode | 0o011);
          chownSync(home, owner, owner);
        }
        const text = follow(length);
        expect(await turn(`read -r first; IFS= read -r second; printf '%s\\n' "$second" | sha256sum | cut -d' ' -f1; id -u`, ["go"], { loginPath: longPath, follow: text })).toEqual([sha(text), String(owner ?? process.getuid?.())]);
      });
    }
  }
});
