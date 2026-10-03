// SPDX-License-Identifier: AGPL-3.0-only
// What slate_catalog answers: only the part asked for, read off the registries, as JSON with the registries' own
// field names and as compact text for an agent that reads text better. Nothing here is written twice.
import { SLATE_FUNCTIONS } from "./expr.js";
import { PR_LINES, TRACKER_LINES, USAGE_LINES } from "./examples.js";
import { SLATE_ACTIONS, SLATE_PIECES, SLATE_SOURCES, SLATE_TONES, slateFlags, type SlateActionModule, type SlatePieceModule, type SlatePropSpec, type SlateShape, type SlateSourceModule } from "./kit.js";
import { nearest, orList } from "./problems.js";

export interface SlateCatalogAsk { piece?: string; source?: string; action?: string; step?: string; functions?: boolean; examples?: boolean }

export interface SlateCatalogAnswer {
  pieces?: Record<string, string>;
  /** The index's action kinds and function names. */
  kinds?: string[];
  names?: string[];
  piece?: { type: string; level: string; purpose: string; props: Record<string, string>; items?: Record<string, Record<string, string>>; flags: string[]; events: string[]; children: string; fallback: string; example: string };
  sources?: Record<string, string>;
  source?: { name: string; level: string; purpose: string; paths: Record<string, string>; update: string; scope: string; cost: string; notes?: Record<string, string>; example: string };
  actions?: Record<string, string>;
  action?: { kind: string; purpose: string; args: Record<string, string>; consent: string; refusal: string; reaches: string; example: string };
  functions?: Record<string, string>;
  rules?: string[];
  examples?: string[];
  /** The same content as compact text. */
  text: string;
  /** Set when the ask named something the kit does not have. */
  error?: string;
}

export const SLATE_RULES: readonly string[] = [
  "One piece per line, children two spaces in; write id: type for any piece you will change later.",
  "prop={path or formula} binds live data; prop=`text ${formula}` fills a sentence; a word or a quoted string is literal.",
  "Bare words are meaning, never style: tone (muted, good, warning, bad), strong, small, primary, mono. No colour, pixels or font.",
  "Bind a list to a table's items and write one - col line per column; item and index read the row.",
  "A press reaches you only through an action: @press send text=\"...\" with=[paths]; text is literal, the changing parts ride with.",
  "Write once, then patch (~ id prop=value) or set state (state.key = json); do not rewrite the slate every turn.",
];

function specText(spec: SlatePropSpec & { path?: string }): string {
  const tones = Array.isArray(spec.type) && (spec.type as readonly string[]).join() === SLATE_TONES.join();
  const type = tones ? "tone" : Array.isArray(spec.type) ? (spec.type as readonly string[]).join("|") : spec.type === "text" ? "string|number" : (spec.type as string);
  const quietDefault = spec.default === false || (Array.isArray(spec.type) && spec.default === (spec.type as readonly string[])[0]);
  const marks = [
    spec.required === true ? "required" : undefined,
    spec.binds === "yes" ? "binds" : spec.binds === "state" ? "binds state.<key> two-way" : spec.binds === "item" ? "binds per row" : undefined,
    spec.default !== undefined && !quietDefault ? `default ${JSON.stringify(spec.default)}` : undefined,
    spec.min !== undefined && spec.max !== undefined ? `${spec.min} to ${spec.max}` : undefined,
    spec.path === "state" ? "a state path" : spec.path === "any" ? "a list of paths" : undefined,
  ].filter(Boolean);
  return marks.length > 0 ? `${type}, ${marks.join(", ")}` : type;
}

function flagsOf(piece: SlatePieceModule): string[] {
  return [...slateFlags(piece.props)].filter(([, hit]) => hit !== "ambiguous").map(([w]) => w).filter(w => !w.startsWith("no-"));
}

function pieceEntry(piece: SlatePieceModule): NonNullable<SlateCatalogAnswer["piece"]> {
  return {
    type: piece.type,
    level: piece.level,
    purpose: piece.purpose,
    props: Object.fromEntries(Object.entries(piece.props).map(([k, s]) => [k, specText(s)])),
    ...(Object.keys(piece.items).length > 0 ? {
      items: Object.fromEntries(Object.entries(piece.items).map(([kind, s]) => [`- ${kind}`, {
        fills: s.prop,
        ...Object.fromEntries(Object.entries(s.fields).map(([k, f]) => [k, specText(f)])),
        ...(s.when === true ? { when: "expression in row scope" } : {}),
        ...(s.events !== undefined ? { on: s.events.map(e => `@${e}`).join(", ") } : {}),
      }])),
    } : {}),
    flags: flagsOf(piece),
    events: [...piece.events],
    children: piece.childLimit !== undefined ? `at most ${piece.childLimit.max} ${piece.childLimit.types.join(" or ")}` : piece.holdsChildren ? "yes" : "no",
    fallback: piece.fallback,
    example: piece.example,
  };
}

/** A shape in one short phrase: records whose fields share one scalar type fold to "{ a, b } number". */
function shapeLine(shape: SlateShape): string {
  if (typeof shape === "string") return shape;
  if ("enum" in shape) return shape.enum.join("|");
  if ("list" in shape) return `[${shapeLine(shape.list)}]`;
  const kinds = new Set(Object.values(shape.fields).map(f => (typeof f === "string" ? f : "mixed")));
  if (kinds.size === 1 && !kinds.has("mixed")) return `{ ${Object.keys(shape.fields).join(", ")} } ${[...kinds][0]}`;
  return `{ ${Object.entries(shape.fields).map(([k, f]) => `${k}: ${shapeLine(f)}`).join(", ")} }`;
}

/** Paths of one shape share a line: thread.{id, title}: string. */
function groupedPaths(source: SlateSourceModule): Record<string, string> {
  const byShape = new Map<string, string[]>();
  for (const [k, s] of Object.entries(source.shape.fields)) {
    const line = shapeLine(s);
    byShape.set(line, [...(byShape.get(line) ?? []), k]);
  }
  return Object.fromEntries([...byShape].map(([line, keys]) => [keys.length === 1 ? `${source.name}.${keys[0]}` : `${source.name}.{${keys.join(", ")}}`, line]));
}

function sourceEntry(source: SlateSourceModule): NonNullable<SlateCatalogAnswer["source"]> {
  return {
    name: source.name,
    level: source.level,
    purpose: source.purpose,
    paths: groupedPaths(source),
    update: source.update,
    scope: source.scope,
    cost: source.cost,
    ...(source.notes !== undefined ? { notes: source.notes } : {}),
    example: source.example,
  };
}

function actionEntry(action: SlateActionModule): NonNullable<SlateCatalogAnswer["action"]> {
  return {
    kind: action.kind,
    purpose: action.purpose,
    args: Object.fromEntries(Object.entries(action.args).map(([k, s]) => [k, specText(s)])),
    consent: action.consent,
    refusal: action.refusal,
    reaches: action.reaches,
    example: action.example,
  };
}

const record = (r: Record<string, unknown>): string => Object.entries(r).map(([k, v]) => `${k}: ${typeof v === "string" ? v : Object.entries(v as Record<string, string>).map(([a, b]) => `${a} (${b})`).join("; ")}`).join("\n");

function missing(kind: string, name: string, options: string[]): SlateCatalogAnswer {
  const fix = nearest(name, options);
  const error = `"${name}" is not a ${kind}${fix !== undefined ? `; did you mean ${fix}?` : "."} The ${kind}s are ${orList(options)}.`;
  return { error, text: error };
}

/** The part of the kit asked for; with nothing asked, the index. */
export function slateCatalog(ask: SlateCatalogAsk): SlateCatalogAnswer {
  const out: SlateCatalogAnswer = { text: "" };
  const text: string[] = [];
  let asked = false;
  if (ask.piece !== undefined) {
    asked = true;
    const piece = SLATE_PIECES[ask.piece];
    if (piece === undefined) return missing("piece", ask.piece, Object.keys(SLATE_PIECES));
    const e = pieceEntry(piece);
    out.piece = e;
    text.push(`${e.type} (${e.level}): ${e.purpose}`, record(e.props), ...(e.items !== undefined ? [record(e.items)] : []),
      `flags: ${e.flags.join(" ") || "none"}`, `events: ${e.events.join(", ") || "none"}; children: ${e.children}`, e.example);
  }
  if (ask.source !== undefined) {
    asked = true;
    const source = SLATE_SOURCES[ask.source];
    if (source === undefined) return missing("source", ask.source, Object.keys(SLATE_SOURCES));
    const e = sourceEntry(source);
    out.source = e;
    text.push(`${e.name} (${e.level}): ${e.purpose}`, record(e.paths), `update: ${e.update}; scope: ${e.scope}; cost: ${e.cost}`,
      ...Object.entries(e.notes ?? {}).map(([k, v]) => `${k}: ${v}`), `example: ${e.example}`);
  }
  if (ask.action !== undefined) {
    asked = true;
    const action = SLATE_ACTIONS[ask.action];
    if (action === undefined) return missing("action", ask.action, Object.keys(SLATE_ACTIONS));
    const e = actionEntry(action);
    out.action = e;
    text.push(`${e.kind}: ${e.purpose}`, record(e.args), `consent: ${e.consent}; reaches the agent: ${e.reaches}`, `refusal: ${e.refusal}`, e.example);
  }
  if (ask.step !== undefined) {
    asked = true;
    const error = "Pipelines are not in this build; compute with an expression (len, sum, pluck, contains) instead.";
    out.error = error;
    text.push(error);
  }
  if (ask.functions === true) {
    asked = true;
    out.functions = Object.fromEntries(Object.entries(SLATE_FUNCTIONS).map(([name, f]) => [name, `${f.sig}, e.g. ${f.example}`]));
    text.push(Object.values(out.functions).join("\n"));
  }
  if (ask.examples === true) {
    asked = true;
    out.examples = [PR_LINES, USAGE_LINES, TRACKER_LINES];
    text.push(out.examples.join("\n"));
  }
  if (!asked) {
    out.pieces = Object.fromEntries(Object.values(SLATE_PIECES).map(p => [p.type, flagsOf(p).join(" ")]));
    out.sources = Object.fromEntries(Object.values(SLATE_SOURCES).map(s => [s.name, Object.keys(s.shape.fields).join(",")]));
    out.kinds = Object.keys(SLATE_ACTIONS);
    out.names = Object.keys(SLATE_FUNCTIONS);
    out.rules = [...SLATE_RULES];
    out.examples = [PR_LINES];
    text.push(
      `pieces: ${Object.values(SLATE_PIECES).map(p => `${p.type} (${flagsOf(p).join(" ") || "-"})`).join("; ")}`,
      `sources: ${Object.values(SLATE_SOURCES).map(s => `${s.name}.{${Object.keys(s.shape.fields).join(",")}}`).join(" ")}; state.<key> is the slate's own`,
      `actions: ${Object.keys(SLATE_ACTIONS).join(", ")}`,
      `functions: ${Object.keys(SLATE_FUNCTIONS).join(", ")}`,
      ...SLATE_RULES.map((r, i) => `${i + 1}. ${r}`),
      "Ask { piece }, { source }, { action }, { functions } or { examples } for more.",
      PR_LINES,
    );
  }
  out.text = text.join("\n");
  return out;
}

/** A rough token count, a quarter of the characters, which the budgets in 11 are held to here. */
export const slateTokens = (text: string): number => Math.ceil(text.length / 4);
