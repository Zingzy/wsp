// SPDX-License-Identifier: AGPL-3.0-only
// The editors page's table, held to the host's own list: a name, an order or an ssh road changed there fails here
// until the page says the same.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EditorId } from "@wsp/protocol";
import { EDITORS } from "../../../packages/host/src/editor.js";

const PAGE = readFileSync(fileURLToPath(new URL("../content/features/editor.mdx", import.meta.url)), "utf8");

/** The cells of each body row of the first table under a heading. */
function tableUnder(heading: string): string[][] {
  const section = PAGE.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";
  const rows = section.split("\n").filter(line => line.startsWith("|"));
  return rows.slice(2).map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
}

const sshWord = (row: (typeof EDITORS)[number]): string =>
  row.remote === undefined ? "No" : row.remoteExtension === undefined ? "Yes" : "Yes, with the Remote SSH extension";

describe("the editors page", () => {
  it("lists every editor the host opens, in its order, by its name, with its ssh road", () => {
    expect(EDITORS.map(row => row.id)).toEqual(EditorId.options);
    expect(tableUnder("The editors")).toEqual(EDITORS.map(row => [row.name, sshWord(row)]));
  });

  it("gives each editor that needs an extension the line the host prints to install it", () => {
    const lines = EDITORS.flatMap(row => (row.remoteExtension === undefined ? [] : [[row.name, `\`${row.remoteExtension.cli} --install-extension ${row.remoteExtension.ids[0]}\``]]));
    expect(tableUnder("Open a thread on another computer")).toEqual(lines);
  });
});
