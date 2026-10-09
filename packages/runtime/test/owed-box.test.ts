// SPDX-License-Identifier: AGPL-3.0-only
// A child's line whose try into a lead on a joined computer is still out when that computer goes away: the line's
// hour stops the try by the road a person's stop takes, so the row settles, the end of the lead's group is owed to
// the computer's next link, and the person is told the child's line. A harness fed by hand over a fake computer on
// the link, on a clock the case moves.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NOTIFY_ME, type TurnResult } from "@wsp/protocol";
import type { HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { NOTIFY_OWED } from "../src/types/internal.js";
import { joined } from "./box-fixture.js";
import { fakeClock } from "./fake-clock.js";
import { placesOf, sockets } from "./places-fixture.js";
import { until } from "./until.js";

const MIN = 60_000;
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 50));

/** A harness whose turns answer at once, but the line's try, which never announces itself and whose stop never
 * answers, as an agent on a computer that went away. */
function linesHang(tries: string[]): HarnessAdapterFactory {
  return () => ({
    steers: false,
    start: o => {
      const sessionId = randomUUID();
      if (o.prompt.includes("built it")) {
        tries.push(o.prompt);
        return { localId: sessionId, finished: new Promise<TurnResult>(() => {}), interrupt: () => new Promise<void>(() => {}) };
      }
      const result: TurnResult = { status: "completed", text: o.prompt === "build" ? "built it" : "waiting" };
      o.onEvent({ type: "session.start", sessionId });
      o.onEvent({ type: "turn.done", sessionId, result });
      o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
    },
  });
}

describe("a line's try into a lead on a computer that went away", () => {
  it("is stopped at the line's hour by the stop road: the row settles, the lead's group end is owed to the computer's next link, and the person is told", async () => {
    const at = fakeClock();
    const store = memoryStore();
    const tries: string[] = [];
    const { rt, placeId, project } = await joined({ store, adapters: { claude: linesHang(tries) }, clock: at.clock });
    const ws = (await rt.workspaces.folderFor({ project: project.id })).workspace.id;
    const lead = await rt.sessions.start(ws, { prompt: "coordinate", harness: "claude" });
    await lead.finished;
    const leadThread = lead.view().threadId!;
    const kid = await rt.sessions.start(ws, { prompt: "build", harness: "claude", notify: [leadThread] });
    const kidThread = kid.view().threadId!;
    await kid.finished;
    await until(() => tries.length === 1);
    // The computer goes away with the try out on it.
    for (const s of sockets.splice(0)) s.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const person = async (): Promise<number> => (await rt.sessions.history(ws)).filter(e => e.type === "session.notify" && e.notify === NOTIFY_ME && e.threadId === kidThread).length;
    at.advance(59 * MIN);
    await settle();
    expect(await person()).toBe(0);
    at.advance(2 * MIN);
    await until(async () => (await person()) === 1);
    expect(await store.get("thread-ends", placeId)).toEqual({ threads: [leadThread] });
    const rows = (await rt.sessions.list(ws)).filter(v => v.threadId === leadThread).map(v => v.status);
    expect(rows).not.toContain("running");
    expect(tries).toHaveLength(1);
    expect(await store.list(NOTIFY_OWED)).toEqual([]);
  }, 20_000);
});
