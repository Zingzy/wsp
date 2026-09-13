// SPDX-License-Identifier: AGPL-3.0-only
// Puts wsp-daemon binaries where the host's asset table reads them in a
// checkout, packages/wspx/daemon/<triple>/wsp-daemon, out of a cargo build or
// out of the artifacts the release job uploaded. Nothing in a node build makes
// them, so this runs before `pnpm build` wherever the command or the app is
// built. With --check it holds the folder against the host's own table.
//
//   node daemon-binary.mjs                        this machine's binary, out of daemon/target/release
//   node daemon-binary.mjs --triple T [--from F]  T's binary, out of daemon/target/T/release unless --from names it
//   node daemon-binary.mjs --from-artifacts DIR   every DIR/wsp-daemon-<triple>/wsp-daemon-<triple> a release job downloaded
//   node daemon-binary.mjs --check                every target the host names is there and executable; sizes printed
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const folder = fileURLToPath(new URL("../daemon", import.meta.url));
const ARTIFACT_PREFIX = "wsp-daemon-";
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;

/** The triple the toolchain on this machine builds for. Linux is spelled musl: the one Linux daemon wsp ships is
 * the static one, so a plain `cargo build` on a Linux box builds the wrong flavour and --triple names the right one. */
function tripleHere() {
  const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).split("\n").find(line => line.startsWith("host: "));
  if (host === undefined) throw new Error("rustc -vV named no host");
  return host.slice("host: ".length).trim().replace(/-linux-gnu$/, "-linux-musl");
}

/** The shared libraries a 64-bit little-endian ELF binary names, read the way the loader reads them: the dynamic
 * segment off the program headers and its string table through DT_STRTAB, never the section headers, which a
 * strip may drop. A binary with no dynamic segment names none. */
export function sharedLibrariesNamed(bytes) {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1) throw new Error("not a 64-bit little-endian ELF file");
  const phoff = Number(bytes.readBigUInt64LE(0x20));
  const phentsize = bytes.readUInt16LE(0x36);
  const phnum = bytes.readUInt16LE(0x38);
  const segments = [];
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    segments.push({ type: bytes.readUInt32LE(at), offset: Number(bytes.readBigUInt64LE(at + 8)), vaddr: Number(bytes.readBigUInt64LE(at + 16)), filesz: Number(bytes.readBigUInt64LE(at + 32)) });
  }
  const dynamic = segments.find(s => s.type === PT_DYNAMIC);
  if (dynamic === undefined) return [];
  const needed = [];
  let strtab;
  for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.filesz; at += 16) {
    const tag = Number(bytes.readBigInt64LE(at));
    const value = Number(bytes.readBigUInt64LE(at + 8));
    if (tag === DT_NULL) break;
    if (tag === DT_NEEDED) needed.push(value);
    if (tag === DT_STRTAB) strtab = value;
  }
  if (needed.length === 0) return [];
  const load = segments.find(s => s.type === PT_LOAD && strtab !== undefined && s.vaddr <= strtab && strtab < s.vaddr + s.filesz);
  if (load === undefined) throw new Error("a dynamic segment naming libraries without a string table to name them in");
  const strings = strtab - load.vaddr + load.offset;
  return needed.map(offset => bytes.subarray(strings + offset, bytes.indexOf(0, strings + offset)).toString());
}

/** Why the binary may not stand for the triple, or nothing. The Linux daemon is one static binary: a static-pie
 * binary loads no shared library, so one it names is a call to address zero at its first use. */
export function refusal(from, triple, bytes) {
  if (!triple.endsWith("-linux-musl")) return undefined;
  const named = sharedLibrariesNamed(bytes);
  if (named.length === 0) return undefined;
  return `${from} names shared libraries (${named.join(", ")}) and the Linux daemon is one static binary that loads none: build it in daemon/, where libseccomp links statically`;
}

function place(from, triple) {
  if (!existsSync(from)) throw new Error(`no daemon binary at ${from}; build it in daemon/ first`);
  const why = refusal(from, triple, readFileSync(from));
  if (why !== undefined) throw new Error(why);
  const to = join(folder, triple, "wsp-daemon");
  mkdirSync(join(folder, triple), { recursive: true });
  cpSync(from, to);
  chmodSync(to, 0o755);
  console.log(`${to} (${statSync(to).size} bytes)`);
}

async function check() {
  const { DAEMON_TARGETS, daemonBinaryIn, workspaceAsset } = await import("@wsp/host");
  const expected = workspaceAsset("daemon");
  if (expected !== folder) throw new Error(`the host reads the daemon asset from ${expected}, this script writes ${folder}`);
  const missing = [];
  for (const target of DAEMON_TARGETS) {
    const bin = daemonBinaryIn(folder, target.triple);
    if (!existsSync(bin) || (statSync(bin).mode & 0o111) === 0) missing.push(bin);
    else console.log(`${target.triple}: ${statSync(bin).size} bytes`);
  }
  if (missing.length !== 0) throw new Error(`daemon binaries missing or not executable:\n${missing.join("\n")}`);
}

function main(args) {
  const flag = name => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  if (args.includes("--check")) return check();
  const artifacts = flag("--from-artifacts");
  if (artifacts !== undefined) {
    const names = readdirSync(artifacts).filter(name => name.startsWith(ARTIFACT_PREFIX));
    if (names.length === 0) throw new Error(`no ${ARTIFACT_PREFIX}* folders under ${artifacts}`);
    for (const name of names) place(join(artifacts, name, name), name.slice(ARTIFACT_PREFIX.length));
    return;
  }
  const triple = flag("--triple") ?? tripleHere();
  const from = flag("--from") ?? (flag("--triple") === undefined ? join(repo, "daemon", "target", "release", "wsp-daemon") : join(repo, "daemon", "target", triple, "release", "wsp-daemon"));
  place(from, triple);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
