// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  checkSlateExpression,
  evaluateSlateExpression,
  parseSlateExpression,
  resolveSlateProp,
  slateDependencies,
  slatePropDependencies,
  type SlateCheckScope,
  type SlateEvalContext,
  type SlateJson,
} from "../../src/index.js";

const NOW = Date.parse("2026-10-04T09:00:00Z");
const WORLD: Record<string, SlateJson> = {
  "thread.context.used": 164_000,
  "thread.context.window": 1_000_000,
  "thread.context.free": 836_000,
  "thread.status": "idle",
  "usage.week": { percent: 46, resetsAt: NOW + (3 * 24 + 7) * 3_600_000 },
  "pr.checks": [
    { name: "build", state: "pending", startedAt: "2026-10-04T08:50:00Z" },
    { name: "lint", state: "pass", startedAt: "2026-10-04T08:50:00Z", completedAt: "2026-10-04T08:51:04Z" },
    { name: "test", state: "fail", startedAt: "2026-10-04T08:50:00Z", completedAt: "2026-10-04T08:54:12Z" },
    { name: "e2e", state: "skipped" },
  ],
  "pr.number": null,
  "pr.word": "checks running",
  "pr.mergeable": "conflicting",
  "state.steps": [{ title: "a", done: true }, { title: "b", done: false }],
  "state.note": "",
};

const ctx = (row?: SlateEvalContext["row"]): SlateEvalContext => ({ resolve: p => WORLD[p], now: NOW, ...(row !== undefined ? { row } : {}) });
const ev = (src: string, row?: SlateEvalContext["row"]) => evaluateSlateExpression(src, ctx(row));

describe("evaluating expressions", () => {
  it.each<[string, SlateJson | undefined]>([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["7 % 4", 3],
    ["-2 + 5", 3],
    ["10 / 4", 2.5],
    ["1 / 0", null],
    ["'a' + 1", null],
    ["null + 1", null],
    ["2 > 1", true],
    ["null > 1", null],
    ["'b' >= 'a'", true],
    ["1 == '1'", false],
    ["null == null", true],
    ["pr.number == null", true],
    ["pr.number != null", false],
    ["0 or 'x'", "x"],
    ["'' and 1", ""],
    ["not 0", true],
    ["not pr.checks", false],
    ["true ? 'y' : 'n'", "y"],
    ["thread.context.used / thread.context.window > 0.1 ? 'warning' : 'default'", "warning"],
    ["usage.week.percent", 46],
    ["usage.weekly.percent", undefined],
    ["pr.checks[0].name", "build"],
    ["pr.checks[-1].name", "e2e"],
    ["pr.checks[9].name", undefined],
    ["state.steps[1].done", false],
    ["\"double\"", "double"],
    ["'it\\'s'", "it's"],
    ["1e3", 1000],
  ])("%s", (src, want) => {
    expect(ev(src)).toEqual(want);
  });

  it.each<[string, SlateJson]>([
    ["percent(thread.context.used / thread.context.window)", "16%"],
    ["percent(0.05)", "5.0%"],
    ["pct(usage.week.percent)", "46%"],
    ["pct(46.25, 1)", "46.3%"],
    ["tokens(thread.context.free)", "836k"],
    ["tokens(4210)", "4.21k"],
    ["bytes(1073741824)", "1 GB"],
    ["usd(2.312)", "$2.31"],
    ["number(1234.5678, 2)", "1,234.57"],
    ["duration(252000)", "4m 12s"],
    ["duration(num(pr.checks[2].completedAt) - num(pr.checks[2].startedAt))", "4m 12s"],
    ["until(usage.week.resetsAt)", "in 3d 7h"],
    ["until(0)", "now"],
    ["ago(" + (NOW - 14 * 60_000) + ")", "14m"],
    ["ago('2026-10-02T09:00:00Z')", "2d"],
    ["plural(3, 'file')", "3 files"],
    ["plural(1, 'file')", "1 file"],
    ["plural(2, 'child', 'children')", "2 children"],
    ["upper('ab')", "AB"],
    ["short('abcdef', 4)", "abc…"],
    ["round(2.567, 1)", 2.6],
    ["min(3, null, 1)", 1],
    ["max(pluck(pr.checks, 'name'))", null],
    ["clamp(120, 0, 100)", 100],
    ["str(12)", "12"],
    ["num('12')", 12],
    ["num('x')", null],
    ["num('2026-10-04T09:00:00Z')", NOW],
    ["bool('')", false],
    ["len(pr.checks)", 4],
    ["len(null)", 0],
    ["len('abc')", 3],
    ["count(state.steps)", 2],
    ["sum(state.steps, 'done')", 0],
    ["first(pr.checks).name", null],
    ["join(pluck(pr.checks, 'name'), ', ')", "build, lint, test, e2e"],
    ["contains(pluck(pr.checks, 'state'), 'fail')", true],
    ["contains('abc', 'b')", true],
    ["startsWith('poc/slate', 'poc/')", true],
    ["concat('a', null, 1)", "a1"],
    ["orElse(pr.number, 'none')", "none"],
    ["orElse(pr.word, 'none')", "checks running"],
    ["exists(state.note)", true],
    ["exists(pr.number)", false],
    ["isNull(pr.headSubject)", true],
    ["coalesce(null, pr.number, 'x')", "x"],
    ["if(pr.checks, 'some', 'none')", "some"],
  ])("%s", (src, want) => {
    expect(ev(src)).toEqual(want);
  });

  it("reads item and index in a row scope, and nothing outside one", () => {
    const row = { item: { name: "lint", state: "fail" } as SlateJson, index: 2 };
    expect(ev("item.state == 'fail' ? 'bad' : 'muted'", row)).toBe("bad");
    expect(ev("index + 1", row)).toBe(3);
    expect(ev("item.name")).toBeUndefined();
  });

  it("answers null where a path reaches into the prototype", () => {
    expect(ev("state.steps.constructor")).toBeUndefined();
    expect(ev("pr.checks[0].__proto__")).toBeUndefined();
  });

  it("answers null past the step budget instead of running on", () => {
    const big = Array.from({ length: 30_000 }, (_, i) => i);
    expect(evaluateSlateExpression("sum(state.big)", { resolve: p => (p === "state.big" ? big : undefined) })).toBeNull();
  });

  it("never throws on junk", () => {
    for (const src of ["(", "1 +", "a.", "'x", "f(1,", "[1]", "a ? b", "", ")))", "a[x]", "1 = 2", "a && b"]) {
      expect(() => ev(src)).not.toThrow();
      expect(ev(src)).toBeNull();
    }
  });
});

describe("parse errors", () => {
  it.each<[string, string, number]>([
    ["a < b < c", "comparisons do not chain; write a < b and b < c", 6],
    ["(1 + 2", "expected ) at column 7, the expression ended", 6],
    ["a && b", "write and instead of &&", 2],
    ["x = 1", "compare with ==, not =", 2],
    ["pr.checks[x]", "an index is a whole number, at column 11", 10],
  ])("%s", (src, message, at) => {
    const { errors } = parseSlateExpression(src);
    expect(errors).toEqual([{ code: "X400", name: "expr-syntax", message, at }]);
  });

  it("refuses an expression over 500 characters", () => {
    expect(parseSlateExpression("1+".repeat(250) + "1").errors[0]!.code).toBe("X407");
  });

  it("refuses nesting past 16", () => {
    expect(parseSlateExpression("(".repeat(17) + "1" + ")".repeat(17)).errors[0]!.code).toBe("X407");
    expect(parseSlateExpression("(".repeat(15) + "1" + ")".repeat(15)).errors).toEqual([]);
  });
});

describe("static checks", () => {
  const scope: SlateCheckScope = {
    path: (head, segs) => {
      const p = [head, ...segs].join(".");
      if (p === "usage.week.percent") return { type: "number" };
      if (p === "pr.word") return { type: "string" };
      return { code: "X401", message: `${p} is not a path`, ...(p === "usage.weekley.percent" ? { fix: "usage.week.percent" } : {}) };
    },
  };

  it("names an unknown path with its fix and its place", () => {
    const { problems } = checkSlateExpression("pct(usage.weekley.percent)", scope);
    expect(problems).toEqual([{ code: "X401", name: "path-unknown", message: "usage.weekley.percent is not a path", at: 4, fix: "usage.week.percent" }]);
  });

  it("names the nearest function and the arity", () => {
    expect(checkSlateExpression("tokns(1)", scope).problems[0]).toMatchObject({ code: "X404", fix: "tokens" });
    expect(checkSlateExpression("clamp(1, 2)", scope).problems[0]).toMatchObject({ code: "X405", message: "clamp takes 3 arguments, got 2: clamp(x, lo, hi)" });
  });

  it("refuses item outside a row and + on text", () => {
    expect(checkSlateExpression("item.name", scope).problems[0]!.code).toBe("X409");
    expect(checkSlateExpression("item.name", { ...scope, row: { item: "any" } }).problems).toEqual([]);
    expect(checkSlateExpression("pr.word + 1", scope).problems[0]!.code).toBe("X408");
  });

  it("infers the type a prop will get", () => {
    expect(checkSlateExpression("usage.week.percent > 80 ? 'warning' : 'default'", scope).type).toBe("string");
    expect(checkSlateExpression("usage.week.percent * 2", scope).type).toBe("number");
    expect(checkSlateExpression("tokens(usage.week.percent)", scope).type).toBe("string");
  });
});

describe("dependencies and props", () => {
  it("lists the paths read, without the row scope, with the clock for until", () => {
    expect(slateDependencies("item.done and state.steps[2].done or until(usage.week.resetsAt)")).toEqual(["state.steps[2].done", "time.now", "usage.week.resetsAt"]);
  });

  it("walks bindings, format holes and nested records", () => {
    expect(slatePropDependencies([{ title: "x", value: { bind: "item.name" }, tone: { bind: "pr.mergeable" } }, { format: "${len(pr.checks)} of ${tokens(thread.context.free)}" }]))
      .toEqual(["pr.mergeable", "pr.checks", "thread.context.free"]);
  });

  it("resolves literals, bindings and format strings, nulls as nothing", () => {
    expect(resolveSlateProp("usage.week.percent", ctx())).toBe("usage.week.percent");
    expect(resolveSlateProp({ bind: "usage.week.percent" }, ctx())).toBe(46);
    expect(resolveSlateProp({ format: "${pct(usage.week.percent)} used, $${not a hole}, ${pr.number}." }, ctx())).toBe("46% used, ${not a hole}, .");
    expect(resolveSlateProp([{ label: "Mergeable", value: { bind: "pr.mergeable" } }], ctx())).toEqual([{ label: "Mergeable", value: "conflicting" }]);
  });
});
