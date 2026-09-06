// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { movedPath, type MovedState, type ProjectStateResolver } from "./resolver.js";

/** The registry maps each resolved project path to the slug naming its tmp and history directories. */
interface Registry {
  projects: Record<string, string>;
}

export const geminiResolver: ProjectStateResolver = {
  agent: "gemini",
  states: ["project registry", "project temp dir", "shell history"],
  async move(home, from, to) {
    const file = join(home, "projects.json");
    if (!existsSync(file)) return [];
    const registry = JSON.parse(readFileSync(file, "utf8")) as Registry;
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
    for (const [state, dir] of [["project temp dir", "tmp"], ["shell history", "history"]] as const) {
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
};
