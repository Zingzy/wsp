// SPDX-License-Identifier: AGPL-3.0-only
// Which agents wsp can open a thread on: one list, the adapter registry keyed
// by exactly it, and every id a catalog agent.
import { CATALOG_AGENTS, THREAD_AGENTS } from "@wsp/catalog";
import { screenCommandsOf, takesMcpServers } from "@wsp/protocol";
import type { Machine } from "@wsp/engine";
import { describe, expect, it } from "vitest";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { HARNESS_CATALOGS } from "../src/harness-catalog.js";
import { machineExecStream } from "../src/machine-exec.js";

describe("the agents wsp can open a thread on", () => {
  it("is one list, the adapter registry is keyed by it, and every id is a catalog agent", () => {
    expect(Object.keys(HARNESS_ADAPTERS).sort()).toEqual([...THREAD_AGENTS].sort());
    expect([...THREAD_AGENTS]).toEqual(["claude", "codex"]);
    for (const id of THREAD_AGENTS) expect(CATALOG_AGENTS.map(a => a.id)).toContain(id);
  });

  it("each catalog row says what its own adapter can hand a launch, so a client reads the row before any workspace exists", () => {
    const machine = {} as Machine;
    for (const id of THREAD_AGENTS) {
      const adapter = HARNESS_ADAPTERS[id]({ machine, workspaceId: "ws_1", execStream: machineExecStream(machine), home: () => "/root/.state", env: {} });
      const row = HARNESS_CATALOGS.find(c => c.harness === id);
      expect(takesMcpServers(row), id).toBe(adapter.mcpServers === true);
      // The row carries the adapter's own table of screen-only commands, so the composer reads it off the table before
      // a machine answers and a command added to the adapter's table needs no second edit.
      expect(screenCommandsOf(row), id).toEqual(adapter.screenCommands ?? []);
    }
    expect(screenCommandsOf(HARNESS_CATALOGS.find(c => c.harness === "claude")).map(c => c.name)).toContain("login");
    expect(screenCommandsOf(HARNESS_CATALOGS.find(c => c.harness === "codex"))).toEqual([]);
    // Where the two stand today: Claude Code takes the servers on its launch, Codex has no per-launch road yet.
    expect(takesMcpServers(HARNESS_CATALOGS.find(c => c.harness === "claude"))).toBe(true);
    expect(takesMcpServers(HARNESS_CATALOGS.find(c => c.harness === "codex"))).toBe(false);
  });

  it("every adapter exports the login env the runtime hands it, so a turn carries the golden's PATH onto the machine", () => {
    const env = { PATH: "/root/.local/bin:/usr/bin" };
    const machine = {} as Machine;
    for (const id of THREAD_AGENTS) {
      const adapter = HARNESS_ADAPTERS[id]({ machine, workspaceId: "ws_1", execStream: machineExecStream(machine), home: () => "/root/.state", env });
      expect(adapter.env?.PATH).toBe(env.PATH);
    }
  });
});
