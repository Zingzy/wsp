// SPDX-License-Identifier: AGPL-3.0-only
// What a send says on stderr while the host holds it: behind the thread's
// running turn, or on a computer that is away until the end a stop owed it
// has run there.
import { describe, expect, it } from "vitest";
import { sendWaitedForLine, sendWaitsForLine } from "@wsp/protocol";
import type { HostClient, VerbContext } from "../src/verbs/client.js";
import { detachVerb, followVerb } from "../src/verbs/turns-help.js";

/** A host that says the start waits, once for each of `waits` with what it waits for, then answers it, and pushes the
 * turn's end right behind for a send that follows it. */
function waitingHost(waits: ReadonlyArray<string | undefined>): HostClient {
  const heard: ((f: Record<string, unknown>) => void)[] = [];
  return {
    events: async () => {},
    onFrame: (fn: (f: Record<string, unknown>) => void) => {
      heard.push(fn);
      return () => heard.splice(heard.indexOf(fn), 1);
    },
    request: async (_op: string, p: Record<string, unknown> = {}) => {
      for (const waitsFor of waits) for (const fn of [...heard]) fn({ type: "session.queued", workspaceId: "ws_1", threadId: "thr_1", harness: "claude", prompt: "and then", requestId: p["requestId"], ...(waitsFor !== undefined ? { waitsFor } : {}) });
      const turn = { workspaceId: "ws_1", threadId: "thr_1", sessionId: "s1", turnId: "t1" };
      for (const fn of [...heard]) fn({ type: "session.done", ...turn, result: { status: "completed", text: "done" } });
      for (const fn of [...heard]) fn({ type: "session.end", ...turn, exitCode: 0, sawResult: true });
      return { session: { id: "t1", workspaceId: "ws_1", harness: "claude", status: "running", threadId: "thr_1" }, outcome: "queued", turnId: "t1" };
    },
    closed: new Promise(() => {}),
  } as unknown as HostClient;
}

const saidBy = async (road: "detach" | "follow", waits: Array<string | undefined>): Promise<string[]> => {
  const errors: string[] = [];
  const ctx = { io: { error: (line: string) => errors.push(line) }, out: { emit: () => {}, stream: () => {} }, flags: {} } as unknown as VerbContext;
  const start = { workspaceId: "ws_1", prompt: "and then", thread: "thr_1" };
  if (road === "detach") await detachVerb(ctx, waitingHost(waits), start);
  else await followVerb(ctx, waitingHost(waits), start, false);
  return errors;
};
const said = (...waits: Array<string | undefined>): Promise<string[]> => saidBy("detach", waits);

describe("a send the host holds", () => {
  it("says it waits for the computer to connect where a stop owed that computer the thread's end", async () => {
    expect((await said("hetzner"))[0]).toBe(sendWaitsForLine("hetzner"));
  });

  it("says it waits behind the running turn otherwise", async () => {
    expect((await said(undefined))[0]).toBe("waiting behind the running turn");
  });

  it("names the computer once a Stop turns a wait behind the running turn into a wait for that computer, and at the wait's end", async () => {
    expect(await said(undefined, "hetzner")).toEqual(["waiting behind the running turn", sendWaitsForLine("hetzner"), sendWaitedForLine("hetzner")]);
  });

  it("names the computer at the end of a wait for it alone", async () => {
    expect(await said("hetzner")).toEqual([sendWaitsForLine("hetzner"), sendWaitedForLine("hetzner")]);
  });

  it("names the computer at the wait's end on a send that follows its turn too", async () => {
    expect(await saidBy("follow", [undefined, "hetzner"])).toEqual(["waiting behind the running turn", sendWaitsForLine("hetzner"), sendWaitedForLine("hetzner")]);
  });

  it("ends on the running turn where the wait for the computer gave way to a wait behind the turn that launched", async () => {
    expect(await said("hetzner", undefined)).toEqual([sendWaitsForLine("hetzner"), "waiting behind the running turn", "queued behind the running turn; it has ended and this turn started"]);
  });
});
