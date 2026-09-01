import { defineConfig } from "vitest/config";

// Live tests create real machines under a 2-machine plan cap, so live runs
// must never execute test files in parallel.
export default defineConfig({
  test: {
    fileParallelism: process.env.WSP_LIVE !== "1",
  },
});
