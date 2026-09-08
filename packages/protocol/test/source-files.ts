// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Every .ts and .tsx file under the src folder of each package and app, repo-relative, tests left out. */
export function sourceFiles(): string[] {
  const out: string[] = [];
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, top), { withFileTypes: true })) {
      // The landing site under apps/www is marketing copy, not the product: it names sizes and words the grep rules guard.
      if (!pkg.isDirectory() || (top === "apps" && pkg.name === "www")) continue;
      const src = join(ROOT, top, pkg.name, "src");
      let files: string[];
      try {
        files = readdirSync(src, { recursive: true, encoding: "utf8" });
      } catch {
        continue;
      }
      for (const f of files) {
        if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(join(top, pkg.name, "src", f));
      }
    }
  }
  return out;
}
