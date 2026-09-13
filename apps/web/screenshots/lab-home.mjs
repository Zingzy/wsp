// SPDX-License-Identifier: AGPL-3.0-only
// What a lab's home is made of, and the one place each part is written. A lab
// home is not a temp folder any more: it is a folder under the person's own
// home named after the persona, because two testers read a path under
// /var/folders as "a temp folder, not my repo" and stopped trusting what the
// app told them about their files.
//
// Five things live in it beyond the fixture state. A copy of the built app,
// which the host is pointed at, so a build landing on main while a tester
// drives cannot change the page under them. An agent home of the lab's own,
// signed in with the agents' key, carrying this lab's own wsp tools and none of
// this computer's other MCP servers and none of its skills: one tester's agent
// reached the person's real host through their own configuration and wrote a
// workspace record there, which is the one thing a lab may not do, and a turn
// with no wsp tools at all does not know it is inside wsp. A small repository
// for a turn to work in. A folder for the stand-in provider's own machines. And
// a wsp on the tester's path, bound to this lab, so nothing has to be pasted
// into a shell: a tester who wrote their own wrapper instead ran every verb
// against the person's own state file and keys.
import { CATALOG_AGENTS, hasLogin } from "@wsp/catalog";
import { MCP_SERVER_NAME, shellQuote, standInRecordsPath } from "@wsp/protocol";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { agentStoreRows, HOST_BIN, REPO, WEB_DIR } from "./host.mjs";

/** Where a lab's homes live, for a run that wants them somewhere else: a throwaway root for a dry run. */
export const LAB_ROOT_ENV = "WSP_LAB_ROOT";

/** The folder every lab home sits in: a plain folder on this computer, and never one inside the person's own home.
 * The agent reads the instruction file out of every .claude folder above the folder it runs in, so a lab home
 * under their home hands every tester's turn the person's own instructions, whatever the agent's store is set to
 * (measured 2026-09-12: the same turn read none from a home beside theirs). On a Mac that is the folder every
 * account shares, which a tester reads as a place on this computer rather than as the temp folder two of them
 * called "not my repo". */
export const labRoot = (env = process.env, platform = process.platform) => {
  const said = env[LAB_ROOT_ENV];
  if (said !== undefined && said !== "") return resolve(said);
  return platform === "darwin" ? "/Users/Shared/wsp-lab" : join(tmpdir(), "wsp-lab");
};

/** One lab's home, named after the lab rather than minted at random, so a later command in another process finds
 * it without being told where it is. */
export const labHome = (name, env = process.env, platform = process.platform) => join(labRoot(env, platform), name);

/** Where a stopped lab's log lands when the start was told no folder: one folder beside the homes, never the one
 * the start happened to be run from. All nine logs of a round landed in a folder nobody was reading, because that
 * is where the shell that started them stood. A lab named "logs" would collide with it, which no persona is. */
export const labLogs = (env = process.env, platform = process.platform) => join(labRoot(env, platform), "logs");

/** The variables an agent reads a key from, each declared once on its own sign-in row in the catalog: what a lab
 * looks for and hands the host, so an agent added to the catalog tomorrow is signed in here without this file
 * learning its name. */
export const AGENT_KEYS = CATALOG_AGENTS.flatMap(a => (hasLogin(a.signIn) && a.signIn.keyEnv !== undefined ? [a.signIn.keyEnv] : []));

/** A folder's contents as one hash: every file under it by relative path, in order, with its bytes. What a lab
 * records about the app it is serving, so two runs can be told apart by more than a commit that may have been
 * dirty. */
export function folderHash(dir) {
  const sum = createHash("sha256");
  const walk = at => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      sum.update(relative(dir, path));
      sum.update(readFileSync(path));
    }
  };
  walk(dir);
  return sum.digest("hex").slice(0, 16);
}

/** The checkout's own word for where it stands, for the record a lab keeps of what it served. */
export function treeSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** When the folder being copied was last written, to the second: the newest file in it. A build that landed while
 * a lab was starting is told from the one before it by this without anybody having to read a hash. */
export function builtAt(dir) {
  let newest = 0;
  const walk = at => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  walk(dir);
  return new Date(newest).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Why a start stops rather than serving what it copied: the folder moved under the copy. One run in a round of
 * nine served an app no other run served and nothing could say what it was, because the copy was taken while a
 * build was writing the folder. */
export const appMovedLine = (from, was, now) =>
  `${from} changed while it was being copied (${was}, then ${now}), so this lab would serve an app no other run can be told from. Wait for the build to finish and start the lab again.`;

/** Copies the built app into the lab's home and answers what it is, with a hash of the wsp command serving it
 * beside it. The host serves this copy rather than the checkout's dist folder: two of nine runs in one round
 * provably saw different apps, because a build landing mid-run rewrote the folder the host was reading from, and
 * no log could say which app a tester had met. The source is hashed on both sides of the copy and the copy itself
 * against them, since a build writing the folder mid-copy leaves a home nobody can name the app of. The command is
 * recorded rather than copied, since its bundle resolves its imports out of the checkout it was built in and would
 * find none beside a copy. */
export function copyApp(home, { from = join(WEB_DIR, "dist"), hash = folderHash, command = () => folderHash(dirname(HOST_BIN)) } = {}) {
  const was = hash(from);
  const dir = join(home, "app");
  cpSync(from, dir, { recursive: true });
  const copied = hash(dir);
  const now = hash(from);
  if (now !== was) throw new Error(appMovedLine(from, was, now));
  if (copied !== was) throw new Error(appMovedLine(from, was, copied));
  return { dir, hash: copied, command: command(), builtAt: builtAt(from) };
}

/** What an agent's store holds when a lab writes it: onboarding already answered, so a turn does not open with a
 * wizard, and no project, so no folder of the person's is remembered. */
const FIRST_RUN = { hasCompletedOnboarding: true, installMethod: "native", numStartups: 5 };

/** The wsp tools a turn in this lab has: this lab's own wsp, which carries this lab's host and nothing of the
 * person's in its own environment. A real Mac gets these from the first-run row, and without them a tester's agent
 * does not know it is inside wsp: one spent twelve minutes and $0.68 writing JSON-RPC by hand to find its own
 * threads, and an orchestrator fanned its work out through its harness's background agents rather than threads. */
export const labMcpServer = home => ({ command: join(binDir(home), "wsp"), args: ["mcp"] });

/** The file an agent reads its first-run answers and its own MCP servers out of when it has been pointed at a
 * store rather than left on a home: the catalog's own path for that file with the home taken off, and the agent's
 * own folder taken off too where the path goes through it, since the store is that folder. A different question
 * from the host's (`mcpConfigFile`, which resolves the same path against a home), so the answer is written here
 * and not borrowed from there. An agent whose config the catalog does not know gets the folder and nothing in it. */
const storeConfig = agent => {
  if (agent.mcp === undefined) return undefined;
  const under = agent.mcp.files[0].replace(/^~\//, "");
  return under.startsWith(`${agent.stateHome}/`) ? under.slice(agent.stateHome.length + 1) : under;
};

/** Every agent store a turn in this lab reads, made and filled where that agent looks for it: the store is the
 * folder the host points the agent at, not the home, so a file written beside the home is a file no agent opens
 * (measured 2026-09-12: the agent's own 38 KB file sat in the store while the lab's sat unread in the home). The
 * server is written by the agent's own config module, so a lab spells no agent's format a second time. */
export function writeAgentHome(home, server = labMcpServer(home)) {
  const written = [];
  for (const { agent, store } of agentStoreRows(home)) {
    mkdirSync(join(store, "skills"), { recursive: true });
    const name = storeConfig(agent);
    if (name === undefined) continue;
    const path = join(store, name);
    writeFileSync(path, agent.mcp.format.place(JSON.stringify(FIRST_RUN), MCP_SERVER_NAME, server).text);
    written.push(path);
  }
  return written;
}

/** The agents' keys for this lab, each out of the first layer that holds it: the shell the lab was started from,
 * the .env beside the checkout, then the person's own wsp home. A lab home is not the person's, so the sign-in
 * they made at a terminal does not reach a turn here, and a key is what signs this home in instead. A layer is a
 * function and is read only where the layers before it answered for nothing, so a lab started with the key in its
 * shell opens none of the person's files. */
export function keysFound(layers, names = AGENT_KEYS) {
  const found = {};
  for (const layer of layers) {
    if (names.every(name => found[name] !== undefined)) break;
    const held = typeof layer === "function" ? layer() : layer;
    for (const name of names) {
      const value = held?.[name];
      if (found[name] === undefined && typeof value === "string" && value.trim() !== "") found[name] = value.trim();
    }
  }
  return found;
}

/** Every layer a lab looks for those keys in, in order, each unread until it is reached. */
export function keyLayers(env = process.env, personHome = homedir()) {
  return [() => env, () => parseEnv(join(REPO, ".env")), () => parseEnv(join(personHome, ".wsp", ".env"))];
}

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap(line => {
          const m = line.match(/^([A-Z_]+)=(.*)$/);
          return m === null || m[2] === "" ? [] : [[m[1], m[2].trim()]];
        }),
    );
  } catch {
    return {};
  }
}

/** This lab's own .wsp, made readable by nobody else: the keys that sign its turns in sit in it, and so does the
 * stand-in's folder, so whichever of the two is written first is what decides the folder's mode. */
export const wspHome = home => {
  const dir = join(home, ".wsp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/** Writes those keys where this lab's own verbs read one: the .env beside its state, readable by nobody else.
 * Never into the lab's record or its log, which are written to be read and pasted. */
export function writeKeys(home, keys) {
  const path = join(wspHome(home), ".env");
  writeFileSync(
    path,
    `${Object.entries(keys)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  return path;
}

/** Where the stand-in a lab serves its forks through keeps its own machines, and what it holds before the host
 * comes up: every machine the fixture names, in the state that fixture says it sleeps or runs in, and the
 * snapshots its image says the account is paying for. Under the lab's .wsp, so its records and every machine's
 * folder go when the lab does, so a tester's command on a fork runs in a folder of the lab's and nowhere near the
 * person's own, and so the app's own folder picker never offers it: a tester opened Import and was shown a folder
 * called stand-in in what the app told them was their home. */
export const standInRoot = home => join(home, ".wsp", "stand-in");

export function writeStandIn(home, held) {
  wspHome(home);
  const path = standInRecordsPath(standInRoot(home));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(held, null, 2)}\n`);
  return path;
}

/** What a turn lands in: the work folder of this home, with a small repository at every folder the fixture says a
 * project was imported into, and one called notes where it names none. A turn starts in the project its workspace
 * has, so a fixture that names a folder nobody made leaves an agent in a folder that is not there, and a folder
 * of the person's own leaves it inside their repository. */
export function writeWorkFolder(home, folders = []) {
  const work = join(home, "wsp-work");
  mkdirSync(work, { recursive: true });
  const dests = folders.length > 0 ? folders : [join(work, "notes")];
  for (const dest of dests) smallRepo(dest);
  return { work, repos: dests };
}

/** One small repository: two short files and a commit, so a turn asked to write anything is in a folder a person
 * would recognise as a repository of their own. */
function smallRepo(dest) {
  mkdirSync(dest, { recursive: true });
  const name = dest.split("/").at(-1);
  writeFileSync(join(dest, "README.md"), `# ${name}\n\nA small repository to try things in.\n`);
  writeFileSync(join(dest, "todo.md"), "- [ ] try the thing\n");
  const git = args => execFileSync("git", args, { cwd: dest, stdio: "ignore" });
  try {
    if (!existsSync(join(dest, ".git"))) git(["init", "-q", "-b", "main"]);
    git(["-c", "user.name=notes", "-c", "user.email=notes@example.com", "add", "README.md", "todo.md"]);
    git(["-c", "user.name=notes", "-c", "user.email=notes@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `${name}: the first page`]);
  } catch {
    // A computer with no git still gets the folder and the files; the repository is the nicety, not the point.
  }
}

/** The line a lab's own wsp runs: the child's environment word for word, nothing of the tester's, and the lab's
 * home as the folder it runs in, so no .env beside a checkout is read and no state file but this lab's is found. */
export const labLine = facts =>
  `cd ${shellQuote(facts.home)} && exec env -i ${Object.entries(facts.env)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ")} ${shellQuote(facts.node)} ${shellQuote(facts.bin)} "$@"`;

/** The wsp a tester's shell finds on its path: a script in the lab's home running that line. A printed shell
 * function was not used by the one tester it was written for, who wrote their own wrapper and ran every verb on
 * the person's own state file, keys and provider. */
export const shimText = facts => `#!/bin/sh\n# This lab's wsp: every verb against this lab's host and nothing else.\n${labLine(facts)}\n`;

/** Writes that script and answers the folder to put on a tester's path. */
export function writeShim(home, facts) {
  const dir = binDir(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "wsp");
  writeFileSync(path, shimText(facts));
  chmodSync(path, 0o755);
  return path;
}

/** Where this lab's own wsp sits: first on the path a tester's shell is started with, and first on the host's, so
 * a turn that shells out to wsp reaches this lab rather than the person's own. */
export const binDir = home => join(home, "bin");
