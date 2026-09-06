// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeScript, pyData } from "./merge.js";
import { underProject } from "@wsp/protocol";
import { filesUnder, movedPath, type MovedState, type ProjectStateResolver } from "./resolver.js";

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
  roots: [REGISTRY, ...SLUG_DIRS.map(([, dir]) => dir)],
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
  async merge(home, from, to, guestHome) {
    const keys = Object.entries(readRegistry(join(home, REGISTRY))?.projects ?? {}).flatMap(([path, slug]) => {
      const target = movedPath(path, from, to);
      return target === undefined ? [] : [[path, target, slug]];
    });
    if (keys.length === 0) return undefined;
    // The registry is a plain file Gemini makes on first run in the measured shape, so a machine without one gets it;
    // a slug another path there owns already holds the landed files, and the merge says so rather than share it.
    // Every key is checked before anything is written, so a conflict leaves the machine's files as they were.
    // A path the machine already registers under its own slug keeps that slug: rebinding it would drop the
    // machine's own chats from Gemini's list.
    return mergeScript(from, to, [
      `HOME = ${pyData(guestHome)}`,
      `REG = ${pyData(join(guestHome, REGISTRY))}`,
      `KEYS = ${pyData(keys)}`,
      `DIRS = ${pyData(SLUG_DIRS.map(([, dir]) => dir))}`,
      "os.makedirs(HOME, exist_ok=True)",
      "if os.path.exists(REG):",
      '    with open(REG, encoding="utf-8") as h:',
      "        reg = json.load(h)",
      "else:",
      '    reg = {"projects": {}}',
      'projects = reg.setdefault("projects", {})',
      "for old, key, slug in KEYS:",
      "    for other, s in projects.items():",
      "        if s == slug and other != key:",
      '            fail("slug " + slug + " already belongs to " + other + " in " + REG)',
      "changed = False",
      "for old, key, slug in KEYS:",
      "    held = projects.get(key)",
      "    if held == slug:",
      "        kept += 1",
      "    elif held is not None:",
      "        kept += 1",
      '        notes.append("the machine already lists " + key + " as " + str(held) + ", so that slug stays and the carried chats under tmp/" + slug + " are not listed there")',
      "    else:",
      "        projects[key] = slug",
      "        merged += 1",
      "        changed = True",
      "    for d in DIRS:",
      '        marker = os.path.join(HOME, d, slug, ".project_root")',
      "        if not os.path.exists(marker):",
      "            continue",
      '        with open(marker, encoding="utf-8", newline="") as h:',
      "            text = h.read()",
      "        if text.rstrip() == old:",
      "            write(marker, key + text[len(text.rstrip()):])",
      "if changed:",
      '    write(REG, json.dumps(reg, indent=2, ensure_ascii=False) + "\\n")',
    ]);
  },
};
