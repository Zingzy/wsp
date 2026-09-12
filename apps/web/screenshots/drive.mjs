// SPDX-License-Identifier: AGPL-3.0-only
// Hands for a tester: one browser command at a time, against a lab. Every run
// attaches to the session's own window, does the one thing it was asked, says
// what changed on the page and lets go, so a tester with no memory of the last
// command carries on from exactly where it left them.
//
//   node drive.mjs <session> goto <url>
//   node drive.mjs <session> click "<visible text>" | click attr=<name>
//   node drive.mjs <session> type "<visible label or attr>" "<text>"
//   node drive.mjs <session> press <key>
//   node drive.mjs <session> text
//   node drive.mjs <session> shot <file.png> [--width <px>]
//   node drive.mjs <session> wait "<visible text>" [ms]
//   node drive.mjs <session> quit
//   ... then <verb> ...   several of the above in one browser life
//
// A wait is for words the page has not said yet, and the draft a tester typed,
// the name the app gives their new thread and their own message in the
// transcript are not the page saying anything: a wait on a word out of the task
// just sent returns when the answer holds it, not when the echo does.
//
// The browser stays up between commands. It is started once, detached, with a
// debugging port of its own written down beside the session's profile, and
// every later command attaches to that same window and leaves it running; the
// page, and with it a menu, a dialog or a picker left open, is there for the
// next command the way it would be for a person who never closed the tab.
// Nine screens were lost in one round to a browser that closed at the end of
// every command, each of them a menu or a dialog that went before its own
// shot, and the testers who lost them had chained no steps. Steps still chain
// with the word then, which is what keeps one screen through a whole sequence.
// `quit` closes the window, by the pid the command that started it wrote down;
// nothing else closes it, so a session left open outlives the lab it drove.
//
// Attaching rather than launching through the driver is what keeps the window
// alive: a browser the driver started goes when the process that started it
// does, whatever is left unclosed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { BROWSER_ARGS, freePort, sleep } from "./host.mjs";
import { selectorFor } from "./plan.mjs";
import { NOT_READY_LINE, PROMPT_ECHOES, whenReady } from "./ready.mjs";

const USAGE = `usage: node drive.mjs <session> goto <url>
       node drive.mjs <session> click "<visible text>"   (or: click attr=<name>, click attr=<name>=<value>)
       node drive.mjs <session> type "<visible label or attr>" "<text>"
       node drive.mjs <session> press <key>
       node drive.mjs <session> text
       node drive.mjs <session> shot <file.png> [--width <px>]
       node drive.mjs <session> wait "<visible text>" [ms]   (never the words you typed coming back)
       node drive.mjs <session> quit   (closes this session's window)

       steps join with the word then, and run in one browser life:
       node drive.mjs <session> click "New workspace" then shot new-workspace.png`;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** The window every session opens at: a laptop's, which is what the app lays out for by default. */
const SIZE = { width: 1280, height: 800 };
/** After an action, before the page is read: long enough for the app's own transitions to land. Half a second
 * photographed a panel picker mid-open, its heading drawn behind its own cards, a frame no state of the app has,
 * and a reviewer spent a round deciding whether it was a layout fault. */
const SETTLE_MS = 1_200;
const WAIT_MS = 15_000;
/** How long a window started by this command is given to open its debugging port before the command gives up. */
const BROWSER_UP_MS = 20_000;

function die(why) {
  console.error(`${why}\n\n${USAGE}`);
  process.exit(2);
}

const sessionDir = session => join(tmpdir(), `wsp-drive-${session}`);
const seenPath = session => join(sessionDir(session), "seen.json");
const windowPath = session => join(sessionDir(session), "window.json");

/** The window this session is holding open, as the command that started it wrote it down: the port it listens for
 * a driver on and the pid it runs as. Nothing when this session has no window, which is its first command and
 * every command after a quit. */
function heldWindow(session) {
  try {
    return JSON.parse(readFileSync(windowPath(session), "utf8"));
  } catch {
    return undefined;
  }
}

/** Whether that window is still there to attach to. Its own port is the question, not its pid: a pid answers for
 * as long as the process exists, and a browser shutting down is one that no longer takes a driver. */
const answering = async port => fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok, () => false);

/** Starts the session's window and leaves it running, with the profile this session has always used. Detached and
 * unreferenced on purpose: the window outlives the command that started it, which is the whole of holding a page
 * between two commands, and the pid is written down so the only window anything here stops is this one. */
async function openWindow(session) {
  const dir = sessionDir(session);
  const port = await freePort();
  const child = spawn(
    chromium.executablePath(),
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(dir, "profile")}`,
      `--window-size=${SIZE.width},${SIZE.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--force-prefers-reduced-motion",
      ...BROWSER_ARGS,
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const deadline = Date.now() + BROWSER_UP_MS;
  while (Date.now() < deadline) {
    if (await answering(port)) {
      writeFileSync(windowPath(session), `${JSON.stringify({ port, pid: child.pid }, null, 2)}\n`);
      return { port, pid: child.pid, fresh: true };
    }
    await sleep(200);
  }
  child.kill("SIGTERM");
  throw new Error(`this session's browser did not open a driver port in ${BROWSER_UP_MS / 1000} s`);
}

/** The window to drive: the one this session left open, else a new one. `fresh` says which, since a command whose
 * first step is a key press has nothing focused to press into on a window that has just opened. */
async function windowFor(session) {
  const held = heldWindow(session);
  if (held !== undefined && (await answering(held.port))) return { ...held, fresh: false };
  return openWindow(session);
}

/** Closes the window this session wrote down, by the pid it wrote down and nothing else: several sessions and
 * several people's own browsers run on this computer, and a window found by name or by port is as likely to be
 * somebody else's. */
function closeWindow(session) {
  const held = heldWindow(session);
  rmSync(windowPath(session), { force: true });
  if (held?.pid === undefined) return "this session had no window open";
  try {
    process.kill(held.pid, "SIGTERM");
  } catch {
    return `this session's window (pid ${held.pid}) had already gone`;
  }
  return `closed this session's window (pid ${held.pid})`;
}

/** What the last command left: the address the page was at, the window it was read at, and the text it read, which
 * is what the next command's answer is a difference from. */
function readSeen(session) {
  try {
    return JSON.parse(readFileSync(seenPath(session), "utf8"));
  } catch {
    return { url: undefined, width: SIZE.width, text: "" };
  }
}

/** What joins two steps of one command. A word rather than a punctuation mark, since every mark a shell leaves
 * alone is also something a page says, and a tester writes what they would say out loud. It breaks a command only
 * where a verb follows it, so `click then` still clicks the word a menu shows. */
const STEP_BREAK = "then";
const VERBS = ["goto", "click", "type", "press", "text", "shot", "wait", "quit"];

/** The field a key press lands in, when an earlier step of the same command typed into one: the browser leaves the
 * focus where the last click or fill put it, but a page that redrew between two steps takes it back, and the
 * composer's editor is focused by the app only on a thread that has never run. Two testers pressed Enter into a
 * composer holding their own words and watched nothing happen. Nothing when no earlier step typed. */
export function typedField(steps, at) {
  for (let i = at - 1; i >= 0; i -= 1) {
    if (steps[i].verb === "type") return steps[i].words[0];
    if (steps[i].verb === "goto") return undefined;
  }
  return undefined;
}

/** What a press is told when it is the first step on a window that has only just opened: nothing on the page is
 * focused yet, so the key would go nowhere and read as the app ignoring it. */
export const PRESS_NEEDS_FOCUS = "a key press needs something focused, and this window has only just opened: click or type first, or chain the press onto that step with then";

/** One step's verb and words, from the words between two breaks. */
function oneStep(words) {
  const [verb, ...rest] = words;
  if (verb === undefined) die(`${STEP_BREAK} takes a step after it: say ${VERBS.join(", ")}`);
  if (!VERBS.includes(verb)) die(`there is no ${verb} command`);
  const said = [];
  let width;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--width") {
      const value = Number(rest[i + 1]);
      if (!Number.isInteger(value) || value < 200) die("--width takes a whole number of pixels, 200 or more");
      width = value;
      i += 1;
    } else said.push(rest[i]);
  }
  return { verb, words: said, ...(width === undefined ? {} : { width }) };
}

/** The session and the steps a command line asks for, in order. The break word is read where a verb would be and
 * nowhere else, so a page's own "then" is still something to click or type. */
export function parseArgs(argv) {
  const [session, ...rest] = argv;
  if (session === undefined) die("the first word is the session's name");
  if (!NAME.test(session)) die(`a session's name is lowercase words and dashes, not ${JSON.stringify(session)}`);
  if (rest.length === 0) die("say goto, click, type, press, text, shot or wait");
  const parts = [[]];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === STEP_BREAK && VERBS.includes(rest[i + 1])) parts.push([]);
    else parts.at(-1).push(rest[i]);
  }
  return { session, steps: parts.map(oneStep) };
}

/** How a step is written back to the tester when a command holds more than one, so each answer sits under the step
 * it came from. */
const stepLine = step => `> ${[step.verb, ...step.words].join(" ")}`;

/** The page as a tester reads it: its visible text with every line that is a control's own words in brackets, and
 * the data attributes those controls carry, which is what `click attr=` aims at. Read in the page, since what is
 * visible is what the browser laid out, never what the markup says. */
export const READ_PAGE = () => {
  const CLICKABLE = 'button, a[href], summary, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [data-row-id], [data-surface-launch], [data-cloud-setup-row]';
  const shown = el => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  // The name a person would call a control by, which is the name the browser gives it too: its own words where it
  // has any, else what it is labelled. An icon button's words are the empty string rather than nothing, so a
  // reading that only fell through on null never reached the label, and a tester was left with a + to describe.
  // The first line alone: a row that carries its machine's size and its threads under its name would otherwise
  // mark every one of those lines as a thing to click.
  const nameOf = el => {
    const own = (el.innerText ?? "").split("\n").find(line => line.trim() !== "");
    if (own !== undefined) return own.trim();
    for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
      const said = el.getAttribute(attr);
      if (said !== null && said.trim() !== "") return said.trim();
    }
    return undefined;
  };
  // What the component kit writes on everything it styles: a name here says how a control looks or what state it
  // is in, never which control it is, so listing them would bury the handful a tester can aim at.
  const STYLING = new Set(["slot", "size", "active", "pressed", "value", "scroll-anchor-ignore"]);
  const labels = new Set();
  const attrs = new Set();
  for (const el of document.querySelectorAll(CLICKABLE)) {
    if (!shown(el)) continue;
    const named = nameOf(el);
    if (named !== undefined) labels.add(named);
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
  const written = new Set(lines);
  // A control whose name is nowhere in the page's own words gets a line of its own at the foot, since a tester who
  // cannot read a name cannot say it, and these are the ones they most often want: the + that opens a workspace,
  // the arrow that sends a message.
  const silent = [...labels].filter(name => !written.has(name));
  const foot = silent.length === 0 ? [] : ["controls with no words of their own:", ...silent.map(name => `[${name}]`)];
  return { text: [...lines.map(line => (labels.has(line) ? `[${line}]` : line)), ...foot].join("\n"), attrs: [...attrs].sort() };
};

/** Whether the page says a word somewhere that is not the tester's own words coming back at them. Read in the
 * page, over its text as a reader meets it, skipping anything inside the places a prompt is echoed: a tester who
 * waits for a word out of the task they sent is waiting for the answer, and the thread the app names after their
 * prompt would otherwise satisfy that wait while the turn was still working. */
export const SAID_ON_THE_PAGE = ([word, echoes]) => {
  const echoed = [...echoes].flatMap(mark => [...document.querySelectorAll(mark)]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node.textContent ?? "").includes(word)) continue;
    let at = node.parentElement;
    while (at !== null && !echoed.includes(at)) at = at.parentElement;
    if (at === null) return true;
  }
  return false;
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

/** Every guess a tester's word is looked up through, in order. The last one is the loose one, and several things
 * reading it is the page drawing a line inside another line rather than two things to choose between; every guess
 * above it names one control, so two of them is a word the driver cannot choose by. */
const GUESSES = [
  (page, word) => page.getByRole("button", { name: word, exact: true }),
  (page, word) => page.getByRole("tab", { name: word, exact: true }),
  (page, word) => page.getByRole("link", { name: word, exact: true }),
  (page, word) => page.getByLabel(word, { exact: true }),
  (page, word) => page.getByText(word, { exact: true }),
  (page, word) => page.getByText(word),
];
const LOOSE = GUESSES.length - 1;

/** Which guess a word lands on and how many things read it there; nothing when none of them reads it. Only what a
 * tester can see counts: a word by role is already read off the tree a screen reader walks, which hidden elements
 * are not in, but a word by text matches an element the page has laid nowhere, so a word drawn once on the screen
 * and once under a closed panel would be refused as two things while the page read lists one. */
async function whereItLands(page, word) {
  for (const [at, guessing] of GUESSES.entries()) {
    const guess = guessing(page, word).filter({ visible: true });
    const count = await guess.count();
    if (count > 0) return { guess, count, at };
  }
  return undefined;
}

/** What a click is told when the word it was given reads on more than one control, or nothing when it reads on
 * one. The driver used to take the first of them, and a tester whose word read both the Remove in a row's menu
 * and the Remove in the row's own detail watched the click time out with nothing on the screen to explain it. */
export const SEVERAL_READ = (word, count) =>
  `${count} things on the page read ${JSON.stringify(word)}; say which: run text and click one of the attributes it lists, as click attr=<name>. If one of them is under a menu an earlier command left open, press Escape first.`;

/** That refusal for one word on one page, or nothing when the word aims at one thing. */
export async function whyNotOne(page, word) {
  if (attrWord(word) !== undefined) return undefined;
  const landed = await whereItLands(page, word);
  return landed === undefined || landed.count < 2 || landed.at === LOOSE ? undefined : SEVERAL_READ(word, landed.count);
}

/** What a click is told when the thing it aimed at is there and would not take the click: the page keeps whatever
 * the last command left open, which is what puts a menu over the next target. */
export const UNDER_AN_OPEN_MENU = word => `${JSON.stringify(word)} is on the page and would not take the click: a menu an earlier command left open is over it. Escape first: press Escape then click ${JSON.stringify(word)}`;

/** What stands open over a page: a menu or a picker the last command left behind. A dialog is not one of them, and
 * neither is anything else: a tester clicking inside a dialog is clicking the thing they opened, and telling them
 * to close it would be telling them to leave. */
export const OPEN_OVER_THE_PAGE = '[role="menu"], [role="listbox"]';

/** Whether one of those is standing open. */
export const openMenu = async page => (await page.locator(OPEN_OVER_THE_PAGE).count()) > 0;

/** What a click that would not land is told, or nothing when the page has no answer for it: a target that is there
 * and will not take a click with a menu standing open is under that menu. Anything else is the driver's own
 * failure and travels whole, since a sentence guessed at one would send a tester chasing a menu nobody opened. */
export async function whyNotClicked(page, word) {
  return (await openMenu(page)) ? UNDER_AN_OPEN_MENU(word) : undefined;
}

/** Opens an address and waits until the page has words on it: the app draws itself after the document is there, so
 * a page read the moment it loads reads nothing. The wait is for words rather than for a selector, since this
 * drives whatever a tester was given the address of. */
async function open(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (document.body?.innerText ?? "").trim() !== "", null, { timeout: WAIT_MS }).catch(() => {});
}

/** The thing a tester means by a word. A control whose name is exactly the word first, then a field by that label,
 * then any text on the page that reads it, so a word that names a row lands on the row and a word that names half
 * a sentence still lands on the sentence.
 *
 * A field's ghost is not here. It is not a thing on the page: it is the example a field shows while it is empty,
 * and it goes the moment anything is typed. A tester read the example path in the folder picker's field as the
 * folder itself, clicked it three times and wrote the picker off as broken. Typing still finds a field by it, in
 * findField below, which is the one place the ghost means anything. */
export async function findByWords(page, word) {
  const selector = attrWord(word);
  if (selector !== undefined) return page.locator(selector).first();
  return (await whereItLands(page, word))?.guess.first();
}

/** What a click is told when the only thing reading its words is a field's ghost: the words are an example, not
 * something to press, and the field they belong to is typed into. */
export const GHOST_IS_NOT_A_CONTROL = word =>
  `${JSON.stringify(word)} is a field's own example of what to type, not something on the page to click; type into that field instead: type ${JSON.stringify(word)} '<what you want there>'`;

/** What a tester means by a field's words. A real field with that name first; then whatever reads those words, and
 * the writable thing it belongs to, since the app's composer draws its own prompt as a sibling of the editable
 * element rather than as an input's placeholder, and the words a tester can see are that sibling's. */
export async function findField(page, word) {
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

const missed = (word, instead) => {
  console.error(instead ?? `nothing on the page reads ${JSON.stringify(word)}; run text to see what does`);
  process.exit(1);
};

async function act({ verb, words, width, focus }, page) {
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
      if (found === undefined) missed(word, (await page.getByPlaceholder(word, { exact: true }).count()) > 0 ? GHOST_IS_NOT_A_CONTROL(word) : undefined);
      const several = await whyNotOne(page, word);
      if (several !== undefined) missed(word, several);
      try {
        await found.click({ timeout: WAIT_MS });
      } catch (e) {
        const covered = await whyNotClicked(page, word);
        if (covered !== undefined) missed(word, covered);
        throw e;
      }
      return {};
    }
    case "type": {
      const [word, said] = words;
      if (word === undefined || said === undefined) die("type takes the field's words and then what to type into it");
      const found = await findField(page, word);
      if (found === undefined) missed(word);
      // The element itself, taken before it is filled, not the words it was found by: a composer holding a draft
      // no longer reads the prompt it was empty under, so the same words looked up after the fill find nothing,
      // and a key press meant for that field would land wherever the page left the focus.
      const field = await found.elementHandle({ timeout: WAIT_MS });
      await field.fill(said, { timeout: WAIT_MS });
      return { field };
    }
    case "press": {
      const key = words[0];
      if (key === undefined) die("press takes the key, as Enter, Escape or Control+K");
      // Into the field this command typed into, where it typed into one: the key belongs to those words, and a
      // redraw between the two steps would otherwise have taken the focus off them.
      if (focus !== null && focus !== undefined) await focus.focus();
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
      const timeout = ms === undefined ? WAIT_MS : Number(ms);
      const selector = attrWord(word);
      if (selector !== undefined) {
        await page.locator(selector).first().waitFor({ state: "visible", timeout });
        return {};
      }
      await page.waitForFunction(SAID_ON_THE_PAGE, [word, PROMPT_ECHOES], { timeout });
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

/** Waits until the app says it is ready, and says so on the tester's own output when it never did, once per
 * command. A step taken before that lands on a page half a second old: a key press falls into a composer that is
 * still connecting and a shot photographs the loading pass, which three testers read as the app losing their
 * first message. */
async function steady(page, warn) {
  if (!(await whenReady(page, WAIT_MS))) warn();
}

/** The window this session drives at, in the size the command asked for or the one it was last read at. A window
 * held open keeps whatever size it has, so the size is put to the page itself rather than to a context that was
 * made one command ago. */
async function sized(page, width) {
  await page.setViewportSize({ width, height: SIZE.height }).catch(async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: SIZE.height, deviceScaleFactor: 1, mobile: false });
    await cdp.detach();
  });
}

async function main() {
  const { session, steps } = parseArgs(process.argv.slice(2));
  const dir = sessionDir(session);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (steps[0].verb === "quit" && steps.length === 1) {
    console.log(closeWindow(session));
    return;
  }
  const seen = readSeen(session);
  const width = steps.find(step => step.width !== undefined)?.width ?? seen.width ?? SIZE.width;
  const held = await windowFor(session);
  if (steps[0].verb === "press" && held.fresh) {
    console.error(PRESS_NEEDS_FOCUS);
    process.exit(1);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${held.port}`);
  let told = false;
  const warn = () => {
    if (told) return;
    told = true;
    console.error(NOT_READY_LINE);
  };
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await sized(page, width);
    // The window this session left open is still on the page it was left on, so nothing is reopened: a menu, a
    // dialog or a picker left open by the last command is there for this one. A window that has only just opened
    // is blank, and the address the session was last at is opened on it.
    if (steps[0].verb !== "goto" && seen.url !== undefined && held.fresh) await open(page, seen.url);
    if (steps[0].verb !== "goto" && seen.url === undefined) {
      console.error("this session has not been anywhere yet; start it with goto <url>");
      process.exit(1);
    }
    let url = seen.url;
    let before = seen.text;
    /** The field the last type step of this command filled, which a press after it lands in. */
    let typed;
    for (const [at, step] of steps.entries()) {
      if (step.verb === "quit") {
        console.error("quit closes the window, so it stands alone rather than after then");
        process.exit(1);
      }
      // Not before a goto, which opens its own address: the page a command starts on is blank, and this app is not
      // on it yet to say anything about itself.
      if (step.verb !== "goto") await steady(page, warn);
      const focus = step.verb === "press" && typedField(steps, at) !== undefined ? typed : undefined;
      const done = await act({ ...step, ...(focus === undefined ? {} : { focus }) }, page);
      typed = done.field ?? typed;
      url = done.url ?? url;
      await steady(page, warn);
      await page.waitForTimeout(SETTLE_MS);
      const read = await marked(page);
      writeFileSync(seenPath(session), `${JSON.stringify({ url, width, text: read.text }, null, 2)}\n`);
      if (steps.length > 1) console.log(stepLine(step));
      if (step.verb === "shot") console.log(done.shot);
      else if (step.verb === "text") console.log(`${read.text}\n\nclickable attributes: ${read.attrs.join(" ") || "none"}`);
      else {
        const changed = diffLines(before, read.text);
        console.log(changed.length === 0 ? "the page reads the same" : changed.join("\n"));
      }
      before = read.text;
    }
  } finally {
    // The connection goes; the window stays, which is what the next command attaches to.
    await browser.close();
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
