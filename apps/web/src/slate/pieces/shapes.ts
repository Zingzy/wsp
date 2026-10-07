// SPDX-License-Identifier: AGPL-3.0-only
// A flowchart's nodes by shape, read off its source, since Mermaid draws a pill, a cylinder and a circle's kin all as
// paths and a diamond, a hexagon and a parallelogram all as polygons. Each shape's nodes take one class the slate's
// look tints from the theme, so the shape picks the colour and the agent never does.

export type Shape = "step" | "decision" | "terminal" | "store" | "io" | "prep" | "event";

/** Each opener with its closer and the shape it draws, longest first so `([` is never read as `(`. */
const OPENERS: ReadonlyArray<readonly [string, string, Shape]> = [
  ["(((", ")))", "event"],
  ["([", "])", "terminal"],
  ["[(", ")]", "store"],
  ["((", "))", "event"],
  ["{{", "}}", "prep"],
  ["[/", "]", "io"],
  ["[\\", "]", "io"],
  ["[[", "]]", "step"],
  ["{", "}", "decision"],
  ["(", ")", "step"],
  ["[", "]", "step"],
  [">", "]", "step"],
];

/** Mermaid's named shapes, `id@{ shape: cyl }`, by the same convention. */
const NAMED: Readonly<Record<string, Shape>> = {
  rect: "step", rounded: "step", proc: "step", process: "step", subproc: "step",
  diam: "decision", diamond: "decision", decision: "decision", question: "decision",
  stadium: "terminal", pill: "terminal", terminal: "terminal", start: "terminal", stop: "terminal",
  cyl: "store", cylinder: "store", db: "store", database: "store", "lin-cyl": "store", "h-cyl": "store",
  "lean-r": "io", "lean-l": "io", "in-out": "io", "out-in": "io", "lean-right": "io", "lean-left": "io",
  hex: "prep", hexagon: "prep", prepare: "prep",
  circle: "event", circ: "event", "sm-circ": "event", "dbl-circ": "event", "fr-circ": "event", "f-circ": "event",
};

/** A node id, which may hold a hyphen but ends before an edge: `b-->c` is b, an arrow and c, never the id `b--`. */
const ID = /[A-Za-z_]\w*(?:-(?![-.>])\w+)*/y;

/** Every node id a flowchart gives a shape, by shape; a source that is not a flowchart names none. */
export function shapesOf(code: string): Map<Shape, Set<string>> {
  return read(code).found;
}

/** Each shaped node, and where the label of each decision and event sits in the source. */
function read(code: string): { found: Map<Shape, Set<string>>; labels: Array<{ from: number; to: number }> } {
  const found = new Map<Shape, Set<string>>();
  const labels: Array<{ from: number; to: number }> = [];
  if (!/^\s*(flowchart|graph)\b/.test(code)) return { found, labels };
  const add = (shape: Shape, id: string): void => void (found.get(shape) ?? found.set(shape, new Set()).get(shape)!).add(id);
  let i = code.indexOf("\n");
  while (i >= 0 && i < code.length) {
    const c = code[i]!;
    if (c === "|") { i = skipPast(code, i + 1, "|"); continue; }
    if (c === '"') { i = skipPast(code, i + 1, '"'); continue; }
    if (c === "%" && code[i + 1] === "%") { i = skipPast(code, i, "\n"); continue; }
    ID.lastIndex = i;
    const id = ID.exec(code)?.[0];
    if (id === undefined || /[\w-]/.test(code[i - 1] ?? "")) { i++; continue; }
    const after = i + id.length;
    if (code.startsWith("@{", after)) {
      const end = skipPast(code, after + 2, "}");
      const named = /shape\s*:\s*([\w-]+)/.exec(code.slice(after, end))?.[1];
      if (named !== undefined && NAMED[named] !== undefined) add(NAMED[named], id);
      i = end;
      continue;
    }
    const open = OPENERS.find(([o]) => code.startsWith(o, after));
    if (open === undefined) { i = after; continue; }
    add(open[2], id);
    i = skipPast(code, after + open[0].length, open[1]);
    if (open[2] === "decision" || open[2] === "event") labels.push({ from: after + open[0].length, to: i - open[1].length });
  }
  return { found, labels };
}

/** The most characters a decision's or an event's line holds: Mermaid sizes a diamond by its label's width plus its
 * height and a circle by its diagonal, so a short line keeps either near two steps tall. */
const LINE_CHARS = 10;

/** A label broken into balanced lines of about LINE_CHARS; one already broken, quoted or short stays as written. */
export function wrapLabel(label: string): string {
  const text = label.trim();
  if (text.length <= LINE_CHARS || /<br|^"|`/.test(text)) return label;
  const words = text.split(/\s+/);
  const target = Math.ceil(text.length / Math.ceil(text.length / LINE_CHARS));
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= target + 2) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.join("<br/>");
}

/** The index just past the next `to` from `from`, or the end. */
function skipPast(code: string, from: number, to: string): number {
  const at = code.indexOf(to, from);
  return at < 0 ? code.length : at + to.length;
}

/** The source with a class line per shape that has nodes, which the slate's look tints. */
export function withShapes(given: string): string {
  const { found, labels } = read(given);
  let code = given;
  for (const { from, to } of [...labels].reverse()) code = `${code.slice(0, from)}${wrapLabel(code.slice(from, to))}${code.slice(to)}`;
  const lines = [...found].filter(([shape]) => shape !== "step").map(([shape, ids]) => `  class ${[...ids].join(",")} shape-${shape}`);
  return lines.length === 0 ? code : `${code.trimEnd()}\n${lines.join("\n")}`;
}

/** Each tinted shape's theme token: amber asks, green starts and ends, indigo keeps, sky goes in and out, rose
 * prepares, grey marks an event. A step keeps the card. */
export const SHAPE_TOKEN: Readonly<Record<Exclude<Shape, "step">, string>> = {
  decision: "--warning",
  terminal: "--success",
  store: "--status-input",
  io: "--info-foreground",
  prep: "--status-working",
  event: "--muted-foreground",
};
