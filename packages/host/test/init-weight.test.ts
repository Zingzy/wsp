// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { diskTone } from "../src/init-weight.js";

const MIB = 1024 * 1024;

describe("the Disk line's tone", () => {
  it("is plain under 50 percent of the room, yellow from 50, bright yellow from 65 and red from 75, over the room included", () => {
    const room = 1000 * MIB;
    expect(diskTone(0, room)).toBeUndefined();
    expect(diskTone(500 * MIB - 1, room)).toBeUndefined();
    expect(diskTone(500 * MIB, room)).toBe("yellow");
    expect(diskTone(650 * MIB - 1, room)).toBe("yellow");
    expect(diskTone(650 * MIB, room)).toBe("yellowBright");
    expect(diskTone(750 * MIB - 1, room)).toBe("yellowBright");
    expect(diskTone(750 * MIB, room)).toBe("red");
    expect(diskTone(1500 * MIB, room)).toBe("red");
  });
});
