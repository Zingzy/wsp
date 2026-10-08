// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { shapesOf } from "./shapes";

const classes = (code: string) => Object.fromEntries([...shapesOf(code)].map(([shape, ids]) => [shape, [...ids].sort()]));

describe("a flowchart's shapes", () => {
  it("reads tight arrows as the spaced source reads them, an id ending before its edge", () => {
    const spaced = "flowchart TD\n  a([Start]) --> b{Is it cached at the edge?}\n  b --> c[(DB)]";
    const tight = "flowchart TD\n  a([Start])-->b{Is it cached at the edge?}\n  b-->c[(DB)]";
    expect(classes(spaced)).toEqual({ terminal: ["a"], decision: ["b"], store: ["c"] });
    expect(classes(tight)).toEqual(classes(spaced));
  });

  it("keeps every shape after a chain with no closing bracket past its arrows", () => {
    const tight = "flowchart LR\n  a-->b-.->c==>d~~~e\n  f[(Store)] --> g{{Prep}}\n  my-node((Event))";
    expect(classes(tight)).toEqual({ store: ["f"], prep: ["g"], event: ["my-node"] });
  });
});
