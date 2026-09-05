// SPDX-License-Identifier: AGPL-3.0-only
// What a recipe costs on the builder's disk, judged before anything boots: a
// Homebrew formula is its dependency closure, sized from a table measured on
// Linux where one exists and from this Mac's own Homebrew otherwise; Homebrew's
// toolchain is one line; agents have measured install sizes; a row nothing
// measured counts at a stated default for its kind. Nothing here runs a
// command: the host reads the Mac's Homebrew and hands the table in.
import { AGENT_INSTALLERS, BREW_TOOLCHAIN, MANAGER_FORMULA, MACOS_ONLY_FORMULAE, agentInstallsFor, toolInstallsFor, type BrewFormula, type BrewTable, type RecipeEntry, type ToolSource } from "./golden-import.js";
import { MIB, TOOLS_DISK_FLOOR } from "./golden-tools.js";

/** Root disk asked for every builder and fork, Solari's cap: a 4 GB root filled during the tools stage and
 * five agents failed to install on it (measured 2026-09-05). */
export const BUILDER_DISK_GB = 20;
/** What df -Pk said was free on a 20 GB builder with the daemon and the login shell on it, before the upload:
 * 17,992,136 KiB (measured 2026-09-05). The base image and the filesystem's reserved blocks are both inside it. */
export const BUILDER_FREE_BYTES = 17570 * MIB;
const UPLOAD_HEADROOM_BYTES = 256 * MIB;
/** The most a recipe's files may add up to on this computer before the plan refuses to boot. The upload needs
 * the archive, its files and headroom under what the builder has free, and the archive is at most as large as the files. */
export const PACK_BUDGET_BYTES = Math.floor((BUILDER_FREE_BYTES - UPLOAD_HEADROOM_BYTES) / 2);
/** What the recipe may take: what the builder has free less the floor the tools stage keeps free for unpack peaks. */
export const DISK_ROOM_BYTES = BUILDER_FREE_BYTES - TOOLS_DISK_FLOOR;

/** The day the tables below were read off a 20 GB Linux builder: Cellar sizes as brew printed them, agents and the
 * toolchain as df moved across their installs; the screens name it so the numbers read as a measurement, not as catalog truth. */
export const MEASURED_ON = "2026-09-05";

/** Homebrew's checkout with its own glibc and gcc, pulled in by the first formula: df moved 1006 MB across the three installs. */
export const BREW_TOOLCHAIN_BYTES = 1024 * MIB;

/** Cellar sizes on the Linux builder, as brew printed them after each pour on MEASURED_ON; the Mac's Cellar
 * stands in for the rest, and for these two llvm builds it was a gigabyte short. */
const LINUX_FORMULA_MIB: Record<string, number> = {
  "llvm@21": 2560,
  "llvm@20": 2458,
  openjdk: 412,
  "openjdk@21": 343,
  "openjdk@17": 316,
  go: 251,
  "firebase-cli": 262,
  gradle: 220,
  zig: 214,
  "zig@0.15": 200,
  swiftlint: 169,
  mongosh: 156,
  binutils: 135,
  beads: 138,
  logcli: 121,
  node: 113,
  rclone: 110,
  "node@24": 106,
  "icu4c@78": 94,
  goreleaser: 85,
  "python@3.14": 82,
  "python@3.12": 77,
  helm: 65,
  uv: 60,
  "helm@3": 60,
};

/** What df moved across each agent's install on the same builder: the global, its caches and whatever the
 * installer put under /root; the cache sweep after the stage gives some of it back. */
const AGENT_MIB: Record<string, number> = { opencode: 673, codex: 455, pi: 165, gemini: 189, hermes: 484, claude: 208 };

/** The Node release the agents stage puts under /usr/local when the base's major is under their floor. */
export const NODE_BYTES = 250 * MIB;
/** The Node major the base image ships; a floor at or under it keeps the base's Node and installs nothing. */
const BASE_NODE_MAJOR = 18;

const OTHER_TOOL_MIB: Record<string, number> = { "tools/npm/bun": 78 };

/** What a row nothing measured counts as, by what installs it: two go installs moved df by 115 MB and 924 MB
 * (module and build caches), three uv tools by 12 to 222 MB, three npm globals by 0 to 25 MB, six agents by
 * 165 to 673 MB. */
const ASSUMED_MIB = { go: 500, uv: 100, npm: 50, agent: 350, other: 100 } as const;

/** The default a row without a size counts at, and the words for where it came from. */
export interface AssumedSize {
  bytes: number;
  kind: "a go install" | "a uv tool" | "an npm global" | "an agent" | "an install";
}

/** The stated default for a tools or agents row nothing measured. */
export function assumedSize(e: RecipeEntry): AssumedSize {
  if (e.rung === "agents") return { bytes: ASSUMED_MIB.agent * MIB, kind: "an agent" };
  if (e.id.startsWith("tools/go/")) return { bytes: ASSUMED_MIB.go * MIB, kind: "a go install" };
  if (e.id.startsWith("tools/uv/")) return { bytes: ASSUMED_MIB.uv * MIB, kind: "a uv tool" };
  if (/^tools\/(npm|pnpm|bun)\//.test(e.id)) return { bytes: ASSUMED_MIB.npm * MIB, kind: "an npm global" };
  return { bytes: ASSUMED_MIB.other * MIB, kind: "an install" };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const GITHUB = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(.*))?$/;

/** The GitHub repository and tag a formula builds from, when its url names them: a release asset,
 * a tag archive, or a git url with the tag beside it. */
export function sourceOf(url: string | undefined, tag: string | null | undefined): ToolSource | undefined {
  const m = url === undefined ? null : GITHUB.exec(url);
  if (m === null) return undefined;
  const repo = `${m[1]}/${m[2]}`;
  const rest = m[3] ?? "";
  const release = /^releases\/download\/([^/]+)\//.exec(rest)?.[1];
  const archive = /^archive\/(?:refs\/tags\/)?([^/]+?)\.(?:tar\.gz|zip)$/.exec(rest)?.[1];
  const found = release ?? archive ?? (rest === "" ? tag ?? undefined : undefined);
  return found === undefined ? undefined : { repo, tag: found };
}

/** The formulae in `brew info --json=v2 --installed`, one row each, without sizes. */
export function parseBrewInfo(json: unknown): BrewFormula[] {
  if (!isRecord(json) || !Array.isArray(json["formulae"])) return [];
  const out: BrewFormula[] = [];
  for (const f of json["formulae"]) {
    if (!isRecord(f)) continue;
    const name = str(f["name"]);
    const fullName = str(f["full_name"]) ?? name;
    if (name === undefined || fullName === undefined) continue;
    const installed = Array.isArray(f["installed"]) && isRecord(f["installed"][0]) ? f["installed"][0] : undefined;
    const runtime = installed !== undefined && Array.isArray(installed["runtime_dependencies"]) ? installed["runtime_dependencies"].flatMap(d => (isRecord(d) ? strings([d["full_name"]]) : [])) : [];
    const deps = [...new Set([...strings(f["dependencies"]), ...runtime])];
    const requirements = Array.isArray(f["requirements"]) ? f["requirements"] : [];
    const macosOnly = MACOS_ONLY_FORMULAE.has(fullName) || requirements.some(r => isRecord(r) && r["name"] === "macos");
    const urls = isRecord(f["urls"]) && isRecord(f["urls"]["stable"]) ? f["urls"]["stable"] : undefined;
    const source = sourceOf(str(urls?.["url"]), urls === undefined ? undefined : (str(urls["tag"]) ?? null));
    out.push({ name, fullName, deps, macosOnly, ...(source !== undefined ? { source } : {}) });
  }
  return out;
}

/** `du -sk` lines over the Cellar's entries: bytes by directory name. */
export function parseDu(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (m === null) continue;
    const path = m[2]!.replace(/\/+$/, "");
    out.set(path.slice(path.lastIndexOf("/") + 1), Number(m[1]) * 1024);
  }
  return out;
}

/** The Mac's formulae by full name, each with its Cellar size when du read one. */
export function brewTable(json: unknown, du: ReadonlyMap<string, number>): BrewTable {
  const out = new Map<string, BrewFormula>();
  for (const f of parseBrewInfo(json)) {
    const bytes = du.get(f.name);
    out.set(f.fullName, bytes === undefined ? f : { ...f, bytes });
  }
  return out;
}

export interface ToolSize {
  bytes: number;
  /** Where the number came from: the table measured on Linux, or this Mac's Homebrew. */
  road: "measured" | "mac";
  /** Dependencies counted in besides the row's own formula. */
  deps: number;
}

const TOOLCHAIN = new Set<string>(BREW_TOOLCHAIN);

/** A formula's size on Linux when measured, else on this Mac. */
function formulaBytes(name: string, brew: BrewTable): number | undefined {
  const measured = LINUX_FORMULA_MIB[name];
  return measured !== undefined ? measured * MIB : brew.get(name)?.bytes;
}

/** The formula and every formula it depends on, by full name, Homebrew's own toolchain left out. */
function closureOf(name: string, brew: BrewTable): Set<string> {
  const seen = new Set<string>([name]);
  const queue = [name];
  for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
    for (const d of brew.get(n)?.deps ?? []) {
      if (TOOLCHAIN.has(d) || seen.has(d)) continue;
      seen.add(d);
      queue.push(d);
    }
  }
  return seen;
}

const formulaOf = (e: RecipeEntry): string | undefined => (e.id.startsWith("tools/brew/") ? e.id.slice("tools/brew/".length) : undefined);

/** What one tools row puts on the machine: a formula with its closure, a measured global; nothing for a
 * tap, a cask, or a row nothing measured or read. */
export function toolSize(e: RecipeEntry, brew: BrewTable): ToolSize | undefined {
  const formula = formulaOf(e);
  if (formula === undefined) {
    const other = OTHER_TOOL_MIB[e.id];
    return other === undefined ? undefined : { bytes: other * MIB, road: "measured", deps: 0 };
  }
  if (formulaBytes(formula, brew) === undefined) return undefined;
  const members = closureOf(formula, brew);
  let bytes = 0;
  for (const m of members) bytes += formulaBytes(m, brew) ?? 0;
  return { bytes, road: LINUX_FORMULA_MIB[formula] !== undefined ? "measured" : "mac", deps: members.size - 1 };
}

/** The host owns Claude Code's installer; every other agent installs from the engine's table. */
const installable = (e: RecipeEntry): boolean => {
  const name = e.id.slice(e.id.indexOf("/") + 1);
  return name === "claude" || name in AGENT_INSTALLERS;
};

/** An agent's measured install size, by the row's name. */
export function agentSize(e: RecipeEntry): number | undefined {
  const mib = AGENT_MIB[e.id.slice(e.id.indexOf("/") + 1)];
  return mib === undefined ? undefined : mib * MIB;
}

export interface DiskEstimate {
  /** The files that travel, as the caller counted them. */
  files: number;
  /** Homebrew with its glibc and gcc, when any formula brings it. */
  toolchain: number;
  /** Every formula the ticked rows and the plan's managers pull in, each once, plus measured globals. */
  tools: number;
  /** The measured agents, and the Node release the stage installs when an agent's floor is above the base's. */
  agents: number;
  /** Ticked rows that install something whose size nothing knows, by label. */
  unknown: string[];
  /** What the unknown rows count as in the total, each at the default for its kind. */
  assumed: number;
  total: number;
  room: number;
  /** How far the total is past the room; zero when it fits. */
  over: number;
}

/** The recipe's cost on the disk from the ticked rows, the plan they make and the Mac's table. */
export function estimateDisk(ticked: readonly RecipeEntry[], files: number, brew: BrewTable): DiskEstimate {
  const plan = toolInstallsFor(ticked, brew);
  const installs = new Set(plan.installs.map(t => t.id));
  const toolchain = installs.has("tools/homebrew") ? BREW_TOOLCHAIN_BYTES : 0;
  const members = new Set<string>();
  let tools = 0;
  let assumed = 0;
  const unknown: string[] = [];
  const assume = (e: RecipeEntry): void => {
    unknown.push(e.label);
    assumed += assumedSize(e).bytes;
  };
  for (const e of ticked) {
    if (e.rung !== "tools" || !installs.has(e.id) || e.id.startsWith("tools/brew-tap/")) continue;
    const formula = formulaOf(e);
    if (formula !== undefined) {
      if (formulaBytes(formula, brew) === undefined) assume(e);
      else for (const m of closureOf(formula, brew)) members.add(m);
      continue;
    }
    const size = toolSize(e, brew);
    if (size === undefined) assume(e);
    else tools += size.bytes;
  }
  for (const t of plan.installs) {
    if (!t.id.startsWith("tools/manager/") || t.manager !== "brew") continue;
    const formula = MANAGER_FORMULA[t.label as keyof typeof MANAGER_FORMULA];
    if (formula !== undefined) for (const m of closureOf(formula, brew)) members.add(m);
  }
  for (const m of members) tools += formulaBytes(m, brew) ?? 0;
  let agents = 0;
  for (const e of ticked) {
    if (e.rung !== "agents" || !installable(e)) continue;
    const size = agentSize(e);
    if (size === undefined) assume(e);
    else agents += size;
  }
  const node = agentInstallsFor(ticked).node;
  if (node !== undefined && node.floor > BASE_NODE_MAJOR) agents += NODE_BYTES;
  const total = files + toolchain + tools + agents + assumed;
  return { files, toolchain, tools, agents, unknown, assumed, total, room: DISK_ROOM_BYTES, over: Math.max(0, total - DISK_ROOM_BYTES) };
}
