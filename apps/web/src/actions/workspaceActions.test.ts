// SPDX-License-Identifier: AGPL-3.0-only
// Bring back as a row action: work leaves a workspace through git, so the
// entry pushes the agent's branch and opens its pull request, and what comes
// back is the row's third line.
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceView } from "@wsp/protocol";
import { actionById, resolveActions } from "./registry.js";
import { workspaceActions, workspaceTarget, type WorkspaceVerbs } from "./workspaceActions.js";
import { BRING_BACK_HINT, broughtBackRowLine, WORKSPACE_WORDS } from "./format.js";
import { WHERE_WORDS } from "../settings/format.js";
import { workspaceMetaLine } from "../sidebar/workspaceRows.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";

const workspace = (phase: WorkspaceView["phase"]): WorkspaceView =>
  ({ id: "ws_a", name: "pricing page", machineId: "m_a", phase, project: { id: "pr_1", name: "repo", path: "/root", computer: "here" }, createdAt: "t", kind: "cloud" }) as WorkspaceView;

const verbs = (over: Partial<WorkspaceVerbs> = {}): WorkspaceVerbs =>
  ({
    togglePhase: vi.fn(async () => {}),
    openTerminal: vi.fn(async () => {}),
    openBrowser: vi.fn(),
    newThread: vi.fn(),
    copyText: vi.fn(async () => {}),
    bringBack: vi.fn(async () => {}),
    ...over,
  }) as WorkspaceVerbs;

const entry = (phase: WorkspaceView["phase"], over: Partial<WorkspaceVerbs> = {}) =>
  actionById(resolveActions(workspaceActions, workspaceTarget(workspace(phase), null, []), verbs(over)), "bring-back");

const back = { branch: "agent/pricing-page", base: "main", ahead: 2, uncommitted: 0, stat: [] };

describe("bring back on the workspace row", () => {
  it("is in the registry under the project group, with its own words", () => {
    const action = entry("running");
    expect(action.title).toBe(WORKSPACE_WORDS.bringBack);
    expect(action.group).toBe("project");
    expect(action.rowLabel).toBe("Bring back pricing page");
    expect(action.hint).toBe(BRING_BACK_HINT);
  });

  it("runs the verb for its own workspace while the machine is running", async () => {
    const run = vi.fn(async () => {});
    const action = entry("running", { bringBack: run });
    expect(action.refusal).toBeNull();
    await action.run();
    expect(run).toHaveBeenCalledWith("ws_a");
  });

  it("is held with the roadless words on a client whose host carries no such request", () => {
    expect(entry("running", { bringBack: undefined }).refusal).toBe(WHERE_WORDS.notYet);
  });

  it("is held on a machine that is not running, in the words every machine action is held in", () => {
    expect(entry("napping").refusal).toBe("Workspace is paused; wake it to bring back");
  });

  it("says pull request in full on the row's third line, and what happened where there is none", () => {
    expect(broughtBackRowLine({ ...back, pr: { number: 12, url: "https://example/pr/12", state: "open", host: "github.com" } })).toBe("agent/pricing-page · pull request #12 open");
    expect(broughtBackRowLine({ ...back, note: "no gh on this computer" })).toBe("agent/pricing-page · pushed, no pull request: no gh on this computer");
    expect(broughtBackRowLine(back)).toBe("agent/pricing-page · pushed");
  });

  it("stands on the row in place of the branch, and yields to the one sentence a person is waiting on", () => {
    const project = {
      state: "running",
      status: null,
      reach: null,
      threads: [],
      workspace: { ...workspace("running"), copy: { road: "clonefile", path: "/root-copy", branch: "agent/pricing-page" } },
    } as unknown as SidebarProjectSnapshot;
    const answer = { ...back, pr: { number: 12, url: "https://example/pr/12", state: "open" as const, host: "github.com" } };
    expect(workspaceMetaLine({ project, outOfMemory: undefined })).toBe("agent/pricing-page");
    expect(workspaceMetaLine({ project, outOfMemory: undefined, broughtBack: answer })).toBe("agent/pricing-page · pull request #12 open");
    const asking = { ...project, threads: [{ asking: "Write out.txt in root (2 B)" }] } as unknown as SidebarProjectSnapshot;
    expect(workspaceMetaLine({ project: asking, outOfMemory: undefined, broughtBack: answer })).toBe("Write out.txt in root (2 B)");
  });
});
