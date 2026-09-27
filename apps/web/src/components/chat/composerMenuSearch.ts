// SPDX-License-Identifier: AGPL-3.0-only
// What the composer's @, # and $ menus offer for what was typed: the copy's
// files ranked by name first and path second, the repository's open pull
// requests and issues by number or by title, and the person's skills the
// thread's agent loads. Ranked with the same scorer the slash menu uses.
import type { HostItem, SkillRow } from "@wsp/protocol";
import { baseName } from "../../files/entries";
import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch } from "../../lib/searchRanking";

/** Rows one @ or # menu draws. */
export const COMPOSER_MENU_ROWS = 30;

export function searchComposerFiles(files: ReadonlyArray<string>, query: string, limit = COMPOSER_MENU_ROWS): string[] {
  const wanted = normalizeSearchQuery(query);
  if (!wanted) return files.slice(0, limit);
  const ranked: Array<{ item: string; score: number; tieBreaker: string }> = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const scores = [
      scoreQueryMatch({ value: baseName(lower), query: wanted, exactBase: 0, prefixBase: 2, boundaryBase: 4, includesBase: 6, fuzzyBase: 100, boundaryMarkers: ["-", "_", "."] }),
      scoreQueryMatch({ value: lower, query: wanted, exactBase: 10, prefixBase: 20, boundaryBase: 22, includesBase: 24, fuzzyBase: 200 }),
    ].filter((score): score is number => score !== null);
    if (scores.length > 0) insertRankedSearchResult(ranked, { item: path, score: Math.min(...scores), tieBreaker: path }, limit);
  }
  return ranked.map(entry => entry.item);
}

export function searchHostItems(items: ReadonlyArray<HostItem>, query: string, limit = COMPOSER_MENU_ROWS): HostItem[] {
  const wanted = normalizeSearchQuery(query);
  if (!wanted) return items.slice(0, limit);
  if (/^\d+$/.test(wanted)) return items.filter(item => String(item.number).startsWith(wanted)).slice(0, limit);
  const ranked: Array<{ item: HostItem; score: number; tieBreaker: string }> = [];
  for (const item of items) {
    const score = scoreQueryMatch({ value: item.title.toLowerCase(), query: wanted, exactBase: 0, prefixBase: 2, boundaryBase: 4, includesBase: 6, fuzzyBase: 100 });
    if (score !== null) insertRankedSearchResult(ranked, { item, score, tieBreaker: String(item.number).padStart(9, "0") }, limit);
  }
  return ranked.map(entry => entry.item);
}

/** The skills the agent loads, which is a skill with a folder that is on and is that agent's or shared by several. */
export function skillsForHarness(skills: ReadonlyArray<SkillRow>, harness: string): SkillRow[] {
  return skills.filter(skill => skill.paths.some(path => path.off !== true && (path.agent === undefined || path.agent === harness)));
}
