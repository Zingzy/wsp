// SPDX-License-Identifier: AGPL-3.0-only
// The thread header's git button, as T3 Code's GitActionsControl.logic reads
// it: the one act the checkout calls for on the main part, and Commit, Push and
// the pull request in its menu. A push always goes through bring back, which
// pushes and opens the pull request, or answers the one already open; a copy a
// lead's thread opened pushes and opens nothing, so it is never offered one.
import { DETACHED_HEAD, isPullRequestNamed, type Checkout, type PullRequestSeen } from "@wsp/protocol";

export type GitAct = "commit-push-pr" | "commit-push" | "push" | "create-pr" | "view-pr";

export interface GitState {
  readonly checkout: Checkout | undefined;
  readonly pr: PullRequestSeen | undefined;
  /** The branch the copy's work goes back to, where it is known. */
  readonly base: string | undefined;
  /** False on a copy a lead's thread opened, whose work lands in the lead's pull request. */
  readonly opensPr: boolean;
  readonly busy: boolean;
}

/** The main part: its label, the act it runs, or null with the reason it is held. */
export interface GitQuick {
  readonly label: string;
  readonly act: GitAct | null;
  readonly hint?: string;
}

/** What a menu item does: open Changes to commit there, or one of the pushing acts. */
export type GitMenuAct = "changes" | "push" | "create-pr" | "view-pr";

export interface GitMenuItem {
  readonly id: "commit" | "push" | "pr";
  readonly label: string;
  readonly act: GitMenuAct;
  readonly disabled: boolean;
}

export const GIT_WORDS = {
  commit: "Commit",
  commitPushPr: "Commit, push and PR",
  commitPush: "Commit and push",
  push: "Push",
  pushCreatePr: "Push and create PR",
  createPr: "Create PR",
  viewPr: "View PR",
  menu: "More git actions",
  noBranch: "The copy is on no branch. Check one out in the terminal to push it.",
  onBase: (base: string) => `${base} is the branch the work goes back to; put the work on a branch of its own to push it.`,
  nothing: "Nothing to commit or push.",
  unread: "The branch is not read yet.",
  busy: "A git action is running.",
} as const;

const held = (label: string, hint: string): GitQuick => ({ label, act: null, hint });

export function gitQuickAction(s: GitState): GitQuick {
  const { checkout, pr } = s;
  if (checkout === undefined) return held(GIT_WORDS.commit, GIT_WORDS.unread);
  if (checkout.branch === "" || checkout.branch === DETACHED_HEAD) return held(GIT_WORDS.commit, GIT_WORDS.noBranch);
  const quick = pick(s, checkout, isPullRequestNamed(pr) && pr.state === "open");
  return s.busy && quick.act !== null ? held(quick.label, GIT_WORDS.busy) : quick;
}

function pick(s: GitState, checkout: Checkout, openPr: boolean): GitQuick {
  // The base first, as T3's isDefaultRef: nothing here pushes onto the branch the work goes back to.
  if (s.base !== undefined && checkout.branch === s.base) return held(GIT_WORDS.commit, GIT_WORDS.onBase(s.base));
  if (checkout.changed > 0) return !s.opensPr || openPr ? { label: GIT_WORDS.commitPush, act: "commit-push" } : { label: GIT_WORDS.commitPushPr, act: "commit-push-pr" };
  if (checkout.ahead > 0) return !s.opensPr || openPr ? { label: GIT_WORDS.push, act: "push" } : { label: GIT_WORDS.pushCreatePr, act: "create-pr" };
  if (!s.opensPr) return held(GIT_WORDS.push, GIT_WORDS.nothing);
  if (openPr) return { label: GIT_WORDS.viewPr, act: "view-pr" };
  return { label: GIT_WORDS.createPr, act: "create-pr" };
}

export function gitMenu(s: GitState): GitMenuItem[] {
  const { checkout, pr } = s;
  const branched = checkout !== undefined && checkout.branch !== "" && checkout.branch !== DETACHED_HEAD;
  const changes = checkout !== undefined && checkout.changed > 0;
  const ahead = checkout !== undefined && checkout.ahead > 0;
  const openPr = isPullRequestNamed(pr) && pr.state === "open";
  const onBase = s.base !== undefined && checkout?.branch === s.base;
  const items: GitMenuItem[] = [
    { id: "commit", label: GIT_WORDS.commit, act: "changes", disabled: s.busy || !changes },
    { id: "push", label: GIT_WORDS.push, act: "push", disabled: s.busy || !branched || onBase || !ahead || (s.opensPr && !openPr) },
  ];
  if (!s.opensPr) return items;
  return [...items, openPr ? { id: "pr", label: GIT_WORDS.viewPr, act: "view-pr", disabled: false } : { id: "pr", label: GIT_WORDS.createPr, act: "create-pr", disabled: s.busy || !branched || changes || onBase }];
}
