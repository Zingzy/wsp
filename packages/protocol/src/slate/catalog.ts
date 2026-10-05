// SPDX-License-Identifier: AGPL-3.0-only
// What slate_catalog answers (10, "The catalog call"): only the part asked for, as text, read off the registries.
// The index stays under 900 tokens and an entry for a piece under 200; slateTokens is the estimate the tests hold.
import { SLATE_FUNCTIONS, SLATE_PIPE_STEPS } from "./expr.js";
import { SLATE_EXAMPLES } from "./examples.js";
import { SLATE_ICONS } from "./icons.js";
import { SLATE_PIECES, SLATE_TONES, type SlatePieceModule, type SlatePropSpec } from "./kit.js";
import { nearest } from "./problems.js";
import { sketchSlate } from "./sketch.js";
import { SLATE_SOURCES, slateShapeText, type SlateShape } from "./sources.js";
import { SLATE_STEPS } from "./steps.js";
import { compileSlateText } from "./syntax.js";
import { SLATE_RUN_FIELDS } from "./types.js";

/** A conservative token count: each word, each number and each other non-space character is one. Real tokenizers
 * join common words with their spaces and punctuation, so they count fewer. */
export function slateTokens(text: string): number {
  return text.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g)?.length ?? 0;
}

export const SLATE_RULES: readonly string[] = [
  "One <slate>, one root piece, declarations beside it. Give an id to a piece you will change.",
  "prop=\"text\" is literal; prop={formula} reads live data or $values with operators, a ? b : c, [lists], {records} and functions, never methods or =>. A text child with {holes} fills a sentence.",
  "Props are meaning, never style. held is a sentence that disables: bind it to a condition; \"\" or false enables.",
  "A list binds to items; item and index read the row.",
  "A press reaches you only through send(\"literal text\", $path); <when> chains run without you.",
  "Small edit: patch by id, <props id=\"price\" value={$spot.json.v} />; bigger: resend the whole slate with if_version.",
  "Simple and airy unless asked for more: few pieces, one idea per section, short labels, no emoji. Separate things by layout, never by ·, • or |.",
  "One heading per section: its title or a heading, in sentence case, never bold text.",
  "Status and last-checked lines small and muted, beside their subject.",
  "Actions at the end of their row; one primary per section.",
  "mono only for figures, ids, times and paths.",
  "Every live number says its window and unit. Show a run's json fields, never its raw out; times through date(), time() or ago().",
  "Nothing centered but a lone figure or card.",
  "Use the slate tools, never wsp from a shell.",
  "A secret the person types goes in a <secret> input, never a file or the chat. One in a file stays there for the run to read, never you.",
  "A button asked for where the project has no UI goes here: the slate is its UI, and the reply says so.",
];

export const SLATE_INDEX_EXAMPLE = `<slate title="Issue">
  <value name="id" start="" />
  <run name="check" cmd='gh api "repos/Zingzy/wsp/issues/$ID"' env={{ ID: $id }} />
  <when change={$id} do={start($check)} />
  <column>
    <input label="Issue" value={$id} />
    <text when={$check.exit == 0}>{$check.json.title}</text>
    <button label="Fix it" onPress={send("Fix this issue.", $id)} />
  </column>
</slate>`;

/** Said once for every group on the index's own line, not on each piece's. */
const BOX = { pad: true, surface: true };

/** Enums said once for every piece on the index's own lines, so a piece's line does not repeat them. */
const SAID_ONCE = new Set(["tone", "emphasis", "pad", "align"]);

/** A prop as the index names it: its allowed words where it takes a fixed set, as the checker holds them, and a !
 * where a piece is refused without it. */
function propWord(name: string, spec: SlatePropSpec): string {
  const words = Array.isArray(spec.type) && !SAID_ONCE.has(name) ? `(${(spec.type as readonly string[]).join("|")})` : "";
  return `${name}${spec.required === true ? "!" : ""}${words}`;
}

function pieceLine(p: SlatePieceModule): string {
  const props = Object.keys(p.props).filter(k => !Object.values(p.items).some(i => i.prop === k) && !(k in BOX)).map(k => propWord(k, p.props[k]!));
  const items = Object.entries(p.items).map(([tag, s]) => `<${tag} ${[...Object.entries(s.fields).map(([k, f]) => propWord(k, f)), ...(s.events !== undefined ? ["onPress"] : [])].join(" ")}>`);
  const events = p.events.map(e => `on${e[0]!.toUpperCase()}${e.slice(1)}`);
  return `${p.type}: ${[...props, ...events].join(" ")}${items.length > 0 ? `; ${items.join(" ")}` : ""}${p.holdsChildren && p.childLimit === undefined ? "; children" : ""}`;
}

/** The fields the index names for each source; the entry for the source has the rest. */
const INDEX_FIELDS: Record<string, readonly string[]> = {
  thread: ["id", "title", "status", "agent", "model", "turns", "lastTurn", "cost", "tokens", "context", "changes", "plan", "waitingOn", "subagents"],
  usage: ["account", "windows", "session", "week", "status", "note"],
  cost: ["rateUsdPerHour", "accruedUsd"],
  time: ["now", "today", "zone"],
  git: ["branch", "head", "ahead", "behind", "changed"],
  pr: ["number", "url", "state", "draft", "branch", "headSubject", "mergeable", "review", "checks", "word"],
};

function sourceLine(name: string): string {
  const shape = SLATE_SOURCES[name]!.shape;
  if ("keyed" in shape) return `${name}.<server>: state tools[] resources[]`;
  const fields = Object.entries(shape.fields).filter(([k]) => INDEX_FIELDS[name]?.includes(k) ?? true);
  const more = fields.length < Object.keys(shape.fields).length ? " ..." : "";
  return `${name}: ${fields.map(([k, v]) => (typeof v === "object" && "list" in v ? `${k}[]` : k)).join(" ")}${more}`;
}

function index(): string {
  const core = Object.values(SLATE_PIECES).filter(p => p.level === "core");
  return [
    "Slate kit wsp/2, JSX-like text. Pieces (attributes, ! required, (a|b) the only values; <items>):",
    ...core.map(pieceLine),
    "Every piece: id, when={cond}; items take when too. tone: default muted good warning bad info accent. emphasis: normal strong quiet.",
    "section, column, grid: pad none tight normal loose; surface=\"inset\" sets the card ground; align start center end, else children fill the width.",
    "bars compare categories; time is a chart, x in ms or ISO; a flow is a diagram.",
    "Sources, read only:",
    ...["thread", "usage", "cost", "time", "git", "pr"].map(sourceLine),
    "Declarations: <value name start> <secret name> <derived name value> <run name cmd env args stdin on timeout every always once confirm then tool resource> <file name> <when change={$path} or done={$run} do={steps}>",
    `Steps: ${Object.keys(SLATE_STEPS).join(" ")}. Functions: ${Object.keys(SLATE_FUNCTIONS).join(" ")}. ago(t) "30s ago", until(t) "in 4m".`,
    `After |: ${Object.keys(SLATE_PIPE_STEPS).join(" ")}. $run reads state exit out err json; a secret only .set .len.`,
    "Rules:",
    ...SLATE_RULES.map((r, i) => `${i + 1}. ${r}`),
    SLATE_INDEX_EXAMPLE,
    "More: slate_catalog <piece, source, runs, patch, functions, steps, handlers, icons or examples>.",
  ].join("\n");
}

function specText(spec: SlatePropSpec): string {
  const tones = Array.isArray(spec.type) && (spec.type as readonly string[]).join() === SLATE_TONES.join();
  const type = tones ? "tone" : Array.isArray(spec.type) ? (spec.type as readonly string[]).join("|") : spec.type === "text" ? "text or number" : spec.type === "path" ? "$run" : spec.type === "icon" ? "icon name" : (spec.type as string);
  const marks = [
    spec.required === true ? "required" : undefined,
    spec.binds === "yes" ? "formula" : spec.binds === "state" ? (spec.literal === true ? "two-way $value or a literal start" : "two-way $value") : spec.binds === "item" ? "per row" : undefined,
    spec.min !== undefined && spec.max !== undefined ? `${spec.min} to ${spec.max}` : undefined,
  ].filter(Boolean);
  return marks.length > 0 ? `${type}, ${marks.join(", ")}` : type;
}

function pieceEntry(p: SlatePieceModule): string {
  const own = Object.entries(p.props).filter(([k]) => !Object.values(p.items).some(i => i.prop === k));
  const compiled = compileSlateText(`<slate><column>${p.example}</column></slate>`).document;
  const sketched = compiled === undefined ? "" : (sketchSlate(compiled, {}, { check: true }).split("\n")[1] ?? "");
  return [
    `${p.type} (${p.level}): ${p.purpose}`,
    ...own.map(([k, s]) => `  ${k}: ${specText(s)}${s.about !== undefined ? `; ${s.about}` : ""}`),
    ...Object.entries(p.items).map(([tag, s]) => `  <${tag}> ${Object.entries(s.fields).map(([k, f]) => `${k}${f.required === true ? "!" : ""}`).join(" ")} when${s.events !== undefined ? " onPress" : ""}${s.row === true ? ` (item and index read the row${s.rowWhen === true ? ", when too" : ""})` : ""}`),
    `events: ${p.events.length > 0 ? p.events.map(e => `on${e[0]!.toUpperCase()}${e.slice(1)}`).join(", ") : "none"}${p.textProp !== undefined ? `; a text child fills ${p.textProp}` : ""}${p.holdsChildren ? "; holds children" : ""}`,
    ...(sketched !== "" ? [`sketch: ${sketched}`] : []),
    `example: ${p.example}`,
  ].join("\n");
}

function sourceEntry(name: string): string {
  const s = SLATE_SOURCES[name]!;
  const paths: string[] = [];
  const scalars = new Map<string, string[]>();
  const walk = (prefix: string, shape: SlateShape): void => {
    if (typeof shape === "string") { (scalars.get(shape) ?? scalars.set(shape, []).get(shape)!).push(prefix); return; }
    paths.push(`  ${prefix}: ${slateShapeText(shape)}`);
  };
  if ("keyed" in s.shape) walk(`${name}.<server>`, s.shape.keyed);
  else for (const [k, v] of Object.entries(s.shape.fields)) walk(`${name}.${k}`, v);
  for (const [type, list] of scalars) paths.unshift(`  ${list.join(" ")}: ${type}`);
  return [
    `${name} (${s.level}): ${s.purpose}`,
    ...paths,
    `update: ${s.update}; scope: ${s.scope}; cost: ${s.cost}`,
    ...Object.entries(s.notes ?? {}).map(([k, v]) => `note ${k}: ${v}`),
    `example: {${s.example}}`,
  ].join("\n");
}

const RUNS = `runs: a command the slate starts with no turn of yours.
<run name="check" cmd='gh api "repos/$REPO/issues/$ID"' env={{ REPO: $repo, ID: $id }} every={60} />
<run name="py">{\`python3 -c "print('both quotes')"\`}</run>
Each attribute:
name: the run is read as $name.
cmd: the literal command, run by bash -c in the thread's folder. Single quotes outside double ones; the block form above takes any text.
env={{ ID: $id }}: values it reads as $ID. args={[$a]}: as $1. stdin={$x}: on standard input. A secret goes only in env or stdin; one in a file, the command reads itself, never through you.
every={60}: starts it again every 60 seconds, at least 10, while the Slate tab is on screen in the app.
always: with every, ticks while the tab is not on screen too.
once: a start while it still runs is skipped; without once it stops and starts again.
stream: fills lines as it prints, the last 500, so an output piece shows them live.
timeout={60}: seconds before it is stopped, at most 600.
on="host": runs on the host's computer, not the thread's.
confirm="Stop it?": asks the person every start; a formula works too.
then='python3 x.py': pipes its raw result to that command; its stdout as JSON becomes json, out stays raw.
tool="server.tool" args={{ id: $id }}, or resource="server:uri": calls an MCP tool instead; slate_catalog <server> lists its tools.
start($run) in a handler or <when> starts one. The person allows each command once, on the slate, when it first wants to start: at the write for an every= run, at the first press or <when> for the rest. Until then it reads held; allowing it starts it at once. slate_state start runs only what they allowed "Always in this thread".
$run reads ${SLATE_RUN_FIELDS.join(" ")}; state is idle (never started) held running done failed cancelled.
json is out parsed as JSON. A failed run's out and json are its own, often empty: show a figure with when={$run.exit == 0}. stale: the command changed since this result. Output is scrubbed of secrets.
<value> state and each run's last result outlive an app or host restart.
Chain: <when done={$check} do={set($ok, $check.exit == 0)} />; done fires on any outcome.
Code only the slate uses goes in <file name="x.py"> and runs as $SLATE_DIR/x.py; project code runs where it is.
A tool's json is its structured result, else its text parsed; one marked text only keeps json empty unless its text is JSON. The person allows a server once per thread, a destructive tool every start. A secret in args returns as [secret:name].`;

const PATCH = `patch: elements without <slate>, sent as text to slate_write; one write may hold several.
<props id="price" tone="warning" />: merges these props into the piece.
<text id="eta">Ready</text>: a piece with an id that exists replaces it whole, children too.
<add under="list" at={0}><text id="new">New</text></add>: adds pieces under a piece, at an index from 0, else last.
<move id="new" under="other" at={1} />: moves a piece.
<remove id="new" />: removes a piece and what it holds. <remove name="hist" /> removes a declaration.
<value name="hist" start={[]} />, <run ...>, <derived ...>, <file name="x.py">...</file>: adds the declaration or replaces the one of that name.
<clear /> empties the slate; <undo /> goes back one write. Each stands alone in its write.
For anything bigger, resend the whole <slate> with if_version set to the version you read.
version, which every write and read answers, counts the slate's edits and is what if_version takes; wsp/2 and schema 2 name the format.
check with press walks a press and its <when> chain on a copy: nothing runs and nothing is sent, and it says what would start.`;

function functionsEntry(): string {
  const shown = new Set(["percent", "pct", "tokens", "usd", "duration", "ago", "until", "date", "plural", "word", "short", "num", "json", "contains", "orElse", "len", "first", "pluck"]);
  return ["Functions (pure; a null argument gives null unless the function takes one):", ...Object.entries(SLATE_FUNCTIONS).map(([n, f]) => (shown.has(n) ? `${f.sig}: ${f.example}` : f.sig))].join("\n");
}

function stepsEntry(): string {
  return ["List steps, after | (item and index read the element):", ...Object.values(SLATE_PIPE_STEPS).map(s => `${s.sig}: ${s.purpose}. ${s.example}`)].join("\n");
}

function handlersEntry(): string {
  return ["Handler steps, in onPress, onSubmit, onChange and <when do>; one step or [a, b], at most 6:", ...Object.values(SLATE_STEPS).map(s => `${s.sig}: ${s.purpose}. ${s.runs === "window" ? "Window only, on a press. " : ""}Consent: ${s.consent}. ${s.example}`)].join("\n");
}

/** The catalog: the index with no name, else the named piece, source or chapter, as text. */
export function slateCatalog(name?: string): string {
  if (name === undefined || name === "" || name === "index") return index();
  const n = name.trim();
  if (n === "file") return `${pieceEntry(SLATE_PIECES[n]!)}\nThe <file name="x.py"> declaration, code a run calls as $SLATE_DIR/x.py, is in slate_catalog runs.`;
  if (SLATE_PIECES[n] !== undefined) return pieceEntry(SLATE_PIECES[n]);
  if (SLATE_SOURCES[n] !== undefined) return sourceEntry(n);
  switch (n) {
    case "runs": case "run": case "tool": case "tools": case "mcp": return RUNS;
    case "functions": return functionsEntry();
    case "patch": case "patches": return PATCH;
    case "steps": case "pipes": case "pipe": return stepsEntry();
    case "handlers": return handlersEntry();
    case "examples": return SLATE_EXAMPLES.map(e => `${e.title}:\n${e.text}`).join("\n\n");
    case "icons": case "icon": return `icon="<name>" or icon={formula}; a name off this list draws none. Lucide names: ${SLATE_ICONS.join(" ")}`;
    default: {
      const options = [...Object.keys(SLATE_PIECES), ...Object.keys(SLATE_SOURCES), "runs", "functions", "steps", "handlers", "patch", "icons", "examples"];
      const fix = nearest(n, options);
      return `${n} is not in the catalog${fix !== undefined ? `; did you mean ${fix}?` : "."} Ask for a piece, a source, runs, patch, functions, steps, handlers, icons or examples; a server's tools are the host's to answer.`;
    }
  }
}
