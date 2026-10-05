// SPDX-License-Identifier: AGPL-3.0-only
// Inputs from the agent or a paired device that once hung or crashed the host, which runs all of this on its event loop.
import { describe, expect, it } from "vitest";
import { compileSlateText, evaluateSlateExpression, parseSlate, runSlateBatch, setSlateValue, sketchSlate, slateCatalog, slateChartAxis, validateSlate, SLATE_LIMITS, type SlateJson } from "../../src/slate/index.js";

const codes = (text: string): string[] => { const r = parseSlate(text); return [...r.errors, ...r.warnings].map(p => p.code); };

describe("hostile slate inputs", () => {
  it("gives a chart an axis when the values' spread overflows or underflows", () => {
    for (const values of [[-1e308, 1e308], [0, 5e-324], [-1.2e308, 0.59e308]]) {
      const axis = slateChartAxis(values);
      expect(axis.parts).toBeGreaterThan(0);
      expect(axis.from).toBeLessThanOrEqual(Math.min(...values));
      expect(axis.to).toBeGreaterThanOrEqual(Math.max(...values));
    }
  });

  it("refuses a list index past the list cap before padding out to it", () => {
    const started = Date.now();
    expect(setSlateValue({ x: [] }, "$x[999999999]", 1)).toBeUndefined();
    expect(setSlateValue({ x: [] }, `$x[${SLATE_LIMITS.listItems}]`, 1)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(100);
    expect(setSlateValue({ x: [] }, "$x[2]", 1)).toEqual({ x: [null, null, 1] });
  });

  it("reads a name Object.prototype has as unknown everywhere the agent names something", () => {
    for (const n of Object.getOwnPropertyNames(Object.prototype)) {
      for (const text of [
        `<slate><text>{${n}(1)}</text></slate>`, `<slate><text>{[1] | ${n}}</text></slate>`, `<slate><${n} x={1} /></slate>`,
        `<slate><text ${n}="a">x</text></slate>`, `<slate><value name="v" start={1} /><button label="a" onPress={${n}($v, 1)} /></slate>`,
        `<slate><text>{time.${n}}</text></slate>`, `<slate><run name="r" cmd="echo" /><text>{$r.${n}}</text></slate>`,
        `<slate><secret name="s" /><text>{$s.${n}}</text></slate>`, `<slate><table items={[]}><${n} label="a" /></table></slate>`,
      ]) {
        const r = parseSlate(text);
        expect(r.errors.length, text).toBeGreaterThan(0);
      }
      expect(() => evaluateSlateExpression(`${n}(1)`, { resolve: () => undefined })).not.toThrow();
      expect(evaluateSlateExpression(`word('${n}')`, { resolve: () => undefined })).toBe(n[0] === "_" ? n.replace(/^_+|_+$/g, "").replace(/^./, c => c.toUpperCase()) : n[0]!.toUpperCase() + n.slice(1));
      expect(slateCatalog(n)).toContain("is not in the catalog");
      expect(validateSlate({ version: 1, root: { id: "r", type: n, props: {} } }).errors.length).toBeGreaterThan(0);
    }
    const doc = parseSlate(`<slate><value name="v" start={{ a: 1 }} /><text>{$v.constructor}</text></slate>`).document!;
    expect(() => { sketchSlate(doc, { v: { a: 1 } }); runSlateBatch(doc, { v: { a: 1 } }, [{ path: "$v.toString", value: 1 }]); }).not.toThrow();
    expect(codes(`<slate><text>{toString(1)}</text></slate>`)).toContain("X404");
    expect(parseSlate(`<slate><constructor /></slate>`).errors[0]!.message).not.toContain("function");
  });

  it("refuses an env key with RegExp characters instead of throwing", () => {
    expect(codes(`<slate><secret name="tok" /><run name="r" cmd="echo" env={{ "A(": $tok }} /><text>x</text></slate>`)).toContain("K702");
  });

  it("reads a slate in time linear in its length, and refuses text past the caps before reading it", () => {
    const pieces = (n: number): string => `<slate>\n<column>\n${Array.from({ length: n }, (_, i) => `<text tone="muted">line ${i}</text>`).join("\n")}\n</column>\n</slate>`;
    const timed = (work: () => void): number => Math.min(...[1, 2, 3].map(() => { const started = performance.now(); work(); return performance.now() - started; }));
    const big = pieces(3_500);
    expect(big.length).toBeLessThan(SLATE_LIMITS.documentBytes + SLATE_LIMITS.filesBytes);
    // Twenty JSON reads of the same length are linear work timed under the same load; the quadratic reader took about 90 times that.
    const json = JSON.stringify(big);
    const linear = timed(() => { for (let i = 0; i < 20; i++) JSON.parse(json); });
    expect(timed(() => compileSlateText(big)) / linear).toBeLessThan(30);
    const over = compileSlateText(pieces(20_000));
    expect(over.errors.map(e => e.code)).toEqual(["D208"]);
    const deep = `<slate>${"<column>".repeat(3_000)}<text>x</text>${"</column>".repeat(3_000)}</slate>`;
    expect(compileSlateText(deep).errors.map(e => e.code)).toEqual(["D206"]);
  });

  it("charges a call for the text it builds, enforces the step budget, and joins through a lookup", () => {
    const nested = Array.from({ length: 8 }).reduce<string>(inner => `replace(${inner}, 'a', 'aaaaaaaaaa')`, "'a'");
    let started = performance.now();
    expect(evaluateSlateExpression(nested, { resolve: () => undefined })).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
    const many = { k: "list" as const, items: Array.from({ length: SLATE_LIMITS.evalSteps }, () => ({ k: "lit" as const, v: 1, at: 0 })), at: 0 };
    expect(evaluateSlateExpression(many, { resolve: () => undefined })).toBeNull();
    const rows = Array.from({ length: 5_000 }, (_, i) => ({ id: i }));
    const values: Record<string, SlateJson> = { a: rows, b: rows.map(r => ({ id: r.id, n: r.id * 2 })) };
    started = performance.now();
    const joined = evaluateSlateExpression("$a | join($b, id)", { resolve: p => values[p.slice(1)] }) as { b: { n: number } }[];
    expect(performance.now() - started).toBeLessThan(500);
    expect(joined[4_999]!.b.n).toBe(9_998);
  });
});
