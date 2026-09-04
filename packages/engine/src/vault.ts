import { createHash } from "node:crypto";
import { backoffMs, classify, shouldRetry } from "./errors.js";
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
}

export interface UploadProgress {
  part: number;
  parts: number;
  bytes: number;
  total: number;
}

function quote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// Signed-URL transport on both directions (PoC P5: ~1s round trips). exec
// stdout could carry base64 for small exports but hits response-size limits.
export async function exportPaths(machine: Machine, paths: string[], opts: VaultOptions = {}): Promise<Buffer> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const tmp = `/tmp/wsp-vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tgz`;
  const rel = paths.map(p => quote(p.replace(/^\//, "")));
  const tar = await machine.exec(`tar czf ${quote(tmp)} -C / ${rel.join(" ")}`, { timeoutMs: opts.timeoutMs ?? 120_000 });
  if (tar.exitCode !== 0) {
    throw new Error(`vault export tar failed (exit ${tar.exitCode}): ${tar.stderr.slice(-500)}`);
  }
  try {
    if (opts.maxBytes !== undefined) {
      const stat = await machine.exec(`stat -c %s ${quote(tmp)}`);
      const bytes = Number(stat.stdout.trim());
      if (stat.exitCode !== 0 || !Number.isFinite(bytes)) throw new Error(`vault export size unknown: ${stat.stderr.slice(-200)}`);
      if (bytes > opts.maxBytes) {
        throw Object.assign(new Error(`vault export is ${bytes} bytes, over the ${opts.maxBytes} byte cap`), { kind: "vaultTooLarge", bytes });
      }
    }
    const url = await machine.downloadUrl(tmp);
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`vault export download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    await machine.exec(`rm -f ${quote(tmp)}`).catch(() => {});
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
    await machine.exec(`rm -f ${partPaths.map(quote).join(" ")}`).catch(() => {});
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
  const joined = `cat ${partPaths.map(quote).join(" ")}`;
  const script = [
    "set -eo pipefail",
    `trap "rm -f ${partPaths.map(quote).join(" ")}" EXIT`,
    `sum=$(${joined} | sha256sum | cut -d' ' -f1)`,
    `test "$sum" = ${digest} || exit ${HASH_MISMATCH_EXIT}`,
    `${joined} | tar xzf - -C ${quote(destDir)} ${flags}`,
  ].join("\n");
  const untar = await machine.exec(script, { timeoutMs: opts.timeoutMs ?? 120_000 });
  if (untar.exitCode === HASH_MISMATCH_EXIT) {
    throw new Error(`vault import: the uploaded archive (${tar.length} bytes in ${parts} part${parts === 1 ? "" : "s"}) did not match its hash on the machine`);
  }
  if (untar.exitCode !== 0) {
    throw new Error(`vault import untar failed (exit ${untar.exitCode}): ${untar.stderr.slice(-500)}`);
  }
  return { parts };
}
