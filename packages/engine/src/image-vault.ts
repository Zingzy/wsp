// SPDX-License-Identifier: AGPL-3.0-only
// The image's vault: what the sign-in and secrets stages left on the builder,
// archived off it before the snapshot so every other place builds its copy of
// the image from the record and never runs a sign-in again. Separate from the
// nap-time vault of a workspace's home (vault.ts's own callers): that one
// carries a machine's work, this one carries the person's logins.
import { createHash } from "node:crypto";
import { shellQuote } from "@wsp/protocol";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import type { Machine } from "./machine.js";
import { exportPaths, importInto, type VaultOptions } from "./vault.js";

export interface ImageVault {
  tar: Buffer;
  sha256: string;
  /** How many of the paths asked for were on the machine and went into the archive. */
  paths: number;
}

/** tar refuses an operand that is not there and the whole export fails with it, so the paths are read first and
 * only the ones that exist are archived: a machine whose person never signed a tool in still seals. The loop ends
 * on an exit of its own, since a missing last path would otherwise leave `[ -e ]`'s 1 as the whole command's and
 * read as a machine that would not answer. Any other exit is exactly that, and the seal stops on it rather than
 * sealing an image whose sign-ins nobody could read. */
async function presentPaths(machine: Machine, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const probe = `for p in ${paths.map(shellQuote).join(" ")}; do [ -e "$p" ] && echo "$p"; done; exit 0`;
  const read = await machine.exec(probe, { timeoutMs: INLINE_EXEC_MS });
  if (read.exitCode !== 0) {
    throw new Error(`the machine would not say which of the image's sign-in paths it holds (exit ${read.exitCode}): ${read.stderr.slice(-200)}`);
  }
  const found = new Set(read.stdout.split("\n").map(l => l.trim()).filter(l => l !== ""));
  return paths.filter(p => found.has(p));
}

/** The tar of the paths that are on the machine, from `/`, and its sha256. */
export async function exportImageVault(machine: Machine, paths: readonly string[], opts: VaultOptions = {}): Promise<ImageVault> {
  const present = await presentPaths(machine, paths);
  const tar = await exportPaths(machine, present, opts);
  return { tar, sha256: createHash("sha256").update(tar).digest("hex"), paths: present.length };
}

/** Lands a vault over `/` on a fresh builder; the paths it carries are the ones the sign-in stages would have
 * written. An overlay, since the pack has already written the config beside the login under the same folders and a
 * wholesale replace of those folders would take it with it. */
export async function importImageVault(machine: Machine, tar: Buffer, opts: VaultOptions = {}): Promise<void> {
  await importInto(machine, tar, "/", { ...opts, overlay: true });
}

/** The header the image hash is taken under, so a hash can never be read as one of another rule's. */
const IMAGE_HASH_RULE = "wsp-image-1";
/** What an image with no vault hashes as: its own word, never the empty string, so a record with no vault and one
 * whose vault hashed to nothing are different images. */
const NO_VAULT = "none";

/** One rule for the image hash: the recipe the copy is built from and the vault it imports, and nothing else. */
export function imageHash(recipeHash: string, vaultSha256: string | undefined): string {
  return createHash("sha256").update(`${IMAGE_HASH_RULE}\n${recipeHash}\n${vaultSha256 ?? NO_VAULT}`).digest("hex");
}
