// SPDX-License-Identifier: AGPL-3.0-only
// A saved key reaches the runtime's provider slot; a runtime made without one
// says so instead of taking the key and doing nothing with it.
import { createRuntime, memoryStore } from "@wsp/runtime";
import { describe, expect, it } from "vitest";
import { makeRuntime, providerSlotOf, swapProvider } from "../src/cli.js";
import { stubBackend } from "./stub-backend.js";

describe("the provider slot behind a host's runtime", () => {
  it("makeRuntime wires a slot a saved key swaps the module in; a runtime from elsewhere refuses the swap in one line", async () => {
    const rt = makeRuntime({}, "/tmp/wsp-provider-swap/state.json");
    try {
      expect(providerSlotOf(rt)?.current().capabilities.previewUrls).toBe(false);
      swapProvider(rt, { solari: "slr_live_fake" });
      expect(providerSlotOf(rt)?.current().capabilities.previewUrls).toBe(true);
    } finally {
      await rt.close();
    }
    const bare = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    try {
      expect(() => swapProvider(bare, { solari: "slr_live_fake" })).toThrow(/no provider slot/);
    } finally {
      await bare.close();
    }
  });
});
