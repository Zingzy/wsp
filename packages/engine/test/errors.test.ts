import { describe, expect, it } from "vitest";
import { machineUnreachedLine } from "@wsp/protocol";
import { classify, isNetworkError, MachineUnreached, shouldRetry, untilReached } from "../src/errors.js";

describe("error policy", () => {
  it("never retries 429", () => {
    const e = classify(429, { code: "ConcurrencyLimitExceeded", error: "Too many concurrent sessions" });
    expect(e.kind).toBe("concurrency");
    expect(shouldRetry(e, 1)).toBe(false);
  });
  it("retries generic 502 up to 3 attempts", () => {
    const e = classify(502, { error: "upstream sad" });
    expect(shouldRetry(e, 1)).toBe(true);
    expect(shouldRetry(e, 3)).toBe(false);
  });
  it("does NOT retry the snapshot-502 signature", () => {
    const e = classify(502, { error: "Failed to snapshot sandbox" });
    expect(e.kind).toBe("snapshotUnavailable");
    expect(shouldRetry(e, 1)).toBe(false);
  });
  it("maps 402/403/404 to permanent", () => {
    expect(classify(402, { code: "InsufficientCredit" }).kind).toBe("plan");
    expect(classify(404, {}).kind).toBe("missing");
  });
});

describe("isNetworkError", () => {
  it("is a fetch that threw, or a socket or DNS code on the error or its cause", () => {
    expect(isNetworkError(new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.example"), { code: "EAI_AGAIN" }) }))).toBe(true);
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isNetworkError(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }))).toBe(true);
  });
  it("is not an answer: a gateway status the backend already retried, gone, paused, refused, or any plain error", () => {
    expect(isNetworkError(Object.assign(new Error("upstream sad"), classify(503, { error: "upstream sad" })))).toBe(false);
    expect(isNetworkError(Object.assign(new Error("gone"), classify(404, { error: "gone" })))).toBe(false);
    expect(isNetworkError(Object.assign(new Error("paused"), classify(409, { error: "paused" })))).toBe(false);
    expect(isNetworkError(Object.assign(new Error("Failed to snapshot sandbox"), classify(502, { error: "Failed to snapshot sandbox" })))).toBe(false);
    expect(isNetworkError(new Error("exit 1: no such file"))).toBe(false);
    expect(isNetworkError("fetch failed")).toBe(false);
  });
});

describe("untilReached", () => {
  /** A clock the retry's own sleeps move, and a call that costs five seconds and fails `times` times. */
  const fixture = (times: number, make: () => Error) => {
    let now = 0;
    let calls = 0;
    const waits: number[] = [];
    return {
      once: async (): Promise<string> => {
        calls++;
        now += 5_000;
        if (calls <= times) throw make();
        return "answered";
      },
      clock: {
        now: () => now,
        sleep: async (ms: number): Promise<void> => {
          waits.push(ms);
          now += ms;
        },
      },
      calls: () => calls,
      waits,
    };
  };

  it("retries a call nothing answered at the engine's backoff and returns the answer that came", async () => {
    const f = fixture(2, () => new TypeError("fetch failed"));
    expect(await untilReached(f.once, f.clock)).toBe("answered");
    expect(f.calls()).toBe(3);
    expect(f.waits.length).toBe(2);
    expect(f.waits[0]).toBeGreaterThanOrEqual(1_000);
    expect(f.waits[0]).toBeLessThan(1_250);
    expect(f.waits[1]).toBeGreaterThanOrEqual(2_000);
    expect(f.waits[1]).toBeLessThan(2_250);
  });

  it("rethrows a failure that is not the network at once, after one call and no wait", async () => {
    const f = fixture(9, () => Object.assign(new Error("gone"), classify(404, { error: "gone" })));
    await expect(untilReached(f.once, f.clock)).rejects.toThrow("gone");
    expect(f.calls()).toBe(1);
    expect(f.waits).toEqual([]);
  });

  it("gives up once the next wait would end past the reach window, with the count and the time in the protocol's words", async () => {
    const f = fixture(99, () => new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }) }));
    const e = await untilReached(f.once, f.clock).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MachineUnreached);
    const unreached = e as MachineUnreached;
    // Five-second calls with waits of 1, 2 and 4 seconds: the fourth call ends 27 seconds in, and the 8 second wait
    // after it would end past the window, so no fifth is made.
    expect(unreached.attempts).toBe(4);
    expect(unreached.elapsedMs).toBeGreaterThanOrEqual(20_000 + 7_000);
    expect(unreached.elapsedMs).toBeLessThan(20_000 + 7_000 + 750);
    expect(unreached.message).toBe(machineUnreachedLine(4, unreached.elapsedMs));
    expect(unreached.message).toMatch(/^the machine could not be reached from this computer after 4 attempts over 2[78]s$/);
    expect((unreached.cause as Error).message).toBe("fetch failed");
    expect(f.calls()).toBe(4);
  });
});
