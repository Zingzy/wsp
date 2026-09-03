// SPDX-License-Identifier: AGPL-3.0-only
// Pass 7. Real config is tiny; anything past this gate is listed but the
// person has to tick it on purpose.
import type { Row } from "./row.js";

export const LARGE_BYTES = 1_000_000;
export const LARGE_FILES = 50;

export function isLarge(row: Pick<Row, "bytes" | "files">): boolean {
  return row.bytes > LARGE_BYTES || row.files > LARGE_FILES;
}

export function sizeGate(rows: readonly Row[]): Row[] {
  return rows.map(r => (isLarge(r) && !r.flags.includes("large") ? { ...r, flags: [...r.flags, "large"] } : r));
}
