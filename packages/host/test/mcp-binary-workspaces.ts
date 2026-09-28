// SPDX-License-Identifier: AGPL-3.0-only
// The workspace and image tools' rows in the binary's test against a host
// over the fake runtime. A row whose second call would answer differently from
// the first (a create, a snapshot, a delete confirmed) is held by its refusal
// or its unconfirmed answer here, and by its recorded answers in the record.
import type { Called } from "./mcp-binary.test.js";

const project: Called["given"] = async rt => {
  await rt.projects.add({ source: "https://github.com/dev/alpha.git", on: "default" });
};

/** A project and one workspace of it, named alpha. */
const alpha: Called["given"] = async (rt, line) => {
  await project(rt, line);
  await line(["new", "alpha"]);
};

export const WORKSPACE_CALLED: Called[] = [
  { tool: "image", argv: ["image"], arguments: {}, heldHere: true },
  { tool: "wake", argv: ["wake", "alpha"], arguments: { workspace: "alpha" }, given: alpha },
  { tool: "pause", argv: ["pause", "alpha"], arguments: { workspace: "alpha" }, given: alpha },
  { tool: "rename", argv: ["rename", "alpha", "alpha"], arguments: { workspace: "alpha", name: "alpha" }, given: alpha, heldHere: true },
  { tool: "workspaces_agents", argv: ["workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "2"], arguments: { workspace: "alpha", spawn: "on", max_machines: 2 }, given: alpha, heldHere: true },
  { tool: "image_move", argv: ["image", "move", "alpha"], arguments: { workspace: "alpha" }, given: alpha, heldHere: true, cloud: true },
  { tool: "delete", argv: ["delete", "alpha", "--yes"], arguments: { workspace: "alpha" }, given: alpha, first: true, error: true, heldHere: true },
  { tool: "rebuild", argv: ["rebuild", "alpha"], arguments: { workspace: "alpha" }, given: alpha, refused: true, cloud: true },
  { tool: "forget", argv: ["forget", "alpha", "--yes"], arguments: { workspace: "alpha" }, given: alpha, refused: true },
  { tool: "projects_remove", argv: ["projects", "remove", "alpha"], arguments: { project: "alpha" }, given: alpha, refused: true },
  { tool: "new", argv: ["new", "alpha", "fix", "--size", "3x3"], arguments: { project: "alpha", name: "fix", size: "3x3" }, given: project, refused: true },
  { tool: "fork", argv: ["fork", "alpha", "--size", "3x3"], arguments: { workspace: "alpha", size: "3x3" }, given: alpha, refused: true, cloud: true },
  { tool: "image_remove", argv: ["image", "remove", "snap-none", "--yes"], arguments: { image: "snap-none", confirm: true }, refused: true, cloud: true },
];
