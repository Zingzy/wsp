// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importConsented, importRequest, type ProjectPlan } from "../src/index.js";
import { ROOT } from "./source-files.js";

const env = { path: ".env", bytes: 19, signals: ["name" as const] };
const config = { path: ".git/config", bytes: 200, signals: ["url" as const], rewrite: { urls: ["https://github.com/o/r"], drop: [] } };
const plan: ProjectPlan = {
  source: "/Users/me/code/proj",
  repo: true,
  files: 3,
  bytes: 300,
  secrets: [env, config],
  excluded: ["node_modules"],
  skipped: [],
  agents: [
    { agent: "claude", name: "Claude Code", sessions: 2, bytes: 100, carry: "moves" },
    { agent: "codex", name: "Codex", sessions: 1, bytes: 50, carry: "transcript-only" },
  ],
};

describe("importConsented", () => {
  it("is yes, or an answer to a secret-shaped row; nothing given is the dry run", () => {
    expect(importConsented({ yes: true, keep: [], cut: [] })).toBe(true);
    expect(importConsented({ keep: [".env"], cut: [] })).toBe(true);
    expect(importConsented({ keep: [], cut: [".git/config"] })).toBe(true);
    expect(importConsented({ yes: false, keep: [], cut: [] })).toBe(false);
    expect(importConsented({ keep: [], cut: [] })).toBe(false);
  });
});

describe("importRequest", () => {
  it("is the one request every client sends: the source as given, dest from the plan, carry and rewrite from the ticks, agents when any is ticked, replace only when asked", () => {
    expect(importRequest(plan, "/Users/me/code/proj/", new Set([".env", ".git/config"]), new Set(["claude"]), true)).toEqual({
      source: "/Users/me/code/proj/",
      dest: "/Users/me/code/proj",
      carry: [".env"],
      rewrite: [".git/config"],
      agents: ["claude"],
      replace: true,
    });
    const bare = importRequest(plan, "/Users/me/code/proj", new Set(), new Set(), false);
    expect(bare).toEqual({ source: "/Users/me/code/proj", dest: "/Users/me/code/proj", carry: [], rewrite: [] });
    expect("agents" in bare).toBe(false);
    expect("replace" in bare).toBe(false);
    expect(importRequest(plan, "/Users/me/code/proj", new Set(), new Set(["codex", "claude"]))).toMatchObject({ agents: ["claude", "codex"] });
  });

  it("is assembled once: the command line, the MCP tool, the dialog and the wizard's first import call it and none spells the request out again", () => {
    const callers = ["packages/host/src/verbs.ts", "packages/host/src/mcp.ts", "apps/web/src/sidebar/ImportProjectDialog.tsx", "packages/host/src/init-first.ts"];
    for (const rel of callers) {
      const source = readFileSync(join(ROOT, rel), "utf8");
      expect(source, rel).toContain("importRequest(");
      expect(source, rel).not.toMatch(/dest: plan\.source/);
      expect(source, rel).not.toMatch(/consentRequest\(/);
    }
    for (const rel of callers.slice(0, 2)) {
      const source = readFileSync(join(ROOT, rel), "utf8");
      expect(source, rel).toContain("importConsented(");
      expect(source, rel).not.toMatch(/keep\.length === 0 && cut\.length === 0/);
    }
  });
});
