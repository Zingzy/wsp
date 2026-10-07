// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HANDSHAKE, RUN_DIR } from "@wsp/engine";
import { stopAwayLine, type TurnResult } from "@wsp/protocol";
import type { HarnessAdapterFactory } from "../src/runtime.js";
import { createOn } from "./stub-backend.js";
import { until } from "./until.js";
import { report } from "./place-join.js";
import { ctx, sockets, serving, code, join, relink, placesOf, forks } from "./places-fixture.js";

describe("a stop on a running turn whose box is away", () => {
  it("answers at once and settles the row, and the turn's run is ended once the box dials back", async () => {
    const run = `${RUN_DIR}/0123456789ab`;
    let gaveUp!: () => void;
    const stopGaveUp = new Promise<void>(resolve => (gaveUp = resolve));
    // The agent's own stop is a write the box has to take, which waits out a gap in the link as Claude's does, and
    // the turn reads over once that write lands or gives up.
    const factory: HarnessAdapterFactory = c => ({
      steers: false,
      start: ({ onEvent }) => {
        const sessionId = randomUUID();
        let end!: (r: TurnResult) => void;
        const finished = new Promise<TurnResult>(resolve => (end = resolve));
        onEvent({ type: "session.start", sessionId });
        return {
          localId: sessionId,
          run,
          finished,
          interrupt: async () => {
            await c.machine.exec(`echo stop >> ${run}.in`, { idempotencyKey: `${run}/stop` }).catch(() => gaveUp());
            end({ status: "interrupted" });
          },
        };
      },
    });
    const { hostKey } = await serving({ adapters: { claude: factory }, relinkWaitMs: 4000 });
    const { client, placeId, pair } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    const ws = await createOn(ctx.runtime!, { golden: "snap_g", name: "x", on: "srv" });
    const handle = await ctx.runtime!.sessions.start(ws.id, { prompt: "work", harness: "claude" });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);

    const answer = await Promise.race([ctx.runtime!.sessions.interrupt(handle.id), new Promise<"still waiting">(r => setTimeout(() => r("still waiting"), 2000))]);
    expect(answer).toEqual({ outcome: "accepted", error: stopAwayLine("srv") });
    const row = (await ctx.runtime!.sessions.list(ws.id)).find(s => s.id === handle.id)!;
    expect(row.status).toBe("interrupted");

    // The box stays away past the agent's own stop, so only its coming back can end the run left on it.
    await stopGaveUp;
    const asks: string[] = [];
    const back = await relink(hostKey, placeId, pair, report("srv"), c =>
      forks(c, undefined, cmd => {
        asks.push(cmd);
        return { exitCode: 0, stdout: cmd.includes(HANDSHAKE.run) ? `${HANDSHAKE.run}\n` : "", stderr: "" };
      }),
    );
    sockets.push(back.client.ws);
    await until(() => asks.some(cmd => cmd.includes(run) && cmd.includes("kill -KILL")), 3000);
  }, 15_000);
});
