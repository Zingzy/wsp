// SPDX-License-Identifier: AGPL-3.0-only
// The order a setup's steps after the base tools run in: what each waits on,
// the lanes two steps may not share, and the width a computer's memory allows.
import { describe, expect, it } from "vitest";
import { runGraph, type GraphStep } from "../src/setup-graph.js";

/** Steps each held until the test lets it go, with what was running whenever one started. */
function held(specs: { name: string; after?: string[]; marks?: string[]; lanes?: string[]; light?: boolean; stop?: boolean; throws?: boolean }[]) {
  const releases = new Map<string, () => void>();
  const marking = new Map<string, (mark: string) => void>();
  const started: string[] = [];
  const together: string[][] = [];
  const steps: GraphStep<string, string>[] = specs.map(s => ({
    name: s.name,
    after: s.after ?? [],
    ...(s.marks !== undefined ? { marks: s.marks } : {}),
    lanes: s.lanes ?? [],
    ...(s.light === true ? { light: true } : {}),
    run: release =>
      new Promise((resolve, reject) => {
        started.push(s.name);
        marking.set(s.name, release);
        releases.set(s.name, () => (s.throws === true ? reject(new Error(`${s.name} broke`)) : resolve(s.stop === true ? "stop" : "go")));
      }),
  }));
  const let_ = async (name: string): Promise<void> => {
    await new Promise(r => setImmediate(r));
    releases.get(name)!();
    await new Promise(r => setImmediate(r));
  };
  const mark = async (name: string, m: string): Promise<void> => {
    marking.get(name)!(m);
    await new Promise(r => setImmediate(r));
  };
  return { steps, started, together, let: let_, mark };
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

  it("starts a step waiting on a mark once the step holding it lets it go, while that step still runs", async () => {
    const g = held([
      { name: "clis", marks: ["gh"] },
      { name: "github", after: ["gh"] },
      { name: "folders", after: ["github"] },
    ]);
    const done = runGraph(g.steps, 3);
    await new Promise(r => setImmediate(r));
    expect(g.started).toEqual(["clis"]);
    // A mark the step does not hold lets nothing go.
    await g.mark("clis", "other");
    expect(g.started).toEqual(["clis"]);
    await g.mark("clis", "gh");
    expect(g.started).toEqual(["clis", "github"]);
    await g.let("github");
    expect(g.started).toEqual(["clis", "github", "folders"]);
    await g.let("folders");
    await g.let("clis");
    expect(await done).toEqual([]);
  });

  it("lets a step's marks go at its end where it never let them go itself, and a mark no step holds counts as ended", async () => {
    const g = held([{ name: "clis", marks: ["gh"] }, { name: "github", after: ["gh"] }, { name: "docs", after: ["nobody"] }]);
    const done = runGraph(g.steps, 3);
    await new Promise(r => setImmediate(r));
    expect(g.started).toEqual(["clis", "docs"]);
    await g.let("clis");
    expect(g.started).toEqual(["clis", "docs", "github"]);
    await g.let("docs");
    await g.let("github");
    expect(await done).toEqual([]);
  });

  it("answers a step waiting on a mark as never started where the step holding it never ran", async () => {
    const g = held([{ name: "agents", stop: true }, { name: "clis", after: ["agents"], marks: ["gh"] }, { name: "github", after: ["gh"] }]);
    const done = runGraph(g.steps, 3);
    await g.let("agents");
    expect(await done).toEqual(["clis", "github"]);
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
