import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { shellQuote } from "@wsp/protocol";
import { backoffMs, classify, shouldRetry } from "./errors.js";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import type { Machine } from "./machine.js";

type Fetch = typeof globalThis.fetch;

export interface VaultOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  /** Export only: an archive over this many bytes is removed and refused with kind vaultTooLarge. */
  maxBytes?: number;
  /** Import only: merge into what the destination already holds instead of replacing its directories. */
  overlay?: boolean;
  /** Import only: called as each part lands, with the bytes sent so far. */
  onPart?: (progress: UploadProgress) => void;
  /** Export only: called as the archive comes down, with the bytes received so far of its total. */
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadProgress {
  bytes: number;
  total: number;
}

export interface UploadProgress {
  part: number;
  parts: number;
  bytes: number;
  total: number;
}

/** The archive at path on the guest, brought down over its signed URL; total is the size read on the guest when
 * the caller has it, else the archive's own length once it is here. */
async function download(machine: Machine, path: string, opts: VaultOptions, total?: number): Promise<Buffer> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = await machine.downloadUrl(path);
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`vault export download failed: HTTP ${res.status}`);
  if (opts.onProgress === undefined || res.body === null) return Buffer.from(await res.arrayBuffer());
  const length = Number(res.headers.get("content-length"));
  const known = total ?? (Number.isFinite(length) && length > 0 ? length : undefined);
  opts.onProgress({ bytes: 0, total: known ?? 0 });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = res.body.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks.push(Buffer.from(next.value));
    bytes += next.value.length;
    opts.onProgress({ bytes, total: known ?? bytes });
  }
  return Buffer.concat(chunks);
}

// Signed-URL transport on both directions (PoC P5: ~1s round trips). exec
// stdout could carry base64 for small exports but hits response-size limits.
export async function exportPaths(machine: Machine, paths: string[], opts: VaultOptions = {}): Promise<Buffer> {
  const tmp = `/tmp/wsp-vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tgz`;
  const rel = paths.map(p => shellQuote(p.replace(/^\//, "")));
  const tar = await machine.run(`tar czf ${shellQuote(tmp)} -C / ${rel.join(" ")}`, { deadlineMs: opts.timeoutMs ?? 120_000 });
  if (tar.exitCode !== 0) {
    throw new Error(`vault export tar failed (exit ${tar.exitCode}): ${tar.stderr.slice(-500)}`);
  }
  try {
    if (opts.maxBytes !== undefined) {
      const stat = await machine.exec(`stat -c %s ${shellQuote(tmp)}`, { timeoutMs: INLINE_EXEC_MS });
      const bytes = Number(stat.stdout.trim());
      if (stat.exitCode !== 0 || !Number.isFinite(bytes)) throw new Error(`vault export size unknown: ${stat.stderr.slice(-200)}`);
      if (bytes > opts.maxBytes) {
        throw Object.assign(new Error(`vault export is ${bytes} bytes, over the ${opts.maxBytes} byte cap`), { kind: "vaultTooLarge", bytes });
      }
    }
    return await download(machine, tmp, opts);
  } finally {
    await machine.exec(`rm -f ${shellQuote(tmp)}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
  }
}

/** What a folder's archive leaves behind: any entry whose name matches one of the globs (find's -name, so a bracket
 * expression spells a case rule), and any directory holding one of the marker files, whatever its name. */
export interface CacheRule {
  globs: readonly string[];
  markers: readonly string[];
}

/** The script that archives a folder on the guest from its own root into `out`: find names every cache root under
 * the rule, tar leaves those subtrees behind, and the roots come back on stdout one per line, relative to the folder.
 * Nothing under a .git directory is judged, as on the trip out. Only find and tar features both GNU and BSD have. */
export function folderExportScript(dir: string, rule: CacheRule, out: string): string {
  const named = [...rule.globs.map(g => `-name ${shellQuote(g)}`), ...rule.markers.map(m => `\\( -type d -exec test -f ${shellQuote(`{}/${m}`)} \\; \\)`)];
  const list = `${out}.list`;
  return [
    "set -eo pipefail",
    `cd ${shellQuote(dir)}`,
    `find . -mindepth 1 \\( -path './.git' -o -path '*/.git' \\) -prune -o \\( ${named.join(" -o ")} \\) -prune -print > ${shellQuote(list)}`,
    `tar czf ${shellQuote(out)} -X ${shellQuote(list)} .`,
    `sed 's|^\\./||' ${shellQuote(list)}`,
    `rm -f ${shellQuote(list)}`,
  ].join("\n");
}

/** A folder on the guest as an archive rooted at the folder, its caches left behind under the rule and named; the
 * folder is checked first so a wrong path costs one command, and the guest keeps nothing afterwards. */
export async function exportFolder(machine: Machine, dir: string, rule: CacheRule, opts: VaultOptions = {}): Promise<{ tar: Buffer; excluded: string[] }> {
  const probe = await machine.exec(`test -d ${shellQuote(dir)} && echo yes || echo no`, { timeoutMs: INLINE_EXEC_MS });
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "yes") throw new Error(`${dir} is not a folder on the machine`);
  const tmp = `/tmp/wsp-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tgz`;
  try {
    const packed = await machine.run(folderExportScript(dir, rule, tmp), { deadlineMs: opts.timeoutMs ?? 600_000 });
    if (packed.exitCode !== 0) throw new Error(`packing ${dir} on the machine failed (exit ${packed.exitCode}): ${packed.stderr.slice(-500)}`);
    const excluded = packed.stdout.split("\n").filter(l => l !== "").sort();
    const size = await machine.exec(`wc -c < ${shellQuote(tmp)}`, { timeoutMs: INLINE_EXEC_MS });
    const total = Number(size.stdout.trim());
    if (size.exitCode !== 0 || !Number.isFinite(total)) throw new Error(`the archive's size on the machine is unknown: ${size.stderr.slice(-200)}`);
    return { tar: await download(machine, tmp, opts, total), excluded };
  } finally {
    await machine.exec(`rm -f ${shellQuote(tmp)} ${shellQuote(`${tmp}.list`)}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
  }
}

/** The signed upload URL takes one PUT of at most this many bytes (measured 2026-09-04: 200 at 32 MiB,
 * 413 from 33 MiB, the body naming the limit); a larger archive travels in parts of this size. */
export const UPLOAD_PART_BYTES = 32 * 1024 * 1024;

type UploadBody = { error?: unknown; limit?: unknown };

function parseBody(body: string): UploadBody | undefined {
  try {
    return JSON.parse(body) as UploadBody;
  } catch {
    return undefined;
  }
}

/** The provider answers a refused upload with `{error, limit}`; the limit is the one figure worth repeating. */
function uploadFailure(status: number, body: string, part: number, parts: number, attempts: number): string {
  const where = parts === 1 ? "" : ` on part ${part} of ${parts}`;
  const parsed = parseBody(body);
  const reason = typeof parsed?.error === "string" ? parsed.error : body.trim().slice(0, 300);
  const limit = typeof parsed?.limit === "number" ? `; the upload takes at most ${parsed.limit} bytes per PUT` : "";
  const tries = attempts > 1 ? ` after ${attempts} attempts` : "";
  return `vault import upload failed${where}: HTTP ${status}${reason === "" ? "" : ` ${reason}`}${tries}${limit}`;
}

/** One part, PUT until it lands. The signed URL truncates the path on every PUT, so a retry after a lost
 * response or a 502 to 504 is safe; the bound and backoff are the backend's own. A 413 or any 4xx is final. */
async function putPart(doFetch: Fetch, url: string, bytes: Uint8Array<ArrayBuffer>, part: number, parts: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { method: "PUT", body: bytes });
    } catch (e) {
      if (attempt >= 3) throw new Error(`vault import upload failed${parts === 1 ? "" : ` on part ${part} of ${parts}`}: ${e instanceof Error ? e.message : String(e)} after ${attempt} attempts`);
      await new Promise(r => setTimeout(r, backoffMs(attempt)));
      continue;
    }
    if (res.ok) return;
    const body = await res.text().catch(() => "");
    const parsed = parseBody(body);
    const kind = classify(res.status, typeof parsed?.error === "string" ? { error: parsed.error } : {});
    if (!shouldRetry(kind, attempt)) throw new Error(uploadFailure(res.status, body, part, parts, attempt));
    await new Promise(r => setTimeout(r, backoffMs(attempt)));
  }
}

/** A file for the upload road: its path on the guest, its mode and its bytes. */
export interface TarFile {
  path: string;
  mode: number;
  content: string | Uint8Array;
}
/** A directory of its own, so an empty one and its mode survive the trip. */
export interface TarDir {
  path: string;
  mode: number;
  dir: true;
}
/** A symbolic link, carried as one: the target is written as it is, never followed. */
export interface TarLink {
  path: string;
  target: string;
}
export type TarEntry = TarFile | TarDir | TarLink;

const TAR_BLOCK = 512;
/** The ustar size field is eleven octal digits. */
export const TAR_MAX_FILE_BYTES = 0o77777777777;
const TAR_LINK_MAX = 100;

function tarField(header: Buffer, at: number, length: number, value: string): void {
  header.write(value, at, length, "utf8");
}

/** A ustar name of at most 100 bytes with a prefix of at most 155, split at a slash; undefined when neither field holds the path. */
function splitName(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return undefined;
}

function tarName(path: string): { name: string; prefix: string } {
  const split = splitName(path);
  if (split === undefined) throw new Error(`${path} does not fit a ustar header`);
  return split;
}

/** Whether tarOf can hold an entry at this path, with this link target when it is a link. */
export function fitsTar(path: string, target?: string): boolean {
  return splitName(path.replace(/^\/+/, "")) !== undefined && (target === undefined || Buffer.byteLength(target) <= TAR_LINK_MAX);
}

/** A gzipped ustar archive of the entries, each at its path with its mode and owned by root, for importInto to land
 * at the root of the guest: paths lose their leading slash, as tar wants them. */
export function tarOf(entries: readonly TarEntry[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const link = "target" in e;
    const body = "content" in e ? (typeof e.content === "string" ? Buffer.from(e.content, "utf8") : Buffer.from(e.content.buffer, e.content.byteOffset, e.content.byteLength)) : Buffer.alloc(0);
    if (body.length > TAR_MAX_FILE_BYTES) throw new Error(`${e.path} is ${body.length} bytes, over what a ustar header holds`);
    if (link && Buffer.byteLength(e.target) > TAR_LINK_MAX) throw new Error(`${e.path} links to a target too long for a ustar header`);
    const { name, prefix } = tarName(e.path.replace(/^\/+/, ""));
    const header = Buffer.alloc(TAR_BLOCK);
    tarField(header, 0, 100, name);
    tarField(header, 100, 8, `${(link ? 0o777 : e.mode).toString(8).padStart(7, "0")}\0`);
    tarField(header, 108, 8, "0000000\0");
    tarField(header, 116, 8, "0000000\0");
    tarField(header, 124, 12, `${body.length.toString(8).padStart(11, "0")}\0`);
    tarField(header, 136, 12, `${mtime.toString(8).padStart(11, "0")}\0`);
    tarField(header, 148, 8, "        ");
    tarField(header, 156, 1, link ? "2" : "dir" in e ? "5" : "0");
    if (link) tarField(header, 157, TAR_LINK_MAX, e.target);
    tarField(header, 257, 6, "ustar\0");
    tarField(header, 263, 2, "00");
    tarField(header, 265, 32, "root");
    tarField(header, 297, 32, "root");
    tarField(header, 345, 155, prefix);
    let sum = 0;
    for (const b of header) sum += b;
    tarField(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body);
    const pad = (TAR_BLOCK - (body.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK * 2));
  return gzipSync(Buffer.concat(blocks));
}

// A hash mismatch exits with its own code so the caller can tell it from a failed extraction.
const HASH_MISMATCH_EXIT = 65;

export async function importInto(machine: Machine, tar: Buffer, destDir: string, opts: VaultOptions = {}): Promise<{ parts: number }> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (tar.length === 0) throw new Error("vault import: empty archive, nothing to import");
  const tmp = `/tmp/wsp-vault-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tgz`;
  const parts = Math.ceil(tar.length / UPLOAD_PART_BYTES);
  const partPaths = parts === 1 ? [tmp] : Array.from({ length: parts }, (_, i) => `${tmp}.part${i}`);
  try {
    for (const [i, path] of partPaths.entries()) {
      const url = await machine.uploadUrl(path);
      const end = Math.min((i + 1) * UPLOAD_PART_BYTES, tar.length);
      await putPart(doFetch, url, new Uint8Array(tar.subarray(i * UPLOAD_PART_BYTES, end)), i + 1, parts);
      opts.onPart?.({ part: i + 1, parts, bytes: end, total: tar.length });
    }
  } catch (e) {
    // Every part path, not only those that answered ok: a body can land before the response fails.
    await machine.exec(`rm -f ${partPaths.map(shellQuote).join(" ")}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
    throw e;
  }
  const digest = createHash("sha256").update(tar).digest("hex");
  // --recursive-unlink: imported dirs replace existing ones wholesale, so a
  // stale config dir on the target can't shadow the vaulted one. An overlay
  // (laptop files onto a fresh guest) merges instead, and --no-same-owner
  // keeps root from inheriting the laptop's uid off the archive.
  const flags = opts.overlay ? "--no-same-owner" : "--recursive-unlink";
  // The parts are streamed into tar in order, never joined on disk, so the guest holds the archive once.
  // pipefail: a part cat cannot read fails the hash line with cat's message instead of hashing what flowed.
  const joined = `cat ${partPaths.map(shellQuote).join(" ")}`;
  const script = [
    "set -eo pipefail",
    `trap "rm -f ${partPaths.map(shellQuote).join(" ")}" EXIT`,
    `sum=$(${joined} | sha256sum | cut -d' ' -f1)`,
    `test "$sum" = ${digest} || exit ${HASH_MISMATCH_EXIT}`,
    `mkdir -p ${shellQuote(destDir)}`,
    `${joined} | tar xzf - -C ${shellQuote(destDir)} ${flags}`,
  ].join("\n");
  const untar = await machine.run(script, { deadlineMs: opts.timeoutMs ?? 120_000 });
  if (untar.exitCode === HASH_MISMATCH_EXIT) {
    throw new Error(`vault import: the uploaded archive (${tar.length} bytes in ${parts} part${parts === 1 ? "" : "s"}) did not match its hash on the machine`);
  }
  if (untar.exitCode !== 0) {
    throw new Error(`vault import untar failed (exit ${untar.exitCode}): ${untar.stderr.slice(-500)}`);
  }
  return { parts };
}

export interface LandOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  /** Remove what is at the destination first; without it an existing path is refused with kind "exists". */
  replace?: boolean;
  onPart?: (progress: UploadProgress) => void;
  /** Called once the archive is extracted, right before it is moved into place. */
  onLanding?: () => void;
}

// The landing refuses with its own code so an existing path can be told from a failed move.
const EXISTS_EXIT = 66;

const exists = (path: string): Error => Object.assign(new Error(`${path} already exists on the machine; import with replace to overwrite it`), { kind: "exists" });

/** Lands an archive of a folder at an absolute path on the guest: extracted beside it into a staging directory,
 * then moved into place in one rename, so a failed upload or extraction leaves nothing at the destination. An
 * existing destination is refused before any byte goes up, and again at the move, unless `replace` removes it. */
export async function landBundle(machine: Machine, tar: Buffer, dest: string, opts: LandOptions = {}): Promise<{ parts: number }> {
  const target = dest.replace(/\/+$/, "");
  if (!dest.startsWith("/") || target === "") throw new Error(`destination must be an absolute path below /, got ${dest}`);
  const probe = await machine.exec(`test -e ${shellQuote(target)} && echo yes || echo no`, { timeoutMs: INLINE_EXEC_MS });
  if (probe.exitCode !== 0) throw new Error(`could not look at ${target} on the machine: ${probe.stderr.slice(-200)}`);
  if (probe.stdout.trim() === "yes" && opts.replace !== true) throw exists(target);
  const staging = `${target}.wsp-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { parts } = await importInto(machine, tar, staging, {
    overlay: true,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onPart !== undefined ? { onPart: opts.onPart } : {}),
  }).catch(async (e: unknown) => {
    await machine.exec(`rm -rf ${shellQuote(staging)}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
    throw e;
  });
  opts.onLanding?.();
  const script = [
    "set -e",
    `trap "rm -rf ${shellQuote(staging)}" EXIT`,
    `mkdir -p ${shellQuote(target.slice(0, target.lastIndexOf("/")) || "/")}`,
    opts.replace === true ? `rm -rf ${shellQuote(target)}` : `test ! -e ${shellQuote(target)} || exit ${EXISTS_EXIT}`,
    `mv ${shellQuote(staging)} ${shellQuote(target)}`,
  ].join("\n");
  const moved = await machine.run(script, { deadlineMs: opts.timeoutMs ?? 120_000 });
  if (moved.exitCode === EXISTS_EXIT) throw exists(target);
  if (moved.exitCode !== 0) throw new Error(`landing at ${target} failed (exit ${moved.exitCode}): ${moved.stderr.slice(-500)}`);
  return { parts };
}
