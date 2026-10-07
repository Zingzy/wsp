// SPDX-License-Identifier: AGPL-3.0-only
// The formats both languages render live, held to the one case file the daemon's own tests read too: a case changed
// there turns red whichever side no longer writes it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fmtBytes, fmtCost, fmtDuration, plural } from "../src/format.js";

const CASES = fileURLToPath(new URL("../../../daemon/fixtures/contract/formats.json", import.meta.url));

type Cases = {
  bytes: [number, string][];
  durations: [number, string][];
  plural: [number, string, string][];
  cost: [number, string][];
};

const cases = JSON.parse(readFileSync(CASES, "utf8")) as Cases;

describe("the shared format cases in daemon/fixtures/contract/formats.json", () => {
  it.each(cases.bytes)("bytes %s reads %j", (n, want) => expect(fmtBytes(n)).toBe(want));
  it.each(cases.durations)("a duration of %s ms reads %j", (ms, want) => expect(fmtDuration(ms)).toBe(want));
  it.each(cases.plural)("%s %s reads %j", (n, noun, want) => expect(plural(n, noun)).toBe(want));
  it.each(cases.cost)("a cost of %s reads %j", (usd, want) => expect(fmtCost(usd)).toBe(want));
});
