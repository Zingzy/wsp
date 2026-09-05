// SPDX-License-Identifier: AGPL-3.0-only
// The login ids the collector can emit, read off its source so a row added
// there is seen by the table and matrix tests without a second list to keep.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function collectorLogins(): string[] {
  const src = readFileSync(join(import.meta.dirname, "../../collect/src/detect/logins.ts"), "utf8");
  return [...new Set([...src.matchAll(/\bid: "(?:logins\/)?([a-z]+)"/g)].map(m => m[1]!))];
}
