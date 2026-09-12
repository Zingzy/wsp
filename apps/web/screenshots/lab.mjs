// SPDX-License-Identifier: AGPL-3.0-only
// A lab: one fixture's app, served and left running, for a tester who drives it
// by hand. It starts what the screenshot run starts, a throwaway home with a
// fixture state in it and the built wsp command serving the built app on two
// free ports, and then stays up instead of photographing anything and going.
//
//   node lab.mjs start <name> --fixture <fixture>
//   node lab.mjs stop <name>
//   node lab.mjs url <name>
//
// A lab's home is named after the lab, not minted at random, so a later command
// in another process finds it without being told where it is. The host's pid is
// written into that home and the stop reads it back: the only process this
// stops is the one this started, which matters on a computer where several
// builders and a person's own host are running at once.
//
// Nothing here touches the person's own ~/.wsp. HOME and WSP_HOME both point
// inside the lab's home, which is what keeps the host's current-home pointer
// out of theirs, and the provider is the one that answers out of memory, so a
// fixture's forks are served without a key and without dialling anything.
//
// A tester who lives in a terminal rather than the app runs no fixture of their
// own: the home in the line the start prints is their road. `wsp workspaces
// --state <home>/.wsp/state.json`, and every other verb the same way, reads the
// fixture the app is showing, so the two kinds of person meet one setup. That
// is why the line carries the home beside the address.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_NAMES, fixtureState } from "./fixture-state.mjs";
import { freePort, providerFor, sleep, startHost, whatIsNotBuilt } from "./host.mjs";

const USAGE = `usage: node lab.mjs start <name> [--fixture <fixture>]
       node lab.mjs stop <name>
       node lab.mjs url <name>

fixtures: ${FIXTURE_NAMES.join(", ")}`;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** How long a stopping lab is given to go on its own before it is killed. */
const GOODBYE_MS = 8_000;

function die(why) {
  console.error(`${why}\n\n${USAGE}`);
  process.exit(2);
}

const homeOf = name => join(tmpdir(), `wsp-lab-${name}`);
const pidsPath = home => join(home, "lab.pids");
const factsPath = home => join(home, "lab.json");
const logPath = home => join(home, "lab.log");

function parseArgs(argv) {
  const [verb, name, ...rest] = argv;
  if (verb === undefined) die("say start, stop or url");
  if (!["start", "stop", "url"].includes(verb)) die(`there is no ${verb} verb`);
  if (name === undefined) die(`${verb} needs the lab's name`);
  if (!NAME.test(name)) die(`a lab's name is lowercase words and dashes, not ${JSON.stringify(name)}`);
  const args = { verb, name, fixture: "mac-only" };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--") continue;
    if (rest[i] !== "--fixture") die(`unknown flag ${rest[i]}`);
    const value = rest[i + 1];
    if (value === undefined || !FIXTURE_NAMES.includes(value)) die(`--fixture takes one of ${FIXTURE_NAMES.join(", ")}`);
    args.fixture = value;
    i += 1;
  }
  if (args.verb !== "start" && rest.length > 0) die(`${args.verb} takes the lab's name and nothing else`);
  return args;
}

/** Whether a pid is a process this computer still holds. Signal 0 asks without sending anything; a pid that is not
 * ours at all answers EPERM, which is still a pid that exists. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** The pids this lab wrote down, each with the word for what it is. A file that is not there is a lab that is not
 * running, which is not an error to stop. */
function recordedPids(home) {
  if (!existsSync(pidsPath(home))) return [];
  return readFileSync(pidsPath(home), "utf8")
    .split("\n")
    .flatMap(line => {
      const [what, pid] = line.trim().split(/\s+/);
      const n = Number(pid);
      return what === undefined || what === "" || !Number.isInteger(n) ? [] : [{ what, pid: n }];
    });
}

function readFacts(home) {
  try {
    return JSON.parse(readFileSync(factsPath(home), "utf8"));
  } catch {
    return undefined;
  }
}

/** The line a lab prints when it comes up and when it is asked where it is, in one place so both say the same
 * thing and a tester's notes read alike whichever they ran. */
const labLine = facts => `lab ${facts.name} serving ${facts.url} pid ${facts.pid} home ${facts.home}`;

async function start({ name, fixture }) {
  const unbuilt = whatIsNotBuilt();
  if (unbuilt !== undefined) {
    console.error(unbuilt);
    process.exit(1);
  }
  const home = homeOf(name);
  const running = recordedPids(home).filter(p => alive(p.pid));
  if (running.length > 0) die(`the lab ${name} is already running as pid ${running.map(p => p.pid).join(", ")}; stop it first, or pick another name`);
  // A home left by a lab that is gone is a state file, a log and a pid file from the run before; the fixture this
  // run was asked for is what the tester is here to see, so nothing of the last one is kept.
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  const state = fixtureState(fixture);
  const port = await freePort();
  const host = await startHost({ home, state, port, wsPort: await freePort(), logPath: logPath(home), detached: true });
  // Detached and let go of: this process wrote the pid down and its job is over, so a tester's shell gets its
  // prompt back rather than holding a lab open for as long as they leave the window there.
  host.child.unref();
  const facts = { name, fixture, provider: providerFor(state), url: host.base, pid: host.child.pid, home, startedAt: new Date().toISOString() };
  writeFileSync(pidsPath(home), `host ${host.child.pid}\n`);
  writeFileSync(factsPath(home), `${JSON.stringify(facts, null, 2)}\n`);
  console.log(labLine(facts));
}

async function stop({ name }) {
  const home = homeOf(name);
  const pids = recordedPids(home);
  if (pids.length === 0) {
    console.log(`no lab called ${name} wrote a pid down; nothing to stop`);
    return;
  }
  const left = [];
  for (const { what, pid } of pids) {
    if (!alive(pid)) {
      console.log(`${what} ${pid} had already gone`);
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (e) {
      console.error(`${what} ${pid} would not take a SIGTERM: ${e.message}`);
    }
    left.push({ what, pid });
  }
  const deadline = Date.now() + GOODBYE_MS;
  while (Date.now() < deadline && left.some(p => alive(p.pid))) await sleep(200);
  for (const { what, pid } of left) {
    if (!alive(pid)) {
      console.log(`stopped ${what} ${pid}`);
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
      console.log(`killed ${what} ${pid} after ${GOODBYE_MS / 1000} s`);
    } catch (e) {
      console.error(`${what} ${pid} is still there: ${e.message}`);
    }
  }
  rmSync(home, { recursive: true, force: true });
  console.log(`the lab ${name} is down and ${home} is gone`);
}

function url({ name }) {
  const facts = readFacts(homeOf(name));
  if (facts === undefined) die(`no lab called ${name} is running`);
  console.log(labLine(facts));
}

const args = parseArgs(process.argv.slice(2));
if (args.verb === "url") url(args);
else {
  await (args.verb === "start" ? start(args) : stop(args)).catch(e => {
    console.error(`lab ${args.verb}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
