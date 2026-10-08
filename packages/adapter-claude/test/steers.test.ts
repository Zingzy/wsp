// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { userMessageLine } from "../src/landmines.js";
import { steeredIds } from "../src/steers.js";

const SID = "e16ed170-8257-4668-879e-fe836341633c";

describe("the steers a re-opened turn waits on", () => {
  it("a run's channel read back names the steers of its last turn alone", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(steeredIds([userMessageLine("open 1", SID), userMessageLine("x", SID, [], a), userMessageLine("open 2", SID), userMessageLine("y", SID, [], b), "not json", JSON.stringify({ type: "control_request" })])).toEqual([b]);
  });

  it("a line written again under a steer's id is that one steer, since only its id is read", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    expect(steeredIds([userMessageLine("open", SID), userMessageLine("x", SID, [], a), userMessageLine("push to main", SID, [], a)])).toEqual([a]);
  });
});
