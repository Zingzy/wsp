#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Executable entry only, nothing importable: index.ts re-exports from cli.ts,
// and sharing THIS module would send it into a tsup chunk whose top-level
// code never runs under `node bin.js`.
import { cli } from "./cli.js";

// A warning listener cannot veto node's own printer, so the printer is wrapped; a --disable-warning
// flag on the shebang misses every launch that runs `node bin.js`, and node:sqlite is loaded lazily.
for (const print of process.listeners("warning")) {
  process.removeListener("warning", print);
  process.on("warning", w => {
    if (w.name === "ExperimentalWarning" && w.message.startsWith("SQLite ")) return;
    print(w);
  });
}

cli(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
