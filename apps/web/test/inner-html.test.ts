// SPDX-License-Identifier: AGPL-3.0-only
// React 19 writes an element's innerHTML again whenever its dangerouslySetInnerHTML object is a new one, so an object
// written inline replaces the element's children on every render: every sidebar tile's agent mark was rebuilt on each
// sidebar render. The object is made once, at module level or in a useMemo.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe("dangerouslySetInnerHTML", () => {
  it("is never handed an object written inline", () => {
    const inline = sources(SRC).flatMap(path =>
      [...readFileSync(path, "utf8").matchAll(/dangerouslySetInnerHTML=\{\s*\{/g)].map(() => relative(SRC, path)),
    );
    expect(inline).toEqual([]);
  });
});
