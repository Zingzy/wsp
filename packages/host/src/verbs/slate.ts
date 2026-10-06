// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { turnTokenOf, usageRefusal, SLATE_TOOLS } from "@wsp/protocol";
import { type HostClient, type VerbDeps, type VerbContext, usageIs, tool, type Verb, flagList, pick } from "./client.js";
import { threadOf } from "./workspaces-help.js";
import { asText } from "./io.js";

// --- the slate: a live panel per thread the agent builds and the person reads, presses and fills in ---

const SlateThreadIn = z.string().optional().describe("another thread's id");
const SlateIfVersionIn = z.number().int().optional().describe("only at this version");
/** What every slate tool answers: the version and the sketch as text, the rest an open record the text already says. */
const slateOut = <K extends string>(...rest: K[]) => ({ version: z.number().int(), text: z.string(), ...(Object.fromEntries(rest.map(k => [k, z.unknown()])) as Record<K, z.ZodUnknown>) });

/** The thread a slate line names, as the host takes it: one named by id or prefix, else the turn this line runs
 * inside, else nothing, which the host reads off the caller's own token. */
async function slateTarget(client: HostClient, ref: string | undefined, env: VerbDeps["env"]): Promise<{ threadId?: string; turnToken?: string }> {
  if (ref !== undefined) {
    const thread = await threadOf(client, ref);
    return { threadId: thread.threadId ?? thread.id };
  }
  const token = turnTokenOf(env);
  return token !== undefined ? { turnToken: token } : {};
}

/** A slate op's answer without the reply frame's own id and ok, so both doors print the answer alone. */
async function slateAsk<T extends { text: string }>(client: HostClient, op: string, params: Record<string, unknown>): Promise<T> {
  const { id: _id, ok: _ok, ...answer } = await client.request<Record<string, unknown>>(op, params);
  return answer as T;
}

/** The sketch as the one frame ahead of the result, and the result without it. */
function emitSlate(ctx: VerbContext, answer: { text: string }): void {
  const { text, ...rest } = answer;
  ctx.out.emit({ text }, text);
  ctx.out.emit(rest);
}

/** A slate file as a write sends it: the JSX-like form for .slate, the stored document for .json. */
function slateFile(ctx: VerbContext, path: string): { text: string } | { document: Record<string, unknown> } {
  if (ctx.elsewhere === true) throw usageRefusal(`${path} is a file on your machine, which this host cannot read.`, "Pass the slate to slate_write as text instead.");
  const at = resolve(ctx.cwd ?? process.cwd(), path);
  if (!path.endsWith(".slate") && !path.endsWith(".json")) throw usageRefusal(`${path} is neither a .slate nor a .json file.`, "Write the JSX-like form to a .slate file or the stored form to a .json file.");
  let text: string;
  try {
    text = readFileSync(at, "utf8");
  } catch {
    throw usageRefusal(`there is no file at ${at}.`, "Name a .slate or .json file that is there.");
  }
  if (path.endsWith(".slate")) return { text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw usageRefusal(`${path} does not parse as JSON (${e instanceof Error ? e.message : String(e)}).`, "Fix the JSON or write the JSX-like form to a .slate file.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw usageRefusal(`${path} holds no JSON object.`, "Write the stored document, an object with schema, root and pieces.");
  return { document: parsed as Record<string, unknown> };
}

const ifVersionOf = (ctx: VerbContext): number | undefined => {
  const raw = ctx.flags["if-version"];
  if (typeof raw !== "string") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw usageRefusal(`--if-version takes a version number, and ${raw} is not one.`, usageIs(ctx));
  return n;
};

/** A $path=json word of a state line: the value parsed as JSON, else taken as the text it is. */
function stateValue(word: string): [string, unknown] | undefined {
  const at = word.indexOf("=");
  if (at <= 0) return undefined;
  const raw = word.slice(at + 1);
  try {
    return [word.slice(0, at), JSON.parse(raw)];
  } catch {
    return [word.slice(0, at), raw];
  }
}

export const SLATE_VERBS: readonly Verb[] = [
  {
    name: "slate catalog",
    usage: "wsp slate catalog [<name>]",
    about: "what a slate can hold: the index of pieces, sources, steps, functions and rules, or one entry in full",
    page: "agent",
    options: {},
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp slate catalog takes one name at most.", usageIs(ctx));
      const client = await ctx.client();
      const read = await slateAsk<{ text: string }>(client, "slates.catalog", { ...(await slateTarget(client, undefined, ctx.env)), ...pick({ name: ctx.args[0] }) });
      ctx.out.emit(read, read.text);
      return 0;
    },
    tool: tool({
      description: "What a slate, the live panel beside the chat, can hold: every piece, and the runs that keep it fresh. Call it first whenever the person wants to see, watch, monitor or keep an eye on something, tick things off as they go, or see what's unread, even when another tool fetches the data.",
      input: { name: z.string().optional().describe("leave out first: the index of every piece; then an entry, like runs") },
      output: { text: z.string() },
      call: async ({ name }, deps) => {
        const client = await deps.client();
        const read = await slateAsk<{ text: string }>(client, "slates.catalog", { ...(await slateTarget(client, undefined, deps.env)), ...pick({ name }) });
        return asText(read.text, read);
      },
    }),
  },
  {
    name: "slate write",
    usage: "wsp slate write [<thread>] [<file>] [--check] [--set <path>=<json>]... [--press <piece>] [--row <n>] [--action <n>] [--if-version <n>]",
    about: "writes the thread's slate from a .slate file (a whole <slate> or a patch) or a .json document and prints its sketch; --check stores nothing, and with --set or --press rehearses values and a press on a copy, the file optional",
    page: "agent",
    options: { check: { type: "boolean" }, set: { type: "string", multiple: true }, press: { type: "string" }, row: { type: "string" }, action: { type: "string" }, "if-version": { type: "string" } },
    run: async ctx => {
      const values: Record<string, unknown> = {};
      for (const word of flagList(ctx.flags, "set")) {
        const pair = stateValue(word);
        if (pair === undefined) throw usageRefusal(`--set ${word} is not <path>=<json>.`, "Write it like --set '$i=2'.");
        values[pair[0]] = pair[1];
      }
      const piece = typeof ctx.flags["press"] === "string" ? ctx.flags["press"] : undefined;
      const row = typeof ctx.flags["row"] === "string" ? Number(ctx.flags["row"]) : undefined;
      const action = typeof ctx.flags["action"] === "string" ? Number(ctx.flags["action"]) : undefined;
      for (const [flag, n] of [["row", row], ["action", action]] as const) if (n !== undefined && (piece === undefined || !Number.isInteger(n) || n < 0)) throw usageRefusal(`--${flag} goes with --press, a whole number from 0:`, usageIs(ctx));
      const rehearsal = Object.keys(values).length > 0 || piece !== undefined;
      const [a, b] = ctx.args;
      if ((a === undefined && !rehearsal) || ctx.args.length > 2) throw usageRefusal("wsp slate write takes a file, after a thread where it is not yours.", usageIs(ctx));
      const [ref, file] = b !== undefined ? [a, b] : a !== undefined && /\.(slate|json)$/.test(a) ? [undefined, a] : [a, undefined];
      if (file === undefined && !rehearsal) throw usageRefusal("wsp slate write takes a .slate or .json file, after a thread where it is not yours.", usageIs(ctx));
      const client = await ctx.client();
      const ifVersion = ifVersionOf(ctx);
      const rehearse = { ...(Object.keys(values).length > 0 ? { values } : {}), ...(piece !== undefined ? { press: { piece, ...(row !== undefined ? { index: row } : {}), ...(action !== undefined ? { action } : {}) } } : {}) };
      const wrote = await slateAsk<{ text: string }>(client, "slates.write", { ...(await slateTarget(client, ref, ctx.env)), ...(file !== undefined ? slateFile(ctx, file) : {}), ...(ctx.flags["check"] === true ? { check: true } : {}), ...rehearse, ...(ifVersion !== undefined ? { ifVersion } : {}) });
      emitSlate(ctx, wrote);
      return 0;
    },
    tool: tool({
      description: "Writes this thread's slate, the live panel shown here beside the chat. Use it to show the person anything they want to see, watch, monitor or keep an eye on while you work (live data, traffic, metrics, a price, logs, a PR, progress, status), or a dashboard, a form to fill in or a checklist. A run with every= refreshes itself on a timer with no turns, so nothing polls.",
      input: {
        thread: SlateThreadIn,
        text: z.string().optional().describe("JSX-like text: a <slate>, or a patch"),
        document: z.record(z.string(), z.unknown()).optional().describe("JSON form from slate_read; not for writing"),
        check: z.boolean().optional().describe("validate, write nothing"),
        values: z.record(z.string(), z.unknown()).optional().describe("with check: $path: value"),
        press: z.string().optional().describe("with check: piece id to press"),
        row: z.number().int().optional().describe("pressed row, from 0"),
        action: z.number().int().optional().describe("row action, from 0"),
        if_version: SlateIfVersionIn,
      },
      output: slateOut("warnings", "problems", "waiting"),
      stream: ["text"],
      call: async ({ thread, text, document, check, values, press, row, action, if_version }, deps) => {
        const client = await deps.client();
        const pressed = press === undefined ? undefined : { piece: press, ...pick({ index: row, action }) };
        const wrote = await slateAsk<{ text: string }>(client, "slates.write", { ...(await slateTarget(client, thread, deps.env)), ...pick({ text, document, check, values, press: pressed, ifVersion: if_version }) });
        return asText(wrote.text, wrote);
      },
    }),
  },
  {
    name: "slate state",
    usage: "wsp slate state [<thread>] [<path>=<json>...] [--start <run>]... [--if-version <n>]",
    about: "sets the slate's $values by path, like '$steps[2].done=true' or 'i=2', starts runs the person let run every time, and prints its sketch",
    page: "agent",
    options: { "if-version": { type: "string" }, start: { type: "string", multiple: true } },
    run: async ctx => {
      const values: Record<string, unknown> = {};
      const rest: string[] = [];
      for (const word of ctx.args) {
        const pair = stateValue(word);
        if (pair === undefined) rest.push(word);
        else values[pair[0]] = pair[1];
      }
      const start = flagList(ctx.flags, "start");
      if (rest.length > 1 || (Object.keys(values).length === 0 && start.length === 0)) throw usageRefusal("wsp slate state takes $path=<json> words or --start <run>, after a thread where it is not yours.", usageIs(ctx));
      const client = await ctx.client();
      const ifVersion = ifVersionOf(ctx);
      const wrote = await slateAsk<{ text: string }>(client, "slates.state", { ...(await slateTarget(client, rest[0], ctx.env)), ...(Object.keys(values).length > 0 ? { values } : {}), ...(start.length > 0 ? { start } : {}), ...(ifVersion !== undefined ? { ifVersion } : {}) });
      emitSlate(ctx, wrote);
      return 0;
    },
    tool: tool({
      description: "Sets the slate's live $values by path, so the person sees progress, status or a checklist tick move as you work; reactions fire. start starts a run the person allowed to run always.",
      input: { thread: SlateThreadIn, values: z.record(z.string(), z.unknown()).optional().describe("$path: new value"), start: z.array(z.string()).optional().describe("runs allowed always"), if_version: SlateIfVersionIn },
      output: slateOut("problems", "waiting", "notStarted"),
      stream: ["text"],
      call: async ({ thread, values, start, if_version }, deps) => {
        const client = await deps.client();
        const wrote = await slateAsk<{ text: string }>(client, "slates.state", { ...(await slateTarget(client, thread, deps.env)), ...pick({ values, start, ifVersion: if_version }) });
        return asText(wrote.text, wrote);
      },
    }),
  },
  {
    name: "slate read",
    usage: "wsp slate read [<thread>] [--values <path>]... [--no-text] [--no-sketch] [--document]",
    about: "the slate as it stands: the sketch, then the JSX-like form, the values, derived values, runs, problems and the paths named; --no-text leaves out the JSX-like form, --document adds the stored JSON",
    page: "agent",
    options: { values: { type: "string", multiple: true }, "no-text": { type: "boolean" }, "no-sketch": { type: "boolean" }, document: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp slate read takes one thread at most.", usageIs(ctx));
      const client = await ctx.client();
      const values = flagList(ctx.flags, "values");
      const read = await slateAsk<{ text: string }>(client, "slates.read", { ...(await slateTarget(client, ctx.args[0], ctx.env)), ...(values.length > 0 ? { values } : {}), ...(ctx.flags["no-text"] === true ? { text: false } : {}), ...(ctx.flags["no-sketch"] === true ? { sketch: false } : {}), ...(ctx.flags["document"] === true ? { document: true } : {}) });
      emitSlate(ctx, read);
      return 0;
    },
    tool: tool({
      description: "Reads this thread's slate: what the person filled in or pressed, live values, run output and logs, and the sketch: the panel's words as the person sees them.",
      input: { thread: SlateThreadIn, values: z.array(z.string()).optional().describe("$run.json, $value, source path, or *"), text: z.boolean().optional().describe("false: no JSX-like form"), sketch: z.boolean().optional().describe("false: no sketch"), document: z.boolean().optional().describe("true: add stored JSON") },
      output: slateOut("document", "values", "derived", "runs", "state", "problems", "waiting", "comments", "approvals"),
      stream: ["text"],
      call: async ({ thread, values, text, sketch, document }, deps) => {
        const client = await deps.client();
        const read = await slateAsk<{ text: string }>(client, "slates.read", { ...(await slateTarget(client, thread, deps.env)), ...pick({ values, text, sketch, document }) });
        return asText(read.text, read);
      },
    }),
  },
];

/** The slate's tools: loaded up front by a client that defers tools behind a search, since a model that never searched
 * never found them, and left off a server for a thread that has no slate. */
export const SLATE_TOOL_NAMES: ReadonlySet<string> = new Set<string>(SLATE_TOOLS);
