// SPDX-License-Identifier: AGPL-3.0-only
// Snapshot storage in words: the line wsp prints at start, and wsp init's
// offer to delete the golden versions retention no longer needs.
import type { Readable, Writable } from "node:stream";
import type { GoldenVersion, SnapshotStorage } from "@wsp/protocol";
import type { RetentionPlan, Runtime } from "@wsp/runtime";
import { isCancel, log } from "@clack/prompts";
import { confirmPrompt } from "./init-layout.js";

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
const perMonth = (usd: number): string => `about $${usd.toFixed(2)}/month`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** v1, v2 and v3. */
function versionList(versions: readonly GoldenVersion[]): string {
  const names = versions.map(v => `v${v.version}`);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function describeStorage(s: SnapshotStorage): string {
  const cost = s.monthlyUsd > 0 ? `${perMonth(s.monthlyUsd)} above the free ${s.freeGb} GB from ${s.billedFrom}` : `inside the free ${s.freeGb} GB, nothing to pay from ${s.billedFrom}`;
  return `storage: ${plural(s.count, "snapshot")}, ${gb(s.totalBytes)}; ${cost}`;
}

/** The one line the offer asks with: what goes, what it holds, what it saves, what stays. */
export function describeRetention(plan: RetentionPlan, pricing: { freeGb: number; billedFrom: string }): string {
  const saving = plan.savesUsdPerMonth > 0 ? `saving ${perMonth(plan.savesUsdPerMonth)} from ${pricing.billedFrom}` : `inside the free ${pricing.freeGb} GB, so nothing saved yet`;
  const parent = plan.keep[1];
  const assumed = plan.parentAssumed && parent !== undefined ? ` v${parent.version} is taken as the parent by version order: v${plan.keep[0]!.version} was sealed before parents were recorded.` : "";
  const abandoned = plan.abandoned.length > 0 ? ` ${versionList(plan.abandoned)} ${plan.abandoned.length === 1 ? "is an abandoned branch" : "are abandoned branches"}: v${plan.keep[0]!.version} was not built through ${plan.abandoned.length === 1 ? "it" : "them"}.` : "";
  return `Delete golden ${versionList(plan.drop)}, ${gb(plan.freedBytes)}, ${saving}? ${versionList(plan.keep)} stay.${assumed}${abandoned}`;
}

export function describeGuarded(g: RetentionPlan["guarded"][number]): string {
  const who = g.workspaces.length === 1 ? `workspace ${g.workspaces[0]} was` : `workspaces ${g.workspaces.join(", ")} were`;
  return `Golden v${g.version.version} stays: ${who} forked from it.`;
}

export interface RetentionOfferOptions {
  rt: Runtime;
  interactive: boolean;
  yes: boolean;
  input: Readable;
  output: Writable;
}

/** The older ancestors and the abandoned branches are offered for deletion, kept on a No, deleted on a Yes or when
 * nobody is asked. A listing the provider refuses keeps every version and says so. */
export async function retentionOffer(o: RetentionOfferOptions): Promise<void> {
  const out = { output: o.output };
  let plan: RetentionPlan | undefined;
  try {
    plan = await o.rt.golden.retention();
  } catch (e) {
    log.warn(`Snapshot storage was not read (${e instanceof Error ? e.message : String(e)}); every golden version is kept.`, out);
    return;
  }
  if (plan === undefined) return;
  for (const g of plan.guarded) log.info(describeGuarded(g), out);
  if (plan.drop.length === 0) return;
  const line = describeRetention(plan, o.rt.backend.pricing.snapshotStorage);
  if (o.interactive) {
    const go = await confirmPrompt({ message: line, hint: "No keeps every version.", initialValue: true, input: o.input, output: o.output });
    if (isCancel(go) || !go) {
      log.step("Every golden version is kept.", out);
      return;
    }
  } else {
    log.step(`${line} Taken as yes (${o.yes ? "--yes" : "no terminal"}).`, out);
  }
  const { dropped, failed } = await o.rt.golden.prune();
  if (dropped.length > 0) log.success(`Deleted golden ${versionList(dropped)}.`, out);
  for (const f of failed) log.warn(`Golden v${f.version} was not deleted (${f.message}); it stays in the lineage.`, out);
  const storage = await o.rt.golden.storage().catch(() => undefined);
  if (storage !== undefined) log.info(describeStorage(storage), out);
}
