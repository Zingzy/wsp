// SPDX-License-Identifier: AGPL-3.0-only
// The app's own log: a time on every entry, a size it never passes by more
// than one entry, a handful of files kept, and no secret in any of them.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENTRY_CHARS, credentialValues, openAppLog, rendererReport } from "../src/app-log.js";

const made: string[] = [];
const dir = (): string => {
  const at = mkdtempSync(join(tmpdir(), "wsp-app-log-"));
  made.push(at);
  return join(at, "logs");
};
afterEach(() => {
  for (const at of made.splice(0)) rmSync(at, { recursive: true, force: true });
});

const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

describe("the app's log", () => {
  it("makes its folder and writes each entry on a line that opens with its time and level, a stack indented under it", () => {
    const logs = dir();
    const log = openAppLog(logs, { now: () => new Date("2026-10-10T11:23:55.178Z") });
    log.write("error", "main: unhandled rejection: Error: forced\n    at main.mjs:1:1");
    log.write("info", "attached http://127.0.0.1:4400");
    expect(log.path).toBe(join(logs, "app.log"));
    expect(readFileSync(log.path, "utf8")).toBe("2026-10-10T11:23:55.178Z error main: unhandled rejection: Error: forced\n      at main.mjs:1:1\n2026-10-10T11:23:55.178Z info attached http://127.0.0.1:4400\n");
  });

  it("appends to the log an earlier launch left", () => {
    const logs = dir();
    openAppLog(logs).write("info", "first launch");
    openAppLog(logs).write("info", "second launch");
    const lines = readFileSync(join(logs, "app.log"), "utf8").trim().split("\n");
    expect(lines.map(l => l.replace(TIME, ""))).toEqual(["info first launch", "info second launch"]);
    for (const line of lines) expect(line).toMatch(TIME);
  });

  it("stays bounded: rotated at its size, four files kept, the oldest dropped, every file under the size", () => {
    const logs = dir();
    const log = openAppLog(logs, { maxBytes: 1000, kept: 4 });
    for (let n = 0; n < 200; n++) log.write("error", `entry ${String(n).padStart(3, "0")} ${"x".repeat(60)}`);
    expect(readdirSync(logs).sort()).toEqual(["app.1.log", "app.2.log", "app.3.log", "app.log"]);
    for (const file of readdirSync(logs)) expect(statSync(join(logs, file)).size).toBeLessThanOrEqual(1000);
    // The newest entry is in app.log and the one before the cut in app.1.log; the first entries are gone.
    expect(readFileSync(join(logs, "app.log"), "utf8")).toContain("entry 199");
    const all = readdirSync(logs).map(f => readFileSync(join(logs, f), "utf8")).join("");
    expect(all).not.toContain("entry 000");
  });

  it("cuts one huge entry to its ceiling, so a page cannot rotate the log away in one line", () => {
    const logs = dir();
    const log = openAppLog(logs);
    log.write("error", "y".repeat(ENTRY_CHARS * 10));
    const text = readFileSync(log.path, "utf8");
    expect(text.length).toBeLessThan(ENTRY_CHARS + 200);
    expect(text).toContain(`(${ENTRY_CHARS * 9} characters cut)`);
  });

  it("never holds a secret: a credential-named assignment loses its value, and every credential value this launch carries is blanked wherever it turns up", () => {
    const logs = dir();
    const key = "sk-ant-api03-forced-secret-value-1234";
    const token = "ghp_forcedtoken5678";
    const log = openAppLog(logs, { env: { ANTHROPIC_API_KEY: key, GH_TOKEN: token, HOME: "/home/dev" } });
    log.write("error", `update: get failed: fetch https://api.example/release?token=${token} refused`);
    log.write("error", `renderer: uncaught at /#/settings: Error: bad key ${key}`);
    log.write("error", `main: spawn failed with SOLARI_API_KEY=slr_live_abcdef and OPENAI_API_KEY="sk-proj-xyz"`);
    log.write("error", `${"z".repeat(ENTRY_CHARS - 5)}${key}`);
    const text = readFileSync(log.path, "utf8");
    // The key past the ceiling was blanked before the cut, so not even its head is left.
    for (const secret of [key, token, "slr_live_abcdef", "sk-proj-xyz", "sk-ant"]) expect(text).not.toContain(secret);
    expect(text).toContain("token=<redacted>");
    expect(text).toContain("bad key <redacted>");
    expect(text).toContain("SOLARI_API_KEY=<redacted>");
    // HOME is no credential, so a path in a line stays readable.
    expect(credentialValues({ ANTHROPIC_API_KEY: key, GH_TOKEN: token, HOME: "/home/dev", DB_PASSWORD: "hunter22" })).toEqual([key, token, "hunter22"]);
  });

  it("drops a write it cannot make and never throws", () => {
    const at = mkdtempSync(join(tmpdir(), "wsp-app-log-"));
    made.push(at);
    // A file where the folder should be: nothing can be made under it.
    writeFileSync(join(at, "logs"), "");
    const log = openAppLog(join(at, "logs"));
    expect(() => log.write("error", "nowhere to go")).not.toThrow();
  });
});

describe("a page's report", () => {
  it("reads as the kind, the route, the message and the stack", () => {
    expect(rendererReport({ kind: "error", message: "Uncaught Error: forced", stack: "Error: forced\n    at index.js:1:1", route: "/#/settings/general" })).toBe("renderer: uncaught at /#/settings/general: Uncaught Error: forced\nError: forced\n    at index.js:1:1");
    expect(rendererReport({ kind: "rejection", message: "Error: lost", stack: "", route: "/" })).toBe("renderer: unhandled rejection at /: Error: lost");
  });

  it("is nothing for a shape the preload never sends", () => {
    for (const raw of [undefined, null, "boom", { kind: "warn", message: "x", route: "/" }, { kind: "error", message: 1, route: "/" }, { kind: "error", message: "x" }]) expect(rendererReport(raw)).toBeUndefined();
  });
});
