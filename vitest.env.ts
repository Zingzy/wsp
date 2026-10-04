// SPDX-License-Identifier: AGPL-3.0-only
// The environment every test project runs its processes with. A test says the
// environment it means by handing one in; this is the belt behind that, so a
// developer or a builder who exports either variable reads the same result as
// one who does not. Read by all three projects (the node one in
// vitest.workspace.ts, apps/web and apps/www) so the fact has one home.
//
// It is the process environment this empties, not every spelling of a read: a
// test that aliases or spreads process.env is caught here rather than by the
// grep in packages/protocol/test/test-env.test.ts, which is deliberate.
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { UPDATE_CHECK_ENV } from "./packages/protocol/src/env.js";

/** The gates a person throws to turn a suite on, each read once to decide whether its file runs. Nothing else: a
 * variable that changes what the code under test does is handed in, never read off the process running the suite. */
export const GATES: Record<string, string> = {
  WSP_LIVE: "runs the tests that create real machines",
  WSP_LIVE_LONG: "runs the live tests that take hours",
  WSP_LIVE_STATE: "the state file the live tests read their golden from",
  WSP_GOLDEN: "the golden the live tests build on instead of the state file's",
  WSP_RUNTIME_LIVE: "runs the tests that drive the workspace runtime on this computer, which take root and cgroup v2",
  WSP_RENDER: "runs the Chromium render tests",
  WSP_PACK_SMOKE: "runs the npm pack smoke",
  WSP_DESKTOP_SMOKE: "runs the packaged desktop smoke",
  WSP_DESKTOP_APP: "the packaged app the desktop smoke drives instead of the built one",
  WSP_DAEMON_BIN: "the daemon binary the daemon suite drives instead of the daemon in its own process",
  WSP_MCP_BIN: "runs the tool server suite against a daemon binary built with its mcp feature",
  WSP_SIGNED: "says a Developer ID signed the bundles the release runner built, which the certificate itself never reaches a test to say",
  WSP_REQUIRE_DAEMON: "fails the staged-daemon case where the build staged no binary, rather than skipping it, so a stale asset cannot ship",
  WSP_DAEMON_CUT: "holds the daemon record to the tree, as the landing gate does once its cut has run",
};

// Every other wsp variable of the shell that started the suite goes before a worker starts, and every worker and
// every process a test starts inherits what is left: a suite run inside a wsp thread would otherwise dial that
// thread's host as that thread, from any code under test that reads the process's own environment.
for (const name of Object.keys(process.env)) if (name.startsWith("WSP_") && !(name in GATES)) delete process.env[name];

/** This run's own temp folder, named for the process that started the run, so whatever lands under it is this run's
 * doing; vitest.agent-store.ts makes it and reads it. A worker reading this file is already inside it. */
export const RUN_TMPDIR = /^wsp-run-\d+$/.test(basename(tmpdir())) ? tmpdir() : join(tmpdir(), `wsp-run-${process.pid}`);

// The release check is off, so no host a test starts asks GitHub for the newest release. Every other wsp variable
// is gone by the rule above, the launch pair, the home and a named host with the rest. TMPDIR puts every folder a
// case or a process it starts makes under the run's own.
export const TEST_ENV: Record<string, string> = { [UPDATE_CHECK_ENV]: "0", TMPDIR: RUN_TMPDIR };
