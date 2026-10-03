// SPDX-License-Identifier: AGPL-3.0-only
// The creations whose first message this window queues on the workspace once it
// is up, kept in local storage under the state file the host serves until then:
// the message lives nowhere else, and a reload, a closed window or a crash while
// the copy is made must lose neither it nor the row that draws it. One page at a
// time owns a kept row, the page holding its lock, and only that page delivers
// its message or writes it: a second tab on the same host leaves it alone.
import { WorkspaceSize } from "@wsp/protocol";
import { bootPayload } from "../boot.js";
import type { Creation, CreationLine, Opens } from "./store.js";

export const KEPT_CREATIONS_KEY = "wsp:creations:v1";

/** The state file this page's host serves; a page with no host (tests, dev) shares one unnamed slot. */
const stateFile = (): string => bootPayload()?.statePath ?? "";

function readAll(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEPT_CREATIONS_KEY) ?? "{}");
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): v is string => typeof v === "string" && v !== "";

function lineOf(raw: unknown): CreationLine | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!text(r["stage"]) || typeof r["message"] !== "string" || typeof r["at"] !== "string" || typeof r["elapsedMs"] !== "number") return undefined;
  return {
    stage: r["stage"] as CreationLine["stage"],
    message: r["message"],
    at: r["at"],
    elapsedMs: r["elapsedMs"],
    ...(typeof r["notice"] === "string" ? { notice: r["notice"] } : {}),
    ...(typeof r["detail"] === "string" ? { detail: r["detail"] } : {}),
  };
}

const OPENS_WORDS = ["model", "effort", "permissionMode", "contextWindow", "attempt"] as const;

function opensOf(raw: unknown): Opens | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!text(r["harness"])) return undefined;
  const words = Object.fromEntries(OPENS_WORDS.flatMap(w => (text(r[w]) ? [[w, r[w]]] : [])));
  return { harness: r["harness"], ...words, ...(typeof r["fast"] === "boolean" ? { fast: r["fast"] } : {}) };
}

function creationOf(raw: unknown): Creation | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!text(r["key"]) || !text(r["name"]) || !text(r["project"]) || !text(r["asked"]) || typeof r["askedAt"] !== "number") return undefined;
  const workspaceId = text(r["workspaceId"]) ? r["workspaceId"] : null;
  const f = r["failed"] as Record<string, unknown> | null | undefined;
  const failed = f !== null && typeof f === "object" && typeof f["title"] === "string" && typeof f["detail"] === "string" ? { title: f["title"], detail: f["detail"] } : null;
  const size = WorkspaceSize.safeParse(r["size"]);
  const opens = opensOf(r["opens"]);
  return {
    key: r["key"],
    name: r["name"],
    project: r["project"],
    askedAt: r["askedAt"],
    asked: r["asked"],
    queued: true,
    ...(opens !== undefined ? { opens } : {}),
    ...(text(r["golden"]) ? { golden: r["golden"] } : {}),
    ...(size.success ? { size: size.data } : {}),
    ...(text(r["where"]) ? { where: r["where"] } : {}),
    workspaceId,
    lines: Array.isArray(r["lines"]) ? r["lines"].flatMap(l => lineOf(l) ?? []) : [],
    failed,
  };
}

/** What this state file's pages left kept, its stage log with it, so a refused row reads the step it stopped on. */
export function keptCreations(): Creation[] {
  const rows = readAll()[stateFile()];
  return Array.isArray(rows) ? rows.flatMap(r => creationOf(r) ?? []) : [];
}

/** The rows this page owns now, and every row it ever owned: a row this page let go of is one it took out of the
 * store, and any other row stored is another page's to keep or drop. */
const owned = new Set<string>();
const everOwned = new Set<string>();
const releases = new Map<string, () => void>();
const gone = new Set<string>();

const lockName = (key: string): string => `wsp:creation:${key}`;

/** The browser's lock on a row is held for as long as this page owns it and dropped when the page goes, reloaded,
 * closed or crashed. A page served where the browser has no locks (a plain-http address that is not localhost) owns
 * every row it holds, as a page did before rows had owners. */
function hold(key: string, taken: () => void, refused: () => void): void {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) {
    taken();
    return;
  }
  void locks.request(lockName(key), { ifAvailable: true }, lock => {
    if (lock === null) {
      refused();
      return undefined;
    }
    if (gone.has(key)) return undefined;
    taken();
    return new Promise<void>(release => releases.set(key, release));
  });
}

const take = (key: string): void => {
  owned.add(key);
  everOwned.add(key);
};

/** Asks for the rows a page before this one left: each is this page's once its lock is, and another page's while
 * that page holds it, which `lost` drops from this page's store. */
export function claimKept(rows: readonly Creation[], lost: (key: string) => void): void {
  for (const row of rows) hold(row.key, () => take(row.key), () => lost(row.key));
}

/** A row this page made under a key it minted is its own from the press. */
export function own(key: string): void {
  take(key);
  hold(key, () => {}, () => {});
}

/** The row left this page's store; its lock goes once the store has been written without it. */
export function letGo(key: string): void {
  gone.add(key);
  owned.delete(key);
  releases.get(key)?.();
  releases.delete(key);
}

/** Writes the rows this page owns and leaves every other page's as stored. A storage that throws keeps nothing,
 * which is the page as it was before anything was kept. */
export function keepCreations(rows: readonly Creation[]): void {
  const kept = rows.filter(row => owned.has(row.key)).map(({ attachments: _files, ...row }) => row);
  try {
    const all = readAll();
    const stored = all[stateFile()];
    const others = Array.isArray(stored) ? stored.filter(r => !everOwned.has(String((r as { key?: unknown } | null)?.key))) : [];
    const { [stateFile()]: _mine, ...rest } = all;
    const slot = [...others, ...kept];
    window.localStorage.setItem(KEPT_CREATIONS_KEY, JSON.stringify(slot.length === 0 ? rest : { ...rest, [stateFile()]: slot }));
  } catch {
    return;
  }
}
