import { describe, expect, it } from "vitest";
import { classify, shouldRetry } from "../src/errors.js";

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

describe("the provider's request id", () => {
  it("rides on the error when the reply carried one, and is absent, not empty, when it did not", () => {
    expect(classify(502, { error: "Failed to snapshot sandbox" }, "req_7")).toEqual({ kind: "snapshotUnavailable", status: 502, code: undefined, message: "Failed to snapshot sandbox", requestId: "req_7" });
    expect(classify(502, { error: "Failed to snapshot sandbox" })).not.toHaveProperty("requestId");
  });
});
