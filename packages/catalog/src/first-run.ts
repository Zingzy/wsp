// SPDX-License-Identifier: AGPL-3.0-only
// A command on PATH that is not the agent but a script that puts the agent on
// the computer the first time it runs, as Omarchy ships every agent:
//   mise use -g --quiet "claude" || exit 1
//   exec mise x "claude" -- "claude" "$@"
// and as ASCII's cloud image ships Cursor and Hermes, through its lazy-run.
// Its first run is a download (97 s for Claude Code on a fresh Omarchy,
// 2026-10-05), so no reader runs it to ask a version, and a send that waits on
// it says why. One module per installer; adding one is a row in FIRST_RUN_INSTALLERS.
import { shellQuote } from "@wsp/protocol";

export interface FirstRunInstaller {
  readonly id: string;
  /** The tool the script installs, off its text; none where the script is not this installer's. */
  tool(script: string): string | undefined;
  /** A shell test that passes once that tool is installed, which installs nothing. */
  installed(tool: string): string;
}

const commandWords = (rest: string): string[] => {
  const words: string[] = [];
  for (const raw of rest.trim().split(/\s+/)) {
    if (["||", "&&", ";", "|"].includes(raw)) break;
    words.push(raw.replace(/^["']|["';]+$/g, ""));
  }
  return words;
};

/** mise keeps each tool under its data folder's installs, in a folder named off the tool with its version cut, by
 * heck's to_kebab_case (mise's tool_directory_name): every run of other characters splits words, as does a capital
 * after a small letter and the last capital of a run before a small letter; the words go lower case, joined by `-`. */
const miseFolder = (spec: string): string => {
  const at = spec.lastIndexOf("@");
  const name = at > 0 && spec[at - 1] !== ":" ? spec.slice(0, at) : spec;
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(word => word !== "")
    .map(word => word.toLowerCase())
    .join("-");
};

const MISE: FirstRunInstaller = {
  id: "mise",
  tool: script => {
    for (const line of script.split("\n")) {
      const m = /^[^#]*\bmise\s+(?:use|install)\b(.*)$/.exec(line);
      const spec = m === null ? undefined : commandWords(m[1]!).find(w => w !== "" && !w.startsWith("-"));
      if (spec !== undefined) return spec;
    }
    return undefined;
  },
  installed: tool => `[ -n "$(ls -A "\${MISE_DATA_DIR:-\${XDG_DATA_HOME:-$HOME/.local/share}/mise}/installs/"${shellQuote(miseFolder(tool))} 2>/dev/null)" ]`,
};

/** ASCII's shim at /usr/local/bin/<name> runs the first other <name> on PATH, else its launcher, which runs lazy-run
 * until lazy-run's install puts the agent in the launcher's place (/usr/local/lib/ascii-harnesses/lazy-run, its
 * adopt). The tool is the launcher's path, off the shim's last line. */
const LAZY_RUN: FirstRunInstaller = {
  id: "lazy-run",
  tool: script => {
    if (script.split("\n")[1] !== "# ascii-harness-shim") return undefined;
    return [...script.matchAll(/^exec (\/\S+) "\$@"$/gm)].at(-1)?.[1];
  },
  installed: launcher => {
    const name = shellQuote(launcher.slice(launcher.lastIndexOf("/") + 1));
    const lazy = `case "$(sed -n 2p ${shellQuote(launcher)} 2>/dev/null)" in "# ascii-lazy-harness "*) false ;; esac`;
    const past = `d=$(dirname "$(command -v ${name})") && PATH=$(printf %s "$PATH" | tr : "\\n" | grep -vxF "$d" | paste -sd:) command -v ${name} >/dev/null 2>&1`;
    return `{ ${lazy} || { ${past}; }; }`;
  },
};

export const FIRST_RUN_INSTALLERS: readonly FirstRunInstaller[] = [MISE, LAZY_RUN];

/** Runs one sh script where the agents' commands are looked up, answering its stdout, or nothing when it failed. */
export type RunScript = (script: string) => Promise<string | undefined>;

/** The first bytes of the command each bin answers with on PATH where that command is a script, one record each. */
const headsScript = (bins: readonly string[]): string =>
  `for b in ${bins.map(shellQuote).join(" ")}; do printf '\\036'; p=$(command -v "$b" 2>/dev/null) && [ -f "$p" ] && [ "$(head -c 2 "$p" 2>/dev/null)" = "#!" ] && head -c 4096 "$p"; done; printf '\\036'`;

/** Whether each bin's command on PATH is a script that installs its agent on its first run, with that run still to
 * come. Reads the commands and the installers' own records and runs no bin: one script, and a second only where a
 * wrapper was found. A script that could not run answers false for every bin. */
export async function installsOnFirstRun(run: RunScript, bins: readonly string[]): Promise<boolean[]> {
  if (bins.length === 0) return [];
  const heads = (await run(headsScript(bins)))?.split("\x1e").slice(1, bins.length + 1) ?? [];
  const found = bins.map((_, i) => {
    const head = heads[i] ?? "";
    for (const installer of FIRST_RUN_INSTALLERS) {
      const tool = head.startsWith("#!") ? installer.tool(head) : undefined;
      if (tool !== undefined) return installer.installed(tool);
    }
    return undefined;
  });
  if (found.every(test => test === undefined)) return bins.map(() => false);
  const tests = found.map(test => (test === undefined ? "echo 0" : `if ${test}; then echo 0; else echo 1; fi`));
  const said = (await run(tests.join("\n")))?.split("\n") ?? [];
  return found.map((test, i) => test !== undefined && said[i] === "1");
}
