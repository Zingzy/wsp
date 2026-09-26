// SPDX-License-Identifier: AGPL-3.0-only
// A bundler orders the modules of a cycle as its split points fall, so a module that reads a value from its cycle
// partner at load gets undefined in one bundle and the value in another: the desktop app once died at start on it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const IMPORT = /^(?:import|export)\s+([^;]*?)\s+from\s+"(\.\/[^"]+)"/gm;

/** The protocol's own modules each module reads at run time, by file name. An import of types alone is erased from
 * the build and is no edge. */
function valueImports(file: string): string[] {
  const text = readFileSync(join(SRC, file), "utf8");
  const out: string[] = [];
  for (const [, clause, target] of text.matchAll(IMPORT)) {
    if (/^type\b/.test(clause!)) continue;
    const named = /^\{([^}]*)\}$/.exec(clause!.trim());
    if (named !== null && named[1]!.split(",").every(part => part.trim() === "" || /^type\s/.test(part.trim()))) continue;
    out.push(target!.slice(2).replace(/\.js$/, ".ts"));
  }
  return out;
}

/** Every cycle the value imports make, each as the path that closes it. */
function cycles(graph: Map<string, string[]>): string[][] {
  const found: string[][] = [];
  const done = new Set<string>();
  const walk = (at: string, path: string[]): void => {
    const back = path.indexOf(at);
    if (back !== -1) {
      found.push([...path.slice(back), at]);
      return;
    }
    if (done.has(at)) return;
    for (const next of graph.get(at) ?? []) walk(next, [...path, at]);
    done.add(at);
  };
  for (const file of graph.keys()) walk(file, []);
  return found;
}

describe("the protocol's modules", () => {
  const files = readdirSync(SRC).filter(f => /\.m?ts$/.test(f) && !f.endsWith(".d.mts"));
  const graph = new Map(files.map(f => [f, valueImports(f)]));

  it("reads the imports the index makes, so an empty graph cannot pass", () => {
    expect(graph.get("index.ts")).toContain("format.ts");
  });

  it("import no value from one another in a cycle", () => {
    expect(cycles(graph)).toEqual([]);
  });
});
