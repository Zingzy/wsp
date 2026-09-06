// SPDX-License-Identifier: AGPL-3.0-only
// Which agents wsp can open a thread on: one list, and the adapter registry
// typed by it.
import { describe, expect, it } from "vitest";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { THREAD_AGENTS } from "../src/thread-agents.js";

describe("the agents wsp can open a thread on", () => {
  it("is one list, and the adapter registry is keyed by it", () => {
    expect(Object.keys(HARNESS_ADAPTERS).sort()).toEqual([...THREAD_AGENTS].sort());
  });
});
