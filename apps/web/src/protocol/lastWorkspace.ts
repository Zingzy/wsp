// SPDX-License-Identifier: AGPL-3.0-only
// The workspace and thread the person had open last, kept in local storage
// under the state file the host serves, so the app opens where they left it
// and two state files served from one origin each keep their own. The app
// opens at its bare address after a restart, so this is the only record then.
import { bootPayload } from "../boot.js";

export const LAST_WORKSPACE_KEY = "wsp:last-workspace:v1";

export interface LastOpen {
  readonly workspaceId: string;
  readonly threadId?: string;
}

/** The state file this page's host serves; a page with no host (tests, dev) shares one unnamed slot. */
const stateFile = (): string => bootPayload()?.statePath ?? "";

/** A workspace id alone is what an earlier app wrote. */
function openOf(value: unknown): LastOpen | undefined {
  if (typeof value === "string") return { workspaceId: value };
  const v = value as Partial<Record<keyof LastOpen, unknown>> | null;
  if (v === null || typeof v !== "object" || typeof v.workspaceId !== "string") return undefined;
  return { workspaceId: v.workspaceId, ...(typeof v.threadId === "string" ? { threadId: v.threadId } : {}) };
}

function readAll(): Record<string, LastOpen> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_KEY) ?? "{}");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).flatMap(([file, value]) => {
      const open = openOf(value);
      return open === undefined ? [] : [[file, open]];
    }));
  } catch {
    return {};
  }
}

export function lastOpen(): LastOpen | undefined {
  return readAll()[stateFile()];
}

/** A storage that throws leaves the page opening on the first row next time. */
export function rememberOpen(workspaceId: string, threadId: string | null): void {
  try {
    const all = readAll();
    const held = all[stateFile()];
    if (held?.workspaceId === workspaceId && held.threadId === (threadId ?? undefined)) return;
    window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify({ ...all, [stateFile()]: { workspaceId, ...(threadId === null ? {} : { threadId }) } }));
  } catch {
    return;
  }
}
