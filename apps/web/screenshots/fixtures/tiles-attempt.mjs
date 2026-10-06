// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { join } from "node:path";
import { ago, copyOn, merge, project, store, THIS_COMPUTER, threadsOn, tileThread, workspace } from "../fixture-kit.mjs";

/** One send from spoo-landing's home to three models: a copy on this computer per model, each running the same task
 * under one attempt, beside a thread opened alone. What the sidebar's group and the home's picks are shot from. */
const tilesAttempt = () => {
  const task = "Find why the cart total test is flaky and fix it";
  const tried = (id, agent, model, label, minutes) => ({
    workspace: workspace(`ws_${id}`, `${nameOfTask(task)} (${label})`, { machineId: `local-${id}`, project: "pr_spoo-landing", worktree: copyOn(`spoo-landing-${id}`, `try/${id}`), createdAt: new Date(ago(minutes + 1)).toISOString() }),
    threads: threadsOn(`ws_${id}`, [[tileThread(id, task, { status: "running", agent, model, attempt: "att_cart" }), minutes]]),
  });
  const picks = [tried("opus", "claude", "claude-opus-5-5", "Opus 5.5", 12), tried("sonnet", "claude", "claude-sonnet-4-5", "Sonnet 4.5", 11.9), tried("sol", "codex", "gpt-5.6-sol", "GPT-5.6-Sol", 11.8)];
  return store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace("ws_flaky", THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-flaky", "fix/checkout-flakes") }), ...picks.map(p => p.workspace)],
    ...merge(threadsOn("ws_flaky", [[tileThread("coupon", "Coupon expiry test", { seen: true }), 35]]), ...picks.map(p => p.threads)),
    readsSince: 60 * 24 * 7,
    preferences: { projectLook: { "pr_spoo-landing": { icon: "folder", hue: "orange" } } },
  });
};

/** The workspace name a home's send gives a copy: the task's first words, as the app's own nameOfTask cuts them. */
const nameOfTask = task => task.trim().split("\n")[0].split(/\s+/).filter(Boolean).slice(0, 5).join(" ").slice(0, 40);

export default { build: tilesAttempt };
