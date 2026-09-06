// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe scan: every option this computer offers, what to do about each
// and why, and nothing written.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan, type RecipeIo } from "../src/recipe-command.js";
import { USED_GROUP, type TableRow } from "../src/init-table.js";
import { ALSO_HERE_TITLE, COMMANDS_TITLE, NOT_SCANNED, RecipeScan, SIGN_INS_TITLE, alsoHereLines, scanPrintout, signInAdvice, tickAdvice } from "../src/recipe-answer.js";
import { claudeLine, fakeHost, HOME } from "./recipe-fixture.js";

const PROJ = `${HOME}/proj`;
const MB = 1024 * 1024;
const quiet: RecipeIo = { log: () => {}, note: () => {} };
const at = () => new Date("2026-09-06T03:00:00Z");

/** Claude Code and Java here, node, pnpm, gh and wrangler in the agent's own sessions, and pulumi, which the
 * catalog does not carry. */
const laptop = () =>
  fakeHost({
    which: ["claude", "java"],
    files: {
      "~/.claude/settings.json": "{}",
      "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", PROJ, ["node --version", "pnpm install", "pulumi -q"]), claudeLine("s1", PROJ, ["gh pr view"])].join("\n"),
      "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", PROJ, ["pnpm test", "node build.js", "gh pr list", "wrangler deploy"]),
      "~/.claude/projects/-Users-dev-other/s3.jsonl": claudeLine("s3", `${HOME}/other`, ["go build ./..."]),
    },
  });

describe("wsp recipe scan", () => {
  it("writes nothing, and answers with the agents, the tools, the commands and the sign-ins in one read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-scan-"));
    const scan = RecipeScan.parse(await runScan(laptop(), {}, quiet, at));
    expect(existsSync(join(dir, "recipe.json"))).toBe(false);
    expect(scan.tick).toBe("used");
    expect(scan.at).toBe("2026-09-06T03:00:00.000Z");
    expect(scan.agents.map(r => r.id).sort()).toEqual(["claude", "codex", "gemini", "hermes", "opencode", "pi"]);
    expect(scan.tools.find(r => r.id === "node")).toMatchObject({ on: true });
    expect(scan.tools.find(r => r.id === "java")).toMatchObject({ on: false, why: "installed here, never used" });
    expect(scan.commands.map(c => c.name)).toEqual(["pulumi"]);
    expect(scan.signIns.map(r => r.id)).toEqual(["claude", "gh", "wrangler"]);
    expect(scan.signIns.find(r => r.id === "gh")).toMatchObject({ signIn: "gh auth login" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries what to do with every row and one line of why, so an agent applies the rest and asks about the delta", async () => {
    const scan = await runScan(laptop(), {}, quiet, at);
    expect(scan.tools.find(r => r.id === "node")?.recommended).toEqual({ value: "on", why: "always on the image" });
    expect(scan.tools.find(r => r.id === "java")?.recommended).toEqual({ value: "off", why: "installed here, never used" });
    for (const row of [...scan.agents, ...scan.tools]) expect(row.recommended.value, row.id).toBe(row.on ? "on" : "off");
    for (const row of scan.signIns) expect(row.recommended.why.length, row.id).toBeGreaterThan(0);
    expect(scan.signIns.find(r => r.id === "claude")?.recommended.value).toBe("machine");
  });

  it("says a heavy row is worth a question in the same line, and nothing else is", () => {
    const row: TableRow = { id: "opencode", name: "OpenCode", kind: "agent", base: false, group: USED_GROUP, why: "used here, 2 sessions", size: 673 * MB, heavy: true, on: true };
    const heavy = tickAdvice({ ...row, on: true });
    expect(heavy).toEqual({ value: "on", why: "used here, 2 sessions; 673.0 MB on the machine, worth a question" });
    // Off, so nothing is being added and there is nothing to ask about.
    expect(tickAdvice({ ...row, on: false }).why).toBe("used here, 2 sessions");
    expect(tickAdvice({ ...row, id: "node", kind: "tool", on: true, heavy: false, size: 250 * MB }).why).toBe("used here, 2 sessions");
  });

  it("recommends the key files where a login cannot produce them, and the machine where a browser can", () => {
    // Hermes signs in on the machine and its keys file cannot be produced there, so key gets both.
    expect(signInAdvice("hermes")).toMatchObject({ value: "key" });
    expect(signInAdvice("claude")).toMatchObject({ value: "machine" });
    expect(signInAdvice("gh")).toMatchObject({ value: "machine" });
  });

  it("prints the heading for the tools no catalog row carries, telling nothing looked from nothing found", () => {
    expect(alsoHereLines({ scanned: false, managers: [] })).toEqual([ALSO_HERE_TITLE, `  ${NOT_SCANNED}`]);
    expect(alsoHereLines({ scanned: true, managers: [] })).toEqual([ALSO_HERE_TITLE, "  none"]);
    const lines = alsoHereLines({ scanned: true, managers: [{ manager: "brew", rows: [{ id: "jj", install: "brew install jj", size: 40 * MB }] }] });
    expect(lines[1]).toBe("  brew");
    expect(lines[2]).toBe("    jj  brew install jj  40.0 MB");
  });

  it("prints every section in order, the do column beside each row", async () => {
    const lines = scanPrintout(await runScan(laptop(), {}, quiet, at));
    expect(lines[0]).toBe("Agents");
    // The shared renderer's own line, with the one column the scan adds.
    expect(lines.find(l => l.includes("Java 21"))).toMatch(/^○ {2}Java 21\s+installed\s+installed here, never used\s+584\.9 MB {2}off$/);
    expect(lines).toContain("Tools");
    expect(lines).toContain(ALSO_HERE_TITLE);
    expect(lines).toContain(`  ${NOT_SCANNED}`);
    expect(lines).toContain(COMMANDS_TITLE);
    expect(lines).toContain(SIGN_INS_TITLE);
    expect(lines.find(l => l.includes("Claude Code"))).toMatch(/^● {2}Claude Code\s+used\s+used here, 3 sessions\s+208\.0 MB {2}on$/);
    // The shared renderer's totals line, one under each table.
    expect(lines.filter(l => l.startsWith("On: "))).toHaveLength(2);
  });

  it("weighs the histories by the folders it is given, as the write verb does", async () => {
    expect((await runScan(laptop(), {}, quiet, at)).tools.find(r => r.id === "go")).toMatchObject({ on: true });
    expect((await runScan(laptop(), { projects: [PROJ] }, quiet, at)).tools.find(r => r.id === "go")).toMatchObject({ on: false });
  });
});
