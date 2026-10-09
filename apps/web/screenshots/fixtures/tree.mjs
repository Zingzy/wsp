// SPDX-License-Identifier: AGPL-3.0-only
import { ago, helper, TREE_COMPARES, treeChild, treeFixture, workspace } from "../fixture-kit.mjs";

/** A fork in each state its card says: working, quiet and ahead, merged, not pushed, one asking the person on a branch of
 * its own, and one on the lead's own branch, whose card names no branch. */
const treeRows = () =>
  treeFixture([
    { workspace: treeChild("ws_rounding", "rounding", "fix/rounding"), thread: helper("rounding", "Round the cart total once", { status: "running" }), minutes: 6 },
    { workspace: treeChild("ws_coupons", "coupons", "fix/coupons"), thread: helper("coupons", "Expire coupons at midnight"), minutes: 30 },
    { workspace: treeChild("ws_totals", "totals", "fix/totals", { tree: { merged: { oid: "4b825dc", at: ago(20), head: "9daeafb" } } }), thread: helper("totals", "Show totals with tax"), minutes: 40 },
    { workspace: treeChild("ws_badges", "badges", "fix/badges"), thread: helper("badges", "Badge the free shipping line"), minutes: 25 },
    { workspace: treeChild("ws_header", "header", "fix/header"), thread: helper("header", "Rename the cart header", { status: "running", asking: "Permission for Bash: pnpm test cart" }), minutes: 8 },
    { workspace: treeChild("ws_copy", "copy", "tree/lead"), thread: helper("copy", "Check the cart copy"), minutes: 35 },
  ]);

export default { build: treeRows, compares: TREE_COMPARES };
