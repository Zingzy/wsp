// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { goldenBuild } from "../src/main.js";

describe("wspx golden build request", () => {
  it("is one request for every road that builds the golden, and names no size", () => {
    const request = goldenBuild({ ANTHROPIC_API_KEY: "sk-ant-x-fake" });
    expect(request).toMatchObject({ smoke: "claude --version", envs: { ANTHROPIC_API_KEY: "sk-ant-x-fake" }, labels: { wsp: "1", "wsp-cli": "1" } });
    expect(request.setup).toContain("claude.ai/install.sh");
    expect([request.cpu, request.memMb]).toEqual([undefined, undefined]);
  });
});
