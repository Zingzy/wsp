// SPDX-License-Identifier: AGPL-3.0-only
// Which agents wsp can open a thread on: one list, the adapter registry keyed
// by exactly it, and every id a catalog agent.
import { CATALOG_AGENTS } from "@wsp/catalog";
import type { Machine } from "@wsp/engine";
import { describe, expect, it } from "vitest";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { THREAD_AGENTS } from "../src/thread-agents.js";

describe("the agents wsp can open a thread on", () => {
  it("is one list, the adapter registry is keyed by it, and every id is a catalog agent", () => {
    expect(Object.keys(HARNESS_ADAPTERS).sort()).toEqual([...THREAD_AGENTS].sort());
    expect([...THREAD_AGENTS]).toEqual(["claude", "codex"]);
    for (const id of THREAD_AGENTS) expect(CATALOG_AGENTS.map(a => a.id)).toContain(id);
  });

  it("every adapter exports the login env the runtime hands it, so a turn carries the golden's PATH onto the machine", () => {
    const env = { PATH: "/root/.local/bin:/usr/bin" };
    for (const id of THREAD_AGENTS) {
      const adapter = HARNESS_ADAPTERS[id]({ machine: {} as Machine, workspaceId: "ws_1", env });
      expect(adapter.env?.PATH).toBe(env.PATH);
    }
  });
});
