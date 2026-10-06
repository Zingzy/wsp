// SPDX-License-Identifier: AGPL-3.0-only
import { helper, TREE_COMPARES, treeChild, treeFixture, workspace } from "../fixture-kit.mjs";

/** A child whose merge into the lead stopped on conflicts, and one whose computer could not push its branch. */
const treeConflict = () =>
  treeFixture([
    { workspace: treeChild("ws_header", "header", "fix/header", { tree: { conflicts: ["lead.txt", "src/cart/total.ts"] } }), thread: helper("header", "Rename the cart header"), minutes: 20 },
    { workspace: treeChild("ws_badges", "badges", "fix/badges", { tree: { pushRefused: "this computer has no git credential for github.com, so nothing was pushed; sign gh in on it with gh auth login, then gh auth setup-git, then bring back again" } }), thread: helper("badges", "Badge the free shipping line"), minutes: 15 },
  ]);

export default { build: treeConflict, compares: TREE_COMPARES };
