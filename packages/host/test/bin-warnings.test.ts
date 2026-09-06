// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** Runs inside the bin's process after the verb, the way the engine's lazy node:sqlite load does. */
const WARN_AT_EXIT =
  "data:text/javascript," +
  encodeURIComponent(
    `process.once("beforeExit", () => {
      process.getBuiltinModule("node:sqlite");
      process.emitWarning("an old thing", "DeprecationWarning");
      process.emitWarning("another new thing", "ExperimentalWarning");
    });`,
  );

describe("the wsp bin and node's warnings", () => {
  it("drops node:sqlite's ExperimentalWarning and prints every other warning", async () => {
    expect(existsSync(BIN), `${BIN} is missing: run pnpm build first`).toBe(true);
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", WARN_AT_EXIT, BIN, "--version"]);
    expect(stdout).toMatch(/^wsp \d/);
    expect(stderr).not.toContain("SQLite");
    expect(stderr).toContain("DeprecationWarning: an old thing");
    expect(stderr).toContain("ExperimentalWarning: another new thing");
  });
});
