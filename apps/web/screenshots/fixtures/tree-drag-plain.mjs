// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { copyOn, merge, project, store, threadsOn, tileThread, workspace } from "../fixture-kit.mjs";

/** A sidebar with nothing pinned and nothing waiting on the person, where a drag from the list used to end the
 * moment it began: a lead whose own turn is over while one of its two builders still works, and a handful of
 * threads alone, one of them quiet and read. */
const treeDragPlain = () => {
  const lead = { parent: "lead", root: "lead", startedBy: "agent" };
  return store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace("ws_here", "spoo-landing", { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-here", "main") })],
    ...merge(
      threadsOn("ws_here", [
        [tileThread("tidy", "Tidy the imports in the parser", { seen: true }), 90],
        [tileThread("webhook", "Retry the webhook on a 502"), 70],
        [tileThread("lead", "Split the cart fixes across two builders"), 50],
        [{ ...tileThread("rounding", "Cart total rounding"), ...lead }, 45],
        [{ ...tileThread("coupons", "Coupon codes at checkout", { status: "running" }), ...lead }, 40],
        [tileThread("coupon", "Coupon expiry at midnight"), 30],
        [tileThread("notes", "Release notes for the next cut"), 20],
      ]),
    ),
    readsSince: 60 * 24 * 7,
  });
};

export default { build: treeDragPlain };
