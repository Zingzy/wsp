// SPDX-License-Identifier: AGPL-3.0-only
// What a send says on stderr while the host holds it: behind the thread's
// running turn, or on a computer that is away until the end a stop owed it
// has run there.
import { describe, expect, it } from "vitest";
import { sendWaitsForLine } from "@wsp/protocol";
import type { HostClient, VerbContext } from "../src/verbs/client.js";
import { detachVerb } from "../src/verbs/turns-help.js";

/** A host that says the start waits, with what it waits for, then answers it. */
function waitingHost(waitsFor: string | undefined): HostClient {
  const heard: ((f: Record<string, unknown>) => void)[] = [];
  return {
    events: async () => {},
    onFrame: (fn: (f: Record<string, unknown>) => void) => {
      heard.push(fn);
      return () => heard.splice(heard.indexOf(fn), 1);
    },
    request: async (_op: string, p: Record<string, unknown> = {}) => {
      for (const fn of [...heard]) fn({ type: "session.queued", workspaceId: "ws_1", threadId: "thr_1", harness: "claude", prompt: "and then", requestId: p["requestId"], ...(waitsFor !== undefined ? { waitsFor } : {}) });
      return { session: { id: "t1", workspaceId: "ws_1", harness: "claude", status: "running", threadId: "thr_1" }, outcome: "queued", turnId: "t1" };
    },
  } as unknown as HostClient;
}

const said = async (waitsFor: string | undefined): Promise<string[]> => {
  const errors: string[] = [];
  const ctx = { io: { error: (line: string) => errors.push(line) }, out: { emit: () => {} } } as unknown as VerbContext;
  await detachVerb(ctx, waitingHost(waitsFor), { workspaceId: "ws_1", prompt: "and then", thread: "thr_1" });
  return errors;
};

describe("a send the host holds", () => {
  it("says it waits for the computer to connect where a stop owed that computer the thread's end", async () => {
    expect((await said("hetzner"))[0]).toBe(sendWaitsForLine("hetzner"));
  });

  it("says it waits behind the running turn otherwise", async () => {
    expect((await said(undefined))[0]).toBe("waiting behind the running turn");
  });
});
