// SPDX-License-Identifier: AGPL-3.0-only
import { ago, helper, TREE_COMPARES, treeChild, treeFixture, workspace } from "../fixture-kit.mjs";

/** A child in each state the row draws before anything went wrong: working, quiet and ahead, merged, and not pushed. */
const treeRows = () =>
  treeFixture([
    { workspace: treeChild("ws_rounding", "rounding", "fix/rounding"), thread: helper("rounding", "Round the cart total once", { status: "running" }), minutes: 6 },
    { workspace: treeChild("ws_coupons", "coupons", "fix/coupons"), thread: helper("coupons", "Expire coupons at midnight"), minutes: 30 },
    { workspace: treeChild("ws_totals", "totals", "fix/totals", { tree: { merged: { oid: "4b825dc", at: ago(20), head: "9daeafb" } } }), thread: helper("totals", "Show totals with tax"), minutes: 40 },
    { workspace: treeChild("ws_badges", "badges", "fix/badges"), thread: helper("badges", "Badge the free shipping line"), minutes: 25 },
  ]);

export default { build: treeRows, compares: TREE_COMPARES };
