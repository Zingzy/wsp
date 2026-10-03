// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compileSlate, SLATE_CODES, SlateSchema, validateSlate, type Slate } from "../../src/index.js";
import { PR_STORED, USAGE_STORED } from "./examples.js";

const reached = new Set<string>();
const codes = (r: { errors: { code: string }[]; warnings: { code: string }[] }): string[] => {
  const all = [...r.errors, ...r.warnings].map(p => p.code);
  for (const c of all) reached.add(c);
  return all;
};
const one = (pieces: Slate["pieces"], more: Partial<Slate> = {}): unknown => ({ schema: 1, root: "r", pieces, ...more });

describe("every code in scope has a fixture", () => {
  it.each<[string, unknown]>([
    ["D200", { schema: 2, root: "r", pieces: { r: { type: "text", props: { value: "a" } } } }],
    ["D201", one({ r: { type: "text", props: { value: "a" } } }, { kit: "acme/1" })],
    ["D203", one({ r: { type: "column", children: ["gone"] } })],
    ["D204", one({ r: { type: "text", props: { value: "a" } }, loose: { type: "text", props: { value: "b" } } })],
    ["D205", one({ r: { type: "column", children: ["a", "b"] }, a: { type: "column", children: ["c"] }, b: { type: "column", children: ["c"] }, c: { type: "text", props: { value: "x" } } })],
    ["D206", one(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i === 0 ? "r" : `c${i}`, i === 11 ? { type: "text", props: { value: "x" } } : { type: "column", children: [`c${i + 1}`] }])))],
    ["D207", one({ r: { type: "column", children: Array.from({ length: 101 }, (_, i) => `t${i}`) }, ...Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`t${i}`, { type: "text", props: { value: "x" } }])) })],
    ["D208", one({ r: { type: "column", children: Array.from({ length: 80 }, (_, i) => `t${i}`) }, ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`t${i}`, { type: "markdown", props: { value: "x".repeat(900) } }])) })],
    ["T300", one({ r: { type: "gauge" } })],
    ["T301", one({ r: { type: "text", props: { value: "a" }, fallback: "drop" } })],
    ["T302", one({ r: { type: "meter", props: { label: "a", value: 1, maxx: 3 } } })],
    ["T303", one({ r: { type: "meter", props: { label: "a", value: "1" } } })],
    ["T304", one({ r: { type: "meter", props: { label: "a" } } })],
    ["T305", one({ r: { type: "button", props: { label: "a", variant: { bind: "state.v" } }, on: { press: { do: "toggle", path: "state.v" } } } })],
    ["T306", one({ r: { type: "text", props: { value: "a", tone: "red" } } })],
    ["T307", one({ r: { type: "button", on: { press: { do: "toggle", path: "state.v" } } } })],
    ["T308", one({ r: { type: "text", props: { value: "a" }, children: ["b"] }, b: { type: "text", props: { value: "b" } } })],
    ["T309", one({ r: { type: "empty", props: { title: "a" }, children: ["b"] }, b: { type: "text", props: { value: "b" } } })],
    ["T310", one({ r: { type: "text", props: { value: "x".repeat(10_001) } } })],
    ["T311", one({ r: { type: "column", children: ["a", "b"] }, a: { type: "text", props: { value: "a", size: "large" } }, b: { type: "text", props: { value: "b", size: "large" } } })],
    ["T312", one({ r: { type: "text", props: { value: "a", color: "red" } } })],
    ["T313", one({ r: { type: "column", children: ["a", "b", "c", "d"] }, ...Object.fromEntries(["a", "b", "c", "d"].map(id => [id, { type: "text", props: { value: id }, announce: true }])) })],
    ["X400", one({ r: { type: "text", props: { value: { bind: "a < b < c" } } } })],
    ["X401", one({ r: { type: "text", props: { value: { bind: "pr.title" } } } })],
    ["X404", one({ r: { type: "text", props: { value: { bind: "format_pct(1)" } } } })],
    ["X405", one({ r: { type: "text", props: { value: { bind: "clamp(1, 2)" } } } })],
    ["X407", one({ r: { type: "text", props: { value: { bind: "1+".repeat(260) + "1" } } } })],
    ["X408", one({ r: { type: "meter", props: { label: "a", value: { bind: "pr.word" } } } })],
    ["X406", one({ r: { type: "text", props: { value: { bind: "tokens(pr.word)" } } } })],
    ["X409", one({ r: { type: "text", props: { value: { bind: "item.name" } } } })],
    ["X410", one({ r: { type: "input", props: { label: "a", value: { bind: "git.branch" } } } })],
    ["X411", one({ r: { type: "text", props: { value: { bind: "state.filter" } } } })],
    ["S500", one({ r: { type: "text", props: { value: "a" } } }, { state: { big: "x".repeat(270_000) } })],
    ["S501", one({ r: { type: "text", props: { value: "a" } } }, { state: { "bad key": 1 } })],
    ["A600", one({ r: { type: "button", props: { label: "a" }, on: { press: { do: "run" } as never } } })],
    ["A601", one({ r: { type: "button", props: { label: "a" }, on: { press: { do: "send" } as never } } })],
    ["A602", one({ r: { type: "text", props: { value: "a" }, on: { press: { do: "send", text: "x" } } } })],
    ["A603", one({ r: { type: "button", props: { label: "a" }, on: { press: { do: "send", text: { bind: "pr.word" } } as never } } })],
    ["A606", one({ r: { type: "button", props: { label: "a" }, on: { press: Array.from({ length: 5 }, () => ({ do: "send" as const, text: "x" })) } } })],
    ["W001", one({ r: { type: "text", props: { value: "usage.week.percent" } } })],
    ["W004", one({ r: { type: "text", props: { value: "a \u2014 b" } } })],
    ["P103", one({ r: { type: "column", children: ["state"] }, state: { type: "text", props: { value: "a" } } })],
    ["P999", one({ r: { type: "text", props: { value: "a" } } }, { pipes: { open: "pr.checks | count" } })],
  ])("%s", (code, doc) => {
    expect(codes(validateSlate(doc))).toContain(code);
  });

  it.each<[string, string]>([
    ["P100", "root: column\n  t: text value=\"open"],
    ["P101", "root: column\n\tt: text value=a"],
    ["P102", "t: text value=a bold"],
    ["P104", "root: column\n  a: text value=x\n  a: text value=y"],
    ["P106", "state.a = {nope}\nt: text value=a"],
    ["D202", "a: text value=x\nb: text value=y"],
    ["T314", "t: table items={pr.checks}\n  - column title=x"],
  ])("%s from the compiler", (code, lines) => {
    expect(codes(compileSlate(lines))).toContain(code);
  });

  it("P105 from a patch line that is no op", async () => {
    const { compileSlatePatch } = await import("../../src/index.js");
    const r = compileSlatePatch("t: text value=a", USAGE_STORED);
    expect(codes({ errors: r.errors, warnings: [] })).toContain("P105");
  });

  it("reaches every code this build carries, bar the draw-time ones", () => {
    const drawTime = new Set(["R900", "R902", "W002", "X402", "S502"]);
    expect(Object.keys(SLATE_CODES).filter(c => !reached.has(c) && !drawTime.has(c))).toEqual([]);
  });
});

describe("the document", () => {
  it("accepts the appendix forms, and the zod frame agrees", () => {
    for (const d of [USAGE_STORED, PR_STORED]) {
      expect(validateSlate(d)).toEqual({ document: d, errors: [], warnings: [] });
      expect(SlateSchema.safeParse(d).success).toBe(true);
    }
  });

  it("reports every error in one pass, up to twenty", () => {
    const pieces = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`t${i}`, { type: "text", props: { value: "a", colour: "red" } }]));
    const r = validateSlate({ schema: 1, root: "r", pieces: { r: { type: "column", children: Object.keys(pieces) }, ...pieces } });
    expect(r.errors).toHaveLength(21);
    expect(r.errors[20]!.message).toBe("and 10 more");
  });

  it("names the fix: nearest path, type, prop and enum value", () => {
    const r = validateSlate(one({
      r: { type: "column", children: ["a", "b", "c", "d"] },
      a: { type: "metre", props: {} } as never,
      b: { type: "meter", props: { label: "x", value: { bind: "usage.weekley.percent" }, tome: "bad" } },
      c: { type: "text", props: { value: "x", tone: "warn" } },
      d: { type: "table", props: { items: { bind: "pr.checks" }, columns: [{ title: "N", value: { bind: "item.nmae" } }] } },
    }));
    expect(r.errors.map(e => [e.code, e.piece, e.prop, e.fix])).toEqual([
      ["T300", "a", undefined, "meter"],
      ["X401", "b", "value", "usage.week.percent"],
      ["T302", "b", "tome", "tone"],
      ["T306", "c", "tone", "tone=warning"],
      ["X401", "d", "columns[0].value", "item.name"],
    ]);
  });

  it("knows a list path is a list", () => {
    const r = validateSlate(one({ r: { type: "text", props: { value: { bind: "pr.checks.length" } } } }));
    expect(r.errors[0]).toMatchObject({ code: "X401", message: "pr.checks is a list; use len(pr.checks)", fix: "len(pr.checks)" });
  });

  it("refuses later pieces and actions by name", () => {
    expect(validateSlate(one({ r: { type: "chart" } })).errors[0]!.message).toContain("chart is not in this build");
    expect(validateSlate(one({ r: { type: "button", props: { label: "a" }, on: { press: { do: "open", href: "x" } } } })).errors[0]!.message).toContain("open is not in this build");
  });
});
