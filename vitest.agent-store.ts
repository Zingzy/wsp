// SPDX-License-Identifier: AGPL-3.0-only
// A run leaves no session in the person's own Claude Code store. A road that
// lands sessions, as an export does, files them under the key of the folder
// it lands in, and one export run on a real home put 575 copies of the
// person's sessions under a scratch folder's key, which their usage then
// counted twice. Every worker and every process a case starts makes its
// folders under the run's own temp folder (RUN_TMPDIR, handed out as TMPDIR),
// which nothing outside the run writes under, so a key for it is this run's
// doing. The person's own agents start sessions in other temp folders while a
// suite runs, and those are not looked at. The teardown runs once for each
// workspace project; each reads the same folder's keys.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectKey } from "./packages/protocol/src/project-path.js";
import { RUN_TMPDIR } from "./vitest.env.js";

const PROJECTS = join(process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), "projects");

export default function setup(): () => void {
  mkdirSync(RUN_TMPDIR, { recursive: true });
  // Both spellings, as Claude Code keys a folder: macOS hands out /var and resolves it to /private/var.
  const runKeys = [...new Set([RUN_TMPDIR, realpathSync(RUN_TMPDIR)])].map(claudeProjectKey);
  return () => {
    const left = existsSync(PROJECTS) ? readdirSync(PROJECTS).filter(k => runKeys.some(r => k === r || k.startsWith(`${r}-`))) : [];
    if (left.length === 0) {
      // A failed run keeps its folder for the goldens it regenerates; a render or smoke run keeps the screenshots in it.
      if (!process.exitCode && !process.env["WSP_RENDER"] && !process.env["WSP_DESKTOP_SMOKE"]) rmSync(RUN_TMPDIR, { recursive: true, force: true });
      return;
    }
    throw new Error(
      [
        `this run left ${left.length} folder${left.length === 1 ? "" : "s"} of its own temp folder in the person's own Claude Code store, ${PROJECTS}:`,
        ...left.map(k => `  ${k}`),
        "A case that lands agent state hands the road homes under its own temp folder, never the ones under this computer's home.",
      ].join("\n"),
    );
  };
}
