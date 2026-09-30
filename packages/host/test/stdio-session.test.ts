// SPDX-License-Identifier: AGPL-3.0-only
// The road the tool server suites take to the binary: a session with a server that exits before it answers fails at
// once in its own words, and a binary from another version of this tree is refused before any case runs, rather than
// every case waiting out its budget on a server that can never answer.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_VERSION } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { writeStub } from "../../protocol/test/stub-script.js";
import { mcpBinNamed, served } from "./stdio-session.js";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A stand-in wsp-daemon that says the version given and refuses everything else, as an older build refuses a flag;
 * with none, one that never answers at all. */
function daemonOf(version?: number): string {
  dir = mkdtempSync(join(tmpdir(), "wsp-stdio-session-"));
  const says = version === undefined ? "exec sleep 30" : `[ "$1" = version ] && { echo ${version}; exit 0; }\necho "error: unexpected argument '--guest' found" >&2\nexit 2`;
  return writeStub(join(dir, "wsp-daemon"), `#!/bin/sh\n${says}\n`);
}

describe("a session with a tool server", () => {
  it("fails at once, with the server's exit code, when the server exits before it answers", async () => {
    const started = Date.now();
    await expect(served([daemonOf(DAEMON_VERSION), "mcp", "--guest"], {}, [{ jsonrpc: "2.0", id: 0, method: "initialize" }])).rejects.toThrow("the tool server exited with code 2 before it answered");
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 5_000);
});

describe("the binary WSP_MCP_BIN names", () => {
  it("is refused where it is another version of the daemon than this tree cuts, and taken where it is this one", () => {
    expect(mcpBinNamed(undefined)).toBeUndefined();
    expect(mcpBinNamed("")).toBeUndefined();
    const older = daemonOf(DAEMON_VERSION - 1);
    expect(() => mcpBinNamed(older)).toThrow(`WSP_MCP_BIN names ${older}, a wsp-daemon of version ${DAEMON_VERSION - 1}, and this tree cuts ${DAEMON_VERSION}`);
    const same = daemonOf(DAEMON_VERSION);
    expect(mcpBinNamed(same)).toBe(same);
  });

  it("is refused, naming it, where it does not say its version within a few seconds, so the suites' collection never hangs", () => {
    const silent = daemonOf();
    const started = Date.now();
    expect(() => mcpBinNamed(silent)).toThrow(`WSP_MCP_BIN names ${silent}, which did not say its version within 3 s, and this tree cuts ${DAEMON_VERSION}`);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 10_000);
});
