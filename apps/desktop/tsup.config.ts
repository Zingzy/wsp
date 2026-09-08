// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "tsup";

// One self-contained main bundle: every workspace package and its deps ride
// inside, so the packaged app carries no pnpm node_modules tree (they are all
// devDependencies, which tsup bundles and electron-builder ignores). Electron
// itself and ws's optional native accelerators stay external.
//
// node-pty is external as well, and is the one package that rides beside the
// bundle: it loads pty.node by a require of a path relative to its own lib, so
// inlined its loader looks under build/app/main and finds nothing, and its
// spawn-helper path is resolved from a __dirname the bundle has not got.
// scripts/stage.mjs lays the package out where the bundle's resolver walks to.
export default defineConfig([
  {
    entry: { main: "src/main.ts" },
    format: ["esm"],
    outDir: "build/app/main",
    platform: "node",
    target: "node22",
    external: ["electron", "bufferutil", "utf-8-validate", "node-pty"],
    // The host's wsp skill rides in as text, the way its own build inlines it.
    loader: { ".md": "text" },
    outExtension: () => ({ js: ".mjs" }),
    // ws is CommonJS and requires node builtins at load; ESM output has no require of its own.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    clean: true,
  },
  {
    // Sandboxed preloads must be CommonJS.
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    outDir: "build/app/main",
    platform: "node",
    target: "node22",
    external: ["electron"],
    outExtension: () => ({ js: ".cjs" }),
  },
]);
