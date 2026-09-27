// Adapted from pingdotgg/t3code apps/web/src/components/files/ProjectFilePicker.logic.ts at 57a66608 (MIT).
// Differs from upstream: the daemon answers every path whose letters hold the
// query in order and ranks none, so the ranking happens here, the file's name
// before its folders, with the same query normalization.
import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch, type RankedSearchResult } from "./searchRanking.js";

export const FILE_FINDER_RESULT_LIMIT = 50;

export interface FileFinderMatch {
  /** Relative to the folder searched, as the daemon names it. */
  readonly path: string;
  readonly name: string;
  /** The folders above it, "" at the top. */
  readonly folder: string;
}

/** The query as a path is matched against it: lowercased, no leading `@`, `.` or `/`, no spaces. */
export function fileFinderQuery(raw: string): string {
  return normalizeSearchQuery(raw, { trimLeadingPattern: /^[@./]+/ }).replaceAll(/\s/g, "");
}

function matchOf(path: string): FileFinderMatch {
  const cut = path.lastIndexOf("/");
  return { path, name: path.slice(cut + 1), folder: cut === -1 ? "" : path.slice(0, cut) };
}

/** The best `limit` paths for the query, a name match before a match in the folders; with no query, the first
 * `limit` in the daemon's order. */
export function rankFilePaths(paths: readonly string[], raw: string, limit = FILE_FINDER_RESULT_LIMIT): FileFinderMatch[] {
  const query = fileFinderQuery(raw);
  if (query === "") return paths.slice(0, limit).map(matchOf);
  const ranked: RankedSearchResult<FileFinderMatch>[] = [];
  for (const path of paths) {
    const match = matchOf(path);
    const byName = scoreQueryMatch({ value: match.name.toLowerCase(), query, exactBase: 0, prefixBase: 10, boundaryBase: 20, includesBase: 30, fuzzyBase: 100 });
    const byPath = scoreQueryMatch({ value: path.toLowerCase(), query, exactBase: 5, prefixBase: 40, boundaryBase: 50, includesBase: 60, fuzzyBase: 200 });
    const scores = [byName, byPath].filter((score): score is number => score !== null);
    if (scores.length === 0) continue;
    insertRankedSearchResult(ranked, { item: match, score: Math.min(...scores), tieBreaker: path }, limit);
  }
  return ranked.map(entry => entry.item);
}
