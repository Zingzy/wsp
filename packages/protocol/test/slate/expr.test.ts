import { describe, expect, it } from "vitest";
import { checkSlateExpression, evaluateSlateExpression, parseSlate, parseSlateExpression, slateDependencies, type SlateCheckScope, type SlateJson } from "../../src/slate/index.js";
import { slateSourceType } from "../../src/slate/sources.js";

const now = Date.parse("2026-10-04T12:00:00Z");
const world: Record<string, SlateJson> = {
  "thread.context.used": 164_000, "thread.context.window": 1_000_000, "thread.context.free": 836_000,
  "usage.week.percent": 46, "usage.week.resetsAt": now + (3 * 24 + 7) * 3_600_000,
  "pr.checks": [
    { name: "build", state: "pending", startedAt: "2026-10-04T11:50:00Z", completedAt: null },
    { name: "lint", state: "pass", startedAt: "2026-10-04T11:50:00Z", completedAt: "2026-10-04T11:51:04Z" },
    { name: "test", state: "fail", startedAt: "2026-10-04T11:50:00Z", completedAt: "2026-10-04T11:55:00Z" },
    { name: "docs", state: "pass", startedAt: "2026-10-04T11:50:00Z", completedAt: "2026-10-04T11:50:30Z" },
  ],
  "pr.word": null,
  "$check": { state: "done", exit: 0, out: '{"id":1234,"title":"Round once"}', json: { id: 1234, title: "Round once" }, runs: 1 },
  "$steps": [{ title: "a", done: true }, { title: "b", done: false }, { title: "c", done: true }],
  "processes.list": [{ name: "a", cpu: 1, mem: 3, pid: 1 }, { name: "b", cpu: 9, mem: 2, pid: 2 }, { name: "c", cpu: null, mem: 1, pid: 3 }, { name: "d", cpu: 5, mem: 0, pid: 4 }],
};
const ctx = { resolve: (p: string) => world[p], now };
const ev = (src: string, extra: object = {}) => evaluateSlateExpression(src, { ...ctx, ...extra });

const scope: SlateCheckScope = {
  path: (head, own, segs) => (own ? (head === "steps" ? { t: "list", of: { t: "record", fields: { title: { t: "string" }, done: { t: "boolean" } } } } : { t: "any" }) : slateSourceType(head, segs)),
};
const check = (src: string, row?: boolean) => checkSlateExpression(src, row ? { ...scope, row: { t: "any" } } : scope).problems.map(p => p.code);

describe("expressions", () => {
  it("evaluates 04's examples to the values its table gives", () => {
    expect(ev("percent(thread.context.used / thread.context.window)")).toBe("16%");
    expect(ev("tokens(thread.context.free)")).toBe("836k");
    expect(ev("usage.week.percent > 80 ? 'warning' : 'default'")).toBe("default");
    expect(ev("until(usage.week.resetsAt)")).toBe("in 3d 7h");
    expect(ev("len(pr.checks)")).toBe(4);
    expect(ev("first(pr.checks).name")).toBe("build");
    expect(ev("word(item.state)", { item: { state: "pending" } })).toBe("Running");
    expect(ev("pr.checks | where(item.state == 'fail') | count")).toBe(1);
    expect(ev("$check.state == 'done' && $check.json.id != null")).toBe(true);
    expect(ev("(pr.checks | first).state")).toBe("pending");
    expect(ev("json($check.out).title")).toBe("Round once");
    expect(ev("orElse(pr.word, 'no pull request')")).toBe("no pull request");
    expect(ev("$steps | where(item.done) | count")).toBe(2);
    expect(ev("item.completedAt ? duration(num(item.completedAt) - num(item.startedAt)) : 'running'", { item: (world["pr.checks"] as SlateJson[])[1] })).toBe("1m 4s");
    expect(ev("processes.list | sortBy(item.cpu, 'desc') | take(2) | pick(name, cpu)")).toEqual([{ name: "b", cpu: 9 }, { name: "d", cpu: 5 }]);
  });

  it("reads JavaScript's spellings as the word forms", () => {
    expect(ev("!(1 === 1) || 2 !== 2")).toBe(false);
    expect(ev("true && 'x'")).toBe("x");
    expect(ev("`${len(pr.checks)} of ${4}`")).toBe("4 of 4");
  });

  it("runs every step over a list", () => {
    expect(ev("pr.checks | groupBy(item.state) | map(n: item.count) | pick(key, n)")).toEqual([{ key: "pending", n: 1 }, { key: "pass", n: 2 }, { key: "fail", n: 1 }]);
    expect(ev("processes.list | sum(item.cpu)")).toBe(15);
    expect(ev("processes.list | avg(item.mem)")).toBe(1.5);
    expect(ev("processes.list | min(item.cpu)")).toBe(1);
    expect(ev("processes.list | sortBy(item.cpu) | format(item.name)")).toEqual(["a", "d", "b", "c"]);
    expect(ev("pr.checks | distinct(item.state) | count")).toBe(3);
    expect(ev("pr.checks | skip(3) | last")).toEqual((world["pr.checks"] as SlateJson[])[3]);
    expect(ev("pr.checks | where(item.state == 'pass') | join(processes.list, name)")).toEqual([
      { ...((world["pr.checks"] as SlateJson[])[1] as object), list: null },
      { ...((world["pr.checks"] as SlateJson[])[3] as object), list: null },
    ]);
    expect(ev("$steps | map(n: index) | flatten")).toEqual([]);
  });

  it("answers null for a failure and never throws", () => {
    expect(ev("1 / 0")).toBe(null);
    expect(ev("null + 1")).toBe(null);
    expect(ev("null < 3")).toBe(null);
    expect(ev("pr.missing.deeper")).toBeUndefined();
    expect(ev("pr.checks[9].name")).toBeUndefined();
    expect(ev("pr.checks[-1].name")).toBe("docs");
    expect(ev("$x.__proto__")).toBeUndefined();
  });

  it("refuses at write time what 04's table refuses", () => {
    expect(check("usage.weekley.percent")).toEqual(["X401"]);
    expect(checkSlateExpression("usage.weekley.percent", scope).problems[0]!.message).toBe("usage.weekley.percent is not a path. Did you mean usage.week.percent?");
    expect(check("pr.checks.length")).toEqual(["X420"]);
    expect(check("a < b < c")).toEqual(["X400"]);
    expect(check("item.name")).toEqual(["X409"]);
    expect(check("pr.checks | take($n)")).toEqual(["Q425"]);
    expect(checkSlateExpression("pr.checks | filter(item.state == 'fail')", scope).problems[0]).toMatchObject({ code: "Q422", fix: "where" });
    expect(check("pr.checks | where(item.state != 'pass') | sortBy(item.name) | pluck")).toEqual(["Q422"]);
    expect(check("pr.checks == 'fail'")).toEqual(["X408"]);
    expect(check("'a' + 1")).toEqual(["X408"]);
    expect(check("items.map(i => i.name)")).toEqual(["X420"]);
    expect(check("s.toUpperCase()")).toEqual(["X420"]);
    expect(check("a ?? b")).toEqual(["X420"]);
    expect(check("[1, 2]")).toEqual(["X420"]);
    expect(check("x = 1")).toEqual(["X420"]);
    expect(check("lenn(pr.checks)")).toEqual(["X404"]);
    expect(check("short(pr.word)")).toEqual(["X405"]);
    expect(check("tokens(pr.word)")).toEqual(["X406"]);
    expect(check("usage.week.percent | count")).toEqual(["Q424"]);
    expect(check("pr.checks | where(item.stat == 'fail')")).toEqual(["X401"]);
    expect(check("$steps | where(item.don)")).toEqual(["X401"]);
    expect(check("set($x, 1)")).toEqual(["X400"]);
    expect(check("pr.checks | take(1) | take(1) | take(1) | take(1) | take(1) | take(1) | take(1) | take(1) | take(1) | take(1) | take(1) | take(1) | take(1)")).toEqual(["Q426"]);
    expect(check("x".repeat(501))).toEqual(["X407"]);
  });

  it("lists every path an expression reads, and time.now for the clock", () => {
    expect(slateDependencies("until(usage.week.resetsAt) + len($steps | where(item.done)) + first(pr.checks).name").sort()).toEqual(["$steps", "pr.checks", "time.now", "usage.week.resetsAt"]);
    expect(slateDependencies("processes.list | pick(name, cpu)")).toEqual(["processes.list"]);
  });

  it("parses every line of 04's example block, the pluck line failing as marked", () => {
    const lines = [
      "percent(thread.context.used / thread.context.window)", "tokens(thread.context.free)", "usage.week.percent > 80 ? 'warning' : 'default'",
      "until(usage.week.resetsAt)", "len(pr.checks)", "first(pr.checks).name", "item.completedAt ? duration(num(item.completedAt) - num(item.startedAt)) : 'running'",
      "word(item.state)", "orElse(pr.word, 'no pull request')", "pr.checks | where(item.state == 'fail') | count", "$check.state == 'done' && $check.json.id != null",
      "json($check.out).title", "processes.list | sortBy(item.cpu, 'desc') | take(5) | pick(name, cpu, mem)", "$steps | where(item.done) | count", "(pr.checks | first).state",
    ];
    for (const l of lines) expect(parseSlateExpression(l).errors).toEqual([]);
    expect(parseSlateExpression("pr.checks | where(item.state != 'pass') | sortBy(item.name) | pluck").errors[0]!.code).toBe("Q422");
  });

  it("holds secrets and run fields in a slate", () => {
    const r = parseSlate(`<slate>
  <secret name="token" />
  <run name="check" cmd="true" />
  <column>
    <text>{$token}</text>
    <text>{$token.len} {$check.exitt}</text>
  </column>
</slate>`);
    expect(r.errors.map(e => e.code)).toEqual(["S520", "X401"]);
  });
});
