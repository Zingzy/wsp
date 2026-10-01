// SPDX-License-Identifier: AGPL-3.0-only
// Which agents wsp can open a thread on: one list, the adapter registry keyed
// by exactly it, and every id a catalog agent.
import { CATALOG_AGENTS, THREAD_AGENTS } from "@wsp/catalog";
import { movesRunningAccess, screenCommandsOf, signInRefusalLine, takesMcpServers } from "@wsp/protocol";
import type { Machine } from "@wsp/engine";
import { describe, expect, it } from "vitest";
import { SKIP_PROMPTS_MODE } from "@wsp/adapter-claude";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { HARNESS_CATALOGS } from "../src/harness-catalog.js";
import { machineExecStream } from "../src/machine-exec.js";

describe("the agents wsp can open a thread on", () => {
  it("is one list, the adapter registry is keyed by it, and every id is a catalog agent", () => {
    expect(Object.keys(HARNESS_ADAPTERS).sort()).toEqual([...THREAD_AGENTS].sort());
    expect([...THREAD_AGENTS]).toEqual(["claude", "codex", "opencode", "cursor"]);
    for (const id of THREAD_AGENTS) expect(CATALOG_AGENTS.map(a => a.id)).toContain(id);
  });

  it("each catalog row says what its own adapter can hand a launch, so a client reads the row before any workspace exists", () => {
    const machine = {} as Machine;
    for (const id of THREAD_AGENTS) {
      const adapter = HARNESS_ADAPTERS[id]({ machine, workspaceId: "ws_1", execStream: machineExecStream(machine), home: () => "/root/.state", env: {}, signInRefusal: signInRefusalLine({ kind: "cloud" }), vault: {}, loginStands: () => false });
      const row = HARNESS_CATALOGS.find(c => c.harness === id);
      expect(takesMcpServers(row), id).toBe(adapter.mcpServers === true);
      // The row carries the adapter's own table of screen-only commands, so the composer reads it off the table before
      // a machine answers and a command added to the adapter's table needs no second edit.
      expect(screenCommandsOf(row), id).toEqual(adapter.screenCommands ?? []);
      // And whether a pick made while a turn runs reaches that turn, which the access picker says before the pick.
      expect(movesRunningAccess(row), id).toBe(adapter.movesAccess === true);
    }
    expect(screenCommandsOf(HARNESS_CATALOGS.find(c => c.harness === "claude")).map(c => c.name)).toContain("login");
    expect(screenCommandsOf(HARNESS_CATALOGS.find(c => c.harness === "codex"))).toEqual([]);
    // The mode a row calls its bypass is the one its adapter knows as a launch flag: one slug, pinned to the module
    // that owns it, so the table and the launch cannot drift apart.
    expect(HARNESS_CATALOGS.find(c => c.harness === "claude")?.bypassMode).toBe(SKIP_PROMPTS_MODE);
    // Both take a message mid-turn: Claude Code on its stream-json channel, Codex as the app server's turn/steer.
    for (const id of ["claude", "codex"] as const) {
      const adapter = HARNESS_ADAPTERS[id]({ machine, workspaceId: "ws_1", execStream: machineExecStream(machine), home: () => "/root/.state", env: {}, signInRefusal: signInRefusalLine({ kind: "cloud" }), vault: {}, loginStands: () => false });
      expect(adapter.steers, id).toBe(true);
      // And a side question: Claude Code on a fork with its tools off, Codex on an ephemeral read-only fork.
      expect(typeof adapter.aside, id).toBe("function");
    }
    // Both take the servers on their launch: Claude Code as --mcp-config, Codex as config overrides.
    expect(takesMcpServers(HARNESS_CATALOGS.find(c => c.harness === "claude"))).toBe(true);
    expect(takesMcpServers(HARNESS_CATALOGS.find(c => c.harness === "codex"))).toBe(true);
  });

  it("OpenCode's row offers Auto alone and says why, Cursor's the two modes its CLI has, and neither takes a message mid-turn", () => {
    const machine = {} as Machine;
    const ctx = { machine, workspaceId: "ws_1", execStream: machineExecStream(machine), home: () => "/root/.state", env: {}, signInRefusal: signInRefusalLine({ kind: "cloud" }), loginStands: () => false };
    const opencode = HARNESS_CATALOGS.find(c => c.harness === "opencode")!;
    expect(opencode.permissionModes.map(m => m.value)).toEqual(["auto"]);
    expect(opencode.permissionModes[0]!.description).toMatch(/^Runs every action without asking.*nobody to ask$/);
    expect([opencode.access, opencode.bypassMode]).toEqual([{ full: "auto" }, "auto"]);
    const cursor = HARNESS_CATALOGS.find(c => c.harness === "cursor")!;
    expect(cursor).toMatchObject({ label: "Cursor", models: [], access: { full: "force", plan: "default" }, bypassMode: "force" });
    expect(cursor.permissionModes.map(m => m.value)).toEqual(["default", "force"]);
    for (const id of ["opencode", "cursor"] as const) expect(HARNESS_ADAPTERS[id]({ ...ctx, vault: {} }).steers, id).toBe(false);
    // The key the vault holds for Cursor rides the turn's environment under the variable its row names, and only where no login stands.
    expect(HARNESS_ADAPTERS.cursor({ ...ctx, vault: { CURSOR_API_KEY: "key_x" } }).env).toEqual({ CURSOR_API_KEY: "key_x" });
    expect(HARNESS_ADAPTERS.cursor({ ...ctx, vault: { CURSOR_API_KEY: "key_x" }, loginStands: () => true }).env).toEqual({});
  });

  it("every adapter exports the login env the runtime hands it, so a turn carries the golden's PATH onto the machine", () => {
    const env = { PATH: "/root/.local/bin:/usr/bin" };
    const machine = {} as Machine;
    for (const id of THREAD_AGENTS) {
      const adapter = HARNESS_ADAPTERS[id]({ machine, workspaceId: "ws_1", execStream: machineExecStream(machine), home: () => "/root/.state", env, signInRefusal: signInRefusalLine({ kind: "cloud" }), vault: {}, loginStands: () => false });
      expect(adapter.env?.PATH).toBe(env.PATH);
    }
  });
});
