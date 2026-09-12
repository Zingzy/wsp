// SPDX-License-Identifier: AGPL-3.0-only
// Photographs the built web app against a real host, so a design review reads
// the app a person meets rather than a fixture page. A run makes a throwaway
// home, serves a fixture state out of it with the built wsp command on two free
// ports, drives Chromium over the surfaces list and leaves a folder of PNGs and
// an index.md. It never reads or writes the person's own ~/.wsp: HOME and
// WSP_HOME both point into the temp folder, which is what keeps the host's own
// current-home pointer out of it.
//
// Themes are emulated as the computer's colour scheme rather than written onto
// the root: with labs off the app's theme preference is `system`, so the scheme
// is the only thing that flips the `dark` class the stylesheet reads. Every shot
// checks the class once the app is up, so a theme that stopped following the
// scheme fails the run instead of shipping two identical files.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { fixtureState } from "./fixture-state.mjs";
import { indexMarkdown, readSurfaces, shotPlan } from "./plan.mjs";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(WEB_DIR, "..", "..");
const HOST_BIN = join(REPO, "packages", "host", "dist", "bin.js");
const APP_PAGE = join(WEB_DIR, "dist", "index.html");

// Chromium's shared memory files land on the root disk, and one uncapped render
// filled it to ENOSPC under other work on this machine (measured 2026-09-08);
// low-end device mode caps the tile and image budgets that grow them.
const BROWSER_ARGS = ["--enable-low-end-device-mode"];

function usage(why) {
  console.error(`${why}\n\nusage: pnpm --filter @wsp/web screenshots -- --out <folder> [--surfaces <file.json>]`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { surfaces: join(WEB_DIR, "screenshots", "surfaces.json") };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    // pnpm hands the separator through to the script; it is not a flag.
    if (flag === "--") continue;
    if (flag === "--out" || flag === "--surfaces") {
      if (value === undefined || value.startsWith("--")) usage(`${flag} needs a path`);
      args[flag.slice(2)] = resolve(value);
      i += 1;
    } else usage(`unknown flag ${flag}`);
  }
  if (args.out === undefined) usage("--out names the folder the files land in");
  return args;
}

const freePort = () =>
  new Promise((ok, no) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address !== null ? ok(address.port) : no(new Error("no port"))));
    });
  });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The repo's own word for where it stands, so the index says which tree a reviewer is looking at. */
function treeFacts() {
  const git = args => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  try {
    return { sha: git(["rev-parse", "--short", "HEAD"]), branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) };
  } catch {
    return { sha: "an unknown commit", branch: "an unknown branch" };
  }
}

async function startHost(home, port, wsPort) {
  const statePath = join(home, ".wsp", "state.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(fixtureState(), null, 2));
  // A bare environment, not this shell's: a Solari key or a WSP_PROVIDER word in the terminal would
  // put the run on a real provider, and a stray WSP_HOME would take it to the person's own machines.
  const child = spawn(process.execPath, [HOST_BIN, "up", "--state", statePath, "--port", String(port), "--ws-port", String(wsPort)], {
    cwd: home,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, WSP_HOME: join(home, ".wsp") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", d => log.push(String(d)));
  child.stderr.on("data", d => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the host exited with ${child.exitCode} before it served:\n${log.join("")}`);
    const served = await fetch(base).then(r => r.ok, () => false);
    if (served) return { child, base, log };
    await sleep(200);
  }
  child.kill("SIGTERM");
  throw new Error(`the host did not serve ${base} in 30 s:\n${log.join("")}`);
}

/** SIGTERM to the pid this run started, and nothing else: four builders share this machine and a host
 * found by port or by name is as likely to be somebody else's. */
async function stopHost(host) {
  if (host === undefined || host.child.exitCode !== null) return;
  const ended = new Promise(r => host.child.once("exit", r));
  host.child.kill("SIGTERM");
  const gaveUp = await Promise.race([ended.then(() => false), sleep(8_000).then(() => true)]);
  if (gaveUp) {
    host.child.kill("SIGKILL");
    await ended;
  }
}

/** The app is up once its centre column is on the page: the socket has answered and the store has
 * rendered. A step taken before that is a click at a shell that is not there yet, and at 390 the right
 * panel opens over the whole window part way through, which swallowed the first click of every narrow
 * shot until this gate went in. */
const APP_UP = "[data-shell-center]";

/** One shot, in a browser that has never seen this app: the context is its own, so the sidebar width, the
 * chosen workspace and the right panel's last state are what a first launch has and not what the shot
 * before left behind. Sharing one context per width and theme is what hid the machine surface at 390,
 * where an earlier shot's remembered panel meant the launcher was never drawn. */
async function shoot(context, shot, base, out) {
  const page = await context.newPage();
  await page.goto(`${base}${shot.at}`, { waitUntil: "domcontentloaded" });
  await page.locator(APP_UP).first().waitFor({ state: "visible", timeout: 30_000 });
  const dark = await page.locator("html").evaluate(el => el.classList.contains("dark"));
  if (dark !== (shot.theme === "dark")) throw new Error(`the page drew the ${dark ? "dark" : "light"} side under an emulated ${shot.theme} scheme; the theme no longer follows the computer, so this file would be wrong`);
  await page.waitForTimeout(shot.settleMs);
  for (const step of shot.steps) {
    if (step.key !== undefined) await page.keyboard.press(step.key);
    else await page.locator(step.click).first().click({ timeout: 15_000 });
  }
  if (shot.wait !== undefined) await page.locator(shot.wait).first().waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(shot.settleMs);
  // A click leaves its control focused and the ring would be the one thing the eye goes to.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.screenshot({ path: join(out, shot.file) });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = readSurfaces(JSON.parse(readFileSync(args.surfaces, "utf8")));
  for (const [what, path, how] of [
    ["the web app", APP_PAGE, "pnpm --filter @wsp/web build"],
    ["the wsp command", HOST_BIN, "pnpm --filter @wsp/host build"],
  ]) {
    if (existsSync(path)) continue;
    console.error(`${what} is not built: ${path} is missing. Run ${how} first, or use the coordinator's screenshots.sh, which builds.`);
    process.exit(1);
  }

  mkdirSync(args.out, { recursive: true });
  // A file a later run misses would otherwise be reviewed from the earlier run's picture of it.
  for (const shot of shotPlan(list)) rmSync(join(args.out, shot.file), { force: true });
  const home = mkdtempSync(join(tmpdir(), "wsp-shots-"));
  let host;
  let browser;
  const written = [];
  const failures = [];
  try {
    host = await startHost(home, await freePort(), await freePort());
    browser = await chromium.launch({ args: BROWSER_ARGS });
    for (const shot of shotPlan(list)) {
      let context;
      try {
        context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, colorScheme: shot.theme, deviceScaleFactor: 2, reducedMotion: "reduce" });
        await shoot(context, shot, host.base, args.out);
        written.push(shot.file);
        console.log(`wrote ${shot.file}`);
      } catch (e) {
        const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
        failures.push(`${shot.file}: ${why}`);
        console.error(`missed ${shot.file}: ${why}`);
      } finally {
        await context?.close();
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    await stopHost(host);
    rmSync(home, { recursive: true, force: true });
  }

  const facts = treeFacts();
  writeFileSync(join(args.out, "index.md"), `${indexMarkdown(list, written, { ...facts, at: new Date().toISOString() })}\n`);
  console.log(`${written.length} of ${shotPlan(list).length} files in ${args.out}`);
  if (failures.length > 0) {
    console.error(`${failures.length} surfaces were not photographed:\n${failures.map(f => `  ${f}`).join("\n")}`);
    process.exit(1);
  }
}

await main().catch(e => {
  console.error(`screenshots: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
