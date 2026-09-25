// SPDX-License-Identifier: AGPL-3.0-only
// Every skill on a computer, off the folders each catalog agent loads skills
// from: one row per name with every folder it lives in, whether that folder
// is a link, and the name and description off its SKILL.md's frontmatter.
// One command reads every folder, so a computer reached over a link answers
// in one round trip however many skills it keeps.
import { posix } from "node:path";
import { CATALOG_AGENTS, type AgentEntry } from "@wsp/catalog";
import type { SkillPath, SkillRow, SkillScope } from "@wsp/protocol";
import { type Host, expand, tilde } from "../host.js";

/** One folder to read skills from, absolute: whose own folder it is, where it is one agent's, and what kind. */
export interface SkillRootAt {
  dir: string;
  scope: SkillScope;
  agent?: string;
}

export interface SkillsRead {
  skills: SkillRow[];
  refused: string[];
}

/** How much of a SKILL.md is read for its frontmatter. */
export const SKILL_HEAD_BYTES = 4096;

const END = "\x1eEND";

/** Prints, per SKILL.md found under each root (two or three folders down: a category folder is allowed, links are
 * followed), the root, the skill's folder, where that folder links, whether it is turned off (a SKILL.md.off with no
 * SKILL.md beside it), and the frontmatter lines alone. */
const SCRIPT = [
  'for r in "$@"; do',
  '  [ -d "$r" ] || continue',
  '  find -L "$r" -mindepth 2 -maxdepth 3 \\( -name SKILL.md -o -name SKILL.md.off \\) -type f 2>/dev/null | while IFS= read -r f; do',
  '    d=${f%/*}',
  '    o=; case $f in *.off) [ -f "$d/SKILL.md" ] && continue; o=1;; esac',
  '    l=; [ -L "$d" ] && l=$(readlink "$d")',
  "    printf '\\036%s\\037%s\\037%s\\037%s\\037' \"$r\" \"$d\" \"$l\" \"$o\"",
  `    head -c ${SKILL_HEAD_BYTES} "$f" | awk 'NR==1 && $0 != "---" {exit} NR>1 && $0 == "---" {exit} NR>1 {print}'`,
  "  done",
  "done",
  "printf '\\036END\\n'",
].join("\n");

const unquote = (v: string): string => {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};

/** `name` and `description` off a SKILL.md's frontmatter lines: a plain value, a quoted one, or a folded or literal
 * block, read as one line. */
export function skillFrontmatter(text: string): { name?: string; description?: string } {
  const out: { name?: string; description?: string } = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(lines[i]!);
    if (m === null) continue;
    const key = m[1] as "name" | "description";
    let value = m[2]!.trim();
    const block = /^[>|][-+]?$/.test(value);
    const more: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) more.push(lines[++i]!.trim());
    value = block ? more.join(" ") : [unquote(value), ...more].filter(w => w !== "").join(" ");
    if (value !== "") out[key] = value;
  }
  return out;
}

/** The folders every catalog agent loads skills from on that computer, absolute, each once: an agent's own folder
 * carries that agent, a folder several read carries none. A project adds the folders the agents read inside it,
 * and the plugin indexes name the folders their plugins' skills sit in. */
export async function skillRoots(host: Host, o: { agents?: readonly AgentEntry[]; project?: string } = {}): Promise<SkillRootAt[]> {
  const agents = o.agents ?? CATALOG_AGENTS;
  const out = new Map<string, SkillRootAt>();
  const add = (dirs: { dir: string; own: boolean }[], scope: SkillScope, agent: string): void => {
    for (const { dir, own } of dirs) {
      const at = out.get(dir);
      if (at === undefined) out.set(dir, { dir, scope, ...(own ? { agent } : {}) });
      else if (own && at.agent === undefined) out.set(dir, { ...at, agent });
    }
  };
  for (const a of agents) add(a.skillRoots.user.map((r, i) => ({ dir: expand(host, r.dir), own: i === 0 })), "user", a.id);
  if (o.project !== undefined) for (const a of agents) add(a.skillRoots.project.map((r, i) => ({ dir: posix.join(o.project!, r.dir), own: i === 0 })), "project", a.id);
  const plugins = agents.filter(a => a.pluginSkills !== undefined);
  const indexes = await Promise.all(plugins.map(a => host.fs.readText(expand(host, a.pluginSkills!.index))));
  plugins.forEach((a, i) => {
    const text = indexes[i];
    if (text !== undefined) add(a.pluginSkills!.roots(text).map(dir => ({ dir, own: true })), "plugin", a.id);
  });
  return [...out.values()];
}

/** Every skill under the roots, one row per name and kind with every folder it lives in. A folder whose name starts
 * with a dot, one without a SKILL.md, and a skill inside another skill's folder are not skills. An answer cut short
 * is a refusal naming it, never a list that silently stops. */
export async function detectSkills(host: Host, roots: readonly SkillRootAt[]): Promise<SkillsRead> {
  if (roots.length === 0) return { skills: [], refused: [] };
  const said = await host.exec.run("sh", ["-c", SCRIPT, "sh", ...roots.map(r => r.dir)], { timeoutMs: 20_000 });
  if (said === undefined) return { skills: [], refused: ["skills: the folders could not be read"] };
  const refused = said.trimEnd().endsWith(END) ? [] : ["skills: the answer was cut short, so the list is not whole"];
  const rootOf = new Map(roots.map(r => [r.dir, r]));
  const found: { root: SkillRootAt; dir: string; link: string; off: boolean; head: string }[] = [];
  for (const record of said.split("\x1e").slice(1)) {
    const [rootDir, dir, link, off, head] = record.split("\x1f");
    const root = rootDir === undefined ? undefined : rootOf.get(rootDir);
    if (root === undefined || dir === undefined || head === undefined) continue;
    const rel = dir.slice(root.dir.length + 1);
    if (!dir.startsWith(`${root.dir}/`) || rel.split("/").some(seg => seg.startsWith("."))) continue;
    found.push({ root, dir, link: link ?? "", off: off === "1", head });
  }
  const dirs = new Set(found.map(f => `${f.root.dir}\0${f.dir}`));
  const rows = new Map<string, SkillRow>();
  for (const f of found) {
    // A SKILL.md under a folder that is itself a skill belongs to that skill (its examples, its templates).
    const parts = f.dir.slice(f.root.dir.length + 1).split("/");
    if (parts.slice(1).some((_, i) => dirs.has(`${f.root.dir}\0${f.root.dir}/${parts.slice(0, i + 1).join("/")}`))) continue;
    const meta = skillFrontmatter(f.head);
    const name = meta.name ?? posix.basename(f.dir);
    const key = `${f.root.scope}\0${name}`;
    const path: SkillPath = {
      path: tilde(host.home, f.dir),
      ...(f.root.agent !== undefined ? { agent: f.root.agent } : {}),
      ...(f.link !== "" ? { linkTo: tilde(host.home, posix.resolve(posix.dirname(f.dir), f.link)) } : {}),
      ...(f.off ? { off: true as const } : {}),
    };
    const row = rows.get(key);
    if (row === undefined) rows.set(key, { name, ...(meta.description !== undefined ? { description: meta.description } : {}), paths: [path], scope: f.root.scope });
    else if (!row.paths.some(p => p.path === path.path)) row.paths.push(path);
  }
  return { skills: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)), refused };
}
