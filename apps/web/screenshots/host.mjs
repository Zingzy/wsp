// SPDX-License-Identifier: AGPL-3.0-only
// The wsp host a fixture is served through, and the one place that knows how to
// start one: a throwaway home, a fixture state written into it, the built
// command on two free ports, and the wait until it answers. The screenshot run
// and the persona lab both take this road, so the environment a fixture is
// served under is written once rather than once per harness.
import { PERSON_HOME_ENV } from "@wsp/protocol";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOTS_DIR = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = resolve(SCREENSHOTS_DIR, "..");
export const REPO = resolve(WEB_DIR, "..", "..");
export const HOST_BIN = join(REPO, "packages", "host", "dist", "bin.js");
export const APP_PAGE = join(WEB_DIR, "dist", "index.html");

/** What a fixture's host must find built, and the command that builds each: the app it serves and the wsp command
 * that serves it. Answers the sentence to print, or nothing when both are there. */
export function whatIsNotBuilt() {
  for (const [what, path, how] of [
    ["the web app", APP_PAGE, "pnpm --filter @wsp/web build"],
    ["the wsp command", HOST_BIN, "pnpm --filter @wsp/host build"],
  ]) {
    if (!existsSync(path)) return `${what} is not built: ${path} is missing. Run ${how} first, or use the coordinator's screenshots.sh or lab.sh, which build.`;
  }
  return undefined;
}

/** What every browser this harness opens is started with. Chromium's shared memory files land on the root disk, and
 * one uncapped render filled it to ENOSPC under other work on this machine (measured 2026-09-08); low-end device
 * mode caps the tile and image budgets that grow them. */
export const BROWSER_ARGS = ["--enable-low-end-device-mode"];

export const freePort = () =>
  new Promise((ok, no) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address !== null ? ok(address.port) : no(new Error("no port"))));
    });
  });

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The provider word a fixture's host runs under: a state holding forks or a sealed image needs a provider that
 * answers for them, and the one that answers out of memory is the only one that dials nothing. A state of local
 * machines alone runs with none, which is what that person's computer really has. */
export const providerFor = state => (Object.values(state.workspaces ?? {}).some(w => w.kind === "cloud") || state.goldens !== undefined ? "fake" : "none");

/**
 * The whole environment a fixture's host is started with, and the only place it is written down, so the lab can
 * print and record the same words the child was given.
 *
 * A bare one, not this shell's: a Solari key or a WSP_PROVIDER word in the terminal would put the run on a real
 * provider, a stray WSP_HOME would take it to the person's own machines, and a thread's own variables would reach
 * the wsp under test and shape what it lists. The path is the one thing carried over, since the agents a turn runs
 * are found on it.
 *
 * The person's own home rides beside the throwaway one. A turn on this computer runs the agent the person signed
 * in to, and that sign-in is keyed to the home they log in to: under any other home the turn answers "Not logged
 * in" and a tester reads it as the product refusing them (measured 2026-09-12).
 */
export function hostEnv({ home, state, personHome = homedir() }) {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    WSP_HOME: join(home, ".wsp"),
    WSP_PROVIDER: providerFor(state),
    [PERSON_HOME_ENV]: personHome,
  };
}

/** Starts the built wsp command on a throwaway home holding one fixture state, and answers once it serves. */
export async function startHost({ home, state, port, wsPort, logPath, detached = false, personHome }) {
  const statePath = join(home, ".wsp", "state.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const out = logPath === undefined ? "pipe" : openSync(logPath, "a");
  const env = hostEnv({ home, state, personHome });
  const child = spawn(process.execPath, [HOST_BIN, "up", "--state", statePath, "--port", String(port), "--ws-port", String(wsPort)], {
    cwd: home,
    env,
    stdio: ["ignore", out, out],
    detached,
  });
  const log = [];
  child.stdout?.on("data", d => log.push(String(d)));
  child.stderr?.on("data", d => log.push(String(d)));
  const said = () => (logPath === undefined ? log.join("") : `the host's log is at ${logPath}`);
  const base = `http://127.0.0.1:${port}`;
  const answer = { child, base, log, env };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the host exited with ${child.exitCode} before it served:\n${said()}`);
    const served = await fetch(base).then(r => r.ok, () => false);
    if (served) return answer;
    await sleep(200);
  }
  child.kill("SIGTERM");
  throw new Error(`the host did not serve ${base} in 30 s:\n${said()}`);
}

/** SIGTERM to the pid this run started, and nothing else: four builders share this machine and a host found by port
 * or by name is as likely to be somebody else's. */
export async function stopHost(host) {
  if (host === undefined || host.child.exitCode !== null) return;
  const ended = new Promise(r => host.child.once("exit", r));
  host.child.kill("SIGTERM");
  const gaveUp = await Promise.race([ended.then(() => false), sleep(8_000).then(() => true)]);
  if (gaveUp) {
    host.child.kill("SIGKILL");
    await ended;
  }
}
