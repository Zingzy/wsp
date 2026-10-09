// SPDX-License-Identifier: AGPL-3.0-only
// The slate catalog page: what slate_catalog answers, the index first, then every piece, source and chapter it
// answers by name.
import { SLATE_CHAPTERS, SLATE_PIECES, SLATE_SOURCES, slateCatalog } from "../../../packages/protocol/src/slate/index.js";
import { block, page, type Generated } from "./generated.js";

/** One named entry as the tool answers it, less the line pointing back at the index, which is this page's top. */
const entry = (name: string): string => slateCatalog(name).replace(/\nThe pieces and rules: slate_catalog with no name\.$/, "");

export default function slate(): Generated[] {
  const section = (name: string): string => `### ${name}\n\n${block(entry(name))}`;
  const body = [
    "What `slate_catalog` answers, and `wsp slate catalog` prints: the index with no name, and one entry for each piece, source and chapter named below. A slate is written in this kit with `slate_write`.",
    "## The index",
    block(slateCatalog()),
    "## Pieces",
    ...Object.keys(SLATE_PIECES).map(section),
    "## Sources",
    ...Object.keys(SLATE_SOURCES).map(section),
    "## Chapters",
    ...SLATE_CHAPTERS.map(section),
  ];
  return [page("content/reference/slate.mdx", "Slate catalog", "slate.ts", body.join("\n\n"))];
}
