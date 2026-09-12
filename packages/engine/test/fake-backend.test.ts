// SPDX-License-Identifier: AGPL-3.0-only
// The provider a harness serves a fixture through: it answers for machines it
// never minted, and says plainly that there is no guest behind them.
import { describe, expect, it } from "vitest";
import { FAKE_NO_GUEST, FakeBackend } from "../src/fake-backend.js";

describe("the provider that answers out of memory", () => {
  it("names itself when a road reaches for the guest, rather than answering an empty success", async () => {
    const machine = await new FakeBackend().get("fk_c0ffee");
    await expect(machine.exec("echo WSP_LAUNCHED")).rejects.toThrow(FAKE_NO_GUEST);
    await expect(machine.run("echo hi", { deadlineMs: 1_000 })).rejects.toThrow(FAKE_NO_GUEST);
    // Exit 0 with nothing was read by the launch check as a failure it could not word: "exit 0: " with no reason
    // after it, which a tester met as the app losing their thread.
    // The sentence is for a person who has never read this code: it says what the provider is and what it will
    // not do, in words nobody has to be taught.
    expect(FAKE_NO_GUEST).toContain("stand-in provider for testing");
    expect(FAKE_NO_GUEST).toContain("nothing runs on them");
    for (const jargon of ["out of memory", "no guest", "capability", "landsBytes"]) expect(FAKE_NO_GUEST).not.toContain(jargon);
  });

  it("still answers for a machine a fixture names, in the state its id says, since the record has to load", async () => {
    const backend = new FakeBackend();
    expect(await (await backend.get("fk_c0ffee")).state()).toBe("running");
    expect(await (await backend.get("fk_c0ffee.paused")).state()).toBe("paused");
  });
});
