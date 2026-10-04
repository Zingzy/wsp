import { describe, expect, it } from "vitest";
import { evaluateSlateExpression, parseSlate, resolveSlateProp, sketchSlate, slateStartValues, type SlateJson } from "../../src/slate/index.js";

const now = Date.parse("2026-10-04T12:00:00Z");
const at = (world: Record<string, SlateJson>) => ({ resolve: (p: string) => world[p], now });
const NONE = at({ $t: [] });
const ZONE = at({ $t: [{ zone: "spoo.me" }] });

describe("text joined from the values it reads", () => {
  it("is missing when everything it reads is missing, so no half sentence draws", () => {
    expect(evaluateSlateExpression("concat($t[0].zone, ', requests per minute')", NONE)).toBeNull();
    expect(evaluateSlateExpression("`${$t[0].zone}, requests per minute`", NONE)).toBeNull();
    expect(resolveSlateProp({ format: "${$t[0].zone}, requests per minute" }, NONE)).toBeNull();
  });

  it("reads whole once its data comes", () => {
    expect(evaluateSlateExpression("concat($t[0].zone, ', requests per minute')", ZONE)).toBe("spoo.me, requests per minute");
    expect(evaluateSlateExpression("`${$t[0].zone}, requests per minute`", ZONE)).toBe("spoo.me, requests per minute");
    expect(resolveSlateProp({ format: "${$t[0].zone}, requests per minute" }, ZONE)).toBe("spoo.me, requests per minute");
  });

  it("joins what it has when only some of what it reads is missing, and literal words alone stay text", () => {
    const errs = at({ "$env": { err: "permission denied" }, "$ci": { err: null } });
    expect(evaluateSlateExpression("concat($env.err, $ci.err)", errs)).toBe("permission denied");
    expect(evaluateSlateExpression("concat('Sp', 'ot')", NONE)).toBe("Spot");
    expect(evaluateSlateExpression("concat(orElse($t[0].zone, ''), ' requests')", NONE)).toBe(" requests");
  });

  it("the sketch says what the person sees: the label left out until its zone comes", () => {
    const d = parseSlate(`<slate title="Traffic">
<value name="t" start={[]} />
<column><number id="rpm" label={concat($t[0].zone, ', requests per minute')} value={1240} /></column>
</slate>`).document!;
    const before = sketchSlate(d, slateStartValues(d), { version: 1, now });
    expect(before).not.toContain("requests per minute");
    const after = sketchSlate(d, { ...slateStartValues(d), t: [{ zone: "spoo.me" }] }, { version: 1, now });
    expect(after).toContain("spoo.me, requests per minute");
  });
});
