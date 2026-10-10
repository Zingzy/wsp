// SPDX-License-Identifier: AGPL-3.0-only
// A failed sign-in row's line names what each of its buttons does: every way
// of an agent with several opens its sentence with its button's own label,
// and the one-way fix names the Sign in its row draws.
import { describe, expect, it } from "vitest";
import { signInThereFix, signInWayLabel, signInWaysFix, type SignInWay } from "../src/index.js";

const FACTS = { name: "Claude Code", here: "zingzy's MacBook Pro", box: "hetzner", mint: "claude setup-token", keyEnv: "ANTHROPIC_API_KEY" };
const WAYS: SignInWay[] = ["token", "key", "machine"];
/** Every order of every non-empty set of ways. */
const orders = (left: readonly SignInWay[]): SignInWay[][] => left.flatMap(way => [[way], ...orders(left.filter(w => w !== way)).map(rest => [way, ...rest])]);

describe("a failed sign-in row's line and its buttons", () => {
  it("opens one sentence per way with that way's button, in the order the buttons stand", () => {
    for (const ways of orders(WAYS)) {
      const fix = signInWaysFix(ways, FACTS);
      const heads = fix.split(/(?<=\.) (?=[A-Z])/).map(sentence => sentence.slice(0, sentence.indexOf(":")));
      expect(heads).toEqual(ways.map(way => signInWayLabel(way, FACTS.box)));
    }
  });

  it("says what each button does: the command that makes the token here, where the key goes, the sign-in on the box", () => {
    expect(signInWaysFix(WAYS, FACTS)).toBe(
      "Make a token: claude setup-token runs on zingzy's MacBook Pro and asks your browser once. Use an API key: put ANTHROPIC_API_KEY in ~/.wsp/.env on zingzy's MacBook Pro first, and wsp reads it from there without showing it. Sign in on hetzner: Claude Code's own sign-in runs there.",
    );
  });

  it("names the Sign in on the box that a one-way row draws", () => {
    expect(signInThereFix("hetzner")).toContain(signInWayLabel("machine", "hetzner"));
  });
});
