import { defineConfig } from "vitest/config";

// Live tests create real machines under a two-machine cap, so files run one at
// a time. The worker pool reads this from the root config only; the same line
// on a workspace project is ignored and the files run in parallel.
// The checks that a run leaves no daemon of its own behind and nothing in the person's Claude Code store run once
// for the whole run, so they live here too.
export default defineConfig({
  test: { fileParallelism: process.env.WSP_LIVE !== "1", globalSetup: ["./vitest.daemons.ts", "./vitest.agent-store.ts"] },
});
