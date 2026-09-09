// SPDX-License-Identifier: AGPL-3.0-only
// What a wsp executable does at start, shared by the npm bin and the command
// the desktop app bundles: quiet node's own line about node:sqlite, run the
// command line, and turn its answer into an exit code.
import { verbFailure } from "@wsp/protocol";
import { cli } from "./cli.js";
import type { RunningWsp } from "./mcp-install.js";

/** A warning listener cannot veto node's own printer, so the printer is wrapped; a --disable-warning flag on the
 * shebang misses every launch that runs `node bin.js`, and node:sqlite is loaded lazily. */
function quietSqliteWarning(): void {
  for (const print of process.listeners("warning")) {
    process.removeListener("warning", print);
    process.on("warning", w => {
      if (w.name === "ExperimentalWarning" && w.message.startsWith("SQLite ")) return;
      print(w);
    });
  }
}

/** Runs the command line in this process and sets its exit code; `run` is how this process was started, for the
 * MCP install to write into an agent's config. */
export function runBin(argv: string[], run?: RunningWsp): void {
  quietSqliteWarning();
  cli(argv, undefined, run).then(
    code => {
      process.exitCode = code;
    },
    (e: unknown) => {
      const failure = verbFailure(e);
      console.error(failure.error);
      process.exitCode = failure.exit;
    },
  );
}
