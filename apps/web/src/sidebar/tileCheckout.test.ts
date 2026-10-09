// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { TREE_WORDS, type TreeChild, type TreeFact } from "@wsp/protocol";
import { tileCheckout } from "./tileCheckout.js";

const runs = (branch: string) => ({ id: "ws_kid", workspace: { project: { path: "/root/lab" }, worktree: { branch } }, status: undefined }) as never;
const lead = (child: Partial<TreeChild>): TreeFact => ({ leadBranch: "main", readAt: 1, children: [{ workspaceId: "ws_kid", branch: "fix/cart", pushed: true, aheadOfLead: 1, ...child }] });
const branchOf = (child: Partial<TreeChild>, on = "fix/cart"): string => tileCheckout(runs(on), { lead: lead(child) }).branch;

describe("the branch line on a fork's card", () => {
  it("says conflicts in n files after a merge stopped, whatever the count says", () => {
    expect(branchOf({ conflicts: ["a.ts", "b.ts"] })).toBe(`fix/cart, ${TREE_WORDS.conflictsIn(2)}`);
  });

  it("says merged into lead once a merge took everything, and the count again once it has more", () => {
    expect(branchOf({ merged: { oid: "d00d", at: 1 }, aheadOfLead: 0 })).toBe(`fix/cart, ${TREE_WORDS.mergedIntoLead}`);
    expect(branchOf({ merged: { oid: "d00d", at: 1 }, aheadOfLead: 2 })).toBe(`fix/cart, ${TREE_WORDS.aheadOf(2, "main")}`);
  });

  it("says not pushed where the git host lacks the branch, before any count", () => {
    expect(branchOf({ pushed: false, aheadOfLead: 1 })).toBe(`fix/cart, ${TREE_WORDS.notPushed}`);
  });

  it("says not counted where nothing could count it", () => {
    expect(branchOf({ aheadOfLead: undefined })).toBe(`fix/cart, ${TREE_WORDS.notCounted}`);
  });

  it("says how far it is ahead of the lead's branch", () => {
    expect(branchOf({ aheadOfLead: 3 })).toBe(`fix/cart, ${TREE_WORDS.aheadOf(3, "main")}`);
  });

  it("names no branch for a fork on its lead's own branch, and the bare branch for a copy outside any tree", () => {
    expect(branchOf({ branch: "main", pushed: false }, "main")).toBe("");
    expect(tileCheckout(runs("fix/cart")).branch).toBe("fix/cart");
    expect(tileCheckout(runs("fix/cart"), { lead: { leadBranch: "main", readAt: 1, children: [] } }).branch).toBe("fix/cart");
  });
});
