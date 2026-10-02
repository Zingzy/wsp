// SPDX-License-Identifier: AGPL-3.0-only
// The creations whose first message this window queues on the workspace once it
// is up, kept in local storage under the state file the host serves until then:
// the message lives nowhere else, and a reload, a closed window or a crash while
// the copy is made must lose neither it nor the row that draws it.
import { WorkspaceSize } from "@wsp/protocol";
import { bootPayload } from "../boot.js";
import type { Creation, CreationLine } from "./store.js";

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

function creationOf(raw: unknown): Creation | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!text(r["key"]) || !text(r["name"]) || !text(r["project"]) || !text(r["asked"]) || typeof r["askedAt"] !== "number") return undefined;
  const workspaceId = text(r["workspaceId"]) ? r["workspaceId"] : null;
  const f = r["failed"] as Record<string, unknown> | null | undefined;
  const failed = f !== null && typeof f === "object" && typeof f["title"] === "string" && typeof f["detail"] === "string" ? { title: f["title"], detail: f["detail"] } : null;
  const size = WorkspaceSize.safeParse(r["size"]);
  return {
    key: r["key"],
    name: r["name"],
    project: r["project"],
    askedAt: r["askedAt"],
    asked: r["asked"],
    queued: true,
    ...(text(r["golden"]) ? { golden: r["golden"] } : {}),
    ...(size.success ? { size: size.data } : {}),
    ...(text(r["where"]) ? { where: r["where"] } : {}),
    workspaceId,
    lines: Array.isArray(r["lines"]) ? r["lines"].flatMap(l => lineOf(l) ?? []) : [],
    failed,
  };
}

/** What this state file's page left kept, its stage log with it, so a refused row reads the step it stopped on. */
export function keptCreations(): Creation[] {
  const rows = readAll()[stateFile()];
  return Array.isArray(rows) ? rows.flatMap(r => creationOf(r) ?? []) : [];
}

/** A storage that throws keeps nothing, which is the page as it was before anything was kept. */
export function keepCreations(rows: readonly Creation[]): void {
  const kept = rows.map(({ quiet: _quiet, ...row }) => row);
  try {
    const { [stateFile()]: _mine, ...rest } = readAll();
    window.localStorage.setItem(KEPT_CREATIONS_KEY, JSON.stringify(kept.length === 0 ? rest : { ...rest, [stateFile()]: kept }));
  } catch {
    return;
  }
}
