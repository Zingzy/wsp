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
//
// A run leaves nothing in the person's home either: every case runs with HOME
// under the run's own folder (RUN_HOME), so a case that writes under
// homedir(), as a host serving a temp state file once wrote its device key
// into the real ~/.wsp, writes there, and anything left there fails the run.
//
// A run runs no agent's own command either: a stand-in for each is first on
// the PATH every case inherits (vitest.env.ts), and one that was called fails
// the run naming the call. A title question a closed runtime let go on once
// ran the person's own claude, billed, after the case's stub was gone.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectKey } from "./packages/protocol/src/project-path.js";
import { AGENT_BINS, AGENT_CALLS, AGENT_STAND_INS, RUN_HOME, RUN_TMPDIR } from "./vitest.env.js";

const PROJECTS = join(process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), "projects");

/** Every file and empty folder under dir, relative to it. */
function leftIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => !e.isDirectory() || readdirSync(join(e.parentPath, e.name)).length === 0)
    .map(e => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}

export default function setup(): () => void {
  mkdirSync(RUN_HOME, { recursive: true });
  mkdirSync(AGENT_STAND_INS, { recursive: true });
  // Not found, as on a computer without the agent, with the call kept for the teardown.
  for (const bin of AGENT_BINS) {
    const script = `#!/bin/sh\nprintf '%s\\n' "${bin} $*  (HOME $HOME, in $PWD)" >> '${AGENT_CALLS}'\necho "${bin}: the suite's stand-in; a case that runs ${bin} names a stub of its own on its PATH" >&2\nexit 127\n`;
    writeFileSync(join(AGENT_STAND_INS, bin), script, { mode: 0o755 });
  }
  // Both spellings, as Claude Code keys a folder: macOS hands out /var and resolves it to /private/var.
  const runKeys = [...new Set([RUN_TMPDIR, realpathSync(RUN_TMPDIR)])].map(claudeProjectKey);
  return () => {
    const left = existsSync(PROJECTS) ? readdirSync(PROJECTS).filter(k => runKeys.some(r => k === r || k.startsWith(`${r}-`))) : [];
    const home = leftIn(RUN_HOME);
    const ran = existsSync(AGENT_CALLS) ? readFileSync(AGENT_CALLS, "utf8").split("\n").filter(line => line !== "") : [];
    if (left.length === 0 && home.length === 0 && ran.length === 0) {
      // A failed run keeps its folder for the goldens it regenerates; a render or smoke run keeps the screenshots in it.
      if (!process.exitCode && !process.env["WSP_RENDER"] && !process.env["WSP_DESKTOP_SMOKE"]) rmSync(RUN_TMPDIR, { recursive: true, force: true });
      return;
    }
    throw new Error(
      [
        ...(left.length === 0
          ? []
          : [
              `this run left ${left.length} folder${left.length === 1 ? "" : "s"} of its own temp folder in the person's own Claude Code store, ${PROJECTS}:`,
              ...left.map(k => `  ${k}`),
              "A case that lands agent state hands the road homes under its own temp folder, never the ones under this computer's home.",
            ]),
        ...(home.length === 0
          ? []
          : [
              `this run left ${home.length} file${home.length === 1 ? "" : "s"} in the home its cases run with, ${RUN_HOME}; outside a test run they land in the person's own home:`,
              ...home.map(f => `  ~/${f}`),
              "A case whose code writes under the home hands that code a home of its own under its temp folder.",
            ]),
        ...(ran.length === 0
          ? []
          : [
              `this run ran ${ran.length} agent command${ran.length === 1 ? "" : "s"} off the suite's PATH, ${AGENT_STAND_INS}; on a computer with that agent installed they run the person's own:`,
              ...ran.map(line => `  ${line}`),
              "A case whose code runs an agent's command puts a stub of its own first on its PATH, and closes what runs it before the stub goes.",
            ]),
      ].join("\n"),
    );
  };
}
