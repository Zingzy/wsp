// SPDX-License-Identifier: AGPL-3.0-only
// The sources of kit wsp/2 (06-sources) as the protocol holds them: each one's declared paths with their shapes,
// how it updates, its scope, its cost and its catalog text. The renderer's select and the host's resolve live
// beside the app and the runtime; this registry is what the checker and the catalog read.
import { CHECK_STATE_WORDS } from "../pull-request.js";
import { LIMIT_KINDS } from "../usage.js";
import type { SlateType } from "./expr.js";
import { nearest } from "./problems.js";

/** A declared path's shape: a scalar, an enum, a list of a shape, or a record of fields. */
export type SlateShape =
  | "number" | "string" | "boolean" | "time" | "any"
  | { enum: readonly string[] }
  | { list: SlateShape }
  | { fields: Record<string, SlateShape> }
  /** mcp.<server>: a record keyed by any name, each of this shape. */
  | { keyed: SlateShape };

export interface SlateSourceModule {
  name: string;
  level: "core" | "working";
  purpose: string;
  update: "push" | "subscription" | "poll" | "tick";
  cost: string;
  scope: string;
  shape: { fields: Record<string, SlateShape> } | { keyed: SlateShape };
  /** Paths the registry marks as time series, which bars warns on. */
  series?: readonly string[];
  /** Notes per path for the catalog: which agents report it, when it is null. */
  notes?: Record<string, string>;
  example: string;
}

const rec = (fields: Record<string, SlateShape>): { fields: Record<string, SlateShape> } => ({ fields });
const list = (of: SlateShape): SlateShape => ({ list: of });
const oneOf = (values: readonly string[]): SlateShape => ({ enum: values });
const points = list(rec({ x: "number", y: "number" }));

export const SLATE_SOURCES: Readonly<Record<string, SlateSourceModule>> = {
  thread: {
    name: "thread", level: "core", purpose: "This thread: status, last turn, context, cost, tokens, changes, plan.",
    update: "push", cost: "none beyond today", scope: "the slate's own thread",
    shape: rec({
      id: "string", title: "string", agent: "string", model: "string", effort: "string",
      status: oneOf(["starting", "working", "needs-you", "failed", "done", "resting"]),
      access: "string", computer: "string", project: "string", folder: "string", turns: "number",
      lastTurn: rec({ status: "string", durationMs: "number", waitedMs: "number", startedAt: "time", endedAt: "time", model: "string" }),
      cost: rec({ usd: "number" }),
      tokens: rec({ input: "number", output: "number", cached: "number", cacheWrite: "number", reasoning: "number" }),
      context: rec({ used: "number", window: "number", free: "number", percent: "number" }),
      changes: rec({ files: list(rec({ path: "string", kind: "string", additions: "number", deletions: "number" })), from: "string", to: "string", moved: list("any"), shared: "boolean" }),
      plan: rec({ steps: list(rec({ text: "string", state: oneOf(["pending", "working", "done"]) })), text: "string" }),
      waitingOn: "string",
      subagents: list(rec({ id: "string", title: "string", state: "string", startedAt: "time", endedAt: "time" })),
      messages: rec({ recent: list(rec({ who: "string", at: "time", text: "string" })), last: "string" }),
    }),
    notes: { "thread.context": "the latest turn that reports it; null on an agent that does not", "thread.changes.files": "the latest session.changes" },
    example: "percent(thread.context.used / thread.context.window)",
  },
  tree: {
    name: "tree", level: "working", purpose: "The thread's root and every thread under it.",
    update: "push", cost: "none beyond today", scope: "the thread's tree",
    shape: rec({
      root: rec({ id: "string", title: "string", status: "string", agent: "string", computer: "string" }),
      parent: rec({ id: "string", title: "string", status: "string", agent: "string", computer: "string" }),
      children: list(rec({ id: "string", title: "string", status: "string", agent: "string", computer: "string", costUsd: "number", startedAt: "time", endedAt: "time" })),
      all: list(rec({ id: "string", title: "string", status: "string", agent: "string", computer: "string", depth: "number" })),
      counts: rec({ working: "number", needsYou: "number", done: "number", failed: "number", resting: "number" }),
    }),
    example: "tree.counts.working",
  },
  usage: {
    name: "usage", level: "core", purpose: "The plan windows of the account the thread runs on.",
    update: "push", cost: "one event per turn end", scope: "the account the thread runs on",
    shape: rec({
      account: rec({ key: "string", label: "string", agent: "string", plan: "string", address: "string", computers: list("string") }),
      windows: list(rec({ kind: oneOf(LIMIT_KINDS), usedPercent: "number", resetsAt: "time" })),
      session: rec({ percent: "number", resetsAt: "time" }),
      week: rec({ percent: "number", resetsAt: "time" }),
      status: oneOf(["ok", "warning", "reached"]),
      note: "string",
      burn: rec({ tokensPerMinute: "number", threads: "number" }),
      credits: rec({ count: "number", nextExpiresAt: "time" }),
      readAt: "time",
    }),
    notes: { "usage.windows": "Claude Code and Codex report them; a keyed sign-in has none and usage.note says why" },
    example: "pct(usage.week.percent)",
  },
  cost: {
    name: "cost", level: "core", purpose: "The workspace's cost: the rate now and what it has run up.",
    update: "push", cost: "none beyond today", scope: "the thread's workspace",
    shape: rec({ rateUsdPerHour: "number", accruedUsd: "number" }),
    notes: { "cost.rateUsdPerHour": "0 on this computer, which usd() reads as free" },
    example: "usd(cost.accruedUsd)",
  },
  time: {
    name: "time", level: "core", purpose: "The clock, so a countdown or an age moves on its own.",
    update: "tick", cost: "one re-evaluation a tick", scope: "none",
    shape: rec({ now: "number", today: "string", zone: "string" }),
    notes: { "time.now": "ms epoch; ticks each second while a visible piece reads it" },
    example: "until(usage.week.resetsAt)",
  },
  git: {
    name: "git", level: "core", purpose: "The thread's checkout: branch, head, counts against upstream.",
    update: "push", cost: "none for the checkout; status entries poll 15 s while bound", scope: "the thread's folder",
    shape: rec({
      branch: "string", head: "string", ahead: "number", behind: "number", changed: "number", stashes: "number",
      editsUnread: "boolean", countsUnknown: "boolean", readAt: "time",
      status: rec({ entries: list(rec({ xy: "string", path: "string", origPath: "string" })) }),
    }),
    notes: { "git.branch": "null on a folder that is not a checkout" },
    example: "git.branch",
  },
  pr: {
    name: "pr", level: "core", purpose: "The pull request of the thread's branch and its checks.",
    update: "push", cost: "one gh read every 3 min; every 30 s while a bound check is pending", scope: "the thread's folder",
    shape: rec({
      number: "number", url: "string", state: oneOf(["open", "merged", "closed"]), draft: "boolean", base: "string", branch: "string",
      headOid: "string", headSubject: "string",
      mergeable: oneOf(["mergeable", "conflicting", "unknown"]),
      review: oneOf(["none", "approved", "changes_asked", "required"]),
      checks: list(rec({ name: "string", workflow: "string", state: oneOf(Object.keys(CHECK_STATE_WORDS)), link: "string", description: "string", startedAt: "time", completedAt: "time" })),
      additions: "number", deletions: "number", changedFiles: "number", commits: "number", behindBase: "number",
      author: "string", readAt: "time", word: "string", unread: "string",
    }),
    notes: { "pr.number": "null while the branch has no pull request", "pr.headSubject": "the head commit's subject; there is no pr.title" },
    example: "pr.checks | where(item.state == 'fail') | count",
  },
  machine: {
    name: "machine", level: "working", purpose: "The thread's computer: load, memory, disk and their last minute.",
    update: "subscription", cost: "one sample a second while bound", scope: "the thread's computer",
    shape: rec({
      name: "string", cpu: "number", load1: "number", mem: rec({ used: "number", total: "number" }), disk: rec({ used: "number", total: "number" }), at: "time",
      history: rec({ cpu: points, load1: points, mem: points }),
    }),
    series: ["machine.history.cpu", "machine.history.load1", "machine.history.mem"],
    example: "bytes(machine.mem.used)",
  },
  processes: {
    name: "processes", level: "working", purpose: "The thread's computer's processes.",
    update: "subscription", cost: "one snapshot every 2 s while bound", scope: "the thread's computer",
    shape: rec({ list: list(rec({ pid: "number", name: "string", cpu: "number", mem: "number", cmd: "string" })), total: "number", at: "time" }),
    example: "processes.list | sortBy(item.cpu, 'desc') | take(5)",
  },
  ports: {
    name: "ports", level: "working", purpose: "Ports open on the thread's computer.",
    update: "push", cost: "none beyond today", scope: "the thread's computer",
    shape: rec({ list: list(rec({ port: "number", process: "string", url: "string" })) }),
    example: "ports.list",
  },
  notifications: {
    name: "notifications", level: "working", purpose: "The last 20 notices for this thread and its account.",
    update: "push", cost: "none beyond today", scope: "this thread and its account",
    shape: rec({ recent: list(rec({ kind: "string", text: "string", at: "time" })) }),
    example: "notifications.recent | first",
  },
  mcp: {
    name: "mcp", level: "working", purpose: "The thread's agent's MCP servers: consent state, tools, resources.",
    update: "push", cost: "a listing on connect", scope: "servers configured for the thread's agent",
    shape: { keyed: rec({
      state: oneOf(["unasked", "asked", "allowed", "refused", "down"]),
      tools: list(rec({ name: "string", title: "string", description: "string", inputSchema: "any", annotations: "any", ui: "string" })),
      resources: list(rec({ uri: "string", name: "string", mimeType: "string", description: "string" })),
    }) },
    example: "mcp.linear.state",
  },
};

/** A shape as a checker type. */
export function slateShapeType(shape: SlateShape): SlateType {
  if (shape === "number" || shape === "time") return { t: shape === "time" ? "any" : "number" };
  if (shape === "string") return { t: "string" };
  if (shape === "boolean") return { t: "boolean" };
  if (shape === "any") return { t: "any" };
  if ("enum" in shape) return { t: "string" };
  if ("list" in shape) return { t: "list", of: slateShapeType(shape.list) };
  if ("keyed" in shape) return { t: "any" };
  return { t: "record", fields: Object.fromEntries(Object.entries(shape.fields).map(([k, v]) => [k, slateShapeType(v)])) };
}

/** A source path's type, or the problem naming the nearest declared path. */
export function slateSourceType(head: string, segs: readonly (string | number)[]): SlateType | { code: "X401"; message: string; fix?: string } {
  const source = SLATE_SOURCES[head];
  if (source === undefined) {
    const fix = nearest(head, Object.keys(SLATE_SOURCES));
    return { code: "X401", message: `${head} is not a path${fix !== undefined ? `; did you mean ${fix}?` : `; sources are ${Object.keys(SLATE_SOURCES).join(", ")}, and the slate's own values are $name`}`, ...(fix !== undefined ? { fix } : {}) };
  }
  let shape: SlateShape = source.shape;
  let walked = head;
  for (const [at, seg] of segs.entries()) {
    if (typeof seg === "number") {
      if (typeof shape === "object" && "list" in shape) { shape = shape.list; walked += `[${seg}]`; continue; }
      return { t: "any" };
    }
    if (typeof shape === "object" && "keyed" in shape) { shape = shape.keyed; walked += `.${seg}`; continue; }
    if (typeof shape !== "object" || !("fields" in shape)) return { t: "any" };
    const next: SlateShape | undefined = shape.fields[seg];
    if (next === undefined) {
      const fix = nearest(seg, Object.keys(shape.fields));
      const rest = segs.slice(at + 1).map(s => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("");
      const fixed = fix !== undefined ? `${walked}.${fix}${rest}` : undefined;
      return { code: "X401", message: `${walked}.${seg}${rest} is not a path${fixed !== undefined ? `. Did you mean ${fixed}?` : `; ${walked} has ${Object.keys(shape.fields).join(", ")}`}`, ...(fixed !== undefined ? { fix: fixed } : {}) };
    }
    shape = next;
    walked += `.${seg}`;
  }
  return slateShapeType(shape);
}

/** Whether a source path is a registered time series. */
export const slateIsSeries = (path: string): boolean => Object.values(SLATE_SOURCES).some(s => (s.series ?? []).includes(path));

/** A shape as one short phrase, for the catalog and the checker's messages. */
export function slateShapeText(shape: SlateShape): string {
  if (typeof shape === "string") return shape;
  if ("enum" in shape) return shape.enum.join("|");
  if ("list" in shape) return `${slateShapeText(shape.list)}[]`;
  if ("keyed" in shape) return `<name>: ${slateShapeText(shape.keyed)}`;
  return `{ ${Object.entries(shape.fields).map(([k, v]) => (typeof v === "string" && v !== "any" ? k : `${k}: ${slateShapeText(v)}`)).join(", ")} }`;
}
