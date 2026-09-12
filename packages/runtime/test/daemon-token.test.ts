// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DAEMON_TOKEN_PATH } from "@wsp/protocol";
import { DAEMON_TOKEN_NONE, DAEMON_TOKEN_SET, assertTokenShape, rotateDaemonTokenScript, writeDaemonTokenScript } from "../src/daemon-token.js";

const TOKEN = "0123456789abcdef".repeat(3);

describe("daemon token scripts", () => {
  it("write the token only inside a NAME='value' assignment, owner-readable, replaced whole", () => {
    const script = writeDaemonTokenScript(TOKEN);
    const lines = script.split("\n");
    expect(lines[0]).toBe(`WSP_DAEMON_TOKEN='${TOKEN}'`);
    expect(lines.slice(1).join("\n")).not.toContain(TOKEN);
    expect(lines.indexOf("umask 077")).toBeLessThan(lines.findIndex(l => l.startsWith("printf")));
    expect(script).toContain(`> ${DAEMON_TOKEN_PATH}.next`);
    expect(script).toContain(`mv -f ${DAEMON_TOKEN_PATH}.next ${DAEMON_TOKEN_PATH}`);
  });

  it("rotate leaves a machine without a daemon alone and names each outcome on stdout", () => {
    const script = rotateDaemonTokenScript(TOKEN);
    expect(script.startsWith(`test -f ${DAEMON_TOKEN_PATH} || { echo ${DAEMON_TOKEN_NONE}; exit 0; }\n`)).toBe(true);
    expect(script).toContain(writeDaemonTokenScript(TOKEN));
    expect(script.endsWith(`\necho ${DAEMON_TOKEN_SET}`)).toBe(true);
  });

  it("refuse anything but hex, so the quoting above is always enough", () => {
    expect(() => assertTokenShape("")).toThrow(/hex/);
    expect(() => assertTokenShape("it's-not-hex-at-all-000")).toThrow(/hex/);
    expect(() => writeDaemonTokenScript("'; rm -rf /; echo '0123456789abcdef")).toThrow(/hex/);
    expect(() => assertTokenShape(TOKEN)).not.toThrow();
  });
});
