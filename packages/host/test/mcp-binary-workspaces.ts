// SPDX-License-Identifier: AGPL-3.0-only
// The workspace and image tools' rows in the binary's test against a host
// over the fake runtime. A row whose second call would answer differently from
// the first (a create, a snapshot, a delete confirmed) is held by its refusal
// or its unconfirmed answer here, and by its recorded answers in the record.
import type { Called } from "./mcp-binary.test.js";

/** A project on a box and one workspace of it, named alpha. */
const alpha: Called["given"] = async rt => {
  const project = await rt.projects.add({ source: "https://github.com/dev/alpha.git", on: "default" });
  await rt.workspaces.create({ project: project.id, name: "alpha" });
};

export const WORKSPACE_CALLED: Called[] = [
  { tool: "image", argv: ["image"], arguments: {}, heldHere: true },
  { tool: "wake", argv: ["wake", "alpha"], arguments: { workspace: "alpha" }, given: alpha, cloud: true },
  { tool: "pause", argv: ["pause", "alpha"], arguments: { workspace: "alpha" }, given: alpha, cloud: true },
  { tool: "rename", argv: ["rename", "alpha", "alpha"], arguments: { workspace: "alpha", name: "alpha" }, given: alpha, heldHere: true, cloud: true },
  { tool: "delete", argv: ["delete", "alpha", "--yes"], arguments: { workspace: "alpha" }, given: alpha, first: true, error: true, heldHere: true, cloud: true },
  { tool: "delete", argv: ["delete", "nope", "--yes"], arguments: { thread: "nope", confirm: true }, refused: true },
  { tool: "rebuild", argv: ["rebuild", "alpha"], arguments: { workspace: "alpha" }, given: alpha, refused: true, cloud: true },
  { tool: "forget", argv: ["forget", "alpha", "--yes"], arguments: { workspace: "alpha" }, given: alpha, refused: true, cloud: true },
  { tool: "commit", argv: ["commit", "alpha"], arguments: { thread: "alpha" }, given: alpha, refused: true },
  { tool: "update", argv: ["update", "nope"], arguments: { thread: "nope" }, refused: true },
  { tool: "projects_remove", argv: ["projects", "remove", "alpha"], arguments: { project: "alpha" }, given: alpha, refused: true },
  { tool: "worktree", argv: ["worktree", "nope", "feat"], arguments: { project: "nope", branch: "feat" }, refused: true },
  { tool: "worktree_remove", argv: ["worktree", "remove", "nope", "feat", "--force"], arguments: { project: "nope", branch: "feat", force: true }, refused: true },
  { tool: "fork", argv: ["fork", "alpha", "--size", "3x3"], arguments: { workspace: "alpha", size: "3x3" }, given: alpha, refused: true, cloud: true },
  { tool: "image_remove", argv: ["image", "remove", "snap-none", "--yes"], arguments: { image: "snap-none", confirm: true }, refused: true, cloud: true },
];
