// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

type Entry = { type: string; filepath?: string; children?: Record<string, Entry> };

/** Every page a Scalar config serves, by its path: each route key joined onto its group's, as Scalar joins them. */
export function pagePaths(configFile: string): Map<string, string> {
  const config = JSON.parse(readFileSync(configFile, "utf8")) as { navigation: { routes: Record<string, Entry> } };
  const paths = new Map<string, string>();
  const walk = (at: string, entry: Entry): void => {
    if (entry.type === "page") paths.set(at.replace(/\/+/g, "/").replace(/(.)\/$/, "$1"), entry.filepath!);
    for (const [key, child] of Object.entries(entry.children ?? {})) walk(`${at}${key}`, child);
  };
  for (const [key, entry] of Object.entries(config.navigation.routes)) walk(key, entry);
  return paths;
}
