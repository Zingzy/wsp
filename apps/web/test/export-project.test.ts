// SPDX-License-Identifier: AGPL-3.0-only
// The export dialog's pure parts: the step rows folded from project.export
// events, which events belong to one export, the agent rows the workspace's
// threads give it and the request their ticks become, the destination a
// picked parent folder gives, and the landed line with each agent's words.
import { describe, expect, it } from "vitest";
import type { ProjectAgentResult, ProjectExportEvent, ProjectExportResult, SessionView } from "@wsp/protocol";
import { EXPORT_STEPS, agentRows, agentsRequest, exportLandedLine, exportStepRows, isExportOf, pickedDest } from "../src/sidebar/exportProject.js";
import { agentName, agentOutcome, agentOutcomes } from "../src/sidebar/projectTrip.js";

const ev = (over: Partial<ProjectExportEvent>): ProjectExportEvent => ({
  type: "project.export",
  workspaceId: "ws_a",
  source: "/root/proj",
  dest: "/Users/me/code/proj",
  stage: "packing",
  message: "Packing /root/proj on the machine.",
  elapsedMs: 10,
  ...over,
});

const row = (id: string, harness: string, over: Partial<SessionView> = {}): SessionView => ({ id, workspaceId: "ws_a", harness, status: "completed", ...over });

describe("export step rows", () => {
  it("lists the four steps in order with no message before any event", () => {
    expect(EXPORT_STEPS).toEqual(["packing", "downloading", "landing", "done"]);
    expect(exportStepRows([])).toEqual(EXPORT_STEPS.map(stage => ({ stage, message: null, elapsedMs: null, fraction: null })));
  });

  it("keeps the last event per step, reads the download fraction from bytes of total, and leaves failed out", () => {
    const rows = exportStepRows([
      ev({}),
      ev({ stage: "downloading", message: "The folder: 1.0 MB of 4.0 MB.", elapsedMs: 40, bytes: 1_048_576, total: 4_194_304 }),
      ev({ stage: "downloading", message: "The folder: 2.0 MB of 4.0 MB.", elapsedMs: 60, bytes: 2_097_152, total: 4_194_304 }),
      ev({ stage: "failed", message: "the machine went away", elapsedMs: 70 }),
    ]);
    expect(rows.map(r => r.stage)).toEqual(["packing", "downloading", "landing", "done"]);
    expect(rows[0]).toEqual({ stage: "packing", message: "Packing /root/proj on the machine.", elapsedMs: 10, fraction: null });
    expect(rows[1]).toEqual({ stage: "downloading", message: "The folder: 2.0 MB of 4.0 MB.", elapsedMs: 60, fraction: 0.5 });
    expect(rows[2]!.message).toBeNull();
    expect(rows[3]!.message).toBeNull();
  });
});

describe("which events are this export's", () => {
  it("matches the workspace and the destination as sent, and nothing else", () => {
    expect(isExportOf(ev({}), "ws_a", "/Users/me/code/proj")).toBe(true);
    expect(isExportOf(ev({ workspaceId: "ws_b" }), "ws_a", "/Users/me/code/proj")).toBe(false);
    expect(isExportOf(ev({ dest: "/Users/me/code/other" }), "ws_a", "/Users/me/code/proj")).toBe(false);
  });
});

describe("agent rows from the workspace's threads", () => {
  it("is one row per harness in first-seen order, none without threads", () => {
    expect(agentRows(undefined)).toEqual([]);
    expect(agentRows([])).toEqual([]);
    expect(agentRows([row("s1", "claude"), row("s2", "codex"), row("s3", "claude"), row("s4", "gemini")])).toEqual(["claude", "codex", "gemini"]);
  });

  it("asks for no agents while every row is ticked, so every agent with sessions comes home, and names the ticked ones otherwise", () => {
    const rows = ["claude", "codex", "gemini"];
    expect(agentsRequest(rows, new Set(rows))).toBeUndefined();
    expect(agentsRequest([], new Set())).toBeUndefined();
    expect(agentsRequest(rows, new Set(["gemini", "claude"]))).toEqual(["claude", "gemini"]);
    expect(agentsRequest(rows, new Set())).toEqual([]);
  });
});

describe("the destination a picked folder gives", () => {
  it("lands the folder inside the picked one under its own name, whatever the slashes", () => {
    expect(pickedDest("/Users/me/code", "/root/proj")).toBe("/Users/me/code/proj");
    expect(pickedDest("/Users/me/code/", "/root/proj/")).toBe("/Users/me/code/proj");
    expect(pickedDest("/", "/root/proj")).toBe("/proj");
  });
});

describe("agent outcome words", () => {
  const agent = (over: Partial<ProjectAgentResult>): ProjectAgentResult => ({ agent: "claude", files: 3, bytes: 900, outcome: "moved", ...over });

  it("names each agent as the catalog does, an unknown id as itself", () => {
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("gemini")).toBe("Gemini CLI");
    expect(agentName("zed")).toBe("zed");
  });

  it("names each agent and what became of its sessions in the short words, with the rollouts skipped and no counts", () => {
    expect(agentOutcomes([agent({ sessions: 2 })])).toBe("Claude Code moved");
    expect(agentOutcomes([agent({ agent: "codex", outcome: "transcript-only", sessions: 1, skipped: 2 })])).toBe("Codex transcripts landed, not yet listed, 2 rollouts skipped");
    expect(agentOutcomes([agent({ agent: "gemini", outcome: "nothing", files: 0, bytes: 0 })])).toBe("Gemini CLI nothing to bring");
    expect(agentOutcomes([agent({ agent: "zed", outcome: "carried" })])).toBe("zed carried unchanged");
    expect(agentOutcomes([agent({ agent: "zed", outcome: "failed", error: "state.db locked" })])).toBe("zed failed: state.db locked");
    expect(agentOutcomes([agent({ agent: "zed", outcome: "failed" })])).toBe("zed failed: no reason given");
    expect(agentOutcomes([agent({ sessions: 1 }), agent({ agent: "codex", outcome: "nothing" })])).toBe("Claude Code moved, Codex nothing to bring");
  });

  it("has a short form for a row's end that keeps the same facts", () => {
    expect(agentOutcome(agent({ outcome: "transcript-only", skipped: 1 }))).toEqual({ short: "transcripts landed, not yet listed, 1 rollout skipped", full: "transcripts landed, not yet in its session list, 1 indexed rollout skipped" });
    expect(agentOutcome(agent({ outcome: "nothing" }))).toEqual({ short: "nothing to bring", full: "had nothing to bring" });
    expect(agentOutcome(agent({ outcome: "failed", error: "locked" }))).toEqual({ short: "failed: locked", full: "failed: locked" });
  });
});

describe("the landed line", () => {
  const result: ProjectExportResult = { dest: "/Users/me/code/proj", files: 11, bytes: 2_900, excluded: [], agents: [] };

  it("names the folder on this Mac, the caches left behind and the sessions, or that the machine had none", () => {
    expect(exportLandedLine(result, "/root/proj")).toBe("proj is at /Users/me/code/proj on this Mac; no agent sessions for it on the machine.");
    expect(exportLandedLine({ ...result, excluded: ["node_modules"] }, "/root/proj/")).toBe("proj is at /Users/me/code/proj on this Mac; 1 cache left behind; no agent sessions for it on the machine.");
    expect(exportLandedLine({ ...result, excluded: ["node_modules", "dist"], agents: [{ agent: "claude", files: 2, bytes: 100, outcome: "moved", sessions: 2 }] }, "/root/proj")).toBe(
      "proj is at /Users/me/code/proj on this Mac; 2 caches left behind; sessions: Claude Code moved.",
    );
  });
});
