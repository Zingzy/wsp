// SPDX-License-Identifier: AGPL-3.0-only
// Which paths under an agent's home on the machine hold one project's state.
// Nothing on the machine can run the engine, so each module emits a python3
// script the machine runs there and the trip pulls only the paths it prints.
// A store the script cannot read comes home whole instead, so the trip still
// reports it the way it reports a store it cannot read here.
import { PY_PREAMBLE, pyData } from "./py.js";

/** The step that names a module's whole roots: what a home gives up when its module emits no listing of its own, and
 * what a listing falls back to when a store on the machine will not open. */
export const ROOTS_STEP = ["for r in ROOTS:", "    say(r)"].join("\n");

const indented = (step: string): string[] => step.split("\n").map(l => `    ${l}`);

/**
 * A listing script from its steps: the shared preamble, then HOME and PATH, say() for a path the trip pulls, and
 * ROOTS for the module's roots joined onto the home. The paths are collected and printed at the end, one per line,
 * so a step that raises half way leaves the roots behind rather than half a listing.
 */
export function listScript(home: string, path: string, roots: readonly string[], steps: readonly string[]): string {
  return [
    PY_PREAMBLE,
    `HOME = ${pyData(home)}`,
    // The same spelling resolveProjectPath gives the path here, so the machine and this computer agree on the key.
    `PATH = os.path.normpath(${pyData(path)})`,
    `ROOTS = [os.path.join(HOME, r) for r in ${pyData(roots)}]`,
    "OUT = []",
    "def say(p):",
    "    if os.path.exists(p) and p not in OUT:",
    "        OUT.append(p)",
    "try:",
    ...steps.flatMap(indented),
    "except Exception:",
    "    OUT = []",
    ...indented(ROOTS_STEP),
    "for p in OUT:",
    "    print(p)",
  ].join("\n");
}

/**
 * A step naming the directories under `parent` keyed to the project, `key` being a python expression for the key rule
 * the module spells here as keyOf. The key is lossy, so the cwd the directory's first transcript line records decides
 * and a directory with no transcript belongs only when it is the project's own key: the same rule keyedDirectories
 * follows on this computer.
 */
export function keyedStep(parent: string, key: string): string {
  return [
    `PARENT = ${pyData(parent)}`,
    `key = ${key}`,
    "def recorded(d):",
    "    found = []",
    "    for base, _dirs, names in os.walk(d):",
    '        found += [os.path.join(base, n) for n in names if n.endswith(".jsonl")]',
    "    for f in sorted(found):",
    '        with open(f, encoding="utf-8", errors="surrogateescape", newline="") as h:',
    "            for line in h:",
    "                try:",
    "                    obj = json.loads(line)",
    "                except ValueError:",
    "                    continue",
    '                if isinstance(obj, dict) and isinstance(obj.get("cwd"), str):',
    '                    return obj["cwd"]',
    "    return None",
    "own = key(PATH)",
    'other = key(PATH + "/x")',
    "n = 0",
    "while n < len(own) and n < len(other) and own[n] == other[n]:",
    "    n += 1",
    "stem = own[:n]",
    "for name in sorted(os.listdir(PARENT)) if os.path.isdir(PARENT) else []:",
    "    d = os.path.join(PARENT, name)",
    "    if not name.startswith(stem) or not os.path.isdir(d):",
    "        continue",
    "    cwd = recorded(d)",
    "    if cwd is None and name == own:",
    "        cwd = PATH",
    "    if cwd is not None and under(cwd, PATH):",
    "        say(d)",
  ].join("\n");
}
