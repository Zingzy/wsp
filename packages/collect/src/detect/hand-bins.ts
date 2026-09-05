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

export type BinFormat =
  | { kind: "mach-o" }
  /** arch is absent when the header names one no machine runs. */
  | { kind: "elf"; arch?: string }
  /** at is the interpreter's path when the shebang names one outside the system dirs, so it exists only on this laptop. */
  | { kind: "script"; interpreter: string; at?: string }
  | { kind: "unknown" };

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

/** Interpreter directories every Linux machine has; a shebang naming one elsewhere points at a laptop install. */
const SYSTEM_BIN = ["/bin/", "/usr/bin/"];
/** Interpreters the base image has at /usr/bin with no tools row: Debian's essential set (bash, sh, perl) and python3, seen at /usr/bin/python3 on 2026-09-04. */
export const BASE_INTERPRETERS: ReadonlySet<string> = new Set(["bash", "sh", "perl", "python3"]);

/** The interpreter a shebang names: the command after `env` and its flags, else the interpreter's basename, with its path when the machine will not have it. */
function shebang(line: string): { interpreter: string; at?: string } {
  const [first = "", ...rest] = line.slice(2).trim().split(/\s+/);
  const name = first.slice(first.lastIndexOf("/") + 1);
  if (name === "env") return { interpreter: rest.find(w => !w.startsWith("-")) ?? name };
  return first.startsWith("/") && !SYSTEM_BIN.some(d => first.startsWith(d)) ? { interpreter: name, at: first } : { interpreter: name };
}

/** The first line a copied script carries so the machine finds its interpreter by name on PATH; undefined when the line already does. */
export function portableShebang(line: string): string | undefined {
  if (!line.startsWith("#!")) return undefined;
  const { interpreter, at } = shebang(line);
  if (at === undefined) return undefined;
  const args = line.slice(2).trim().split(/\s+/).slice(1);
  return args.length === 0 ? `#!/usr/bin/env ${interpreter}` : `#!/usr/bin/env -S ${interpreter} ${args.join(" ")}`;
}

export function formatOf(head: Uint8Array): BinFormat {
  if (MACH_O.some(m => startsWith(head, m))) return { kind: "mach-o" };
  if (startsWith(head, ELF)) {
    const little = head[5] === 1;
    const machine = little ? (head[18] ?? 0) | ((head[19] ?? 0) << 8) : ((head[18] ?? 0) << 8) | (head[19] ?? 0);
    const arch = ELF_ARCH[machine];
    return arch === undefined ? { kind: "elf" } : { kind: "elf", arch };
  }
  if (head[0] === 0x23 && head[1] === 0x21) {
    const text = Buffer.from(head).toString("utf8").split("\n")[0] ?? "";
    return { kind: "script", ...shebang(text) };
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
      const format = formatOf(probe.head);
      if (format.kind === "script" && format.at !== undefined) format.at = tilde(host.home, format.at);
      out.push({ name, path, ...(probe.target !== undefined ? { target: tilde(host.home, probe.target) } : {}), format, bytes });
    }
  }
  return out;
}

const NO_ARCH = "for neither x86_64 nor aarch64";

function words(bin: HandBin, brings: ReadonlySet<string>): string {
  const dir = bin.path.slice(0, bin.path.lastIndexOf("/"));
  const size = fmt(bin.bytes);
  const copy = `travels as a copy into ${dir} on the machine if ticked${dir === "~/bin" ? ", and ~/bin is not on the machine's PATH" : ""}`;
  const f = bin.format;
  switch (f.kind) {
    case "mach-o":
      return `a macOS binary (Mach-O) of ${size} in ${dir}, installed by hand; a Linux build has to be installed on the machine by hand`;
    case "elf":
      if (f.arch === undefined) return `a Linux binary (ELF) of ${size} in ${dir} ${NO_ARCH}, installed by hand; no machine runs it`;
      return `a Linux binary (ELF, ${f.arch}) of ${size} in ${dir}, installed by hand; runs only on an ${f.arch} machine; ${copy}`;
    case "script": {
      const lead = `a ${f.interpreter} script of ${size} in ${dir}, installed by hand`;
      if (f.at === undefined) return `${lead}; ${copy}`;
      if (BASE_INTERPRETERS.has(f.interpreter)) return `${lead}; runs with ${f.at} here and with the machine's own ${f.interpreter} there; ${copy}`;
      if (brings.has(f.interpreter)) return `${lead}; runs with ${f.at} here; the copy finds ${f.interpreter} on the machine's PATH instead, so the ${f.interpreter} row has to be ticked too; ${copy}`;
      return `${lead}; runs with ${f.at} here, and neither the machine nor a tools row brings ${f.interpreter}`;
    }
    case "unknown":
      return `a file of ${size} in ${dir} of no recognised format, installed by hand; nothing can install it on the machine`;
  }
}

/** Why the row is locked off; undefined when a copy of the file can run on the machine. */
function locked(f: BinFormat, brings: ReadonlySet<string>): string | undefined {
  switch (f.kind) {
    case "mach-o":
      return "installed by hand; no Linux build known";
    case "elf":
      return f.arch === undefined ? `installed by hand; a Linux binary ${NO_ARCH}` : undefined;
    case "script":
      return f.at !== undefined && !brings.has(f.interpreter) ? `installed by hand; needs ${f.interpreter}, which the machine lacks and no tools row brings` : undefined;
    case "unknown":
      return "installed by hand; no recognised format";
  }
}

/** Whether the file's format can run on a Linux machine when copied there; a script may still want its interpreter brought. */
export const carries = (f: BinFormat): boolean => f.kind === "script" || (f.kind === "elf" && f.arch !== undefined);

/** The commands the machine has without a hand row: the base image's interpreters and each installable tools row's command, the last id segment minus a formula's version suffix (python@3.12). */
export function brought(rows: readonly ManifestEntry[]): Set<string> {
  const installable = rows.filter(r => r.rung === "tools" && !r.id.startsWith(HAND_PREFIX) && r.reason === undefined);
  return new Set([...BASE_INTERPRETERS, ...installable.map(r => r.id.slice(r.id.lastIndexOf("/") + 1).replace(/@.*$/, ""))]);
}

export function handRow(bin: HandBin, brings: ReadonlySet<string>): ManifestEntry {
  const detail = bin.target === undefined ? words(bin, brings) : `${words(bin, brings)}; a link to ${bin.target}`;
  const base = { rung: "tools" as const, id: `${HAND_PREFIX}${bin.name}`, label: bin.name, group: HAND_GROUP, paths: [bin.path], bytes: bin.bytes, default: "skip" as const, detail };
  const reason = locked(bin.format, brings);
  if (reason !== undefined) return entry({ ...base, reason, linux: "no" });
  return entry({ ...base, linux: "unknown", ...(bin.format.kind === "elf" && bin.format.arch !== undefined ? { arch: bin.format.arch } : {}) });
}

export async function handRows(host: Host, brings: ReadonlySet<string>): Promise<ManifestEntry[]> {
  return (await handBins(host)).map(b => handRow(b, brings));
}
