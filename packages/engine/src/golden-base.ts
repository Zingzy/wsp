// SPDX-License-Identifier: AGPL-3.0-only
// The base floor: what every golden gets before the person's recipe, from
// the catalog's floor rows by each row's own road, and the versions read back
// once they are on. It runs under the base stage ahead of the daemon, so the
// daemon's native module compiles against the Node the agents will run.
import { BASE_FLOOR, smokeOf, type InstallRoad, type ToolEntry } from "@wsp/catalog";
import type { GoldenStage } from "@wsp/protocol";
import { PRELUDE } from "./dotfiles-presets.js";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { PATH_LINE, TOOLS_PATH, type ToolInstall } from "./golden-import.js";
import { fmtBytes, installTools, type ToolResult } from "./golden-tools.js";
import type { Machine } from "./machine.js";

const BASE_STAGE: GoldenStage = "deploying-daemon";
const APT_INDEX = "base/apt-index";
const APT_ENV = "export DEBIAN_FRONTEND=noninteractive";

const stepId = (e: ToolEntry): string => `base/${e.id}`;

function roadCommand(road: InstallRoad): string {
  switch (road.road) {
    case "script":
      return road.script;
    case "npm":
      if (road.version === undefined) throw new Error(`${road.package} names no version to pin`);
      return `npm install -g ${road.ignoreScripts === true ? "--ignore-scripts " : ""}${road.package}@${road.version}`;
    case "apt":
      return `${APT_ENV}\napt-get install -y -qq ${road.packages.join(" ")}`;
    default:
      throw new Error(`the ${road.road} road is not one the base stage runs`);
  }
}

/** What a floor row waits on: pnpm on the Node it rides, Python on the uv that fetches it, every apt row on the one index read. */
function after(e: ToolEntry): string | undefined {
  if (e.id === "pnpm") return stepId(BASE_FLOOR.find(x => x.id === "node")!);
  if (e.id === "python") return stepId(BASE_FLOOR.find(x => x.id === "uv")!);
  if (e.installRoad.road === "apt") return APT_INDEX;
  return undefined;
}

const withEnv = (cmd: string): string => `${PRELUDE}\n${PATH_LINE}\n${cmd}`;

/** The floor as the tools loop runs it: one guarded step per row in catalog order, the apt index read once before the first apt row. */
export function baseInstalls(): ToolInstall[] {
  const out: ToolInstall[] = [];
  for (const e of BASE_FLOOR) {
    if (e.installRoad.road === "apt" && !out.some(t => t.id === APT_INDEX)) out.push({ id: APT_INDEX, label: "apt index", manager: "apt", cmd: withEnv(`${APT_ENV}\napt-get update -qq`) });
    const dep = after(e);
    out.push({ id: stepId(e), label: e.name, manager: e.installRoad.road === "script" ? "script" : e.installRoad.road, cmd: withEnv(roadCommand(e.installRoad)), ...(dep !== undefined ? { after: dep } : {}), bin: e.bin });
  }
  return out;
}

interface VersionCheck {
  /** The name the line and the machine context show. */
  name: string;
  cmd: string;
  /** The floor row whose install put it there; absent for a command that rode in with another. */
  id?: string;
}

/** What comes along with a floor row and has a version of its own. */
const COMPANIONS: Record<string, readonly { name: string; cmd: string }[]> = {
  node: [{ name: "npm", cmd: "npm --version" }],
  docker: [{ name: "docker compose", cmd: "docker compose version" }],
};

const VERSION_CHECKS: readonly VersionCheck[] = BASE_FLOOR.flatMap(e => [{ name: e.bin, cmd: smokeOf(e), id: e.id }, ...(COMPANIONS[e.id] ?? [])]);

/** One exec that prints `VERSION <name>: <first line>` for every floor command, an empty line for one that is not there. */
export const BASE_VERSIONS_CMD = [`export PATH=${TOOLS_PATH}:$PATH`, ...VERSION_CHECKS.map(c => `echo "VERSION ${c.name}: $(${c.cmd} 2>/dev/null | head -n 1)"`)].join("\n");

export interface ToolVersion {
  name: string;
  version: string;
}

/** The versions the read printed, each as its number alone; a command that printed nothing, or nothing with a number in it, is left out. */
export function parseVersions(stdout: string): ToolVersion[] {
  const out: ToolVersion[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^VERSION ([^:]+): (.*)$/.exec(line.trimEnd());
    if (m === null) continue;
    const version = /\d+\.\d+(?:\.\d+)?/.exec(m[2]!)?.[0];
    if (version !== undefined) out.push({ name: m[1]!, version });
  }
  return out;
}

/** The base stage's closing words: each command with its version and, when df moved across its install, what it cost;
 * then every floor row that did not land, by its reason. */
export function versionsLine(versions: readonly ToolVersion[], results: readonly ToolResult[]): string {
  const landed = versions.map(v => {
    const check = VERSION_CHECKS.find(c => c.name === v.name);
    const bytes = check?.id === undefined ? undefined : results.find(r => r.id === `base/${check.id}`)?.bytes;
    return `${v.name} ${v.version}${bytes !== undefined && bytes > 0 ? ` (${fmtBytes(bytes)})` : ""}`;
  });
  const missed = results.filter(r => r.id !== APT_INDEX && r.outcome !== "installed").map(r => `${r.label} ${r.outcome} (${r.note})`);
  return [landed.join(", "), ...missed].filter(s => s !== "").join("; ");
}

export interface BaseOutcome {
  tools: ToolResult[];
  /** The stage's closing words. */
  line: string;
}

/** Installs the floor and reads the versions back; the tools loop names each failure alone and skips what waited on it. */
export async function installBase(machine: Machine, stage: (stage: GoldenStage, detail?: string) => void): Promise<BaseOutcome> {
  const { tools } = await installTools(machine, baseInstalls(), stage, BASE_STAGE);
  const read = await machine.exec(BASE_VERSIONS_CMD, { timeoutMs: INLINE_EXEC_MS });
  return { tools, line: versionsLine(parseVersions(read.stdout), tools) };
}
