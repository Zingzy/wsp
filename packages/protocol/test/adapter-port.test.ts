// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, sourceFiles } from "./source-files.js";

const PACKAGES = join(ROOT, "packages");
const PORT_FILE = "packages/protocol/src/adapter-port.ts";
/** What an adapter is written against; each of these may be declared in PORT_FILE and nowhere else. */
const PORT_NAMES = ["AdapterEvent", "ExecStream", "ExecStreamFactory", "SessionTitleReader"];
/** Matches whatever keywords a declaration uses, so a duplicate written as an interface, class or const cannot hide from a type-only pattern. */
const declarationOf = (name: string): RegExp => new RegExp(`^export (?:\\w+ )+${name}\\b`, "m");

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const adapterPackages = readdirSync(PACKAGES, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith("adapter-"))
  .map(entry => entry.name)
  .sort();

/** Every source and test file of a package, repo-relative. */
function filesOf(pkg: string): string[] {
  const out: string[] = [];
  for (const dir of ["src", "test"]) {
    let names: string[];
    try {
      names = readdirSync(join(PACKAGES, pkg, dir), { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const name of names) if (/\.tsx?$/.test(name)) out.push(join("packages", pkg, dir, name));
  }
  return out;
}

const wspImports = (rel: string): string[] => [...read(rel).matchAll(/from "(@wsp\/[^"]+)"/g)].map(m => m[1]!);

describe("the harness adapter port", () => {
  it("is declared in one file, and that file is in the protocol", () => {
    const sources = sourceFiles();
    for (const name of PORT_NAMES) {
      const declared = sources.filter(rel => declarationOf(name).test(read(rel)));
      expect(`${name}: ${declared.join(", ")}`).toBe(`${name}: ${PORT_FILE}`);
    }
  });

  it("is what every adapter package is written against", () => {
    expect(adapterPackages.length).toBeGreaterThan(1);
    for (const pkg of adapterPackages) {
      const siblings = adapterPackages.filter(other => other !== pkg).map(other => `@wsp/${other}`);
      for (const rel of filesOf(pkg)) {
        expect(`${rel}: ${wspImports(rel).filter(i => siblings.includes(i)).join(", ")}`).toBe(`${rel}: `);
      }
      const manifest = JSON.parse(read(join("packages", pkg, "package.json"))) as Record<string, Record<string, string> | undefined>;
      const declared = [...Object.keys(manifest["dependencies"] ?? {}), ...Object.keys(manifest["devDependencies"] ?? {})];
      expect(declared.filter(dep => dep !== `@wsp/${pkg}` && dep.startsWith("@wsp/adapter-"))).toEqual([]);
    }
  });
});
