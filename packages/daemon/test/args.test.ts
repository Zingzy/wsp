// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseDaemonArgs } from "../src/main.js";

describe("wsp-daemon argv", () => {
  it("defaults to the in-guest shape (0.0.0.0:7070) when no flags are given", () => {
    expect(parseDaemonArgs([])).toEqual({});
  });

  it("parses --host for local runs, --port, and --token-path", () => {
    expect(parseDaemonArgs(["--host", "127.0.0.1", "--port", "7171"])).toEqual({ host: "127.0.0.1", port: 7171 });
    expect(parseDaemonArgs(["--token-path", "/tmp/tok"])).toEqual({ tokenPath: "/tmp/tok" });
  });

  it("parses --root for a workspace root other than HOME", () => {
    expect(parseDaemonArgs(["--root", "/srv/work"])).toEqual({ root: "/srv/work" });
    expect(() => parseDaemonArgs(["--root"])).toThrow(/--root/);
  });

  it("refuses a missing value or a non-numeric port", () => {
    expect(() => parseDaemonArgs(["--host"])).toThrow(/--host/);
    expect(() => parseDaemonArgs(["--port", "abc"])).toThrow(/--port/);
    expect(() => parseDaemonArgs(["--token-path"])).toThrow(/--token-path/);
    expect(() => parseDaemonArgs(["--wat"])).toThrow(/--wat/);
  });
});
