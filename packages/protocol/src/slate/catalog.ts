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
  "prop=\"text\" is literal; prop={formula} reads live data or $values; a text child with {holes} fills a sentence. Nothing in braces is JavaScript.",
  "Props are meaning, never style. held is a sentence that disables: bind it to a condition.",
  "A list binds to items; item and index read the row.",
  "A press reaches you only through send(\"literal text\", $path); <when> chains run without you.",
  "Write once, then patch by id: <props id=\"price\" value={$spot.json.v} />; never resend the whole slate.",
  "Simple and airy unless asked for more: few pieces, one idea per section, short labels. Separate things by layout, never by ·, • or |.",
  "One heading per section: its title or a heading, never bold text.",
  "Status and last-checked lines small and muted, beside their subject.",
  "Actions at the end of their row; one primary per section.",
  "mono only for figures, ids, times and paths.",
  "Every live number says its window and unit.",
  "Nothing centered but a lone figure or card.",
  "Use the slate tools, never wsp from a shell.",
  "A secret the person types goes in a <secret> input, never a file or the chat.",
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

function pieceLine(p: SlatePieceModule): string {
  const props = Object.keys(p.props).filter(k => !Object.values(p.items).some(i => i.prop === k) && !(k in BOX));
  const items = Object.entries(p.items).map(([tag, s]) => `<${tag} ${[...Object.keys(s.fields), ...(s.events !== undefined ? ["onPress"] : [])].join(" ")}>`);
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
    "Slate kit wsp/2, JSX-like text. Pieces (attributes; <items>):",
    ...core.map(pieceLine),
    "Every piece: id, when={cond}; items take when too. tone: default muted good warning bad info accent. emphasis: normal strong quiet.",
    "section, column, grid: pad none tight normal loose; surface=\"inset\" sets the card ground; align start center end, else children fill the width.",
    "icon: a lucide name or a formula. bars compare categories; time is a chart.",
    "Sources, read only:",
    ...["thread", "usage", "cost", "time", "git", "pr"].map(sourceLine),
    "Declarations: <value name start> <secret name> <derived name value> <run name cmd env args stdin on timeout every always once confirm then> <file name> <when change={$path} or done={$run} do={steps}>",
    `Steps: ${Object.keys(SLATE_STEPS).join(" ")}. Functions: ${Object.keys(SLATE_FUNCTIONS).join(" ")}.`,
    `After |: ${Object.keys(SLATE_PIPE_STEPS).join(" ")}. $run reads state exit out err json; a secret only .set .len.`,
    "Rules:",
    ...SLATE_RULES.map((r, i) => `${i + 1}. ${r}`),
    SLATE_INDEX_EXAMPLE,
    "More: slate_catalog <piece, source, runs, functions, steps, handlers, icons or examples>.",
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
<run name="check" cmd='gh api "repos/$REPO/issues/$ID"' env={{ REPO: $repo, ID: $id }} />
<run name="py">{\`python3 -c "print('both quotes, $HOME')"\`}</run>
Quoted cmd takes no escapes; the block above takes any text as written.
<run name="ci" cmd='gh secret set TOKEN --repo "$REPO"' stdin={$token} env={{ REPO: $repo }} on="host" />
The command is literal, run by bash -c in the thread's folder; values reach it only as env ($ID), args ($1) or stdin. A secret goes only on stdin or in the program's own env, never after a flag (W011).
on: host, else the thread. timeout: seconds, default 60, at most 600. every={60}: seconds, at least 10, while shown; always ticks hidden too. once: no restart while running.
start($run) in a handler or <when>. The person approves each command once; until then it reads held. confirm="Stop it?" or confirm={\`Kill \${$name}?\`} asks every start.
$run reads ${SLATE_RUN_FIELDS.join(" ")}; state is idle held running done failed cancelled; output is scrubbed of secrets.
Chain: <when done={$check} do={set($ok, $check.exit == 0)} />; done fires on any outcome.
Code written only for the slate goes in a <file name="x.py"> and runs as "$SLATE_DIR/x.py"; code the project already has is called where it is.
<run name="list" tool="server.tool" args={{ id: $id }} /> calls an MCP tool; resource="server:uri" reads one. slate_catalog <server> lists its tools. json is its structured result, else its text parsed. The person allows a server once per thread; a destructive tool asks every start. A secret in args returns as [secret:name].
A tool slate_catalog marks text only answers prose: json stays empty unless the text is JSON, and out draws as one block.
then='python3 inbox.py' on any run pipes its raw result (structured as JSON, else text) to that literal command; its stdout, as JSON, becomes json; out stays raw. Approved with the run; its failure fails the run.`;

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
  if (SLATE_PIECES[n] !== undefined) return pieceEntry(SLATE_PIECES[n]);
  if (SLATE_SOURCES[n] !== undefined) return sourceEntry(n);
  switch (n) {
    case "runs": case "run": return RUNS;
    case "functions": return functionsEntry();
    case "steps": return stepsEntry();
    case "handlers": return handlersEntry();
    case "examples": return SLATE_EXAMPLES.map(e => `${e.title}:\n${e.text}`).join("\n\n");
    case "icons": case "icon": return `icon="<name>" or icon={formula}; a name off this list draws none. Lucide names: ${SLATE_ICONS.join(" ")}`;
    default: {
      const options = [...Object.keys(SLATE_PIECES), ...Object.keys(SLATE_SOURCES), "runs", "functions", "steps", "handlers", "icons", "examples"];
      const fix = nearest(n, options);
      return `${n} is not in the catalog${fix !== undefined ? `; did you mean ${fix}?` : "."} Ask for a piece, a source, runs, functions, steps, handlers, icons or examples; a server's tools are the host's to answer.`;
    }
  }
}
