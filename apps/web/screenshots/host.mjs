// SPDX-License-Identifier: AGPL-3.0-only
// The wsp host a fixture is served through, and the one place that knows how to
// start one: a throwaway home, a fixture state written into it, the built
// command on two free ports, and the wait until it answers. The screenshot run
// and the persona lab both take this road, so the environment a fixture is
// served under is written once rather than once per harness.
import { CATALOG_AGENTS } from "@wsp/catalog";
import { FAKE_AS_ENV, PERSON_HOME_ENV, WEB_DIR_ENV } from "@wsp/protocol";
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
 * The home a turn's agent runs under rides beside the host's. The screenshot run leaves it the person's, since it
 * runs no turn; a lab names its own, which is what keeps this Mac's own MCP servers and skills out of a tester's
 * thread. An agent under a home that is not the person's reads no sign-in of theirs, so a lab signs its own home
 * in with the agents' key instead (measured 2026-09-12: neither a copy of their agent's file nor a link to their
 * keychain carries a subscription sign-in under another home).
 *
 * A lab's own home takes each agent's store with it. The home alone does not: the agent this computer runs looks
 * its user instructions up under the home the login record names, whatever HOME says, and a tester's turn quoted
 * the person's own instruction file back at them (measured 2026-09-12). The variable each agent reads its store
 * from is the catalog's to name, so this moves them all by one rule rather than by a word written here.
 */
export function hostEnv({ home, state, personHome = homedir(), appDir, cloud, binDir }) {
  const path = process.env["PATH"] ?? "/usr/bin:/bin";
  return {
    // A lab's own wsp leads the path where it has one, so a turn that shells out to wsp reaches the lab's host
    // rather than the person's.
    PATH: binDir === undefined ? path : `${binDir}:${path}`,
    HOME: home,
    WSP_HOME: join(home, ".wsp"),
    WSP_PROVIDER: providerFor(state),
    [PERSON_HOME_ENV]: personHome,
    ...(appDir === undefined ? {} : { [WEB_DIR_ENV]: appDir }),
    ...(personHome === home ? agentStores(home) : {}),
    ...(cloud === undefined || providerFor(state) !== "fake" ? {} : { [FAKE_AS_ENV]: cloud }),
  };
}

/** Every agent's store under one home, by the variable that agent reads it from: what a harness sets so a turn
 * reads the instructions, the MCP servers and the skills in that home and none of the person's. An agent whose
 * store follows HOME alone names no variable and is not here. */
export const agentStores = home => Object.fromEntries(CATALOG_AGENTS.flatMap(a => (a.stateHomeEnv == null ? [] : [[a.stateHomeEnv, join(home, a.stateHome)]])));

/** Starts the built wsp command on a throwaway home holding one fixture state, and answers once it serves. A
 * secret is handed to the child and never written into the environment this answers with: the lab records and
 * prints what it started the host with, and a key in that record would be a key in a log. */
export async function startHost({ home, state, port, wsPort, logPath, detached = false, personHome, appDir, cloud, binDir, secrets = {} }) {
  const statePath = join(home, ".wsp", "state.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const out = logPath === undefined ? "pipe" : openSync(logPath, "a");
  const env = hostEnv({ home, state, personHome, appDir, cloud, binDir });
  const child = spawn(process.execPath, [HOST_BIN, "up", "--state", statePath, "--port", String(port), "--ws-port", String(wsPort)], {
    cwd: home,
    env: { ...env, ...secrets },
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
