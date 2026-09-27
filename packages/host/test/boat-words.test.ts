// SPDX-License-Identifier: AGPL-3.0-only
// ASCII's Box is Boat. The provider's id stays box inside stored state, and
// every word a person reads names Boat: its rows, its key, where the key is
// made, the skill, the docs, the app and the command line.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_KEY_WORDS, providerKeyName } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { BOX_KEY_ENV } from "../src/providers.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The old product's words, as a line a person reads would carry them. */
const OLD = [/Box by ASCII/, /\bBox API key\b/, /\bBOX_API_KEY\b/];

/** Where every word a person reads is written: each package's and app's source, the skill, the docs, the READMEs
 * and the tool list the Rust server serves. A test file says what the words were, so it is not one of them. */
function readWords(): { path: string; text: string }[] {
  const files: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js|md|json|rs)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  for (const group of ["packages", "apps"])
    for (const name of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, name, "src");
      if (statSync(join(ROOT, group, name)).isDirectory() && readdirSync(join(ROOT, group, name)).includes("src")) walk(src);
      if (readdirSync(join(ROOT, group, name)).includes("README.md")) files.push(join(ROOT, group, name, "README.md"));
    }
  for (const dir of ["skills", "docs", "daemon/crates/wsp-mcp/record"]) walk(join(ROOT, dir));
  files.push(join(ROOT, "README.md"));
  return files.map(path => ({ path: path.slice(ROOT.length), text: readFileSync(path, "utf8") }));
}

describe("ASCII's provider is Boat", () => {
  it("is named Boat, with a Boat API key made at the console boat.dev serves", () => {
    expect(PROVIDER_KEY_WORDS["box"]).toEqual({ name: "Boat", keyName: "Boat API key", keyConsole: "boat.dev/dashboard" });
    expect(providerKeyName("box")).toBe("Boat");
    expect(BOX_KEY_ENV).toBe("BOAT_API_KEY");
  });

  it("no word a person reads says Box by ASCII, the Box API key or BOX_API_KEY", () => {
    const words = readWords();
    expect(words.length).toBeGreaterThan(100);
    const said = words.flatMap(({ path, text }) => OLD.filter(old => old.test(text)).map(old => `${path}: ${old.source}`));
    expect(said).toEqual([]);
  });
});
