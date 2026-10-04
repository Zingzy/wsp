// SPDX-License-Identifier: AGPL-3.0-only
// The window's slate ops (01-architecture, "Wire operations"), each answer parsed where it crosses in.
import type { SlateJson } from "@wsp/protocol";
import type { SlateEventAnswer, SlateEventAsk } from "./actions.js";
import type { SlateApproval, SlateAsk, SlateDoc } from "./model.js";

interface Requester {
  request<T = Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T>;
}

/** The schema this renderer draws; a newer document is held untouched and the tab says so (13, "Versioning"). */
export const SLATE_SCHEMA = 2;

/** One thread's slate as slates.get answers it, the document checked for its frame. */
export interface SlateRecord {
  document: SlateDoc | null;
  values: Record<string, SlateJson>;
  version: number;
  shownOnce?: boolean;
  canUndo?: boolean;
  empty?: "none" | "cleared" | "rewound-before";
  /** Every held run's sheet, oldest first. */
  asks: SlateAsk[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const EMPTY: readonly unknown[] = ["none", "cleared", "rewound-before"] satisfies NonNullable<SlateRecord["empty"]>[];
const isEmptyWord = (v: unknown): v is NonNullable<SlateRecord["empty"]> => EMPTY.includes(v);

class WireFault extends Error {}
const fault = (op: string): never => {
  throw new WireFault(`The host answered ${op} in a shape this window does not read.`);
};

function isSlateDoc(v: unknown): v is SlateDoc {
  return isObject(v) && v["schema"] === SLATE_SCHEMA && typeof v["root"] === "string" && isObject(v["pieces"]) && Object.values(v["pieces"]).every(p => isObject(p) && typeof p["type"] === "string");
}

function recordOf(raw: unknown): { record: SlateRecord | null; newer?: number } {
  const slate = isObject(raw) && "slate" in raw ? raw["slate"] : raw;
  if (slate === null || slate === undefined) return { record: null };
  if (!isObject(slate) || typeof slate["version"] !== "number") return fault("slates.get");
  const doc = slate["document"];
  const empty = slate["empty"];
  const base = {
    values: (isObject(slate["values"]) ? slate["values"] : {}) as Record<string, SlateJson>,
    version: slate["version"],
    ...(typeof slate["shownOnce"] === "boolean" ? { shownOnce: slate["shownOnce"] } : {}),
    ...(typeof slate["canUndo"] === "boolean" ? { canUndo: slate["canUndo"] } : {}),
    ...(isEmptyWord(empty) ? { empty } : {}),
    asks: Array.isArray(slate["asks"]) ? slate["asks"].flatMap(ask => askOf(ask) ?? []) : [],
  };
  const schema = isObject(doc) ? doc["schema"] : undefined;
  if (typeof schema === "number" && schema > SLATE_SCHEMA) return { record: { ...base, document: null }, newer: schema };
  return { record: { ...base, document: isSlateDoc(doc) ? doc : null } };
}

const strings = (v: unknown): Record<string, string> | undefined =>
  isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? x : JSON.stringify(x)])) : undefined;

function askOf(v: unknown): SlateAsk | undefined {
  if (!isObject(v)) return undefined;
  const { key, run, cmd, computer, folder, timeoutS, why, stdin, confirm } = v;
  if (typeof key !== "string" || typeof run !== "string" || typeof cmd !== "string" || typeof computer !== "string" || typeof folder !== "string" || typeof timeoutS !== "number") return undefined;
  return {
    key, run, kind: "cmd", cmd, computer, folder, timeoutS,
    why: typeof why === "string" ? why : "",
    env: strings(v["env"]) ?? {},
    args: Array.isArray(v["args"]) ? v["args"].map(a => (typeof a === "string" ? a : JSON.stringify(a))) : [],
    ...(typeof stdin === "string" ? { stdin } : {}),
    ...(typeof confirm === "string" ? { confirm } : {}),
  };
}

function versionOf(op: string, raw: unknown): { version: number } {
  return isObject(raw) && typeof raw["version"] === "number" ? { version: raw["version"] } : fault(op);
}

export interface SlateApi {
  /** The record, or, for a document of a schema this build does not know, the record without it and that schema. */
  get(threadId: string): Promise<{ record: SlateRecord | null; newer?: number }>;
  state(threadId: string, values: Record<string, SlateJson>): Promise<{ version: number }>;
  event(threadId: string, ask: SlateEventAsk): Promise<SlateEventAnswer>;
  approve(threadId: string, key: string, scope: SlateApproval): Promise<void>;
  cancel(threadId: string, run: string): Promise<void>;
  shown(threadId: string): Promise<void>;
  /** The slate as text, the sketch the agent reads (10). */
  sketch(threadId: string): Promise<string>;
  undo(threadId: string): Promise<{ version: number }>;
  clear(threadId: string): Promise<{ version: number }>;
  subscribe(threadId: string, sources: readonly string[]): Promise<void>;
  unsubscribe(threadId: string, sources: readonly string[]): Promise<void>;
  resolve(threadId: string, paths: readonly string[]): Promise<Record<string, unknown>>;
}

export function slateApi(c: Requester): SlateApi {
  const write = async (threadId: string, text: string) => versionOf("slates.write", await c.request<unknown>("slates.write", { threadId, text }));
  return {
    get: async threadId => recordOf(await c.request<unknown>("slates.get", { threadId })),
    state: async (threadId, values) => versionOf("slates.state", await c.request<unknown>("slates.state", { threadId, values })),
    event: async (threadId, ask) => {
      const raw = await c.request<unknown>("slates.event", { threadId, ...ask });
      if (!isObject(raw) || typeof raw["outcome"] !== "string") return fault("slates.event");
      const held = askOf(raw["ask"]);
      return { outcome: raw["outcome"], ...(typeof raw["said"] === "string" ? { said: raw["said"] } : {}), ...(held !== undefined ? { ask: held } : {}) };
    },
    approve: async (threadId, key, scope) => void (await c.request("slates.approve", { threadId, key, scope })),
    cancel: async (threadId, run) => void (await c.request("slates.cancel", { threadId, run })),
    shown: async threadId => void (await c.request("slates.shown", { threadId })),
    sketch: async threadId => {
      const raw = await c.request<unknown>("slates.read", { threadId, sketch: true });
      return isObject(raw) && typeof raw["text"] === "string" ? raw["text"] : isObject(raw) && typeof raw["sketch"] === "string" ? raw["sketch"] : fault("slates.read");
    },
    undo: threadId => write(threadId, "<undo />"),
    clear: threadId => write(threadId, "<clear />"),
    subscribe: async (threadId, sources) => void (await c.request("slates.subscribe", { threadId, sources: [...sources] })),
    unsubscribe: async (threadId, sources) => void (await c.request("slates.unsubscribe", { threadId, sources: [...sources] })),
    resolve: async (threadId, paths) => {
      const raw = await c.request<unknown>("slates.resolve", { threadId, paths: [...paths] });
      return isObject(raw) && isObject(raw["values"]) ? raw["values"] : fault("slates.resolve");
    },
  };
}
