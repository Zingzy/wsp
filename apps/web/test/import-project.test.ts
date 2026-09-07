// SPDX-License-Identifier: AGPL-3.0-only
// The import dialog's pure parts: which events belong to one import, the consent defaults for the
// secret-shaped files and the agents and the request they become, the secret
// offer wording as the tick changes it, the agent row's words, and the landed
// line with what was cut.
import { describe, expect, it } from "vitest";
import type { ProjectAgent, ProjectImportEvent, ProjectSecret } from "@wsp/protocol";
import { agentState, agentsRequest, canTravel, consentRequest, defaultAgents, defaultConsent, isImportOf, landedLine, secretOffer } from "../src/sidebar/importProject.js";

const ev = (over: Partial<ProjectImportEvent>): ProjectImportEvent => ({
  type: "project.import",
  workspaceId: "ws_a",
  source: "/Users/me/code/proj",
  dest: "/Users/me/code/proj",
  stage: "planned",
  message: "12 files, 3.0 KB and the repository; 2 secret-shaped files; 1 cache left behind.",
  elapsedMs: 10,
  ...over,
});

const env: ProjectSecret = { path: ".env", bytes: 120, signals: ["name", "keys"] };
const key: ProjectSecret = { path: "keys/id_ed25519", bytes: 400, signals: ["pem"] };
const config: ProjectSecret = { path: ".git/config", bytes: 300, signals: ["url"], rewrite: { urls: ["https://github.com/o/r"], drop: [] } };
const header: ProjectSecret = { path: "vendor/x/.git/config", bytes: 200, signals: ["keys"], rewrite: { urls: [], drop: ["http.extraheader"] } };

const claude: ProjectAgent = { agent: "claude", name: "Claude Code", sessions: 46, bytes: 9_400_000, carry: "moves" };
const codex: ProjectAgent = { agent: "codex", name: "Codex", sessions: 1, bytes: 12_000, carry: "transcript-only" };
const empty: ProjectAgent = { agent: "gemini", name: "Gemini CLI", sessions: 0, bytes: 0, carry: "moves" };
const broken: ProjectAgent = { agent: "opencode", name: "OpenCode", sessions: 0, bytes: 0, carry: "moves", error: "state.db is locked by another process" };

describe("agent consent", () => {
  it("starts every agent with readable sessions ticked, and none without sessions or with a read error", () => {
    expect(canTravel(claude)).toBe(true);
    expect(canTravel(empty)).toBe(false);
    expect(canTravel(broken)).toBe(false);
    expect([...defaultAgents([claude, codex, empty, broken])]).toEqual(["claude", "codex"]);
    expect([...defaultAgents([])]).toEqual([]);
  });

  it("names the ticked agents in the plan's order, and nothing when none is ticked", () => {
    expect(agentsRequest([claude, codex], new Set(["codex", "claude"]))).toEqual(["claude", "codex"]);
    expect(agentsRequest([claude, codex], new Set(["codex"]))).toEqual(["codex"]);
    expect(agentsRequest([claude, codex], new Set())).toBeUndefined();
    expect(agentsRequest([], new Set(["claude"]))).toBeUndefined();
  });

  it("gives a row its session count, or its read error when the store could not be read", () => {
    expect(agentState(claude)).toBe("46 sessions");
    expect(agentState(codex)).toBe("1 session");
    expect(agentState(empty)).toBe("0 sessions");
    expect(agentState(broken)).toBe("state.db is locked by another process");
  });
});

describe("which events belong to the import", () => {
  const plan = { source: "/private/var/proj", repo: true, files: 1, bytes: 1, secrets: [], excluded: [], skipped: [], agents: [] };
  it("matches the workspace with the path as typed or the plan's realpath, nothing else", () => {
    expect(isImportOf(ev({ source: "/var/proj" }), "ws_a", "/var/proj", plan)).toBe(true);
    expect(isImportOf(ev({ source: "/private/var/proj" }), "ws_a", "/var/proj", plan)).toBe(true);
    expect(isImportOf(ev({ source: "/var/proj" }), "ws_a", "/var/proj", null)).toBe(true);
    expect(isImportOf(ev({ source: "/private/var/proj" }), "ws_a", "/var/proj", null)).toBe(false);
    expect(isImportOf(ev({ source: "/var/other" }), "ws_a", "/var/proj", plan)).toBe(false);
    expect(isImportOf(ev({ source: "/var/proj", workspaceId: "ws_b" }), "ws_a", "/var/proj", plan)).toBe(false);
  });
});

describe("consent", () => {
  it("ticks every rewrite offer by default and nothing that would travel as it is", () => {
    expect([...defaultConsent([env, config, key, header])].sort()).toEqual([".git/config", "vendor/x/.git/config"]);
    expect(defaultConsent([]).size).toBe(0);
  });

  it("turns the ticked paths into carry for plain files and rewrite for offered ones; unticked paths appear in neither", () => {
    expect(consentRequest([env, config, key, header], new Set([".env", ".git/config"]))).toEqual({ carry: [".env"], rewrite: [".git/config"] });
    expect(consentRequest([env, config, key, header], new Set())).toEqual({ carry: [], rewrite: [] });
    expect(consentRequest([env, config], new Set([".env", ".git/config", "gone"]))).toEqual({ carry: [".env"], rewrite: [".git/config"] });
  });

  it("words each row by its tick in plain words: unticked is left out; ticked travels as is, or is rewritten without its keys, the full form naming what the rewrite leaves", () => {
    expect(secretOffer(env, false)).toEqual({ short: "left out", full: "left out" });
    expect(secretOffer(env, true)).toEqual({ short: "travels as is", full: "travels as is" });
    expect(secretOffer(config, false)).toEqual({ short: "left out", full: "left out" });
    expect(secretOffer(config, true)).toEqual({ short: "rewritten without keys", full: "rewritten without keys; the remote reads https://github.com/o/r" });
    expect(secretOffer(header, true)).toEqual({ short: "rewritten without keys", full: "rewritten without keys; http.extraheader left out" });
    expect(secretOffer({ ...config, rewrite: { urls: ["https://github.com/o/r", "https://gitlab.com/o/s"], drop: ["http.extraheader"] } }, true)).toEqual({
      short: "rewritten without keys",
      full: "rewritten without keys; the remote reads https://github.com/o/r, https://gitlab.com/o/s; http.extraheader left out",
    });
  });
});

describe("the landed line", () => {
  it("names the folder, its path on the machine and the workspace, then how many were left out and where the list is", () => {
    const result = { dest: "/Users/me/code/proj", files: 11, bytes: 2_900, parts: 1, cut: [], rewritten: [".git/config"], agents: [] };
    expect(landedLine(result, "/Users/me/code/proj", "api")).toBe("proj is at /Users/me/code/proj on api.");
    expect(landedLine(result, "/Users/me/code/proj/", "api")).toBe("proj is at /Users/me/code/proj on api.");
    expect(landedLine({ ...result, cut: ["keys/id_ed25519", ".env"] }, "/Users/me/code/proj", "api")).toBe("proj is at /Users/me/code/proj on api; 2 files left out, listed above.");
    expect(landedLine({ ...result, cut: [".env"] }, "/Users/me/code/proj", "api")).toBe("proj is at /Users/me/code/proj on api; 1 file left out, listed above.");
    expect(landedLine({ ...result, agents: [{ agent: "claude", files: 2, bytes: 100, outcome: "moved", sessions: 2 }, { agent: "codex", files: 0, bytes: 0, outcome: "carried" }] }, "/Users/me/code/proj", "api")).toBe(
      "proj is at /Users/me/code/proj on api; sessions: Claude Code moved, Codex carried unchanged.",
    );
  });
});
