// SPDX-License-Identifier: AGPL-3.0-only
// The order a setup's steps after the base tools run in: what each waits on,
// the lanes two steps may not share, and the width a computer's memory allows.
import { describe, expect, it } from "vitest";
import { runGraph, type GraphStep } from "../src/setup-graph.js";

/** Steps each held until the test lets it go, with what was running whenever one started. */
function held(specs: { name: string; after?: string[]; lanes?: string[]; light?: boolean; stop?: boolean; throws?: boolean }[]) {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const together: string[][] = [];
  const steps: GraphStep<string>[] = specs.map(s => ({
    name: s.name,
    after: s.after ?? [],
    lanes: s.lanes ?? [],
    ...(s.light === true ? { light: true } : {}),
    run: () =>
      new Promise((resolve, reject) => {
        started.push(s.name);
        releases.set(s.name, () => (s.throws === true ? reject(new Error(`${s.name} broke`)) : resolve(s.stop === true ? "stop" : "go")));
      }),
  }));
  const let_ = async (name: string): Promise<void> => {
    await new Promise(r => setImmediate(r));
    releases.get(name)!();
    await new Promise(r => setImmediate(r));
  };
  return { steps, started, together, let: let_ };
}

describe("the steps after the base tools", () => {
  it("start together up to the width, each once what it waits on ended, never two on one lane", async () => {
    const g = held([
      { name: "agents", lanes: ["installs"] },
      { name: "skills", lanes: ["files"] },
      { name: "clis", after: ["agents"], lanes: ["installs"] },
      { name: "mcp", after: ["agents", "clis"], lanes: ["files"] },
      { name: "folders" },
    ]);
    const moves: string[][] = [];
    const done = runGraph(g.steps, 2, now => moves.push([...now]));
    await new Promise(r => setImmediate(r));
    expect(g.started).toEqual(["agents", "skills"]);
    await g.let("skills");
    // Two at once: folders takes the room skills left, clis waits on agents.
    expect(g.started).toEqual(["agents", "skills", "folders"]);
    await g.let("agents");
    expect(g.started).toEqual(["agents", "skills", "folders", "clis"]);
    await g.let("folders");
    await g.let("clis");
    expect(g.started.at(-1)).toBe("mcp");
    await g.let("mcp");
    expect(await done).toEqual([]);
    expect(Math.max(...moves.map(m => m.length))).toBe(2);
    expect(moves.at(-1)).toEqual([]);
  });

  it("runs one at a time at width one, and a light step takes no room", async () => {
    const g = held([{ name: "a" }, { name: "b" }, { name: "signins", light: true }]);
    const done = runGraph(g.steps, 1);
    await new Promise(r => setImmediate(r));
    expect(g.started).toEqual(["a", "signins"]);
    await g.let("signins");
    await g.let("a");
    expect(g.started).toEqual(["a", "signins", "b"]);
    await g.let("b");
    expect(await done).toEqual([]);
  });

  it("starts nothing more once a step says stop, lets the running end, and answers what never started", async () => {
    const g = held([{ name: "agents", stop: true }, { name: "skills" }, { name: "clis", after: ["agents"] }]);
    const done = runGraph(g.steps, 2);
    await g.let("agents");
    expect(g.started).toEqual(["agents", "skills"]);
    await g.let("skills");
    expect(await done).toEqual(["clis"]);
  });

  it("throws the first error once every running step ended", async () => {
    const g = held([{ name: "a", throws: true }, { name: "b" }, { name: "c", after: ["a"] }]);
    const done = runGraph(g.steps, 2);
    let settled = false;
    void done.catch(() => (settled = true));
    await g.let("a");
    expect(settled).toBe(false);
    await g.let("b");
    await expect(done).rejects.toThrow("a broke");
    expect(g.started).toEqual(["a", "b"]);
  });
});
