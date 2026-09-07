// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, type SuiteFactory } from "vitest";

/** The cli as pnpm build leaves it; only the build makes it, so a test that spawns it cannot make it. */
export const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** A suite that spawns the built cli: never a silent pass when the build is absent. */
export function describeWithBin(name: string, suite: SuiteFactory): void {
  if (existsSync(BIN)) describe(name, suite);
  else describe(name, () => it.skip(`${BIN} is missing: run pnpm build first`, () => {}));
}
