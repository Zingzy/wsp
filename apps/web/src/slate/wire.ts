// SPDX-License-Identifier: AGPL-3.0-only
// The window's slate ops (01-architecture, "Wire operations"), each answer parsed against the wire type.
import { SlateEventAnswer, SlateReadAnswer, SlatesGetAnswer, SlatesResolveAnswer, SlateStateAnswer, SlateWriteAnswer, type SlateDoc, type SlateJson, type SlateView } from "@wsp/protocol";
import type { SlateEventAsk } from "./actions.js";
import type { SlateApproval } from "./model.js";

interface Requester {
  request<T = Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T>;
}

/** The schema this renderer draws; a newer document is held untouched and the tab says so (13, "Versioning"). */
export const SLATE_SCHEMA = 2;

/** One thread's slate as the window draws it: the host's record with its document checked for a slate's frame. */
export type SlateRecord = Omit<SlateView, "document" | "values"> & { document: SlateDoc | null; values: Record<string, SlateJson> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isSlateDoc(v: unknown): v is SlateDoc {
  return isObject(v) && v["schema"] === SLATE_SCHEMA && typeof v["root"] === "string" && isObject(v["pieces"]) && Object.values(v["pieces"]).every(p => isObject(p) && typeof p["type"] === "string");
}

function recordOf(view: SlateView | null): { record: SlateRecord | null; newer?: number } {
  if (view === null) return { record: null };
  const values = view.values as Record<string, SlateJson>;
  const schema = view.document?.["schema"];
  if (typeof schema === "number" && schema > SLATE_SCHEMA) return { record: { ...view, values, document: null }, newer: schema };
  return { record: { ...view, values, document: isSlateDoc(view.document) ? view.document : null } };
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
  const write = async (threadId: string, text: string) => SlateWriteAnswer.parse(await c.request<unknown>("slates.write", { threadId, text }));
  return {
    get: async threadId => recordOf(SlatesGetAnswer.parse(await c.request<unknown>("slates.get", { threadId })).slate),
    state: async (threadId, values) => SlateStateAnswer.parse(await c.request<unknown>("slates.state", { threadId, values })),
    event: async (threadId, ask) => SlateEventAnswer.parse(await c.request<unknown>("slates.event", { threadId, ...ask })),
    approve: async (threadId, key, scope) => void (await c.request("slates.approve", { threadId, key, scope })),
    cancel: async (threadId, run) => void (await c.request("slates.cancel", { threadId, run })),
    shown: async threadId => void (await c.request("slates.shown", { threadId })),
    sketch: async threadId => SlateReadAnswer.parse(await c.request<unknown>("slates.read", { threadId, sketch: true })).text,
    undo: threadId => write(threadId, "<undo />"),
    clear: threadId => write(threadId, "<clear />"),
    subscribe: async (threadId, sources) => void (await c.request("slates.subscribe", { threadId, sources: [...sources] })),
    unsubscribe: async (threadId, sources) => void (await c.request("slates.unsubscribe", { threadId, sources: [...sources] })),
    resolve: async (threadId, paths) => SlatesResolveAnswer.parse(await c.request<unknown>("slates.resolve", { threadId, paths: [...paths] })).values,
  };
}
