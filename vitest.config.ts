import { defineConfig } from "vitest/config";

// Live tests create real machines under a two-machine cap, so files run one at
// a time. The worker pool reads this from the root config only; the same line
// on a workspace project is ignored and the files run in parallel.
// The check that a run leaves no daemon of its own behind runs once for the whole run, so it lives here too.
export default defineConfig({
  test: { fileParallelism: process.env.WSP_LIVE !== "1", globalSetup: ["./vitest.daemons.ts"] },
});
