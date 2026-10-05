// SPDX-License-Identifier: AGPL-3.0-only
// Inputs from the agent or a paired device that once hung or crashed the host, which runs all of this on its event loop.
import { describe, expect, it } from "vitest";
import { setSlateValue, slateChartAxis, SLATE_LIMITS } from "../../src/slate/index.js";

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
});
