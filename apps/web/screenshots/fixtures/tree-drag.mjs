// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { copyOn, merge, project, store, threadsOn, tileThread, workspace } from "../fixture-kit.mjs";

const TASKS = ["Fix the flaky cart test", "Tidy the imports in the parser", "Coupon expiry at midnight", "Retry the webhook on a 502", "Dark mode contrast pass", "Release notes for the next cut", "Move the relay to one helper", "Stop leaking ptys on close"];
const PROJECTS = ["spoo-landing", "wsp", "docs", "relay"];

/** A sidebar of four hundred threads, the size the drag is held to: twenty leads with five threads under each, two of
 * them pinned, then two hundred and eighty threads alone, four of them stopped on a question. Spread over four
 * projects of a hundred threads, since the runtime keeps two hundred rows a workspace. None was opened since it
 * finished, so nothing folds into Settled and every tree stands in the list. */
const treeDrag = () => {
  const on = PROJECTS.map(() => []);
  for (let lead = 0; lead < 20; lead += 1) {
    const id = `lead-${lead}`;
    const rows = on[lead % PROJECTS.length];
    rows.push([tileThread(id, `Lead ${lead + 1}: ${TASKS[lead % TASKS.length]}`, lead < 2 ? { pinned: true } : {}), 600 - lead * 20]);
    for (let kid = 0; kid < 5; kid += 1) rows.push([{ ...tileThread(`${id}-kid-${kid}`, `Builder ${kid + 1} of lead ${lead + 1}`), parent: id, root: id, startedBy: "agent" }, 599 - lead * 20 - kid]);
  }
  for (let n = 0; n < 280; n += 1) {
    const asks = n % 70 === 5 ? { status: "running", asking: "Permission for Bash: pnpm test" } : {};
    on[n % PROJECTS.length].push([tileThread(`alone-${n}`, `${TASKS[n % TASKS.length]} (${n + 1})`, asks), 590 - n * 2]);
  }
  return store({
    projects: PROJECTS.map(name => project(name, HERE, 60 * 30)),
    workspaces: PROJECTS.map(name => workspace(`ws_${name}`, name, { machineId: `local-${name}`, project: `pr_${name}`, worktree: copyOn(`${name}-many`, "main") })),
    // The runtime writes a workspace's threads oldest first.
    ...merge(...PROJECTS.map((name, i) => threadsOn(`ws_${name}`, on[i].sort((a, b) => b[1] - a[1])))),
    readsSince: 60 * 24 * 7,
  });
};

export default { build: treeDrag };
