// SPDX-License-Identifier: AGPL-3.0-only
// Inputs from the agent or a paired device that once hung or crashed the host, which runs all of this on its event loop.
import { describe, expect, it } from "vitest";
import { evaluateSlateExpression, parseSlate, runSlateBatch, setSlateValue, sketchSlate, slateCatalog, slateChartAxis, validateSlate, SLATE_LIMITS } from "../../src/slate/index.js";

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
});
