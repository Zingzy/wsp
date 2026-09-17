// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { ProjectView } from "@wsp/protocol";
import type { SidebarProjectSnapshot, SidebarThreadSnapshot } from "../adapt/index.js";
import { forkedWorkspaces, projectGroups, threadTree } from "./threadTree";

const project = (id: string, name: string, computer = "here"): ProjectView => ({
  id,
  name,
  computer,
  source: { kind: "folder", path: `/Users/dev/${name}` },
  path: `/Users/dev/${name}`,
  remote: `https://github.com/dev/${name}.git`,
  defaultBranch: "main",
  memoryKey: `-Users-dev-${name}`,
  memoryDir: `/Users/dev/.claude-cfg/projects/-Users-dev-${name}/memory`,
  createdAt: "2026-09-17T00:00:00.000Z",
});

const thread = (id: string, workspaceId: string, parentThreadId: string | null = null): SidebarThreadSnapshot =>
  ({ id, threadId: id, sessionId: `s_${id}`, workspaceId, title: id, status: "running", parentThreadId, asking: null }) as unknown as SidebarProjectSnapshot["threads"][number];

const row = (id: string, projectId: string, threads: SidebarThreadSnapshot[] = [], parentThreadId?: string): SidebarProjectSnapshot =>
  ({
    id,
    displayName: id,
    threads,
    workspace: { id, project: { id: projectId, name: projectId, path: "/root", computer: "here" }, ...(parentThreadId === undefined ? {} : { parentThreadId }) },
  }) as unknown as SidebarProjectSnapshot;

describe("the projects the sidebar draws", () => {
  it("keeps the host's own order, holds every project's workspaces under it, and keeps a project nobody has started work on", () => {
    const groups = projectGroups([project("pr_1", "spoo"), project("pr_2", "wsp")], [row("ws_a", "pr_1"), row("ws_b", "pr_1")]);
    expect(groups.map(g => [g.project.name, g.workspaces.map(w => w.id)])).toEqual([
      ["spoo", ["ws_a", "ws_b"]],
      ["wsp", []],
    ]);
  });

  it("keeps a workspace whose project the host's list has not answered for, off the record the row itself carries", () => {
    const groups = projectGroups([], [row("ws_a", "pr_1")]);
    expect(groups.map(g => [g.project.id, g.workspaces.map(w => w.id)])).toEqual([["pr_1", ["ws_a"]]]);
  });

  it("leaves a workspace an agent forked out of the project's own list: it is drawn under the thread that forked it", () => {
    const groups = projectGroups([project("pr_1", "spoo")], [row("ws_a", "pr_1", [thread("lead", "ws_a")]), row("ws_fork", "pr_1", [], "lead")]);
    expect(groups.map(g => g.workspaces.map(w => w.id))).toEqual([["ws_a"]]);
    expect(forkedWorkspaces([row("ws_a", "pr_1"), row("ws_fork", "pr_1", [], "lead")], "lead").map(w => w.id)).toEqual(["ws_fork"]);
    expect(forkedWorkspaces([row("ws_a", "pr_1")], "lead")).toEqual([]);
  });
});

describe("the threads of a workspace an agent forked", () => {
  it("stay on that workspace rather than joining the rows of the workspace the forking thread runs on", () => {
    const lead = row("ws_a", "pr_1", [thread("lead", "ws_a")]);
    const forked = row("ws_fork", "pr_1", [thread("builder", "ws_fork", "lead")], "lead");
    expect(threadTree([lead, forked]).map(group => [group.project.id, group.threads.map(t => t.id)])).toEqual([
      ["ws_a", ["lead"]],
      ["ws_fork", ["builder"]],
    ]);
  });

  it("while a thread an agent opened on another workspace that is not a fork still joins its opener's rows", () => {
    const lead = row("ws_a", "pr_1", [thread("lead", "ws_a")]);
    const other = row("ws_b", "pr_1", [thread("helper", "ws_b", "lead")]);
    expect(threadTree([lead, other]).map(group => [group.project.id, group.threads.map(t => t.id)])).toEqual([
      ["ws_a", ["lead", "helper"]],
      ["ws_b", []],
    ]);
  });
});
