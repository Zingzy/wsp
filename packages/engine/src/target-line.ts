// SPDX-License-Identifier: AGPL-3.0-only
// Who a line on a computer runs as. A box's daemon runs as root, so a line it
// runs as it is would read root's view of the person's home and write
// root-owned files into it. Every line that reads or writes the agents' files
// on a computer comes through here and runs as the owner of the home instead.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { noRunuserRefusal, shellQuote } from "@wsp/protocol";
import { landBytes } from "./land-bytes.js";
import type { Machine } from "./machine.js";

/** The login a computer's lines run as: its home and PATH, the owner of that home, and, where the road runs lines as
 * root and the home is somebody else's, the user every line is handed to. */
export interface TargetLogin {
  platform: "darwin" | "linux";
  home: string;
  path?: string;
  user: string;
  runAs?: string;
}

const PROBE_MS = 20_000;

/** The one read of who a computer's lines run as. `given` is the home and PATH the computer reported for its
 * login, which win over what the road's own shell has, since a box's daemon runs with root's. Refuses where the
 * road is root, the home is somebody else's and there is no runuser to hand the lines to: a line run as root there
 * is a root-owned file in that person's home. */
export async function targetLogin(machine: Pick<Machine, "exec">, given: { HOME?: string; PATH?: string } = {}): Promise<TargetLogin> {
  const home = given.HOME === undefined ? '"$HOME"' : shellQuote(given.HOME);
  const probe = [
    "uname -s",
    "id -u",
    "id -un",
    `stat -c %U ${home} 2>/dev/null || stat -f %Su ${home} 2>/dev/null || echo`,
    "command -v runuser >/dev/null 2>&1 && echo 1 || echo 0",
    `printf '%s\\n' "$HOME" "$PATH"`,
  ].join("; ");
  const res = await machine.exec(probe, { timeoutMs: PROBE_MS });
  if (res.exitCode !== 0) throw new Error(`the computer did not say who its lines run as: ${(res.stderr || res.stdout).trim().split("\n")[0] ?? ""}`);
  const [os = "", uid = "", self = "", owner = "", runuser = "", shellHome = "", shellPath = ""] = res.stdout.split("\n").map(l => l.trim());
  const platform: TargetLogin["platform"] = os === "Darwin" ? "darwin" : "linux";
  const user = owner === "" ? self : owner;
  const path = given.PATH ?? shellPath;
  const at: TargetLogin = { platform, home: given.HOME ?? shellHome, ...(path !== "" ? { path } : {}), user };
  if (platform !== "linux" || uid !== "0" || user === "root" || user === "") return at;
  if (runuser !== "1") throw new Error(noRunuserRefusal(user));
  return { ...at, runAs: user };
}

/** The line as that login runs it: its HOME and PATH exported, in its home, and handed to the home's owner where
 * the road runs as root. `bash -c`, never a login shell, which would reset the PATH. */
export function asLogin(t: TargetLogin, line: string): string {
  const inner = `export HOME=${shellQuote(t.home)}${t.path !== undefined ? ` PATH=${shellQuote(t.path)}` : ""}; cd "$HOME" 2>/dev/null; ${line}`;
  return t.runAs === undefined ? inner : `runuser -u ${shellQuote(t.runAs)} -- bash -c ${shellQuote(inner)}`;
}

/** Puts bytes at `dest` as that login: the bytes land in a staging file by the machine's own road, which may run as
 * root, then one line as the login writes them where they go, so the file is the login's and a file already there
 * keeps its mode. `unpack` takes the bytes as a gzipped tarball unpacked into the folder `dest`. The staging file
 * goes whatever happened. */
export async function landAsLogin(machine: Machine, t: TargetLogin, dest: string, bytes: Uint8Array, o: { unpack?: boolean; timeoutMs?: number } = {}): Promise<void> {
  const staging = `/tmp/wsp-land-${randomBytes(6).toString("hex")}`;
  const at = shellQuote(staging);
  try {
    await landBytes(machine, staging, bytes, o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {});
    if (t.runAs !== undefined) await machine.exec(`chmod 0644 ${at}`);
    const to = shellQuote(dest);
    const put = o.unpack === true ? `mkdir -p ${to} && tar -xzf ${at} -C ${to}` : `mkdir -p ${shellQuote(posix.dirname(dest))} && cat ${at} > ${to}`;
    const res = await machine.exec(asLogin(t, put), o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {});
    if (res.exitCode !== 0) throw new Error(`${dest} was not written as ${t.user}: ${(res.stderr || res.stdout).trim().split("\n")[0] ?? `exit ${res.exitCode}`}`);
  } finally {
    await machine.exec(`rm -f ${at}`).catch(() => undefined);
  }
}
