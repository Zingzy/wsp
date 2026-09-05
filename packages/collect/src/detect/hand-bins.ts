// SPDX-License-Identifier: AGPL-3.0-only
// Executables put in ~/.local/bin or ~/bin by an installer script or by hand:
// no package manager lists them, so nothing on the machine can install them.
// A binary built for macOS stays here; a script or a Linux binary can travel
// as a copy of the file. The row says which from the file's first bytes.
import { type Host, expand } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { entry, fmt } from "./common.js";

export const HAND_GROUP = "Installed by hand";
export const HAND_PREFIX = "tools/hand/";
export const HAND_DIRS: readonly string[] = ["~/.local/bin", "~/bin"];

export type BinFormat = { kind: "mach-o" } | { kind: "elf"; arch: string } | { kind: "script"; interpreter: string } | { kind: "unknown" };

export interface HandBin {
  name: string;
  /** `~/`-relative path of the entry in its bin directory. */
  path: string;
  /** Where a link resolves, `~`-relative when under home. */
  target?: string;
  format: BinFormat;
  bytes: number;
}

const MACH_O = [
  [0xfe, 0xed, 0xfa, 0xce], [0xce, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca],
];
const ELF = [0x7f, 0x45, 0x4c, 0x46];
const ELF_ARCH: Record<number, string> = { 0x3e: "x86_64", 0xb7: "aarch64" };

const startsWith = (head: Uint8Array, magic: readonly number[]): boolean => magic.every((b, i) => head[i] === b);

/** The interpreter a shebang names: the command after `env` and its flags, else the interpreter's basename. */
function interpreterOf(line: string): string {
  const [first = "", ...rest] = line.slice(2).trim().split(/\s+/);
  const name = first.slice(first.lastIndexOf("/") + 1);
  return name === "env" ? (rest.find(w => !w.startsWith("-")) ?? name) : name;
}

export function formatOf(head: Uint8Array): BinFormat {
  if (MACH_O.some(m => startsWith(head, m))) return { kind: "mach-o" };
  if (startsWith(head, ELF)) {
    const little = head[5] === 1;
    const machine = little ? (head[18] ?? 0) | ((head[19] ?? 0) << 8) : ((head[18] ?? 0) << 8) | (head[19] ?? 0);
    return { kind: "elf", arch: ELF_ARCH[machine] ?? "another arch" };
  }
  if (head[0] === 0x23 && head[1] === 0x21) {
    const text = Buffer.from(head).toString("utf8").split("\n")[0] ?? "";
    return { kind: "script", interpreter: interpreterOf(text) };
  }
  return { kind: "unknown" };
}

/** Where a package manager or an app keeps what it installs; a link from a bin directory into one is that manager's, not the person's. */
function managedRoots(home: string): string[] {
  return [
    "/opt/homebrew/", "/usr/local/Cellar/", "/usr/local/Caskroom/", "/usr/local/Homebrew/", "/home/linuxbrew/", "/nix/",
    "/Applications/", `${home}/Applications/`,
    `${home}/go/`, `${home}/.cargo/`, `${home}/.rustup/`,
    `${home}/.local/share/pnpm/`, `${home}/Library/pnpm/`, `${home}/.npm-global/`, `${home}/.nvm/`, `${home}/.volta/`, `${home}/.local/share/fnm/`, `${home}/.bun/`,
    `${home}/.local/share/uv/`, `${home}/.local/pipx/`, `${home}/.local/share/pipx/`, `${home}/Library/Application Support/pipx/`,
    `${home}/.local/share/mise/`, `${home}/.asdf/`,
  ];
}

const managed = (target: string, home: string): boolean => target.includes("/node_modules/") || managedRoots(home).some(r => target.startsWith(r));

const tilde = (home: string, p: string): string => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

/** The executables in the bin directories that no manager owns, in directory then name order. */
export async function handBins(host: Host): Promise<HandBin[]> {
  const out: HandBin[] = [];
  for (const dir of HAND_DIRS) {
    for (const name of await host.fs.list(expand(host, dir))) {
      const path = `${dir}/${name}`;
      const abs = expand(host, path);
      const probe = await host.fs.probe(abs);
      if (probe === undefined || !probe.executable) continue;
      if (probe.target !== undefined && managed(probe.target, host.home)) continue;
      const bytes = (await host.fs.stat(abs))?.bytes ?? 0;
      out.push({ name, path, ...(probe.target !== undefined ? { target: tilde(host.home, probe.target) } : {}), format: formatOf(probe.head), bytes });
    }
  }
  return out;
}

const LOCKED = "installed by hand; no Linux build known";

function words(bin: HandBin): string {
  const dir = bin.path.slice(0, bin.path.lastIndexOf("/"));
  const size = fmt(bin.bytes);
  const copy = `travels as a copy into ${dir} on the machine if ticked${dir === "~/bin" ? ", and ~/bin is not on the machine's PATH" : ""}`;
  const f = bin.format;
  switch (f.kind) {
    case "mach-o":
      return `a macOS binary (Mach-O) of ${size} in ${dir}, installed by hand; a Linux build has to be installed on the machine by hand`;
    case "elf":
      return `a Linux binary (ELF, ${f.arch}) of ${size} in ${dir}, installed by hand; ${copy}`;
    case "script":
      return `a ${f.interpreter} script of ${size} in ${dir}, installed by hand; ${copy}`;
    case "unknown":
      return `a file of ${size} in ${dir} of no recognised format, installed by hand; nothing can install it on the machine`;
  }
}

/** Whether the file itself can run on the machine when copied there. */
export const carries = (f: BinFormat): boolean => f.kind === "script" || f.kind === "elf";

export function handRow(bin: HandBin): ManifestEntry {
  const detail = bin.target === undefined ? words(bin) : `${words(bin)}; a link to ${bin.target}`;
  const base = { rung: "tools" as const, id: `${HAND_PREFIX}${bin.name}`, label: bin.name, group: HAND_GROUP, paths: [bin.path], bytes: bin.bytes, default: "skip" as const, detail };
  return carries(bin.format) ? entry({ ...base, linux: "unknown" }) : entry({ ...base, reason: LOCKED, linux: "no" });
}

export async function handRows(host: Host): Promise<ManifestEntry[]> {
  return (await handBins(host)).map(handRow);
}
