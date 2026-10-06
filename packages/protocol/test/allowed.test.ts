// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { holdTo } from "./allowed.js";

const ALLOWED = [
  { text: "text-[13px]", count: 2, why: "a size off the scale" },
  { text: "<Kbd>", count: 1, why: "a keycap" },
];
const TODAY = [
  { text: "text-[13px]", where: "a.ts:1" },
  { text: "text-[13px]", where: "b.ts:4" },
  { text: "<Kbd>", where: "c.tsx:9" },
];
const clean = { refused: [], over: [], stale: [] };

describe("an allowed list held by text", () => {
  it("passes the tree it was written for", () => {
    expect(holdTo(TODAY, ALLOWED)).toEqual(clean);
  });

  it("passes an allowed line moved to another file", () => {
    expect(holdTo([TODAY[0]!, { text: "text-[13px]", where: "split/b-part.ts:2" }, TODAY[2]!], ALLOWED)).toEqual(clean);
  });

  it("reads an entry whose line was deleted as stale, none left included", () => {
    expect(holdTo(TODAY.slice(0, 2), ALLOWED)).toEqual({ ...clean, stale: ["<Kbd>: found 0, allowed 1"] });
    expect(holdTo(TODAY.slice(1), ALLOWED)).toEqual({ ...clean, stale: ["text-[13px]: found 1, allowed 2"] });
  });

  it("refuses a hit no entry names", () => {
    expect(holdTo([...TODAY, { text: "text-[17px]", where: "d.ts:3" }], ALLOWED)).toEqual({ ...clean, refused: ["d.ts:3: text-[17px]"] });
  });

  it("refuses a copy of an allowed text past its count, naming where it sits", () => {
    expect(holdTo([...TODAY, { text: "<Kbd>", where: "e.tsx:1" }], ALLOWED)).toEqual({ ...clean, over: ["<Kbd>: found 2, allowed 1, at c.tsx:9, e.tsx:1"] });
  });

  it("names the first five places of a text past its count and how many more", () => {
    const many = Array.from({ length: 148 }, (_, i) => ({ text: "text-[13px]", where: `f${i}.tsx` }));
    expect(holdTo(many, [{ text: "text-[13px]", count: 147, why: "a size off the scale" }]).over).toEqual([
      "text-[13px]: found 148, allowed 147, at f0.tsx, f1.tsx, f2.tsx, f3.tsx, f4.tsx and 143 more",
    ]);
  });

  it("refuses a list that names one text twice", () => {
    expect(() => holdTo(TODAY, [...ALLOWED, { text: "<Kbd>", count: 1, why: "again" }])).toThrow(/names "<Kbd>" twice/);
  });
});
