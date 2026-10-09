// SPDX-License-Identifier: AGPL-3.0-only
// The changelog: every published release's notes, newest first, as a Keep a Changelog file whose front matter has
// Scalar draw each version as a timeline item. The releases come from releases.json, which scripts/releases.mjs
// fetches off GitHub when generate runs, so this script and its test read no network.
import { readFileSync } from "node:fs";
import { mdxSafe, type Generated } from "./generated.js";

type Release = { tag: string; date: string; body: string };

/** A release's notes under its version heading: its own top heading level moved to ###, every other level with it. */
const section = (r: Release): string => {
  const body = r.body.replace(/\r\n/g, "\n");
  const top = Math.min(...[...body.matchAll(/^(#{1,6}) /gm)].map(m => m[1]!.length), 3);
  const notes = body.replace(/^(#{1,6}) /gm, (_, marks: string) => `${"#".repeat(Math.min(6, marks.length + 3 - top))} `).trim();
  return `## [${r.tag.replace(/^v/, "")}] - ${r.date}\n\n${mdxSafe(notes)}`;
};

export default function changelog(): Generated[] {
  const releases = JSON.parse(readFileSync(new URL("./releases.json", import.meta.url), "utf8")) as Release[];
  const text = [
    "---\nchangelog: true\n---",
    "# Changelog",
    "{/* Written by apps/docs-next/scripts/changelog.ts from the release notes on GitHub: run pnpm --filter @wsp/docs-next generate. */}",
    "Every release of wsp, newest first, with the notes it was published with. The downloads are on [GitHub](https://github.com/wsp-labs/wsp/releases).",
    ...releases.map(section),
  ].join("\n\n");
  return [{ file: "content/project/changelog.mdx", text: `${text}\n` }];
}
