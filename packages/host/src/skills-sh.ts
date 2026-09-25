// SPDX-License-Identifier: AGPL-3.0-only
// skills.sh, asked by this host and nothing else: its search, and a skill's
// whole folder as its download answers it, which is what the official skills
// CLI installs from. A download is checked whole before a byte of it lands:
// every path plain and inside the skill, a count and size cap, a SKILL.md at
// its root; the archive the host lands is built here, regular files at 0644
// in folders at 0755, so nothing in a skill carries a link or a mode of its
// own and nothing in it runs.
import { tarOf, type TarEntry } from "@wsp/engine";
import { SKILL_PREVIEW_BYTES, SkillHit, hasControlChar, skillsSearchEmptyRefusal, type SkillPreview } from "@wsp/protocol";
import { z } from "zod";

export const SKILLS_SH = "https://skills.sh";

/** The one road to skills.sh: the global fetch, or a fake in a test. */
export type SkillsFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const ASK_MS = 20_000;
/** What is read of an answer: a search is small, a download holds up to MAX_TOTAL of text with its escapes. */
const SEARCH_ANSWER_MAX = 1024 * 1024;
const DOWNLOAD_ANSWER_MAX = 12 * 1024 * 1024;

export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_BYTES = 1024;

/** A skill's folder name: what every agent's skills folder holds it under. */
export const SKILL_NAME_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;

const UNREAD = "skills.sh answered something this wsp does not read.";

const notASkillId = (id: string): string => `${id} is not a skill skills.sh names; it reads <owner>/<repo>/<skill>.`;

/** The owner, repo and folder name of an id skills.sh names, or a refusal before anything is asked. */
export function skillIdOf(id: string): { owner: string; repo: string; skill: string } {
  const parts = id.split("/");
  const [owner = "", repo = "", skill = ""] = parts;
  const plain = (p: string): boolean => REPO_PART.test(p) && p !== "." && p !== "..";
  if (parts.length !== 3 || !plain(owner) || !plain(repo) || !SKILL_NAME_SHAPE.test(skill)) throw usage(notASkillId(id));
  return { owner, repo, skill };
}

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

async function ask(fetch: SkillsFetch, path: string, max: number, missing: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${SKILLS_SH}${path}`, { signal: AbortSignal.timeout(ASK_MS) });
  } catch (e) {
    throw new Error(`skills.sh did not answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 404) throw usage(missing);
  if (!res.ok) throw new Error(`skills.sh answered ${res.status}.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > max) throw new Error(`skills.sh answered over ${Math.round(max / 1024 / 1024)} MB, which is not read.`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(UNREAD);
  }
}

const SearchAnswer = z.object({ skills: z.array(SkillHit) });

/** skills.sh's search for the query, trimmed; an empty one is refused here, as skills.sh refuses it. */
export async function searchSkills(fetch: SkillsFetch, q: string, limit: number): Promise<SkillHit[]> {
  const query = q.trim();
  if (query === "") throw usage(skillsSearchEmptyRefusal);
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const parsed = SearchAnswer.safeParse(await ask(fetch, `/api/search?${params.toString()}`, SEARCH_ANSWER_MAX, `skills.sh has no search at ${SKILLS_SH}.`));
  if (!parsed.success) throw new Error(UNREAD);
  return parsed.data.skills;
}

/** One file of a skill as it will land: its path inside the skill's folder and its bytes. */
export interface SkillFile {
  path: string;
  bytes: Uint8Array;
}

const plainPath = (path: string): boolean => {
  if (path === "" || Buffer.byteLength(path) > MAX_PATH_BYTES || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path) || hasControlChar(path)) return false;
  return path.split("/").every(seg => seg !== "" && seg !== "." && seg !== ".." && Buffer.byteLength(seg) <= MAX_SEGMENT_BYTES);
};

/** The download's files, checked whole: the first path that could land anywhere but inside the skill's own folder,
 * a count or a size past its cap, or no SKILL.md at the root refuses the whole skill in one sentence. */
export function checkSkillFiles(name: string, files: readonly { path?: unknown; contents?: unknown }[]): SkillFile[] {
  if (!SKILL_NAME_SHAPE.test(name)) throw usage(`${name} is not a plain skill name, so nothing was installed.`);
  const refuse = (why: string): Error => usage(`${name} was not installed: ${why}`);
  if (files.length > MAX_FILES) throw refuse(`it has ${files.length} files, over the ${MAX_FILES} a skill may have.`);
  const out: SkillFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (typeof f.path !== "string" || typeof f.contents !== "string") throw new Error(UNREAD);
    if (!plainPath(f.path)) throw refuse(`the download names ${JSON.stringify(f.path)}, which is not a plain path inside the skill.`);
    if (seen.has(f.path)) throw refuse(`the download names ${f.path} twice.`);
    seen.add(f.path);
    const bytes = new TextEncoder().encode(f.contents);
    if (bytes.byteLength > MAX_FILE_BYTES) throw refuse(`${f.path} is over 1 MB.`);
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw refuse("it is over 5 MB in all.");
    out.push({ path: f.path, bytes });
  }
  for (const path of seen) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join("/"))) throw refuse(`the download names ${parts.slice(0, i).join("/")} as a file and as a folder.`);
  }
  if (!seen.has("SKILL.md")) throw refuse("it has no SKILL.md at its root.");
  return out;
}

/** A gzipped tarball of the checked files: every folder at 0755, every file at 0644, no link, no owner but root's
 * placeholder, which an unpack as the login ignores. */
export function skillArchive(files: readonly SkillFile[]): Buffer {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const entries: TarEntry[] = [...[...dirs].sort().map(path => ({ path, mode: 0o755, dir: true as const })), ...files.map(f => ({ path: f.path, mode: 0o644, content: f.bytes }))];
  return tarOf(entries);
}

/** A SKILL.md as a preview carries it: its first SKILL_PREVIEW_BYTES, cut on a whole character, and its size. */
export function skillPreview(bytes: Uint8Array): SkillPreview {
  if (bytes.byteLength <= SKILL_PREVIEW_BYTES) return { text: new TextDecoder().decode(bytes), size: bytes.byteLength };
  let end = SKILL_PREVIEW_BYTES;
  // A UTF-8 continuation byte is 10xxxxxx: step back to the start of the character the cut fell in.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), size: bytes.byteLength };
}

const DownloadAnswer = z.object({ files: z.array(z.object({ path: z.unknown(), contents: z.unknown() })) });

/** A skill off skills.sh, checked whole: its folder name and its files. */
export async function getSkill(fetch: SkillsFetch, id: string): Promise<{ name: string; files: SkillFile[] }> {
  const { owner, repo, skill } = skillIdOf(id);
  const parsed = DownloadAnswer.safeParse(await ask(fetch, `/api/download/${owner}/${repo}/${skill}`, DOWNLOAD_ANSWER_MAX, `skills.sh has no skill ${id}.`));
  if (!parsed.success) throw new Error(UNREAD);
  return { name: skill, files: checkSkillFiles(skill, parsed.data.files) };
}
