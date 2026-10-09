// SPDX-License-Identifier: AGPL-3.0-only
// A lead's tree in figures, as the Threads section's head says it: each live status's glyph with its number in the
// status slot's own grammar and ink (needs you, failed, working, waiting), working's crab after its number as the slot
// draws it, and threads and subagents apart on its hover. With nothing live, how many finished, in words and the
// muted ink.
import { memo } from "react";
import { CHILD_WORDS } from "../../actions/format.js";
import { cn } from "../../lib/utils.js";
import { Crab } from "../status/Crab.js";
import { FAILED } from "../status/kinds/failed.js";
import type { StatusKind } from "../status/kinds/kind.js";
import { NEEDS_YOU } from "../status/kinds/needs-you.js";
import { WORKING } from "../status/kinds/working.js";
import { WAITING } from "../status/kinds/waiting.js";
import type { TreeCounts as Counts } from "./leadTree.js";

const many = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

const TREE_COUNT_WORDS = {
  count: (n: number, word: string): string => `${n} ${word.toLowerCase()}`,
  working: (threads: number, subagents: number): string =>
    `${[threads > 0 ? many(threads, "thread") : "", subagents > 0 ? many(subagents, "subagent") : ""].filter(half => half !== "").join(" and ")} working`,
  finished: (n: number): string => `${n} ${CHILD_WORDS.finished.toLowerCase()}`,
} as const;

/** A count as the status slot draws its kind: the ink, and the slot's weight where the kind is toned. */
const inked = (kind: StatusKind): string => cn("inline-flex items-center gap-1 tabular-nums", kind.tone !== undefined && "font-medium", kind.ink ?? "text-muted-foreground");

function Glyphed({ id, kind, n }: { id: string; kind: StatusKind; n: number }) {
  const Glyph = kind.glyph!;
  return (
    <span data-tree-count={id} title={TREE_COUNT_WORDS.count(n, kind.word!)} className={inked(kind)}>
      <Glyph aria-hidden className="size-3 shrink-0" />
      {n}
    </span>
  );
}

export const TreeCounts = memo(function TreeCounts({ counts }: { counts: Counts }) {
  const { needsYou, failed, working, workingSubagents, waiting, finished } = counts;
  const live = needsYou + failed + working + waiting > 0;
  return (
    <span data-tree-counts className="inline-flex shrink-0 items-center gap-3 text-xs">
      {needsYou > 0 ? <Glyphed id="needs-you" kind={NEEDS_YOU} n={needsYou} /> : null}
      {failed > 0 ? <Glyphed id="failed" kind={FAILED} n={failed} /> : null}
      {working > 0 ? (
        <span data-tree-count="working" title={TREE_COUNT_WORDS.working(working - workingSubagents, workingSubagents)} className={inked(WORKING)}>
          {working}
          <Crab />
        </span>
      ) : null}
      {waiting > 0 ? <Glyphed id="waiting" kind={WAITING} n={waiting} /> : null}
      {!live && finished > 0 ? (
        <span data-tree-count="finished" className="text-muted-foreground tabular-nums">
          {TREE_COUNT_WORDS.finished(finished)}
        </span>
      ) : null}
    </span>
  );
}, sameCounts);

/** Two counts that draw the same figures. */
function sameCounts(a: { counts: Counts }, b: { counts: Counts }): boolean {
  const x = a.counts;
  const y = b.counts;
  return x.needsYou === y.needsYou && x.failed === y.failed && x.working === y.working && x.workingSubagents === y.workingSubagents && x.waiting === y.waiting && x.finished === y.finished;
}
