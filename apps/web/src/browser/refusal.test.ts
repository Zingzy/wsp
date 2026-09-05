// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { explainRefusal } from "./refusal.js";

const HOST = "d1f292946d3bf9229dff-5173.preview.getsolari.com";
const at = { port: 5173, host: HOST };

describe("explainRefusal", () => {
  it("names Vite's host check from the measured 403 body and says both fixes", () => {
    const body = `Blocked request. This host (${HOST}) is not allowed. To allow this host, add it to server.allowedHosts`;
    const refusal = explainRefusal({ status: 403, body }, at);
    expect(refusal?.title).toBe(":5173 refused the preview host");
    expect(refusal?.detail).toContain("Vite");
    expect(refusal?.detail).toContain(HOST);
    expect(refusal?.detail).toContain("Restart the dev server");
    expect(refusal?.detail).toContain("server.allowedHosts");
  });

  it("reads Vite's newer body too, with the host quoted and the fix on its own line", () => {
    const body = `Blocked request. This host ("${HOST}") is not allowed.\nTo allow this host, add "${HOST}" to \`server.allowedHosts\` in vite.config.js.`;
    expect(explainRefusal({ status: 403, body }, at)?.detail).toContain("Vite");
  });

  it("names Next's allowedDevOrigins from its bare 403 Unauthorized", () => {
    const refusal = explainRefusal({ status: 403, body: "Unauthorized" }, { port: 3000, host: HOST });
    expect(refusal?.title).toBe(":3000 refused the preview host");
    expect(refusal?.detail).toContain("Next.js");
    expect(refusal?.detail).toContain("allowedDevOrigins");
    expect(refusal?.detail).toContain("next.config");
  });

  it("explains any other 403 as a refusal of the preview host without guessing the server", () => {
    const refusal = explainRefusal({ status: 403, body: "<html>Forbidden</html>" }, at);
    expect(refusal?.title).toBe(":5173 answered 403 through the preview route");
    expect(refusal?.detail).toContain(HOST);
    expect(refusal?.detail).not.toContain("Vite");
    expect(refusal?.detail).not.toContain("Next");
  });

  it("leaves every other answer to the frame", () => {
    expect(explainRefusal({ status: 200, body: "<!doctype html>" }, at)).toBeNull();
    expect(explainRefusal({ status: 404, body: "Not found" }, at)).toBeNull();
    expect(explainRefusal({ status: 500, body: "boom" }, at)).toBeNull();
    expect(explainRefusal({ status: 502, body: "" }, at)).toBeNull();
  });
});
