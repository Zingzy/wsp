// SPDX-License-Identifier: AGPL-3.0-only
// What a machine that already existed says about itself: the system it runs
// and how long it has been up. The answers are the same wherever the machine
// is, so the lines that ask for them and the readings of what came back live
// here once and the kinds that reach a machine call them: this computer runs
// them in a shell of its own, a machine over ssh carries them over the
// connection. Everything here is one shell's worth of printf, since the only
// road every kind has to a machine is a command.

import type { ExecResult } from "./machine.js";

/** `key value` lines to a record, which is the shape every read here prints in: one answer per line, the key up to
 * the first space. A key whose command printed nothing is present and empty, which the readings below take as an
 * answer the machine does not have rather than as a value. */
export function readValues(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) values[line.slice(0, space)] = line.slice(space + 1).trim();
  }
  return values;
}

/** The lines that ask a machine what system it runs: the distribution's own name where the machine keeps one, the
 * product version where the maker is Apple, and the kernel with its release, which every unix answers whatever else
 * it has. Each is a printf of its own, so a machine missing one of the three still answers for the others. */
export const OS_READ: readonly string[] = [
  `printf "pretty %s\\n" "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -1 | tr -d '"')"`,
  `printf "mac %s\\n" "$(sw_vers -productVersion 2>/dev/null)"`,
  `printf "kernel %s %s\\n" "$(uname -s)" "$(uname -r)"`,
];

/** The lines that ask how long the machine has been up: the seconds Linux keeps in /proc, and the moment macOS says
 * it booted at, which is a time and not a length. */
export const UPTIME_READ: readonly string[] = [
  `printf "uptime %s\\n" "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"`,
  `printf "boot %s\\n" "$(sysctl -n kern.boottime 2>/dev/null)"`,
];

/** The line that asks where the machine's login lands, which on a machine somebody owns is the folder a command
 * starts in: the read that records a workspace and the read behind its rows both ask for it this way. */
export const HOME_READ = `printf "home %s\\n" "$HOME"`;

/** The operating system as its maker names it: macOS by its product version, a Linux by its distribution's own
 * name, and the kernel where neither answered. Absent where the machine answered none of the three, which is a
 * machine that did not run the lines rather than one without a name. */
export function osNameOf(values: Record<string, string>): string | undefined {
  const mac = values["mac"];
  if (mac !== undefined && mac !== "") return `macOS ${mac}`;
  const pretty = values["pretty"];
  if (pretty !== undefined && pretty !== "") return pretty;
  const kernel = values["kernel"];
  return kernel === undefined || kernel === "" ? undefined : kernel;
}

/** How long the machine has been up, in ms. Linux says it directly; macOS says when it booted, so the length is
 * read against the clock here, which is close enough for a row that shows days and hours and is the only reading
 * either machine offers. */
export function uptimeMsOf(values: Record<string, string>, now: number): number | undefined {
  const secs = Number(values["uptime"]);
  if (values["uptime"] !== undefined && values["uptime"] !== "" && Number.isFinite(secs)) return Math.round(secs * 1_000);
  const boot = /sec = (\d+)/.exec(values["boot"] ?? "")?.[1];
  return boot === undefined ? undefined : Math.max(0, now - Number(boot) * 1_000);
}

/** One command on a machine for the name of the system it runs; absent where the command failed or the machine
 * answered nothing, which leaves the caller to say what it knows without it. */
export async function readOsName(exec: (cmd: string) => Promise<ExecResult>): Promise<string | undefined> {
  const res = await exec(OS_READ.join("\n")).catch(() => undefined);
  return res === undefined || res.exitCode !== 0 ? undefined : osNameOf(readValues(res.stdout));
}
