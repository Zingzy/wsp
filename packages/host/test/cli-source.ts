// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";

/** cli.ts and every file under cli/, as one text, so a law read off the command line's source holds over all of it
 * whichever file a declaration sits in. */
export function cliSource(): string {
  const dir = new URL("../src/cli/", import.meta.url);
  const parts = readdirSync(dir).filter(name => name.endsWith(".ts")).sort();
  return [readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8"), ...parts.map(name => readFileSync(new URL(name, dir), "utf8"))].join("\n");
}
