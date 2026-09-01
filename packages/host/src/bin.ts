#!/usr/bin/env node
// Executable entry only, nothing importable: index.ts re-exports from cli.ts,
// and sharing THIS module would send it into a tsup chunk whose top-level
// code never runs under `node bin.js`.
import { cli } from "./cli.js";

cli(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
