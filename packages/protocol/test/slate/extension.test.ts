// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLATE_PIECES, SLATE_PIPE_STEPS } from "../../src/slate/index.js";

const dir = fileURLToPath(new URL("../../src/slate/", import.meta.url));
const sources = readdirSync(dir).filter(f => f.endsWith(".ts")).map(f => ({ file: f, text: readFileSync(dir + f, "utf8") }));

describe("the kit's registries", () => {
  it("are the one place a piece's own rules live: no other file compares a type to a piece's name", () => {
    // A prop's spec has a type too (spec.type, ps.type), which names a value's kind, not a piece.
    const pieceType = (name: string): RegExp => new RegExp(`(?<!\\b(?:spec|ps|f|s|t)\\.)\\btype === "${name}"`);
    const switched = sources.filter(s => s.file !== "kit.ts").flatMap(s => Object.keys(SLATE_PIECES).filter(name => pieceType(name).test(s.text)).map(name => `${s.file}: ${name}`));
    expect(switched).toEqual([]);
  });

  it("run each pipeline step off its own entry, as functions run off theirs, with no switch on the step's name", () => {
    const switched = sources.flatMap(s => Object.keys(SLATE_PIPE_STEPS).filter(name => s.text.includes(`case "${name}":`)).map(name => `${s.file}: ${name}`));
    expect(switched).toEqual([]);
  });
});
