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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { fixtureState } from "./fixture-state.mjs";
import { BROWSER_ARGS, freePort, REPO, startHost, stopHost, WEB_DIR, whatIsNotBuilt } from "./host.mjs";
import { indexMarkdown, readSurfaces, shotPlan } from "./plan.mjs";
import { APP_UP } from "./ready.mjs";

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

/** The repo's own word for where it stands, so the index says which tree a reviewer is looking at. */
function treeFacts() {
  const git = args => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  try {
    return { sha: git(["rev-parse", "--short", "HEAD"]), branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) };
  } catch {
    return { sha: "an unknown commit", branch: "an unknown branch" };
  }
}

/** Where a paired browser keeps the token the host handed it, copied from `apps/web/src/protocol/pairing.ts`
 * (DEVICE_TOKEN_KEY): this file is plain node beside the app rather than inside its build, so it cannot import the
 * app's TypeScript, and a rename there is a rename here. */
const DEVICE_TOKEN_KEY = "wsp:device-token";

/** The host's own token, read out of the boot object it inlines into the page it serves. */
async function bootToken(base) {
  const html = await fetch(base).then(r => r.text());
  const boot = /window\.__WSP__ = (\{.*?\});/.exec(html);
  if (boot === null) throw new Error("the page the host served carries no boot object");
  const token = JSON.parse(boot[1]).token;
  if (typeof token !== "string") throw new Error("the host inlined no token, so no window can stand in for one on another computer");
  return token;
}

/** A context that reads as a window on another computer: the boot object the page is handed loses the host's own
 * token, which is what a page served beyond loopback carries, and the token is in this browser's store instead,
 * where a paired device keeps it. The boot object is taken as the page's own inline script sets it rather than by
 * rewriting the page: a fulfilled response puts the page in another address space and Chromium then blocks its
 * socket to loopback outright (measured 2026-09-12). Nothing in the app is told which window this is; it reads the
 * same boot object a real window on another computer reads. */
async function asAnotherComputer(context, token) {
  await context.addInitScript(
    ([key, held]) => {
      window.localStorage.setItem(key, held);
      let boot;
      Object.defineProperty(window, "__WSP__", {
        configurable: true,
        get: () => boot,
        set: value => {
          const { token: _own, ...rest } = value ?? {};
          boot = rest;
        },
      });
    },
    [DEVICE_TOKEN_KEY, token],
  );
}

/** The page's socket to the host, in this run's hands. It connects as it would until the function this returns is
 * called, which shuts it and leaves every redial unanswered: that is what a window sees the moment the computer
 * running wsp falls asleep, and it is not what Playwright's own offline mode does, which leaves an open socket
 * alone. */
async function holdSocket(page) {
  const open = [];
  let asleep = false;
  await page.routeWebSocket(/.*/, ws => {
    if (asleep) return ws.close();
    open.push(ws.connectToServer());
  });
  return () => {
    asleep = true;
    for (const server of open) server.close();
  };
}

/** One shot, in a browser that has never seen this app: the context is its own, so the sidebar width, the
 * chosen workspace and the right panel's last state are what a first launch has and not what the shot
 * before left behind. Sharing one context per width and theme is what hid the machine surface at 390,
 * where an earlier shot's remembered panel meant the launcher was never drawn. */
async function shoot(context, shot, base, out, token) {
  if (shot.remote) await asAnotherComputer(context, token);
  const page = await context.newPage();
  const fallAsleep = shot.steps.some(step => step.offline === true) ? await holdSocket(page) : undefined;
  await page.goto(`${base}${shot.at}`, { waitUntil: "domcontentloaded" });
  await page.locator(APP_UP).first().waitFor({ state: "visible", timeout: 30_000 });
  const dark = await page.locator("html").evaluate(el => el.classList.contains("dark"));
  if (dark !== (shot.theme === "dark")) throw new Error(`the page drew the ${dark ? "dark" : "light"} side under an emulated ${shot.theme} scheme; the theme no longer follows the computer, so this file would be wrong`);
  await page.waitForTimeout(shot.settleMs);
  for (const step of shot.steps) {
    // The socket going is the whole of "the computer running wsp fell asleep": nothing new arrives, nothing answers
    // the redial, and the window keeps every row it was last told about.
    if (step.offline === true) fallAsleep();
    else if (step.key !== undefined) await page.keyboard.press(step.key);
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
  const unbuilt = whatIsNotBuilt();
  if (unbuilt !== undefined) {
    console.error(unbuilt);
    process.exit(1);
  }

  mkdirSync(args.out, { recursive: true });
  // A file a later run misses would otherwise be reviewed from the earlier run's picture of it.
  for (const shot of shotPlan(list)) rmSync(join(args.out, shot.file), { force: true });
  const home = mkdtempSync(join(tmpdir(), "wsp-shots-"));
  let host;
  let browser;
  let token;
  const written = [];
  const failures = [];
  try {
    host = await startHost({ home, state: fixtureState(), port: await freePort(), wsPort: await freePort() });
    token = await bootToken(host.base);
    browser = await chromium.launch({ args: BROWSER_ARGS });
    for (const shot of shotPlan(list)) {
      let context;
      try {
        context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, colorScheme: shot.theme, deviceScaleFactor: 2, reducedMotion: "reduce" });
        await shoot(context, shot, host.base, args.out, token);
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
