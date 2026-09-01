import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Live tests create real machines under a 2-machine plan cap, so live runs
// must never execute test files in parallel.
export default defineConfig({
  test: {
    fileParallelism: process.env.WSP_LIVE !== "1",
  },
  resolve: {
    // Tests run against package sources, not stale dist builds.
    alias: {
      "@wsp/engine": pkg("engine"),
      "@wsp/adapter-claude": pkg("adapter-claude"),
      "@wsp/daemon": pkg("daemon"),
      "@wsp/protocol": pkg("protocol"),
      "@wsp/runtime": pkg("runtime"),
    },
  },
});
