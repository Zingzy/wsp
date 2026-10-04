import { describe, expect, it } from "vitest";
import { parseSlate, runSlateBatch, slateStartValues, type SlateDoc, type SlateRunRecord } from "../../src/slate/index.js";
import { SPEC_EXAMPLES } from "./examples.js";

const doc = (decls: string, pieces = `<text>x</text>`): SlateDoc => {
  const r = parseSlate(`<slate title="B">\n${decls}\n  <column>\n    ${pieces}\n  </column>\n</slate>`);
  expect(r.errors).toEqual([]);
  return r.document!;
};

describe("the batch", () => {
  it("recomputes derived values before reactions fire, and fires them in document order", () => {
    const d = doc(`  <value name="n" start={0} />
  <value name="log" start="" />
  <derived name="big" value={$n > 5} />
  <when id="second" change={$big} do={set($log, concat($log, 'big:', $big, ';'))} />
  <when id="first" change={$n} do={set($log, concat($log, 'n:', $n, ';'))} />`);
    const r = runSlateBatch(d, slateStartValues(d), [{ path: "$n", value: 9 }], { by: "agent" });
    expect(r.problems).toEqual([]);
    expect(r.values.log).toBe("big:true;n:9;");
    expect(r.changed).toEqual(["$n", "$log"]);
  });

  it("shows a set in one round to the reactions of the next, never the same round", () => {
    const d = doc(`  <value name="a" start={0} />
  <value name="b" start={0} />
  <value name="c" start={0} />
  <value name="seen" start={-1} />
  <when id="ab" change={$a} do={set($b, $a + 1)} />
  <when id="peek" change={$a} do={set($seen, $b)} />
  <when id="bc" change={$b} do={set($c, $b + 1)} />`);
    const r = runSlateBatch(d, slateStartValues(d), [{ path: "$a", value: 1 }]);
    expect(r.values).toMatchObject({ a: 1, b: 2, c: 3 });
    expect(r.values.seen).toBe(2);
  });

  it("takes no write that changes nothing as a change", () => {
    const d = doc(`  <value name="a" start={1} />\n  <value name="hits" start={0} />\n  <when change={$a} do={set($hits, $hits + 1)} />`);
    const r = runSlateBatch(d, slateStartValues(d), [{ path: "$a", value: 1 }]);
    expect(r.values.hits).toBe(0);
    expect(r.changed).toEqual([]);
  });

  it("refuses a static cycle at write time, so the batch never meets one", () => {
    const r = parseSlate(`<slate>\n  <value name="a" start={0} />\n  <derived name="twice" value={$a * 2} />\n  <when change={$twice} do={set($a, 1)} />\n  <text>x</text>\n</slate>`);
    expect(r.errors.map(e => e.code)).toEqual(["A610"]);
    expect(r.errors[0]!.message).toBe("reactions and derived values form a cycle: $twice reads $a; when change of $twice sets $a");
  });

  it("stops a loop through a run after 8 rounds with R910, keeping what was written", () => {
    const d = doc(`  <run name="tick" cmd="true" />\n  <when done={$tick} do={start($tick)} />`);
    let n = 0;
    const done = (): SlateRunRecord => ({ state: "done", exit: 0, runs: ++n });
    const r = runSlateBatch(d, slateStartValues(d), [{ path: "$tick", value: { state: "done", exit: 0, runs: 0 } }], { by: "run", start: done });
    expect(r.problems.map(p => p.code)).toEqual(["R910"]);
    expect(r.starts).toHaveLength(8);
    expect(r.values.tick).toEqual({ state: "done", exit: 0, runs: 8 });
  });

  it("stops a reaction at a refused step, keeps its earlier steps, and fires the rest of the round", () => {
    const d = doc(`  <value name="a" start={0} />
  <value name="x" start={0} />
  <value name="y" start={0} />
  <value name="z" start={0} />
  <when id="chain" change={$a} do={[set($x, 1), send("Moved.", $a), set($y, 1)]} />
  <when id="after" change={$a} do={set($z, 1)} />`);
    const r = runSlateBatch(d, slateStartValues(d), [{ path: "$a", value: 1 }], { by: "agent" });
    expect(r.values).toMatchObject({ x: 1, y: 0, z: 1 });
    expect(r.problems).toEqual([expect.objectContaining({ code: "R912", piece: "chain" })]);
    expect(r.problems[0]!.message).toBe("reaction chain, step 2 (send): the person has not let this slate message the agent from a reaction; the steps after it did not run");
    const allowed = runSlateBatch(d, slateStartValues(d), [{ path: "$a", value: 1 }], { by: "agent", reactionSends: true });
    expect(allowed.values).toMatchObject({ x: 1, y: 1, z: 1 });
    expect(allowed.sends).toEqual([{ do: "send", text: "Moved.", with: ["$a"], values: { $a: 1 }, reaction: "chain", by: "reaction" }]);
  });

  it("fires done once a run ends, whatever the outcome", () => {
    const d = doc(`  <run name="check" cmd="true" />\n  <value name="ok" start={null} />\n  <when done={$check} do={set($ok, $check.exit == 0)} />`);
    const running = runSlateBatch(d, slateStartValues(d), [{ path: "$check", value: { state: "running", runs: 1 } }], { by: "run" });
    expect(running.values.ok).toBe(null);
    const failed = runSlateBatch(d, running.values, [{ path: "$check", value: { state: "failed", exit: 1, why: "the host restarted while it ran", runs: 1 } }], { by: "run" });
    expect(failed.values.ok).toBe(false);
  });

  it("runs a press as round 0 with the row in scope, and hands window steps back", () => {
    const d = doc(`  <value name="pick" start="" />\n  <run name="finish" cmd='echo "$ID"' env={{ ID: $pick }} />`,
      `<table items={pr.checks} key={item.name}><col title="Name" value={item.name} /><action label="Done" onPress={[set($pick, item.name), start($finish), open(item.link)]} /></table>`);
    const checks = [{ name: "lint", link: "https://x.example/1" }, { name: "build", link: "https://x.example/2" }];
    const r = runSlateBatch(d, slateStartValues(d), [], { by: "person", resolve: p => (p === "pr.checks" ? checks : undefined), event: { piece: "table-1", kind: "press", rowAction: 0, index: 1 } });
    expect(r.values.pick).toBe("build");
    expect(r.starts).toEqual([{ run: "finish", by: "person", why: "a press on table-1" }]);
    expect(r.other).toEqual([{ step: { do: "open", target: { bind: "item.link" } }, piece: "table-1", value: "https://x.example/2" }]);
  });

  it("refuses an agent's write to a derived value, a run or a secret, and takes the person's handle", () => {
    const d = doc(`  <value name="a" start={0} />\n  <derived name="b" value={$a} />\n  <run name="r" cmd="true" />\n  <secret name="t" />`);
    const r = runSlateBatch(d, slateStartValues(d), [{ path: "$b", value: 1 }, { path: "$r", value: { state: "done", runs: 1 } }, { path: "$t", value: "plaintext" }], { by: "agent" });
    expect(r.problems.map(p => p.code)).toEqual(["A607", "A607", "S520"]);
    expect(r.changed).toEqual([]);
    const handle = { secret: true, set: true, len: 24, at: 1 };
    expect(runSlateBatch(d, slateStartValues(d), [{ path: "$t", value: handle }], { by: "person" }).values.t).toEqual(handle);
  });

  it("carries the setup example's chain: a pasted project starts the check, held until approved", () => {
    const c = parseSlate(SPEC_EXAMPLES.find(e => e.text.includes("Deploy setup") && e.text.includes("vercelToken"))!.text).document!;
    const v0 = slateStartValues(c);
    const held = (): SlateRunRecord => ({ state: "held", why: "needs your approval", runs: 0 });
    const b1 = runSlateBatch(c, { ...v0, step: 2 }, [{ path: "$project", value: "wsp-landing" }], { by: "person", start: held });
    expect(b1.starts).toEqual([{ run: "check", by: "reaction", why: "reaction reaction-1" }]);
    expect(b1.values.check).toEqual({ state: "held", why: "needs your approval", runs: 0 });
    const b2 = runSlateBatch(c, b1.values, [{ path: "$check", value: { state: "done", exit: 0, out: "wsp-landing\n  Framework: Next.js", runs: 1 } }], { by: "run" });
    expect(b2.values.step).toBe(3);
  });
});
