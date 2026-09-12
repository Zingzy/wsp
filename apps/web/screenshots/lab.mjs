// SPDX-License-Identifier: AGPL-3.0-only
// A lab: one fixture's app, served and left running, for a tester who drives it
// by hand. It starts what the screenshot run starts, a throwaway home with a
// fixture state in it and the built wsp command serving the built app on two
// free ports, and then stays up instead of photographing anything and going.
//
//   node lab.mjs start <name> --fixture <fixture>
//   node lab.mjs stop <name> [--log <file>]
//   node lab.mjs url <name>
//
// A lab's home is named after the lab, not minted at random, so a later command
// in another process finds it without being told where it is, and it sits on
// this computer beside the person's home rather than in a temp folder, which
// two testers read as "not my repo". The home is pointed at from a file the
// name alone finds, so a stop run from a shell that names another root still
// reaches it. The host's pid is written into that home and the stop reads it
// back: the only process this stops is the one this started, which matters on a
// computer where several builders and a person's own host are running at once.
//
// Nothing here touches the person's own ~/.wsp. HOME and WSP_HOME both point
// inside the lab's home, which is what keeps the host's current-home pointer
// out of theirs, and the provider is the one that answers out of memory, so a
// fixture's forks are served without a key and without dialling anything.
//
// What a run served is written down: the commit the checkout stood on, a hash
// of the app as it was copied into the lab's home, which is the copy the host
// serves, and a hash of the wsp command serving it, which is the checkout's own
// since its bundle resolves its imports there. A build landing on main while a
// tester drives used to change the page under them, and no log could say which
// app they had met.
//
// A tester who lives in a terminal rather than the app runs no fixture of their
// own: this lab's wsp is on the path of the shell the start prints. It runs the
// child's own environment, word for word, from a shell with nothing else in it,
// because a wsp verb that runs under whatever the tester's terminal holds reads
// their own state file, their own provider key, and the .env beside whichever
// checkout they happen to stand in. A tester given a shell function to paste
// wrote their own wrapper instead and was told both the lab's machines were
// gone at the provider. The same lines are written into the lab's log and kept
// in lab.json, so what a run met can be read afterwards.
import { shellQuote } from "@wsp/protocol";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureCloud, fixtureFolders, FIXTURE_NAMES, fixtureState } from "./fixture-state.mjs";
import { freePort, HOST_BIN, providerFor, sleep, startHost, whatIsNotBuilt } from "./host.mjs";
import { AGENT_KEYS, binDir, copyApp, keyLayers, keysFound, labHome, treeSha, writeAgentHome, writeKeys, writeShim, writeWorkFolder } from "./lab-home.mjs";

const USAGE = `usage: node lab.mjs start <name> [--fixture <fixture>]
       node lab.mjs stop <name> [--log <file>]
       node lab.mjs url <name>

fixtures: ${FIXTURE_NAMES.join(", ")}`;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** How long a stopping lab is given to go on its own before it is killed. */
const GOODBYE_MS = 8_000;

function die(why) {
  console.error(`${why}\n\n${USAGE}`);
  process.exit(2);
}

/** Where a lab's name is looked up when nobody says: the pointer the start wrote, else the home the root this
 * shell names would give it. A lab started under one root and stopped from a shell that names another used to be
 * told there was nothing to stop, and its host stayed up; the pointer is what makes a recorded pid findable. */
export const homeOf = name => pointedHome(name) ?? labHome(name);
export const pointerPath = name => join(tmpdir(), `wsp-lab-${name}.json`);

function pointedHome(name) {
  try {
    const { home } = JSON.parse(readFileSync(pointerPath(name), "utf8"));
    return typeof home === "string" && existsSync(join(home, "lab.json")) ? home : undefined;
  } catch {
    return undefined;
  }
}

const pidsPath = home => join(home, "lab.pids");
const factsPath = home => join(home, "lab.json");
const logPath = home => join(home, "lab.log");

/** The flag each verb takes, and nothing else: a word this table does not hold is a typo rather than something to
 * carry through. */
const FLAGS = { start: "--fixture", stop: "--log" };

function parseArgs(argv) {
  const [verb, name, ...rest] = argv;
  if (verb === undefined) die("say start, stop or url");
  if (!["start", "stop", "url"].includes(verb)) die(`there is no ${verb} verb`);
  if (name === undefined) die(`${verb} needs the lab's name`);
  if (!NAME.test(name)) die(`a lab's name is lowercase words and dashes, not ${JSON.stringify(name)}`);
  const args = { verb, name, fixture: "mac-only" };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--") continue;
    if (rest[i] !== FLAGS[verb]) die(`${verb} takes the lab's name${FLAGS[verb] === undefined ? " and nothing else" : ` and ${FLAGS[verb]}`}, not ${rest[i]}`);
    const value = rest[i + 1];
    if (verb === "start") {
      if (value === undefined || !FIXTURE_NAMES.includes(value)) die(`--fixture takes one of ${FIXTURE_NAMES.join(", ")}`);
      args.fixture = value;
    } else {
      if (value === undefined || value.startsWith("--")) die("--log takes the file the lab's log is copied to");
      args.log = resolve(value);
    }
    i += 1;
  }
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

/** Why a folder standing where this lab's home goes is not this lab's to remove, or nothing when it is: a lab's
 * own home holds its record, and an empty folder is nobody's. A root named wrongly in a shell would otherwise
 * take a real folder with it, and the start removes what it finds before it writes. */
export function whyNotOursToRemove(home, holds = () => (existsSync(home) ? readdirSync(home) : undefined)) {
  const held = holds();
  if (held === undefined || held.length === 0 || held.includes("lab.json")) return undefined;
  return `${home} is not a lab of this harness (no lab.json in it) and it is not empty, so this start would delete a folder that is somebody's; pick another name, or another root.`;
}

/** What a lab says when it comes up and when it is asked where it is, in one place so both say the same thing and a
 * tester's notes read alike whichever they ran: where the app is, which build it is serving, what a turn there is
 * signed in with, and the shell whose wsp is this lab's. */
export const labLines = facts => [
  `lab ${facts.name} serving ${facts.url} pid ${facts.pid} home ${facts.home}`,
  `built from ${facts.build.sha}, app ${facts.build.app}, command ${facts.build.command}, served out of ${facts.build.appDir}`,
  facts.signedIn ? "turns run in this lab's own home, signed in with the agents' key, with no MCP server and no skill of this computer's" : `turns run in this lab's own home and none of ${AGENT_KEYS.join(", ")} was found, so an agent there answers that it is not logged in`,
  "a shell whose wsp is this lab's, carrying nothing of the tester's own:",
  `  ${labShell(facts)}`,
];

/** The shell a tester runs this lab's verbs from: nothing of their own in it, and this lab's wsp first on the
 * path, so `wsp doctor` is this lab's doctor with no wrapper to write and nothing to paste. */
const labShell = facts => `env -i HOME=${shellQuote(facts.home)} PATH=${shellQuote(facts.env.PATH)} TERM=xterm-256color /bin/sh`;

async function start({ name, fixture }) {
  const unbuilt = whatIsNotBuilt();
  if (unbuilt !== undefined) {
    console.error(unbuilt);
    process.exit(1);
  }
  const home = labHome(name);
  const running = recordedPids(home).filter(p => alive(p.pid));
  if (running.length > 0) die(`the lab ${name} is already running as pid ${running.map(p => p.pid).join(", ")}; stop it first, or pick another name`);
  const notALab = whyNotOursToRemove(home);
  if (notALab !== undefined) die(notALab);
  // A home left by a lab that is gone is a state file, a log and a pid file from the run before; the fixture this
  // run was asked for is what the tester is here to see, so nothing of the last one is kept.
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  // Every folder the fixture names is under this home, so a turn starts in a folder of the lab's rather than in
  // whatever the person keeps under the same name.
  const state = fixtureState(fixture, { home });
  // Everything a tester meets is written before the host comes up: the app it serves, the home its turns run in,
  // the folders those turns start in and the keys that sign them in.
  const app = copyApp(home);
  writeAgentHome(home);
  writeWorkFolder(home, fixtureFolders(state));
  const keys = keysFound(keyLayers());
  const key = Object.keys(keys).length > 0;
  if (key) writeKeys(home, keys);
  const cloud = fixtureCloud(fixture);
  const port = await freePort();
  const host = await startHost({
    home,
    state,
    port,
    wsPort: await freePort(),
    logPath: logPath(home),
    detached: true,
    // The lab's own home on both counts: the host's files and the home a turn's agent reads. What signs that agent
    // in is the key, which travels to the child alone and is never written into the record or the log.
    personHome: home,
    appDir: app.dir,
    binDir: binDir(home),
    ...(cloud === undefined ? {} : { cloud }),
    ...(key ? { secrets: keys } : {}),
  });
  // Detached and let go of: this process wrote the pid down and its job is over, so a tester's shell gets its
  // prompt back rather than holding a lab open for as long as they leave the window there.
  host.child.unref();
  const facts = {
    name,
    fixture,
    provider: providerFor(state),
    ...(cloud === undefined ? {} : { cloud }),
    url: host.base,
    pid: host.child.pid,
    home,
    node: process.execPath,
    bin: HOST_BIN,
    env: host.env,
    build: { sha: treeSha(), app: app.hash, command: app.command, appDir: app.dir },
    signedIn: key,
    startedAt: new Date().toISOString(),
  };
  writeShim(home, facts);
  writeFileSync(pidsPath(home), `host ${host.child.pid}\n`);
  writeFileSync(factsPath(home), `${JSON.stringify(facts, null, 2)}\n`);
  // Where a later command finds this lab whatever its own shell says the root is.
  writeFileSync(pointerPath(name), `${JSON.stringify({ home }, null, 2)}\n`);
  const lines = labLines(facts);
  // Into the log as well as onto the screen: the log is what is kept when the lab is stopped, and what a run met
  // cannot be worked out afterwards from the host's own lines alone.
  appendFileSync(logPath(home), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

/** Where a stopped lab's log is kept: the file the tester named, else one beside them in the folder they ran the
 * stop from. The home goes with the lab, and the host's side of a send that died is only in that log. */
export const keptLog = (name, said) => said ?? resolve(process.cwd(), `${name}-lab.log`);

async function stop({ name, log }) {
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
  rmSync(pointerPath(name), { force: true });
  const kept = keptLog(name, log);
  if (existsSync(logPath(home))) {
    mkdirSync(dirname(kept), { recursive: true });
    copyFileSync(logPath(home), kept);
    console.log(`the lab's log is at ${kept}`);
  }
  rmSync(home, { recursive: true, force: true });
  console.log(`the lab ${name} is down and ${home} is gone`);
}

function url({ name }) {
  const facts = readFacts(homeOf(name));
  if (facts === undefined) die(`no lab called ${name} is running`);
  console.log(labLines(facts).join("\n"));
}

// Only when a tester ran this file: a test that reads the lines a lab prints imports it, and an import must not
// start a host.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.verb === "url") url(args);
  else {
    await (args.verb === "start" ? start(args) : stop(args)).catch(e => {
      console.error(`lab ${args.verb}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
  }
}
