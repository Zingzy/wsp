// SPDX-License-Identifier: AGPL-3.0-only
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DaemonErrorCode } from "@wsp/protocol";

export type OpErrorCode = DaemonErrorCode;

/** A refusal the client can branch on; main.ts copies code onto the wire error. */
export class OpError extends Error {
  readonly code: OpErrorCode;
  constructor(code: OpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function nearestExisting(p: string): Promise<string> {
  let cur = p;
  for (;;) {
    try {
      return await realpath(cur);
    } catch (e) {
      if (!isMissing(e)) throw e;
      const parent = dirname(cur);
      if (parent === cur) throw e;
      cur = parent;
    }
  }
}

function outsideRoot(requested: string): OpError {
  return new OpError("outside-root", `${requested} resolves outside the workspace root`);
}

/**
 * Resolves requested (relative to the first root, or absolute) to a real path
 * inside one of the roots. The lexical check runs first so nothing outside
 * every root is ever stat'ed; the realpath check then refuses symlinks that
 * leave them all, including a symlinked parent of a missing leaf, which stays
 * outside-root rather than not-found so the refusal never confirms what
 * exists there.
 */
export async function resolveInside(roots: readonly string[], requested: string): Promise<string> {
  const lexicalRoots = roots.map(root => resolve(root));
  const lexical = resolve(lexicalRoots[0] ?? "/", requested);
  if (!lexicalRoots.some(root => isInside(root, lexical))) throw outsideRoot(requested);
  const realRoots = await Promise.all(lexicalRoots.map(root => realpath(root).catch((e: unknown) => (isMissing(e) ? null : Promise.reject(e)))));
  let real: string;
  let exists = true;
  try {
    real = await realpath(lexical);
  } catch (e) {
    if (!isMissing(e)) throw e;
    exists = false;
    real = await nearestExisting(dirname(lexical));
  }
  if (!realRoots.some(root => root !== null && isInside(root, real))) {
    // A root that is gone (an imported folder since removed) hides nothing, so a leaf under it is missing, not outside.
    const underGoneRoot = lexicalRoots.some((root, i) => realRoots[i] === null && isInside(root, lexical));
    if (!exists && underGoneRoot) throw new OpError("not-found", `${requested} does not exist`);
    throw outsideRoot(requested);
  }
  if (!exists) throw new OpError("not-found", `${requested} does not exist`);
  return real;
}
