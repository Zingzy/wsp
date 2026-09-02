import type { Machine } from "./machine.js";

type Fetch = typeof globalThis.fetch;

export interface VaultOptions {
  fetch?: Fetch;
  timeoutMs?: number;
  /** Export only: an archive over this many bytes is removed and refused with kind vaultTooLarge. */
  maxBytes?: number;
}

function quote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

// Signed-URL transport on both directions (PoC P5: ~1s round trips). exec
// stdout could carry base64 for small exports but hits response-size limits;
// signed URLs have no such ceiling, so no chunking is needed either.
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

export async function importInto(machine: Machine, tar: Buffer, destDir: string, opts: VaultOptions = {}): Promise<void> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const tmp = `/tmp/wsp-vault-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tgz`;
  const url = await machine.uploadUrl(tmp);
  const put = await doFetch(url, { method: "PUT", body: new Uint8Array(tar) });
  if (!put.ok) throw new Error(`vault import upload failed: HTTP ${put.status}`);
  // --recursive-unlink: imported dirs replace existing ones wholesale, so a
  // stale config dir on the target can't shadow the vaulted one.
  const untar = await machine.exec(
    `tar xzf ${quote(tmp)} -C ${quote(destDir)} --recursive-unlink && rm -f ${quote(tmp)}`,
    { timeoutMs: opts.timeoutMs ?? 120_000 },
  );
  if (untar.exitCode !== 0) {
    throw new Error(`vault import untar failed (exit ${untar.exitCode}): ${untar.stderr.slice(-500)}`);
  }
}
