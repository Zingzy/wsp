// SPDX-License-Identifier: AGPL-3.0-only
// Inputs from the agent or a paired device that once hung or crashed the host, which runs all of this on its event loop.
import { describe, expect, it } from "vitest";
import { slateChartAxis } from "../../src/slate/index.js";

describe("hostile slate inputs", () => {
  it("gives a chart an axis when the values' spread overflows or underflows", () => {
    for (const values of [[-1e308, 1e308], [0, 5e-324], [-1.2e308, 0.59e308]]) {
      const axis = slateChartAxis(values);
      expect(axis.parts).toBeGreaterThan(0);
      expect(axis.from).toBeLessThanOrEqual(Math.min(...values));
      expect(axis.to).toBeGreaterThanOrEqual(Math.max(...values));
    }
  });
});
