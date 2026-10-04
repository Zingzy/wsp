// SPDX-License-Identifier: AGPL-3.0-only
// What each side reads before writing. The lines get the catalog's own text for every piece, source, action and
// function plus the three examples; the JSX form gets the same entries with only the parts that are syntax (the
// rules, the examples, item and event names) printed in its form, so neither side is told more.
import { compileSlate, printSlateJsx, SLATE_ACTIONS, SLATE_PIECES, SLATE_SOURCES, slateCatalog, type Slate } from "../../../src/index.js";
import { compileLines } from "../../../src/slate/shorthand.js";
import { PR_LINES, TRACKER_LINES, USAGE_LINES } from "../../../src/slate/examples.js";

export type Syntax = "lines" | "jsx";

const ASK_LINE = "Ask { piece }, { source }, { action }, { functions } or { examples } for more.";

export const JSX_RULES: readonly string[] = [
  "One element per piece, children nested inside; give id=\"...\" to any piece you will change later. <slate title=\"...\" state={{ key: json }}> wraps the root.",
  "prop={path or formula} binds live data; prop={`text ${formula}`} fills a sentence; a \"quoted string\" or {literal} is literal. <text> takes words and {formulas} between its tags.",
  "Bare attributes are meaning, never style: tone (muted, good, warning, bad), strong, small, primary, mono. No colour, pixels or font.",
  "Bind a list to a table's items and put one <col /> inside per column; item and index read the row.",
  "A press reaches you only through an action: onPress={send(\"...\", { with: [paths] })}; text is literal, the changing parts ride with.",
  "Write once, then change one piece by its id or set state; do not rewrite the slate every turn.",
];

const doc = (lines: string): Slate => {
  const r = compileSlate(lines);
  if (r.document === undefined) throw new Error(`an example does not compile: ${JSON.stringify(r.errors)}`);
  return r.document;
};

/** A piece example, a fragment of lines, as the JSX it compiles to, without the frame. */
function fragment(lines: string): string {
  const compiled = compileLines(lines);
  if (compiled.document === undefined) throw new Error(`a fragment does not compile: ${JSON.stringify(compiled.errors)}`);
  const body = printSlateJsx(compiled.document).split("\n").slice(1, -2);
  return body.map(l => l.slice(2)).join("\n");
}

/** An action example, "@press send ...", as its onPress={...} attribute. */
function actionAttr(line: string): string {
  const out = fragment(`b: button label=x\n  ${line}`);
  const m = /(on[A-Z][a-z]+=\{.*\})\s*\/>$/s.exec(out);
  if (m === null) throw new Error(`no event in ${out}`);
  return m[1]!.replace(/\n\s*/g, " ");
}

const record = (r: Record<string, unknown>): string => Object.entries(r).map(([k, v]) => `${k}: ${typeof v === "string" ? v : Object.entries(v as Record<string, string>).map(([a, b]) => `${a} (${b})`).join("; ")}`).join("\n");

function pieceText(type: string, syntax: Syntax): string {
  const answer = slateCatalog({ piece: type });
  if (syntax === "lines") return answer.text;
  const e = answer.piece!;
  const items = e.items === undefined ? undefined : Object.fromEntries(Object.entries(e.items).map(([kind, fields]) => [
    `<${kind.slice(2)} />`,
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === "on" ? v.replace(/@([a-z])/g, (_m, c: string) => `on${c.toUpperCase()}`) : v])),
  ]));
  const events = e.events.map(ev => `on${ev[0]!.toUpperCase()}${ev.slice(1)}`).join(", ");
  return [`<${e.type}> (${e.level}): ${e.purpose}`, record(e.props), ...(items !== undefined ? [record(items)] : []),
    `flags: ${e.flags.join(" ") || "none"}`, `events: ${events || "none"}; children: ${e.children}`, fragment(e.example)].join("\n");
}

function actionText(kind: string, syntax: Syntax): string {
  const answer = slateCatalog({ action: kind });
  if (syntax === "lines") return answer.text;
  const e = answer.action!;
  return [`${e.kind}: ${e.purpose}`, record(e.args), `consent: ${e.consent}; reaches the agent: ${e.reaches}`, `refusal: ${e.refusal}`, actionAttr(e.example)].join("\n");
}

function indexText(syntax: Syntax): string {
  const lines = slateCatalog({}).text.split("\n").filter(l => l !== ASK_LINE);
  if (syntax === "lines") return lines.join("\n");
  const head = lines.slice(0, 4);
  return [...head, ...JSX_RULES.map((r, i) => `${i + 1}. ${r}`), printSlateJsx(doc(PR_LINES)).trimEnd()].join("\n");
}

/** Everything one side reads before its first write. */
export function reference(syntax: Syntax): string {
  const example = (lines: string): string => (syntax === "lines" ? lines.trimEnd() : printSlateJsx(doc(lines)).trimEnd());
  return [
    indexText(syntax),
    "## Pieces",
    ...Object.keys(SLATE_PIECES).map(t => pieceText(t, syntax)),
    "## Sources",
    ...Object.keys(SLATE_SOURCES).map(s => slateCatalog({ source: s }).text),
    "## Actions",
    ...Object.keys(SLATE_ACTIONS).map(a => actionText(a, syntax)),
    "## Functions",
    slateCatalog({ functions: true }).text,
    "## Two more examples",
    example(USAGE_LINES),
    example(TRACKER_LINES),
  ].join("\n\n");
}
