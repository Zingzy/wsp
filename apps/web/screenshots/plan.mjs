// SPDX-License-Identifier: AGPL-3.0-only
// The reading of a surfaces list, apart from the browser that photographs it:
// what a surface is allowed to say, the selector each click word folds into,
// the name every file takes and the index a reader opens first. Kept separate
// so a list can be checked without a host, a build or a browser. A surface may
// name the fixture it is served from, since one state file cannot hold both a
// person whose image is built and one whose image never was.

/** The widths every list is shot at when it names none: a desktop window and a phone. */
const DEFAULT_WIDTHS = [1440, 390];
/** The window height each width gets, so a shot is a window rather than a full-page scroll. The desktop app opens
 * at 1280 by 800, which is the window a design reading is held to. */
const DEFAULT_HEIGHTS = { 1440: 900, 1280: 800, 390: 844 };
const THEMES = ["light", "dark"];
/** Milliseconds a surface rests before its shot when it names none: enough for a popup's opening and
 * the transition the stylesheet runs on colours, which would otherwise be caught part way. */
const DEFAULT_SETTLE_MS = 450;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
/** A step kept for one width: the digits, a colon, then the step itself. Only leading digits count, so an
 * attribute value with a colon in it (`row-id=ws:ws_api`) is left whole. */
const AT_WIDTH = /^(\d+):(.+)$/;
/** A step that presses a key rather than clicking. The narrow window opens with the right panel over the
 * whole shell and no control of its own on top, so Escape is the only way to the sidebar under it. */
const KEY = /^key:(.+)$/;
/** The one step that is neither: the network under the window goes, which is what a window on another computer
 * sees the moment the computer running wsp falls asleep. The rows stay as they were last known. */
const OFFLINE = "offline";

const fail = message => {
  throw new Error(`surfaces list: ${message}`);
};

/** The CSS selector a data attribute word means. `row-id=thread:th_a` is that attribute at that value,
 * `cloud-setup-row` is the attribute being there at all; nothing here reaches past a data attribute, so a
 * list cannot point the harness at a class name the next restyle moves. */
export function selectorFor(word) {
  if (typeof word !== "string" || word === "") fail("a click or wait word is a non-empty string");
  const split = word.indexOf("=");
  const attr = split === -1 ? word : word.slice(0, split);
  if (!NAME.test(attr)) fail(`"${attr}" is not a data attribute name (lowercase, digits and dashes)`);
  if (split === -1) return `[data-${attr}]`;
  return `[data-${attr}="${word.slice(split + 1).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
}

/** A step as the driver takes it: a click on a data attribute or a key press, and the width it belongs to
 * where the word named one. The narrow window keeps the sidebar behind a toggle and the wide one does not,
 * so the step that opens it is a step for one width rather than a second surface with its own file names. */
export function stepFor(word, widths) {
  const kept = AT_WIDTH.exec(typeof word === "string" ? word : "");
  const width = kept === null ? undefined : Number(kept[1]);
  if (width !== undefined && !widths.includes(width)) fail(`a step is kept for width ${width}, which the list does not shoot`);
  const bare = kept === null ? word : kept[2];
  const key = KEY.exec(typeof bare === "string" ? bare : "");
  const step = bare === OFFLINE ? { offline: true } : key === null ? { click: selectorFor(bare) } : { key: key[1] };
  return width === undefined ? step : { width, ...step };
}

/** What the index says a step was. */
const stepWords = step => (step.offline === true ? "the network going" : step.key === undefined ? `\`${step.click}\`` : `the ${step.key} key`);

const surfaceFrom = (raw, index, widths) => {
  if (raw === null || typeof raw !== "object") fail(`surface ${index} is not an object`);
  const { name, at, steps, wait, settleMs, fixture, remote } = raw;
  if (typeof name !== "string" || !NAME.test(name)) fail(`surface ${index} needs a name of lowercase words and dashes, got ${JSON.stringify(name)}`);
  if (typeof at !== "string" || !at.startsWith("/")) fail(`${name}: "at" is the route or hash the page opens, starting with /`);
  if (steps !== undefined && !Array.isArray(steps)) fail(`${name}: "steps" is an array of data attribute words and key presses`);
  if (settleMs !== undefined && (typeof settleMs !== "number" || settleMs < 0)) fail(`${name}: "settleMs" is a count of milliseconds`);
  if (remote !== undefined && typeof remote !== "boolean") fail(`${name}: "remote" says whether the page is served to another computer`);
  const own = raw.widths;
  if (own !== undefined && (!Array.isArray(own) || own.some(w => !widths.includes(w)))) fail(`${name}: "widths" picks from the list's own ${widths.join(", ")}`);
  if (fixture !== undefined && (typeof fixture !== "string" || !NAME.test(fixture))) fail(`${name}: "fixture" is the name of a fixture the state file serves`);
  return {
    name,
    at,
    steps: (steps ?? []).map(word => stepFor(word, widths)),
    ...(wait !== undefined ? { wait: selectorFor(wait) } : {}),
    ...(fixture !== undefined ? { fixture } : {}),
    settleMs: settleMs ?? DEFAULT_SETTLE_MS,
    widths: own ?? widths,
    remote: remote === true,
  };
};

/** A surfaces list as the driver takes it, or an error naming the entry at fault. */
export function readSurfaces(raw) {
  if (raw === null || typeof raw !== "object") fail("the file holds an object with a surfaces array");
  const widths = raw.widths ?? DEFAULT_WIDTHS;
  if (!Array.isArray(widths) || widths.length === 0 || widths.some(w => !Number.isInteger(w) || w < 1)) fail('"widths" is a non-empty array of whole pixel widths');
  const heights = { ...DEFAULT_HEIGHTS, ...(raw.heights ?? {}) };
  for (const w of widths) if (!Number.isInteger(heights[w]) || heights[w] < 1) fail(`width ${w} has no height; give one in "heights"`);
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length === 0) fail("the list names no surfaces");
  const surfaces = raw.surfaces.map((s, i) => surfaceFrom(s, i, widths));
  const seen = new Set();
  for (const s of surfaces) {
    if (seen.has(s.name)) fail(`two surfaces are called ${s.name}; one would overwrite the other's files`);
    seen.add(s.name);
  }
  return { widths, heights, surfaces };
}

export const shotName = (surface, theme, width) => `${surface}-${theme}-${width}.png`;

/** Every shot a list asks for, in the order the driver takes them, each carrying the steps its own width
 * keeps and the file it lands in. Widest first, so a run watched from the terminal shows the window a
 * reviewer reads first. */
export function shotPlan(list) {
  const shots = [];
  for (const width of list.widths) {
    for (const theme of THEMES) {
      for (const surface of list.surfaces) {
        if (!surface.widths.includes(width)) continue;
        const steps = surface.steps.filter(s => s.width === undefined || s.width === width).map(({ width: _kept, ...step }) => step);
        shots.push({ name: surface.name, at: surface.at, steps, wait: surface.wait, ...(surface.fixture === undefined ? {} : { fixture: surface.fixture }), settleMs: surface.settleMs, remote: surface.remote, theme, width, height: list.heights[width], file: shotName(surface.name, theme, width) });
      }
    }
  }
  return shots;
}

/** The index a reader opens first: what each surface is, then its files as a table a person and an agent
 * both read. Only shots that were actually written are listed, so a missed one cannot be reviewed by
 * accident from a stale file left by an earlier run. */
export function indexMarkdown(list, written, meta) {
  const has = new Set(written);
  const plan = shotPlan(list);
  const lines = ["# wsp UI screenshots", "", `Taken ${meta.at} from ${meta.sha} on ${meta.branch}.`, "", `${written.length} of ${plan.length} files, widths ${list.widths.join(" and ")}, light and dark.`, ""];
  for (const surface of list.surfaces) {
    const rows = plan.filter(s => s.name === surface.name && has.has(s.file));
    if (rows.length === 0) continue;
    const road = `Route \`${surface.at}\`${surface.remote ? ", served to a window on another computer" : ""}${surface.steps.length > 0 ? `, then ${surface.steps.map(s => `${stepWords(s)}${s.width === undefined ? "" : ` (at ${s.width} only)`}`).join(", ")}` : ""}${surface.fixture === undefined ? "" : `, served from the ${surface.fixture} fixture`}.`;
    lines.push(`## ${surface.name}`, "", road, "", "| theme | width | file |", "| --- | --- | --- |");
    for (const row of rows) lines.push(`| ${row.theme} | ${row.width} | [${row.file}](${row.file}) |`);
    lines.push("");
  }
  return lines.join("\n");
}
