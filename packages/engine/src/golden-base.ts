// SPDX-License-Identifier: AGPL-3.0-only
// The base floor: what every golden gets before the person's recipe, from
// the catalog's floor rows by each row's own road, and the versions read back
// once they are on. It runs under the base stage ahead of the daemon, so the
// daemon's native module compiles against the Node the agents will run.
import { BASE_FLOOR, installAfter, installLine, smokeOf } from "@wsp/catalog";
import { fmtBytes, type GoldenBaseTool, type GoldenStage } from "@wsp/protocol";
import { PRELUDE } from "./dotfiles-presets.js";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { PATH_LINE, TOOLS_PATH, type ToolInstall } from "./golden-import.js";
import { installTools, type ToolResult } from "./golden-tools.js";
import type { Machine } from "./machine.js";

const BASE_STAGE: GoldenStage = "deploying-daemon";
const APT_INDEX = "base/apt-index";
const APT_ENV = "export DEBIAN_FRONTEND=noninteractive";

const stepId = (id: string): string => `base/${id}`;

const withEnv = (cmd: string): string => `${PRELUDE}\n${PATH_LINE}\n${cmd}`;

/** The floor as the tools loop runs it: one guarded step per row in catalog order by the catalog's install line, each
 * after the row the catalog says it runs on top of; the apt index is read once, before the first row that waits on it. */
export function baseInstalls(): ToolInstall[] {
  const out: ToolInstall[] = [];
  for (const e of BASE_FLOOR) {
    const dep = installAfter(e);
    if (dep !== undefined && stepId(dep) === APT_INDEX && !out.some(t => t.id === APT_INDEX)) out.push({ id: APT_INDEX, label: "apt index", manager: "apt", cmd: withEnv(`${APT_ENV}\napt-get update -qq`) });
    out.push({ id: stepId(e.id), label: e.name, manager: e.installRoad.road, cmd: withEnv(installLine(e)), ...(dep !== undefined ? { after: stepId(dep) } : {}), bin: e.bin });
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

const VERSION_CHECKS: readonly VersionCheck[] = BASE_FLOOR.flatMap(e => [{ name: e.bin, cmd: smokeOf(e), id: e.id }, ...(e.brings ?? []).map(b => ({ name: b.bin, cmd: b.version }))]);

/** One `VERSION <name>: <first line>` echo per floor command, an empty value for one that is not there; the caller puts the tools PATH ahead. */
export const BASE_VERSION_LINES = VERSION_CHECKS.map(c => `echo "VERSION ${c.name}: $(${c.cmd} 2>/dev/null | head -n 1)"`).join("\n");

/** The read as one exec, as the base stage runs it. */
export const BASE_VERSIONS_CMD = `export PATH=${TOOLS_PATH}:$PATH\n${BASE_VERSION_LINES}`;

/** The versions the read printed, each as its number alone; a command that printed nothing, or nothing with a number in it, is left out. */
export function parseVersions(stdout: string): GoldenBaseTool[] {
  const out: GoldenBaseTool[] = [];
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
export function versionsLine(versions: readonly GoldenBaseTool[], results: readonly ToolResult[]): string {
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
  /** What the read found on the machine; the sealed version records it. */
  versions: GoldenBaseTool[];
  /** The stage's closing words. */
  line: string;
}

/** Installs the floor and reads the versions back; the tools loop names each failure alone and skips what waited on it. */
export async function installBase(machine: Machine, stage: (stage: GoldenStage, detail?: string) => void): Promise<BaseOutcome> {
  const { tools } = await installTools(machine, baseInstalls(), stage, BASE_STAGE);
  const read = await machine.exec(BASE_VERSIONS_CMD, { timeoutMs: INLINE_EXEC_MS });
  const versions = parseVersions(read.stdout);
  return { tools, versions, line: versionsLine(versions, tools) };
}
