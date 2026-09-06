// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filesUnder, movedPath, underProject, type MovedState, type ProjectStateResolver } from "./resolver.js";

/** The registry maps each resolved project path to the slug naming its tmp and history directories. */
interface Registry {
  projects: Record<string, string>;
}

const REGISTRY = "projects.json";
const readRegistry = (file: string): Registry | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Registry) : undefined);
/** The slugs registered at the path or under it, in registry order. */
const slugsUnder = (home: string, path: string): string[] => Object.entries(readRegistry(join(home, REGISTRY))?.projects ?? {}).flatMap(([key, slug]) => (underProject(key, path) ? [slug] : []));
/** The catalog rows a slug names, each with its directory under the home. */
const SLUG_DIRS = [["project temp dir", "tmp"], ["shell history", "history"]] as const;

export const geminiResolver: ProjectStateResolver = {
  agent: "gemini",
  carry: "transcript-only",
  states: ["project registry", "project temp dir", "shell history"],
  async move(home, from, to) {
    const file = join(home, REGISTRY);
    const registry = readRegistry(file);
    if (registry === undefined) return [];
    const renamed = new Map<string, { slug: string; path: string }>();
    for (const [path, slug] of Object.entries(registry.projects)) {
      const target = movedPath(path, from, to);
      if (target === undefined) continue;
      if (registry.projects[target] !== undefined) throw new Error(`${target} already exists in ${file}`);
      renamed.set(path, { slug, path: target });
    }
    if (renamed.size === 0) return [];
    registry.projects = Object.fromEntries(Object.entries(registry.projects).map(([k, v]) => [renamed.get(k)?.path ?? k, v]));
    writeFileSync(file, JSON.stringify(registry, null, 2) + "\n");
    const moved: MovedState[] = [{ state: "project registry", files: [file], changed: renamed.size }];
    for (const [state, dir] of SLUG_DIRS) {
      const files: string[] = [];
      for (const [path, { slug, path: target }] of renamed) {
        const marker = join(home, dir, slug, ".project_root");
        if (!existsSync(marker)) continue;
        const text = readFileSync(marker, "utf8");
        if (text.trimEnd() !== path) continue;
        writeFileSync(marker, text.replace(path, () => target));
        files.push(marker);
      }
      if (files.length > 0) moved.push({ state, files, changed: files.length });
    }
    return moved;
  },
  sessions: async (home, path) => slugsUnder(home, path).reduce((n, slug) => n + filesUnder(join(home, "tmp", slug, "chats"), ".jsonl").length, 0),
  entries: async (home, path) => slugsUnder(home, path).flatMap(slug => SLUG_DIRS.flatMap(([, dir]) => filesUnder(join(home, dir, slug), ""))).sort(),
};
