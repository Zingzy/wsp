// SPDX-License-Identifier: AGPL-3.0-only
// The files a slate run reads: the slate's own files its command names, and the scripts in the thread's folder an
// approval binds by hash.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { SlateDoc, SlateRunDecl } from "@wsp/protocol/slate";

/** The files a run's cmd or then reads: every one where it names $SLATE_DIR, else the ones it names. */
function filesRead(doc: SlateDoc | null, decl: SlateRunDecl): Record<string, string> | undefined {
  const said = [decl.kind === "cmd" ? decl.cmd : "", (decl as { then?: string }).then ?? ""].join("\n");
  const every = /\$\{?SLATE_DIR\b/.test(said);
  const used = Object.entries(doc?.files ?? {}).filter(([name]) => every || new RegExp(`(^|[^A-Za-z0-9._-])${name.replace(/[.]/g, "\\.")}($|[^A-Za-z0-9._-])`).test(said));
  return used.length === 0 ? undefined : Object.fromEntries(used);
}

/** A declaration with the text of the files it reads beside it, as its approval key and its sheet take it. */
export function withFiles(doc: SlateDoc | null, decl: SlateRunDecl): SlateRunDecl & { files?: Record<string, string> } {
  const files = filesRead(doc, decl);
  return files === undefined ? decl : { ...decl, files };
}

/** How many named files an approval binds, and how large one may be to be read for it. */
const SCRIPTS_MAX = 32;
const SCRIPT_BYTES = 4 * 1024 * 1024;

/** The words of a run's cmd or then that read as a path: what an Always has to cover the content of. */
export function pathsNamed(decl: Extract<SlateRunDecl, { kind: "cmd" }>): string[] {
  return [decl.cmd, decl.then ?? ""].join("\n").split(/[\s'"`;|&()<>=,]+/).filter(w => w !== "" && !w.startsWith("-") && !w.includes("$") && /[./]/.test(w));
}

/** Every file a run's cmd or then names that exists under the thread's folder, by its path there, with a hash of its
 * content: an "Always" covers the script the person read, and an edit to it asks again. A file the command reaches
 * some other way (an import, a glob, a path it builds) is out of reach, and the sheet says so. */
export function scriptsNamed(folder: string | undefined, decl: SlateRunDecl): Record<string, string> | undefined {
  if (folder === undefined || decl.kind !== "cmd") return undefined;
  let root: string;
  try { root = realpathSync(folder); } catch { return undefined; }
  const words = pathsNamed(decl);
  const found: Record<string, string> = {};
  for (const word of words) {
    if (Object.keys(found).length >= SCRIPTS_MAX) break;
    let at: string;
    try { at = realpathSync(isAbsolute(word) ? word : join(folder, word)); } catch { continue; }
    const rel = relative(root, at);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || found[rel] !== undefined) continue;
    try {
      const st = statSync(at);
      if (!st.isFile() || st.size > SCRIPT_BYTES) continue;
      found[rel] = createHash("sha256").update(readFileSync(at)).digest("hex").slice(0, 16);
    } catch { continue; }
  }
  return Object.keys(found).length === 0 ? undefined : found;
}
