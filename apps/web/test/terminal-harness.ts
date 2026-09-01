// SPDX-License-Identifier: AGPL-3.0-only
// Shared harness: a real in-process daemon reached through the reach client,
// registered as the terminal link for WS_ID. Callers must run teardown() in
// afterEach.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { connectDaemon, type DaemonReach } from "@wsp/runtime";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";

export const TOKEN = "t21-token";
export const WS_ID = "ws_term_test";

let daemon: DaemonHandle | undefined;
let reach: DaemonReach | undefined;
let inboxDir: string | undefined;

export interface Harness {
  wt: WorkspaceTerminals;
  daemon: DaemonHandle;
  /** Every op sent over the wire, in order; lets tests count pty.write calls. */
  wireLog: { op: string; params: Record<string, unknown> }[];
}

export async function boot(): Promise<Harness> {
  inboxDir = mkdtempSync(join(tmpdir(), "wsp-term-"));
  daemon = await startDaemon({
    port: 0,
    token: TOKEN,
    inboxDir,
    inboxQuietMs: 100,
    inboxPollMs: 50,
    portsSource: async () => [],
    portsIntervalMs: 1000,
    // The real probe is Linux-only and its failure fallback reports line mode,
    // which would hold keystrokes locally. A fixed raw report keeps these
    // tests on the passthrough path; compose has its own suite.
    modeProbe: async () => ({ icanon: false, echo: true, foreground: "sh" }),
  });
  const wireLog: Harness["wireLog"] = [];
  const wire: TerminalWire = {
    request: (op, params = {}) => {
      wireLog.push({ op, params });
      return reach!.request(op, params);
    },
  };
  const wt = new WorkspaceTerminals(wire);
  reach = connectDaemon({
    previewUrl: `ws://127.0.0.1:${daemon.port}`,
    token: TOKEN,
    heartbeatMs: 60_000,
    onEvent: e => wt.feedEvent(e),
    onStatus: s => wt.feedStatus(s),
  });
  await reach.ready;
  provideTerminals(WS_ID, wt);
  return { wt, daemon, wireLog };
}

export async function teardown(): Promise<void> {
  provideTerminals(WS_ID, null);
  reach?.close();
  reach = undefined;
  await daemon?.close();
  daemon = undefined;
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  inboxDir = undefined;
}
