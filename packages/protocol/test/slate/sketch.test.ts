import { describe, expect, it } from "vitest";
import { parseSlate, runSlateBatch, sketchSlate, slateCatalog, slateStartValues, slateTokens, SLATE_EXAMPLES, SLATE_PIECES, SLATE_SOURCES, type SlateDoc } from "../../src/slate/index.js";
import { SLATE_INDEX_EXAMPLE } from "../../src/slate/catalog.js";
import { SPEC_EXAMPLES } from "./examples.js";

const now = Date.parse("2026-10-04T12:00:00Z");
const setup = (): SlateDoc => parseSlate(SPEC_EXAMPLES.find(e => e.text.includes("Deploy setup") && e.text.includes("vercelToken"))!.text).document!;

describe("the sketch", () => {
  it.each(SPEC_EXAMPLES.map(e => [e.name, e.text]))("%s sketches under its budget", (_name, text) => {
    const d = parseSlate(text).document!;
    const s = sketchSlate(d, slateStartValues(d), { version: 1, now });
    expect(s.split("\n")[0]).toMatch(/^slate v1 ".+", \d+ pieces, \d+ bound, 0 problems$/);
    expect(slateTokens(s)).toBeLessThan(500);
    expect(s.split("\n").every(l => l.length <= 100)).toBe(true);
  });

  it("draws the setup slate as the person sees it, the secret as dots, and the runs that moved", () => {
    const d = setup();
    const handle = { secret: true, set: true, len: 24, at: now };
    let v = runSlateBatch(d, slateStartValues(d), [{ path: "$vercelToken", value: handle }], { by: "person" }).values;
    v = runSlateBatch(d, v, [], { by: "person", event: { piece: "button-2", kind: "press" } }).values;
    v = runSlateBatch(d, v, [{ path: "$project", value: "wsp-landing" }], { by: "person", start: () => ({ state: "held", why: "needs your approval", runs: 0 }) }).values;
    const s = sketchSlate(d, v, { version: 4, now });
    expect(s).toBe([
      'slate v4 "Deploy setup", 24 pieces, 8 bound, 0 problems',
      "Step 2 of 4  [text-1 text strong]",
      "(hidden) [section-1 section]",
      "2. The project  [section-2 section]",
      '  Project name on Vercel: "wsp-landing"  [project-name input]',
      "  Approve the check to go on  [text-2 text muted]",
      "  (hidden) [text-3 text muted]",
      "  (hidden) [text-4 text bad]",
      "  (hidden) [text-5 text good]",
      "(hidden) [section-3 section]",
      "(hidden) [section-4 section]",
      "values:",
      "  $step = 2",
      '  $project = "wsp-landing"',
      "  $vercelToken = •••• (24 characters)",
      "  $checked = false",
      "  $written = false",
      "runs:",
      "  $check: held needs your approval",
    ].join("\n"));
    expect(s).not.toContain("plaintext");
  });

  it("shows formulas in braces for a check with no thread", () => {
    const d = parseSlate(`<slate><column><meter id="week" label="Weekly" value={usage.week.percent} /></column></slate>`).document!;
    expect(sketchSlate(d, {}, { check: true })).toBe('slate, 2 pieces, 1 bound, 0 problems\nWeekly  [{usage.week.percent} of 100]  [week meter]');
  });
});

describe("the catalog", () => {
  it("keeps the index under 900 tokens and its example valid", () => {
    expect(slateTokens(slateCatalog())).toBeLessThan(900);
    expect(parseSlate(SLATE_INDEX_EXAMPLE).errors).toEqual([]);
    expect(slateCatalog()).toContain(SLATE_INDEX_EXAMPLE);
  });

  it("answers every piece under 200 tokens and every source under 300", () => {
    for (const p of Object.keys(SLATE_PIECES)) expect(slateTokens(slateCatalog(p)), p).toBeLessThan(200);
    for (const s of Object.keys(SLATE_SOURCES)) expect(slateTokens(slateCatalog(s)), s).toBeLessThan(300);
  });

  it("answers runs, functions, steps, handlers and examples within their budgets", () => {
    expect(slateTokens(slateCatalog("runs"))).toBeLessThan(400);
    for (const n of ["functions", "steps", "handlers"]) expect(slateTokens(slateCatalog(n)), n).toBeLessThan(600);
    expect(slateTokens(slateCatalog("examples"))).toBeLessThan(2500);
    for (const e of SLATE_EXAMPLES) expect(parseSlate(e.text).errors, e.title).toEqual([]);
  });

  it("names the nearest entry for a wrong name", () => {
    expect(slateCatalog("metre")).toMatch(/^metre is not in the catalog; did you mean meter\?/);
  });

  it("every piece's catalog example compiles", () => {
    for (const p of Object.values(SLATE_PIECES)) expect(slateCatalog(p.type), p.type).toMatch(/\nsketch: /);
  });
});
