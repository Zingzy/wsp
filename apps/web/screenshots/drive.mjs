// SPDX-License-Identifier: AGPL-3.0-only
// Hands for a tester: one browser command at a time, against a lab. Every run
// opens the session's own Chromium profile, does the one thing it was asked,
// says what changed on the page and exits, so a tester with no memory of the
// last command still carries on from where it left them.
//
//   node drive.mjs <session> goto <url>
//   node drive.mjs <session> click "<visible text>" | click attr=<name>
//   node drive.mjs <session> type "<visible label or attr>" "<text>"
//   node drive.mjs <session> press <key>
//   node drive.mjs <session> text
//   node drive.mjs <session> shot <file.png> [--width <px>]
//   node drive.mjs <session> wait "<visible text>" [ms]
//
// The profile holds the cookies and the local storage, which is where the app
// keeps the workspace a person picked and the shape of their window; the page
// itself does not survive, since the browser is closed at the end of every
// command, so the address is written down beside the profile and opened again
// at the start of the next one. What that costs is the state a page holds in
// memory alone: a menu left open closes between two commands, the way it would
// if the tester had reloaded the tab.
//
// This file stands where the browser vendor's own MCP server was planned, which
// would have held that page open between commands. The reason is whose computer
// this runs on: attaching that server to a tester's thread means editing the
// owner's MCP configuration on their Mac, and no tester touches that. A tester
// that loses an open menu is a cost the irritation logs will show, and the
// server can come in for a later round if held page state is what is missing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { BROWSER_ARGS } from "./host.mjs";
import { selectorFor } from "./plan.mjs";

const USAGE = `usage: node drive.mjs <session> goto <url>
       node drive.mjs <session> click "<visible text>"   (or: click attr=<name>, click attr=<name>=<value>)
       node drive.mjs <session> type "<visible label or attr>" "<text>"
       node drive.mjs <session> press <key>
       node drive.mjs <session> text
       node drive.mjs <session> shot <file.png> [--width <px>]
       node drive.mjs <session> wait "<visible text>" [ms]`;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** The window every session opens at: a laptop's, which is what the app lays out for by default. */
const SIZE = { width: 1280, height: 800 };
/** After an action, before the page is read: long enough for the app's own transition, which the stylesheet runs
 * on colours and on the panels' width. */
const SETTLE_MS = 500;
const WAIT_MS = 15_000;

function die(why) {
  console.error(`${why}\n\n${USAGE}`);
  process.exit(2);
}

const sessionDir = session => join(tmpdir(), `wsp-drive-${session}`);
const seenPath = session => join(sessionDir(session), "seen.json");

/** What the last command left: the address the page was at, the window it was read at, and the text it read, which
 * is what the next command's answer is a difference from. */
function readSeen(session) {
  try {
    return JSON.parse(readFileSync(seenPath(session), "utf8"));
  } catch {
    return { url: undefined, width: SIZE.width, text: "" };
  }
}

function parseArgs(argv) {
  const [session, verb, ...rest] = argv;
  if (session === undefined) die("the first word is the session's name");
  if (!NAME.test(session)) die(`a session's name is lowercase words and dashes, not ${JSON.stringify(session)}`);
  if (verb === undefined) die("say goto, click, type, press, text, shot or wait");
  const words = [];
  let width;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--width") {
      const value = Number(rest[i + 1]);
      if (!Number.isInteger(value) || value < 200) die("--width takes a whole number of pixels, 200 or more");
      width = value;
      i += 1;
    } else words.push(rest[i]);
  }
  return { session, verb, words, width };
}

/** The page as a tester reads it: its visible text with every line that is a control's own words in brackets, and
 * the data attributes those controls carry, which is what `click attr=` aims at. Read in the page, since what is
 * visible is what the browser laid out, never what the markup says. */
const READ_PAGE = () => {
  const CLICKABLE = 'button, a[href], summary, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [data-row-id], [data-surface-launch], [data-cloud-setup-row]';
  const shown = el => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  // What the component kit writes on everything it styles: a name here says how a control looks or what state it
  // is in, never which control it is, so listing them would bury the handful a tester can aim at.
  const STYLING = new Set(["slot", "size", "active", "pressed", "value", "scroll-anchor-ignore"]);
  const labels = new Set();
  const attrs = new Set();
  for (const el of document.querySelectorAll(CLICKABLE)) {
    if (!shown(el)) continue;
    const words = el.innerText ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "";
    // The first line alone: a row that carries its machine's size and its threads under its name would otherwise
    // mark every one of those lines as a thing to click, and only the name is what a tester would say.
    const named = words.split("\n").find(line => line.trim() !== "");
    if (named !== undefined) labels.add(named.trim());
    for (const attr of el.attributes) {
      const name = attr.name.startsWith("data-") ? attr.name.slice(5) : undefined;
      if (name === undefined || STYLING.has(name) || name.startsWith("base-ui-")) continue;
      attrs.add(attr.value === "" ? name : `${name}=${attr.value}`);
    }
  }
  const lines = (document.body.innerText ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "");
  return { text: lines.map(line => (labels.has(line) ? `[${line}]` : line)).join("\n"), attrs: [...attrs].sort() };
};

/** The lines one text has and the other does not, in the order they appear, as a longest common run tells them
 * apart: a page whose rows only moved reads as no change rather than as every line twice. */
export function diffLines(before, after) {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const same = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) same[i][j] = a[i] === b[j] ? same[i + 1][j + 1] + 1 : Math.max(same[i + 1][j], same[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (same[i + 1][j] >= same[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}

const marked = page => page.evaluate(READ_PAGE);

/** A word that names a data attribute rather than something on the page: `attr=row-id=ws:ws_api` is that attribute
 * at that value, `attr=cloud-setup-row` is the attribute being there at all. */
export const attrWord = word => (typeof word === "string" && word.startsWith("attr=") ? selectorFor(word.slice(5)) : undefined);

/** The first of several guesses that is on the page at all; nothing when none is. */
async function firstThere(guesses) {
  for (const guess of guesses) if ((await guess.count()) > 0) return guess.first();
  return undefined;
}

/** Opens an address and waits until the page has words on it: the app draws itself after the document is there, so
 * a page read the moment it loads reads nothing. The wait is for words rather than for a selector, since this
 * drives whatever a tester was given the address of. */
async function open(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (document.body?.innerText ?? "").trim() !== "", null, { timeout: WAIT_MS }).catch(() => {});
}

/** The thing a tester means by a word. A control whose name is exactly the word first, then a field by that label
 * or that placeholder, then any text on the page that reads it, so a word that names a row lands on the row and a
 * word that names half a sentence still lands on the sentence. */
async function findByWords(page, word) {
  const selector = attrWord(word);
  if (selector !== undefined) return page.locator(selector).first();
  return firstThere([
    page.getByRole("button", { name: word, exact: true }),
    page.getByRole("tab", { name: word, exact: true }),
    page.getByRole("link", { name: word, exact: true }),
    page.getByLabel(word, { exact: true }),
    page.getByPlaceholder(word, { exact: true }),
    page.getByText(word, { exact: true }),
    page.getByText(word),
  ]);
}

/** What a tester means by a field's words. A real field with that name first; then whatever reads those words, and
 * the writable thing it belongs to, since the app's composer draws its own prompt as a sibling of the editable
 * element rather than as an input's placeholder, and the words a tester can see are that sibling's. */
async function findField(page, word) {
  const selector = attrWord(word);
  if (selector !== undefined) return page.locator(selector).first();
  const named = await firstThere([page.getByRole("textbox", { name: word, exact: true }), page.getByLabel(word, { exact: true }), page.getByPlaceholder(word, { exact: true })]);
  if (named !== undefined) return named;
  const found = await findByWords(page, word);
  if (found === undefined) return undefined;
  const WRITABLE = "self::textarea or self::input or @contenteditable='true'";
  const near = await firstThere([found.locator(`xpath=ancestor-or-self::*[${WRITABLE}][1]`), found.locator(`xpath=ancestor::*[.//*[${WRITABLE}]][1]//*[${WRITABLE}]`)]);
  return near ?? found;
}

const missed = word => {
  console.error(`nothing on the page reads ${JSON.stringify(word)}; run text to see what does`);
  process.exit(1);
};

async function act({ verb, words, width }, page) {
  switch (verb) {
    case "goto": {
      const url = words[0];
      if (url === undefined) die("goto takes the address to open");
      await open(page, url);
      return { url };
    }
    case "click": {
      const word = words[0];
      if (word === undefined) die("click takes the words on the thing to click, or attr=<name>");
      const found = await findByWords(page, word);
      if (found === undefined) missed(word);
      await found.click({ timeout: WAIT_MS });
      return {};
    }
    case "type": {
      const [word, said] = words;
      if (word === undefined || said === undefined) die("type takes the field's words and then what to type into it");
      const found = await findField(page, word);
      if (found === undefined) missed(word);
      await found.fill(said, { timeout: WAIT_MS });
      return {};
    }
    case "press": {
      const key = words[0];
      if (key === undefined) die("press takes the key, as Enter, Escape or Control+K");
      await page.keyboard.press(key);
      return {};
    }
    case "wait": {
      const [word, ms] = words;
      if (word === undefined) die("wait takes the words to wait for");
      // A word that is not a number would reach the browser as a NaN bound, which waits for as long as the default
      // and says nothing about the typo; refused here the way a width is.
      if (ms !== undefined && (!Number.isInteger(Number(ms)) || Number(ms) < 1)) die(`wait takes a whole number of milliseconds, not ${JSON.stringify(ms)}`);
      // Never through findByWords: that one asks what is on the page now, and a wait is for words that are not.
      const selector = attrWord(word);
      const waiting = selector === undefined ? page.getByText(word).first() : page.locator(selector).first();
      await waiting.waitFor({ state: "visible", timeout: ms === undefined ? WAIT_MS : Number(ms) });
      return {};
    }
    case "text":
      return {};
    case "shot": {
      const file = words[0];
      if (file === undefined) die("shot takes the file to write");
      const path = resolve(file);
      mkdirSync(dirname(path), { recursive: true });
      if (width !== undefined) await page.setViewportSize({ width, height: SIZE.height });
      await page.screenshot({ path });
      return { shot: path, ...(width !== undefined ? { width } : {}) };
    }
    default:
      return die(`there is no ${verb} command`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seen = readSeen(args.session);
  const dir = sessionDir(args.session);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const width = args.width ?? seen.width ?? SIZE.width;
  const context = await chromium.launchPersistentContext(join(dir, "profile"), { viewport: { width, height: SIZE.height }, args: BROWSER_ARGS, reducedMotion: "reduce" });
  let done;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // The browser closed at the end of the last command, so the page is blank: the address it was left at is
    // opened again before anything is done to it, and the profile carries what the app remembered.
    if (args.verb !== "goto" && seen.url !== undefined && page.url() !== seen.url) await open(page, seen.url);
    if (args.verb !== "goto" && seen.url === undefined) {
      console.error("this session has not been anywhere yet; start it with goto <url>");
      process.exit(1);
    }
    done = await act(args, page);
    await page.waitForTimeout(SETTLE_MS);
    const read = await marked(page);
    writeFileSync(seenPath(args.session), `${JSON.stringify({ url: done.url ?? seen.url, width, text: read.text }, null, 2)}\n`);
    if (args.verb === "shot") console.log(done.shot);
    else if (args.verb === "text") console.log(`${read.text}\n\nclickable attributes: ${read.attrs.join(" ") || "none"}`);
    else {
      const changed = diffLines(seen.text, read.text);
      console.log(changed.length === 0 ? "the page reads the same" : changed.join("\n"));
    }
  } finally {
    await context.close();
  }
}

// Only when a tester ran this file: a test that reads the two rules above imports it, and an import must not
// open a browser.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(e => {
    console.error(`drive: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    process.exit(1);
  });
}
