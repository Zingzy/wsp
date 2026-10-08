// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { freePorts } from "./held-port.js";

describe("free ports picked together", () => {
  // Picked one at a time, 300 numbers held a repeat in 20 of 20 runs (measured on Linux, 2026-10-08).
  it("hold no number twice", async () => {
    const ports = await freePorts(300);
    expect(new Set(ports).size).toBe(300);
  });
});
