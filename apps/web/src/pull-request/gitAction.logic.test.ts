// SPDX-License-Identifier: AGPL-3.0-only
import type { Checkout, PullRequestSeen } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { gitMenu, gitQuickAction } from "./gitAction.logic";

const checkout = (over: Partial<Checkout> = {}): Checkout => ({ branch: "fix/cart", ahead: 0, behind: 0, changed: 0, readAt: 1, ...over });
const open: PullRequestSeen = { number: 42, url: "https://github.com/o/r/pull/42", state: "open", draft: false, base: "main", mergeable: "mergeable", review: "none", checks: [], readAt: 1 } as unknown as PullRequestSeen;
const merged: PullRequestSeen = { number: 42, url: "https://github.com/o/r/pull/42", state: "merged", base: "main", readAt: 1 };
const at = (o: Partial<Parameters<typeof gitQuickAction>[0]> = {}) => gitQuickAction({ checkout: checkout(), pr: undefined, base: "main", opensPr: true, busy: false, ...o });

describe("the git button's label, off the checkout and the pull request", () => {
  it("commits, pushes and opens the pull request while there are changes and none is open", () => {
    expect(at({ checkout: checkout({ changed: 3 }) })).toEqual({ label: "Commit, push and PR", act: "commit-push-pr" });
  });

  it("commits and pushes while there are changes and a pull request is open", () => {
    expect(at({ checkout: checkout({ changed: 3, ahead: 1 }), pr: open })).toEqual({ label: "Commit and push", act: "commit-push" });
  });

  it("pushes commits an open pull request does not have yet, and pushes and opens one where none is", () => {
    expect(at({ checkout: checkout({ ahead: 2 }), pr: open })).toEqual({ label: "Push", act: "push" });
    expect(at({ checkout: checkout({ ahead: 2 }) })).toEqual({ label: "Push and create PR", act: "create-pr" });
  });

  it("views an open pull request with nothing to push, and creates one for a branch that has none", () => {
    expect(at({ pr: open })).toEqual({ label: "View PR", act: "view-pr" });
    expect(at()).toEqual({ label: "Create PR", act: "create-pr" });
    expect(at({ pr: merged })).toEqual({ label: "Create PR", act: "create-pr" });
  });

  it("never pushes from the base branch: a copy on main with changes or commits is held with the reason, as T3's isDefaultRef comes first", () => {
    for (const on of [checkout({ branch: "main" }), checkout({ branch: "main", changed: 3 }), checkout({ branch: "main", ahead: 2 }), checkout({ branch: "main", changed: 1, ahead: 1 })]) {
      expect(at({ checkout: on }), JSON.stringify(on)).toMatchObject({ label: "Commit", act: null, hint: expect.stringMatching(/main is the branch the work goes back to/) });
      expect(at({ checkout: on, pr: open }).act, JSON.stringify(on)).toBeNull();
      expect(at({ checkout: on, opensPr: false }).act, JSON.stringify(on)).toBeNull();
    }
    // The menu still opens Changes to commit there, which pushes nothing, and offers no push or pull request.
    expect(gitMenu({ checkout: checkout({ branch: "main", changed: 3, ahead: 1 }), pr: undefined, base: "main", opensPr: true, busy: false })).toEqual([
      { id: "commit", label: "Commit", act: "changes", disabled: false },
      { id: "push", label: "Push", act: "push", disabled: true },
      { id: "pr", label: "Create PR", act: "create-pr", disabled: true },
    ]);
  });

  it("holds the button with the reason on no branch, while a git act runs, and where nothing is read", () => {
    expect(at({ checkout: checkout({ branch: "(detached)", changed: 2 }) })).toMatchObject({ label: "Commit", act: null, hint: expect.stringMatching(/no branch/i) });
    expect(at({ checkout: checkout({ changed: 2 }), busy: true })).toMatchObject({ label: "Commit, push and PR", act: null });
    expect(at({ checkout: undefined })).toMatchObject({ label: "Commit", act: null });
  });

  it("never offers a pull request on a copy a lead's thread opened, whose work lands in the lead's", () => {
    expect(at({ opensPr: false, checkout: checkout({ changed: 1 }) })).toEqual({ label: "Commit and push", act: "commit-push" });
    expect(at({ opensPr: false, checkout: checkout({ ahead: 1 }) })).toEqual({ label: "Push", act: "push" });
    expect(at({ opensPr: false })).toMatchObject({ label: "Push", act: null });
  });
});

describe("the git button's menu", () => {
  it("lists Commit, Push and the pull request, each held where it cannot run now", () => {
    expect(gitMenu({ checkout: checkout({ changed: 2 }), pr: undefined, base: "main", opensPr: true, busy: false })).toEqual([
      { id: "commit", label: "Commit", act: "changes", disabled: false },
      { id: "push", label: "Push", act: "push", disabled: true },
      { id: "pr", label: "Create PR", act: "create-pr", disabled: true },
    ]);
    expect(gitMenu({ checkout: checkout({ ahead: 1 }), pr: open, base: "main", opensPr: true, busy: false })).toEqual([
      { id: "commit", label: "Commit", act: "changes", disabled: true },
      { id: "push", label: "Push", act: "push", disabled: false },
      { id: "pr", label: "View PR", act: "view-pr", disabled: false },
    ]);
    expect(gitMenu({ checkout: checkout(), pr: undefined, base: "main", opensPr: true, busy: false }).at(-1)).toEqual({ id: "pr", label: "Create PR", act: "create-pr", disabled: false });
    expect(gitMenu({ checkout: checkout({ changed: 1 }), pr: undefined, base: "main", opensPr: false, busy: false }).map(item => item.id)).toEqual(["commit", "push"]);
  });
});
