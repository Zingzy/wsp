// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { ago, copyOn, event, project, replay, store, THIS_COMPUTER, threadId, threadsOn, tileThread, turn, turnId, uuidFor, workspace } from "../fixture-kit.mjs";

/** A thread of several turns on one session row, as a resumed turn keeps it: each turn's replay under its own id,
 * closed by the checkpoint the runtime records at its end, and the row naming the latest. */
const turnsOn = (workspaceId, thread, turns) => {
  const idOf = n => turnId(`${thread.id}:${n}`);
  const last = turns.length - 1;
  const events = turns.flatMap((t, n) => {
    const kept = n === last ? [] : [event(thread, { type: "session.checkpoint", at: ago(t.minutes - 3), ref: `refs/wsp/checkpoints/spoo-landing-rewind/${threadId(thread.id)}/${idOf(n)}`, anchor: uuidFor(`anchor:${thread.id}:${n}`) }, workspaceId)];
    return [...replay({ ...thread, ...t }, t.minutes, workspaceId), ...kept].map(e => ({ ...e, turnId: idOf(n) }));
  });
  const newest = { ...thread, ...turns[last] };
  return {
    sessions: { [workspaceId]: { workspaceId, sessions: [{ ...turn(newest, newest.minutes, workspaceId), turnId: idOf(last) }], threads: {} } },
    transcripts: { [workspaceId]: { workspaceId, events } },
  };
};

/** Two threads of three and two turns on a copy of spoo-landing, each earlier turn closed on a checkpoint, so Rewind
 * to here stands on their earlier replies: one on Claude, which cuts its own conversation and has a thread its agent
 * opened still working under it, and one on Cursor, which keeps its own and is rewound in its files alone. */
const rewind = () => {
  const cart = tileThread("rounding", "Find why the cart total test is flaky");
  const cursor = tileThread("tax", "Round the tax line once", { agent: "cursor", model: "auto" });
  // A thread the lead's agent opened, still working: a rewind of the lead waits for it.
  const child = tileThread("fixture", "Check the tax fixture", { status: "running", parent: "rounding", root: "rounding", startedBy: "agent" });
  const children = threadsOn("ws_rewind", [[child, 5]]);
  const claudeTurns = turnsOn("ws_rewind", cart, [
    { minutes: 40, prompt: "Find why the cart total test is flaky", reply: "The total rounds per line instead of once at the end, so three lines at 0.335 land on 1.00 or 1.01 depending on the order the cart iterates." },
    { minutes: 30, prompt: "Move the rounding to the end and pin it with a test", reply: "Moved the rounding to the end in cart/total.ts and added a fixture that pins the order. The test passes 200 times in a row." },
    { minutes: 20, prompt: "Now round the tax line the same way", reply: "Tax rounds once at the end too, in cart/tax.ts. Two files changed." },
  ]);
  const cursorTurns = turnsOn("ws_rewind", cursor, [
    { minutes: 15, prompt: "Round the tax line once", reply: "Tax now rounds once at the end, in cart/tax.ts." },
    { minutes: 10, prompt: "Add a test for the tax rounding", reply: "Added cart/tax.test.ts with the three line fixture." },
  ]);
  return store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace("ws_rewind", THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-rewind", "fix/cart-rounding") })],
    sessions: { ws_rewind: { workspaceId: "ws_rewind", sessions: [...cursorTurns.sessions.ws_rewind.sessions, ...children.sessions.ws_rewind.sessions, ...claudeTurns.sessions.ws_rewind.sessions], threads: {} } },
    transcripts: { ws_rewind: { workspaceId: "ws_rewind", events: [...claudeTurns.transcripts.ws_rewind.events, ...cursorTurns.transcripts.ws_rewind.events, ...children.transcripts.ws_rewind.events] } },
    readsSince: 60 * 24 * 7,
    preferences: { projectLook: { "pr_spoo-landing": { icon: "folder", hue: "orange" } } },
  });
};

export default { build: rewind };
