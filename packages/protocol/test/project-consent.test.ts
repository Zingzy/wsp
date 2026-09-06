// SPDX-License-Identifier: AGPL-3.0-only
// The consent an import starts from, which the app's dialog offers as ticks
// and wsp init's first import takes whole, and the address that opens the app
// on one workspace.
import { describe, expect, it } from "vitest";
import { defaultImportConsent, workspaceFromHash, workspaceHash, type ProjectAgent, type ProjectPlan, type ProjectSecret } from "../src/index.js";

const bare: ProjectSecret = { path: ".env", bytes: 120, signals: ["keys"] };
const rewritable: ProjectSecret = { path: ".git/config", bytes: 300, signals: ["url"], rewrite: { urls: ["https://github.com/o/r"], drop: [] } };
const busy: ProjectAgent = { agent: "claude", name: "Claude Code", sessions: 46, bytes: 9_400_000, carry: "moves" };
const idle: ProjectAgent = { agent: "gemini", name: "Gemini CLI", sessions: 0, bytes: 0, carry: "moves" };
const broken: ProjectAgent = { agent: "opencode", name: "OpenCode", sessions: 3, bytes: 40, carry: "moves", error: "state.db is locked by another process" };

const plan = (over: Partial<ProjectPlan> = {}): ProjectPlan => ({
  source: "/Users/me/code/proj",
  repo: true,
  files: 12,
  bytes: 3072,
  secrets: [],
  excluded: [],
  skipped: [],
  agents: [],
  ...over,
});

describe("defaultImportConsent", () => {
  it("rewrites what can be rewritten, carries nothing bare, and sends the agents with readable sessions", () => {
    expect(defaultImportConsent(plan({ secrets: [bare, rewritable], agents: [busy, idle, broken] }))).toEqual({
      carry: [],
      rewrite: [".git/config"],
      agents: ["claude"],
    });
  });

  it("leaves agents out entirely when none can travel, which the runtime reads as none named", () => {
    expect(defaultImportConsent(plan({ secrets: [bare], agents: [idle, broken] }))).toEqual({ carry: [], rewrite: [] });
  });

  it("a folder with no secrets and no agents consents to nothing at all", () => {
    expect(defaultImportConsent(plan())).toEqual({ carry: [], rewrite: [] });
  });
});

describe("the workspace a page opens on", () => {
  it("round-trips an id through the hash", () => {
    expect(workspaceHash("ws_a1b2")).toBe("#w/ws_a1b2");
    expect(workspaceFromHash(workspaceHash("ws_a1b2"))).toBe("ws_a1b2");
  });

  it("names no workspace for the app's own hashes, an empty one, or no hash at all", () => {
    expect(workspaceFromHash("#gallery")).toBeUndefined();
    expect(workspaceFromHash("")).toBeUndefined();
    expect(workspaceFromHash("#w/")).toBeUndefined();
  });
});
