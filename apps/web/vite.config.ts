// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const pkg = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

export default defineConfig({
  // Tailwind only touches stylesheets that import it; the CSS modules of the
  // old tabs keep going through Vite's own pipeline.
  plugins: [react(), tailwindcss()],
  // noVNC's H.264 decoder module uses top-level await, which vite's default
  // es2020 target rejects at bundle time.
  build: { target: "es2022" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // Test-only: terminal tests drive the real in-process daemon through the
    // reach client, source-aliased like the root workspace's node project.
    alias: {
      "@wsp/engine": pkg("engine/src/index.ts"),
      "@wsp/adapter-claude": pkg("adapter-claude/src/index.ts"),
      "@wsp/daemon": pkg("daemon/src/index.ts"),
      "@wsp/protocol": pkg("protocol/src/index.ts"),
      "@wsp/runtime": pkg("runtime/src/index.ts"),
    },
  },
});
