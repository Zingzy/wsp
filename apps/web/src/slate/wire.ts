// SPDX-License-Identifier: AGPL-3.0-only
// The window's slate ops (01-architecture, "Wire operations"), each answer parsed against the wire type.
import { SlateActAnswer, SlatesGetAnswer, SlatesResolveAnswer, SlateStateAnswer, type SlateView as SlateRecord } from "@wsp/protocol";
import type { SlateActAsk } from "./actions.js";

interface Requester {
  request<T = Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T>;
}

export interface SlateApi {
  get(threadId: string): Promise<SlateRecord | null>;
  state(threadId: string, values: Record<string, unknown>): Promise<{ version: number }>;
  act(threadId: string, ask: SlateActAsk): Promise<SlateActAnswer>;
  shown(threadId: string): Promise<void>;
  undo(threadId: string): Promise<{ version: number }>;
  clear(threadId: string): Promise<{ version: number }>;
  subscribe(threadId: string, sources: readonly string[]): Promise<void>;
  unsubscribe(threadId: string, sources: readonly string[]): Promise<void>;
  resolve(threadId: string, paths: readonly string[]): Promise<Record<string, unknown>>;
}

export function slateApi(c: Requester): SlateApi {
  return {
    get: async threadId => SlatesGetAnswer.parse(await c.request<unknown>("slates.get", { threadId })).slate,
    state: async (threadId, values) => SlateStateAnswer.parse(await c.request<unknown>("slates.state", { threadId, values })),
    act: async (threadId, ask) => SlateActAnswer.parse(await c.request<unknown>("slates.act", { threadId, ...ask })),
    shown: async threadId => void (await c.request("slates.shown", { threadId })),
    undo: async threadId => ({ version: Number((await c.request<{ version?: unknown }>("slates.undo", { threadId })).version) }),
    clear: async threadId => ({ version: Number((await c.request<{ version?: unknown }>("slates.clear", { threadId })).version) }),
    subscribe: async (threadId, sources) => void (await c.request("slates.subscribe", { threadId, sources: [...sources], feeds: [] })),
    unsubscribe: async (threadId, sources) => void (await c.request("slates.unsubscribe", { threadId, sources: [...sources], feeds: [] })),
    resolve: async (threadId, paths) => SlatesResolveAnswer.parse(await c.request<unknown>("slates.resolve", { threadId, paths: [...paths] })).values,
  };
}
