// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { ago, helper, merge, onPlace, place, project, store, threadId, threadsOn, TREE_COMPARES, treeChild, workspace, copyOn } from "../fixture-kit.mjs";

/** A lead whose turn still runs, on a copy of its own so the stand-in keeps the turn running, with two subagents of
 * its own agent: one reading, one that ended inside this turn. */
const LEAD = {
  id: "tree-lead",
  status: "running",
  prompt: "land the cart fixes: a helper per fix, a reviewer per branch, and tell me when one needs me",
  title: "Cart fixes, one helper each",
  thought: "Four small fixes that touch different files: one child each, then merge them into my branch.",
  tool: { name: "wsp", input: '{"tool":"run","count":4}', result: "rounding, coupons, totals, badges" },
  reply: "Four helpers are out. Rounding has a reviewer on it; the install on the address form waits on you.",
  costUsd: 0.42,
  subagents: [
    { task: "task_map", title: "Read the open tickets on the map", state: "running", started: 2, model: "Haiku 4.5", asked: "Read every open ticket with no branch yet, and list the files each one names." },
    { task: "task_prs", title: "List the open pull requests", state: "done", started: 9, ended: 7, model: "Haiku 4.5", asked: "List the open pull requests with their review state.", summary: "11 open, 4 approved, 7 waiting on a reviewer." },
  ],
};

const fork = (id, name, branch, extra = {}) => treeChild(id, name, branch, { machineId: `local-${name}`, ...extra });

/** Every part a child of a lead stands in: asking, failed, working with a reviewer under it, one on another computer,
 * and finished ones behind the fold, read and unread, with their branches against the lead's. */
const leadRows = () =>
  store({
    projects: [project("tree-lab", HERE, 60 * 3)],
    workspaces: [
      workspace("ws_lead", "cart fixes", { machineId: "local-lead", project: "pr_tree-lab", worktree: copyOn("tree-lab-lead", "tree/lead"), base: "tree/lead", agents: { spawn: true, maxMachines: 8, maxDepth: 2 } }),
      fork("ws_address", "address", "fix/address"),
      fork("ws_header", "header", "fix/header"),
      fork("ws_rounding", "rounding", "fix/rounding"),
      fork("ws_review", "review", "fix/rounding", { parentThreadId: threadId("rounding"), rootThreadId: threadId("tree-lead") }),
      { ...onPlace("ws_bench", "bench", "p_spoo", { cpu: 4, memMb: 8192 }, "pr_tree-lab"), parentThreadId: threadId("tree-lead"), rootThreadId: threadId("tree-lead") },
      fork("ws_coupons", "coupons", "fix/coupons"),
      fork("ws_totals", "totals", "fix/totals", { tree: { merged: { oid: "4b825dc", at: ago(20), head: "9daeafb" } } }),
      fork("ws_badges", "badges", "fix/badges"),
    ],
    ...merge(
      threadsOn("ws_lead", [[LEAD, 12]]),
      threadsOn("ws_address", [[helper("address", "Fix the address form race", { status: "running", asking: "Bash: pnpm install --frozen-lockfile" }), 8]]),
      threadsOn("ws_header", [[helper("header", "Pin the header on scroll", { status: "failed", failure: "pnpm test exited 1: 3 tests failed in src/header.test.ts" }), 20]]),
      threadsOn("ws_rounding", [[helper("rounding", "Round the cart total once", { status: "running" }), 6]]),
      threadsOn("ws_review", [[{ ...helper("review", "Review: round the cart total once", { status: "running", agent: "codex" }), parent: "rounding", root: "tree-lead" }, 3]]),
      threadsOn("ws_bench", [[helper("bench", "Benchmark the cart on spoo", { status: "running" }), 4]]),
      threadsOn("ws_coupons", [[helper("coupons", "Expire coupons at midnight", { seen: true, lastLine: "Pushed fix/coupons, 3 files, gate green." }), 30]]),
      threadsOn("ws_totals", [[helper("totals", "Show totals with tax", { seen: true, lastLine: "Merged into tree/lead at 9daeafb." }), 40]]),
      threadsOn("ws_badges", [[helper("badges", "Badge the free shipping line", { lastLine: "Pushed fix/badges; the badge reads Free shipping." }), 25]]),
    ),
    places: {
      p_spoo: place("p_spoo", "spoo", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 4, memMb: 8192 }, runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }, true),
    },
  });

export default { build: leadRows, compares: TREE_COMPARES };
