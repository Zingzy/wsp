// SPDX-License-Identifier: AGPL-3.0-only
// The machine context: two renders for every agent on the guest, a short text
// each agent loads at start with the facts it must not get wrong, and a skill
// in its global skills directory with the full document of what this machine
// is and how the common things are done on it. A probe reads the facts off the
// guest, both are rendered here, and the files go back up the same upload road
// the person's files take (an exec body has a cap a six-agent set exceeded)
// through a hook per agent without any file of the person's being touched. A
// hook the person's own file already claims is left alone and named in the result.
import type { GoldenVersion } from "@wsp/protocol";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { TOOLS_PATH } from "./golden-import.js";
import { TOOLS_DISK_FLOOR, fmtBytes } from "./golden-tools.js";
import type { ImportResult } from "./golden.js";
import type { Machine } from "./machine.js";
import { DAEMON_PORT } from "./preview.js";
import { importInto, tarOf } from "./vault.js";

export type ContextAgent = "claude" | "codex" | "gemini" | "opencode" | "pi" | "hermes";

export const CONTEXT_AGENTS: readonly ContextAgent[] = ["claude", "codex", "gemini", "opencode", "pi", "hermes"];

const AGENT_NAMES: Record<ContextAgent, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", opencode: "OpenCode", pi: "Pi", hermes: "Hermes Agent" };

/** The first line of the source file and of every copy, so a person who finds one knows where it comes from. */
export const CONTEXT_MARKER = "wsp writes this file when a workspace is forked; edits are overwritten.";

export const SKILL_NAME = "wsp-machine";

/** One line, plain, no colon or quote so every agent's frontmatter parser reads it whole; each caps it at 1,024 characters. */
export const SKILL_DESCRIPTION =
  "How this cloud Linux machine differs from the person's computer, what did not install here, where secrets live, and how to keep a server alive, hand over a URL and sign in. Read it before starting a server, opening a port, using a secret or calling a tool that may not be installed.";

/** Where the guest keeps system files and the home; tests point both at a temp dir and run the scripts on a local bash. */
export interface GuestRoots {
  etc: string;
  home: string;
}

export const GUEST_ROOTS: GuestRoots = { etc: "/etc", home: "/root" };

/** The short, always-loaded text; the skill beside it carries the full document. */
export const contextPath = (roots: GuestRoots = GUEST_ROOTS): string => `${roots.etc}/wsp/machine-context.md`;
export const skillPath = (roots: GuestRoots = GUEST_ROOTS): string => `${roots.etc}/wsp/skills/${SKILL_NAME}/SKILL.md`;
const factsPath = (roots: GuestRoots): string => `${roots.etc}/wsp/machine-context.json`;
const SECRETS_SH = "/etc/profile.d/wsp-secrets.sh";
const SECRETS_FISH = "/etc/fish/conf.d/wsp-secrets.fish";
const GIB = 1024 * 1024 * 1024;

/** Mirrors @wsp/daemon's OPEN_SHIM_PATH (the engine cannot import the daemon package, which only runs inside guests); a host test pins the two equal. */
export const BROWSER_SHIM_PATH = "/usr/local/bin/wsp-open";

// --- what did not land, kept on the guest between builds ---------------------

export interface MissingItem {
  id: string;
  label: string;
  note: string;
}

/** What the recipe asked for that is not on the machine, with the reason for each; a build writes it beside the
 * document, an update folds its own outcomes in, and a workspace reads it back. */
export interface BuildFacts {
  tools: MissingItem[];
  agents: MissingItem[];
  files: { path: string; note: string }[];
}

const EMPTY_FACTS: BuildFacts = { tools: [], agents: [], files: [] };

/** A run's outcomes over what the guest already records: a row that installed or was removed leaves the list,
 * one that was skipped or failed enters it or replaces its earlier note. */
export function mergeFacts(prior: BuildFacts | undefined, result: ImportResult | undefined): BuildFacts {
  const facts: BuildFacts = { tools: [...(prior?.tools ?? [])], agents: [...(prior?.agents ?? [])], files: [...(prior?.files ?? [])] };
  if (result === undefined) return facts;
  const fold = (list: MissingItem[], rows: { id: string; label: string; outcome: string; note?: string }[]): MissingItem[] => {
    const missing = rows.filter(r => r.outcome !== "installed").map(r => ({ id: r.id, label: r.label, note: r.note ?? r.outcome }));
    const kept = list.flatMap(m => (rows.some(r => r.id === m.id) ? missing.filter(r => r.id === m.id) : [m]));
    return [...kept, ...missing.filter(r => !list.some(m => m.id === r.id))];
  };
  facts.tools = fold(facts.tools, result.tools);
  facts.agents = fold(facts.agents, result.agents.map(a => ({ id: a.id, label: a.name, outcome: a.outcome, ...(a.note !== undefined ? { note: a.note } : {}) })));
  for (const r of result.removed ?? []) {
    if (r.outcome !== "removed") continue;
    facts.tools = facts.tools.filter(m => m.id !== r.id);
    facts.agents = facts.agents.filter(m => m.id !== r.id);
  }
  if (result.files !== undefined) {
    facts.files = facts.files.filter(f => !result.files!.skipped.some(s => s.path === f.path));
    for (const s of result.files.skipped) facts.files.push({ path: s.path, note: s.note });
  }
  return facts;
}

function parseFacts(b64: string): BuildFacts | undefined {
  try {
    const v = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Partial<BuildFacts>;
    return { tools: Array.isArray(v.tools) ? v.tools : [], agents: Array.isArray(v.agents) ? v.agents : [], files: Array.isArray(v.files) ? v.files : [] };
  } catch {
    return undefined;
  }
}

// --- the probe ---------------------------------------------------------------

export interface ContextProbe {
  kernel?: string;
  disk?: { sizeBytes: number; freeBytes: number };
  /** The kernel lists overlayfs, which containers need. */
  overlay: boolean;
  /** Binaries and files found: docker, podman, tmux, fish, brew, golden-path, wsp-open. */
  has: Set<string>;
  agents: ContextAgent[];
  /** Names the secrets file exports, never values. */
  secrets: string[];
  shell: string;
  /** Aliases the login shell defines whose command is not on the machine. */
  aliases: { name: string; word: string }[];
  /** Agents whose own file claims the hook wsp would use; Claude Code, Codex and OpenCode have no such hook. */
  conflicts: Set<ContextAgent>;
  facts?: BuildFacts;
}

function squote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Words an alias may start with before the command it runs. */
const ALIAS_PREFIX = "sudo|command|builtin|exec|env|nohup|noglob|nocorrect|time";

/** A word shaped like a command name; anything else (a brace, a semicolon from a body that starts on a new line,
 * a path) is not reported, since the sentence "x runs y" must be true. */
const ALIAS_WORD_SHAPE = "''|*[!A-Za-z0-9_.+-]*|[!A-Za-z0-9_]*";

/** The POSIX tail shared by zsh and bash: the first word, its shape, and a body that defines that word itself. */
const aliasTail = (body: string, lookup: string): string[] => [
  `  for t in ${body}; do`,
  `    case $t in [A-Za-z_]*=*|${ALIAS_PREFIX}) continue;; esac`,
  "    w=${t#\\\\}; w=${w#\\'}; w=${w#\\\"}; break",
  "  done",
  `  case $w in ${ALIAS_WORD_SHAPE}) continue;; esac`,
  '  case $b in *"$w()"*|*"$w ()"*|*"function $w"*) continue;; esac',
  `  ${lookup} >/dev/null 2>&1 || echo "ALIAS $k $w"`,
];

/** Each alias the login shell defines, checked in that shell from its own alias listing: the first word that is not
 * an assignment or a prefix word is looked up, and one the shell cannot find is printed with the alias. */
export const ALIAS_PROBES: Record<string, string> = {
  zsh: ["for k in ${(k)aliases}; do", "  b=$aliases[$k]; w=", ...aliasTail("${(z)b}", 'whence -w -- "$w"'), "done"].join("\n"),
  bash: [
    "set -f",
    "alias | while IFS= read -r line; do",
    '  case $line in "alias "*=*) ;; *) continue;; esac',
    "  rest=${line#alias }; k=${rest%%=*}; b=${rest#*=}; b=${b#\\'}; b=${b%\\'}; w=",
    ...aliasTail("$b", 'type -t "$w"'),
    "done",
  ].join("\n"),
  fish: [
    "for line in (alias)",
    "  set -l rest (string replace -r '^alias ' '' -- $line)",
    "  set -l name (string split -m1 ' ' -- $rest)[1]",
    "  set -l def (string split -m1 ' ' -- $rest)[2]",
    "  if string match -q '*=*' -- $name",
    "    set def (string split -m1 '=' -- $rest)[2]",
    "    set name (string split -m1 '=' -- $rest)[1]",
    "  end",
    "  set -l w",
    `  for t in (string split ' ' -- (string trim -l -c "'\\"\\\\" -- $def))`,
    "    if string match -qr '^[A-Za-z_][A-Za-z0-9_]*=' -- $t; continue; end",
    `    if contains -- $t ${ALIAS_PREFIX.split("|").join(" ")}; continue; end`,
    "    set w $t; break",
    "  end",
    "  string match -qr '^[A-Za-z0-9_][A-Za-z0-9_.+-]*$' -- $w; or continue",
    '  type -q -- $w; or echo "ALIAS $name $w"',
    "end",
  ].join("\n"),
};

/** True when the person's Gemini settings set context.fileName; comments are stripped the way Gemini strips them,
 * and a file that still does not parse is searched for the key by name. */
const GEMINI_FILENAME_CHECK = [
  'const t=require("fs").readFileSync(process.argv[1],"utf8");',
  'let o="",i=0,s=false;',
  "while(i<t.length){const c=t[i];",
  'if(s){o+=c;if(c==="\\\\"&&i+1<t.length)o+=t[++i];else if(c===\'"\')s=false;i++}',
  'else if(c===\'"\'){s=true;o+=c;i++}',
  'else if(c==="/"&&t[i+1]==="/"){while(i<t.length&&t[i]!=="\\n")i++}',
  'else if(c==="/"&&t[i+1]==="*"){const e=t.indexOf("*/",i+2);i=e<0?t.length:e+2}',
  "else{o+=c;i++}}",
  "let hit;try{const j=JSON.parse(o);hit=!!(j&&j.context&&j.context.fileName!==undefined)}catch{hit=/\"fileName\"\\s*:/.test(o)}",
  "process.exit(hit?0:1)",
].join("");

/** True when agent.environment_hint is set to something other than an empty string. */
const HERMES_HINT_CHECK = [
  "/^[^[:space:]#]/{blk=$1}",
  'blk=="agent:" && /^[[:space:]]+environment_hint[[:space:]]*:/{v=$0; sub(/^[^:]*:[[:space:]]*/,"",v); sub(/[[:space:]]+#.*$/,"",v); if (v!="" && v!="\\"\\"" && v!="\'\'") f=1}',
  "END{exit !f}",
].join(" ");

/** Runs a command in the background and kills it at the bound, so a login shell that waits cannot hold the probe. */
export function boundedCommand(seconds: number, cmd: string): string {
  return `${cmd} & p=$!; ( sleep ${seconds}; kill $p 2>/dev/null ) >/dev/null 2>&1 & k=$!; wait $p; kill $k 2>/dev/null`;
}

/** One short exec that prints the facts between two markers: the kernel, the disk, what is installed, the secret
 * names, the aliases the login shell cannot resolve, each hook the person's file already claims, and the facts a
 * build left on the guest. Every read fails alone. */
export function probeCommand(roots: GuestRoots = GUEST_ROOTS): string {
  const h = roots.home;
  const e = roots.etc;
  return [
    `export PATH=${TOOLS_PATH}:$PATH`,
    "echo WSP_CTX",
    'echo "KERNEL $(uname -r 2>/dev/null)"',
    `echo "DISK $(df -Pk ${h} 2>/dev/null | awk 'NR==2{print $2, $4}')"`,
    "if grep -qw overlay /proc/filesystems 2>/dev/null; then echo OVERLAY yes; else echo OVERLAY no; fi",
    'for b in docker podman tmux fish brew; do if command -v "$b" >/dev/null 2>&1; then echo "HAS $b"; fi; done',
    `if [ -f ${e}/profile.d/wsp-golden.sh ]; then echo "HAS golden-path"; fi`,
    `if [ -x ${BROWSER_SHIM_PATH} ]; then echo "HAS wsp-open"; fi`,
    `for a in ${CONTEXT_AGENTS.join(" ")}; do if command -v "$a" >/dev/null 2>&1; then echo "AGENT $a"; fi; done`,
    `sed -n 's/^export \\([A-Za-z_][A-Za-z0-9_]*\\)=.*/SECRET \\1/p' ${e}/profile.d/wsp-secrets.sh 2>/dev/null`,
    'shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7); shell=${shell##*/}; shell=${shell:-bash}',
    'echo "SHELL $shell"',
    "case $shell in",
    `  zsh) ${boundedCommand(8, `zsh -lic ${squote(ALIAS_PROBES["zsh"]!)} </dev/null 2>/dev/null`)} ;;`,
    `  fish) ${boundedCommand(8, `fish -lic ${squote(ALIAS_PROBES["fish"]!)} </dev/null 2>/dev/null`)} ;;`,
    `  *) ${boundedCommand(8, `bash -lic ${squote(ALIAS_PROBES["bash"]!)} </dev/null 2>/dev/null`)} ;;`,
    "esac",
    `if [ -f ${h}/.gemini/settings.json ] && node -e ${squote(GEMINI_FILENAME_CHECK)} ${h}/.gemini/settings.json 2>/dev/null; then echo "CONFLICT gemini"; fi`,
    `if [ -f ${h}/.pi/agent/APPEND_SYSTEM.md ] && ! head -n 1 ${h}/.pi/agent/APPEND_SYSTEM.md | grep -qF ${squote(CONTEXT_MARKER)}; then echo "CONFLICT pi"; fi`,
    `if [ -f ${h}/.hermes/config.yaml ] && awk ${squote(HERMES_HINT_CHECK)} ${h}/.hermes/config.yaml; then echo "CONFLICT hermes"; fi`,
    `if [ -f ${factsPath(roots)} ]; then echo "FACTS $(base64 < ${factsPath(roots)} | tr -d '\\n')"; fi`,
    "echo WSP_CTX_END",
  ].join("\n");
}

const isAgent = (s: string): s is ContextAgent => (CONTEXT_AGENTS as readonly string[]).includes(s);

/** The probe's lines between its markers; nothing when the markers are missing. */
export function parseProbe(stdout: string): ContextProbe | undefined {
  const lines = stdout.split("\n").map(l => l.trimEnd());
  const start = lines.indexOf("WSP_CTX");
  const end = lines.indexOf("WSP_CTX_END");
  if (start === -1 || end === -1 || end < start) return undefined;
  const probe: ContextProbe = { overlay: false, has: new Set(), agents: [], secrets: [], shell: "bash", aliases: [], conflicts: new Set() };
  for (const line of lines.slice(start + 1, end)) {
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? "" : line.slice(sp + 1).trim();
    switch (key) {
      case "KERNEL":
        if (rest !== "") probe.kernel = rest;
        break;
      case "DISK": {
        const [size, free] = rest.split(/\s+/).map(Number);
        if (size !== undefined && free !== undefined && Number.isFinite(size) && Number.isFinite(free) && size > 0) probe.disk = { sizeBytes: size * 1024, freeBytes: free * 1024 };
        break;
      }
      case "OVERLAY":
        probe.overlay = rest === "yes";
        break;
      case "HAS":
        if (rest !== "") probe.has.add(rest);
        break;
      case "AGENT":
        if (isAgent(rest) && !probe.agents.includes(rest)) probe.agents.push(rest);
        break;
      case "SECRET":
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rest) && !probe.secrets.includes(rest)) probe.secrets.push(rest);
        break;
      case "SHELL":
        if (rest !== "") probe.shell = rest;
        break;
      case "ALIAS": {
        const at = rest.indexOf(" ");
        if (at > 0) probe.aliases.push({ name: rest.slice(0, at), word: rest.slice(at + 1).trim() });
        break;
      }
      case "CONFLICT":
        if (isAgent(rest)) probe.conflicts.add(rest);
        break;
      case "FACTS": {
        const facts = parseFacts(rest);
        if (facts !== undefined) probe.facts = facts;
        break;
      }
    }
  }
  probe.aliases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return probe;
}

// --- the document ------------------------------------------------------------

export interface ContextInput {
  /** Absent on a golden builder, which is not a workspace. */
  workspace?: { name: string };
  /** Absent while the golden is being built, before its version exists. */
  golden?: Pick<GoldenVersion, "version" | "createdAt" | "setupSha">;
  probe: ContextProbe;
  facts: BuildFacts;
  /** The agent this render is for; absent for the shared source files, which state nothing agent-specific. */
  agent?: ContextAgent;
}

/** What is true of a cd for this agent. Only Claude Code's shell is known to persist across tool calls, with the
 * files pane following it; every other agent gets the facts wsp has verified for all of them. */
const cdFact = (agent: ContextAgent | undefined): string =>
  agent === "claude"
    ? "- Every agent session starts in the thread's folder; terminal panes open in the home folder. A cd moves your own shell, which persists across your tool calls, not the thread's folder, and the files pane follows that shell's folder unless you pinned the panes."
    : "- Every agent session starts in the thread's folder; terminal panes open in the home folder.";

const cdHowto = (agent: ContextAgent | undefined): string =>
  agent === "claude"
    ? "- Work in a folder: cd <dir> in your shell and it stays there across your tool calls; the thread's folder does not move. Absolute paths work from anywhere."
    : "- Work in a folder: cd <dir> && <cmd> on one line, or absolute paths.";

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

function missingList(items: readonly { label: string; note: string }[]): string {
  return items.map(m => `${m.label} (${m.note})`).join("; ");
}

/** The document, sentence case and dry: what is true of this machine, what is true of this workspace, and how the
 * things that go wrong here are done right. */
export function renderMachineContext(input: ContextInput): string {
  const { probe, facts } = input;
  const fish = probe.has.has("fish");
  const shim = probe.has.has("wsp-open");
  const secretsFile = fish ? `${SECRETS_SH} and ${SECRETS_FISH}` : SECRETS_SH;
  const machine: string[] = [];
  machine.push(`- Linux${probe.kernel !== undefined ? ` ${probe.kernel}` : ""}, user root, home /root. macOS apps, casks and Mac App Store apps are not here.`);
  if (probe.has.has("brew")) machine.push("- Homebrew is at /home/linuxbrew/.linuxbrew.");
  if (probe.has.has("golden-path")) machine.push(`- Login shells get their PATH from /etc/profile.d/wsp-golden.sh: ${TOOLS_PATH}`);
  const containers = ["docker", "podman"].filter(b => probe.has.has(b));
  if (!probe.overlay) machine.push(`- Containers do not run here: the kernel has no overlayfs${containers.length === 0 ? ", and Docker and Podman are not installed" : ""}. Install services natively.`);
  else if (containers.length === 0) machine.push("- Docker and Podman are not installed.");
  machine.push(`- wsp-daemon listens on 0.0.0.0:${DAEMON_PORT} with its own token. Do not stop it and do not bind port ${DAEMON_PORT}.`);
  machine.push("- A background process started with a plain & inside a tool call dies when that tool call ends.");
  machine.push(cdFact(input.agent));
  machine.push("- A server listening on a port shows in the app as a server the person can open. A loopback-only bind (127.0.0.1) is unreachable through the preview edge; bind 0.0.0.0. Ports below 1024 are not forwarded.");
  if (shim) machine.push(`- Sign-ins go through wsp: BROWSER is ${BROWSER_SHIM_PATH} and xdg-open is the same shim. The page opens on the person's computer and the callback port is tunnelled back here.`);
  machine.push(`- Secrets are exported by ${secretsFile}. They are never printed, logged or committed, and that file is never read or copied. .env files, .netrc and private keys were never copied from the person's computer.`);

  const workspace: string[] = [];
  workspace.push(input.workspace !== undefined ? `- Workspace: ${input.workspace.name}.` : "- This machine is a golden builder, not a workspace yet.");
  workspace.push(input.golden !== undefined ? `- Golden: v${input.golden.version}, sealed ${input.golden.createdAt.slice(0, 10)}, setup ${input.golden.setupSha.slice(0, 12)}.` : input.workspace !== undefined ? "- Golden: version not recorded." : "- Golden: not sealed yet.");
  workspace.push(
    probe.disk !== undefined
      ? `- Disk: ${gib(probe.disk.sizeBytes)} root disk, ${gib(probe.disk.freeBytes)} free when this file was written. wsp keeps ${gib(TOOLS_DISK_FLOOR)} free and skips tool installs that would go under it.`
      : `- Disk: size unknown when this file was written. wsp keeps ${gib(TOOLS_DISK_FLOOR)} free and skips tool installs that would go under it.`,
  );
  workspace.push(`- Secrets set in ${SECRETS_SH}: ${probe.secrets.length > 0 ? probe.secrets.join(", ") : "none"}. Use them by name ($NAME); a missing one is asked for through wsp, not typed here.`);
  workspace.push(`- Tools that did not install: ${facts.tools.length > 0 ? missingList(facts.tools) : "none"}.`);
  workspace.push(`- Agents that did not install: ${facts.agents.length > 0 ? missingList(facts.agents) : "none"}.`);
  workspace.push(`- Files left on the person's computer: ${facts.files.length > 0 ? facts.files.map(f => `${f.path} (${f.note})`).join("; ") : "none"}.`);
  workspace.push(`- Aliases whose command is not here: ${probe.aliases.length > 0 ? probe.aliases.map(a => `${a.name} runs ${a.word}`).join("; ") : "none"}.`);

  const tmux = probe.has.has("tmux");
  const howto: string[] = [];
  howto.push(`- Keep a server alive: setsid nohup <cmd> > /tmp/<name>.log 2>&1 < /dev/null &${tmux ? ", or tmux new -d -s <name> '<cmd>'" : ""}. Read the log file, not the tool output. Bind 0.0.0.0 if the person should open it.`);
  howto.push(`- Hand the person a URL: print it as http://localhost:<port>; wsp forwards the port and the link opens on their computer.${shim ? " For a page that is not a local server, run wsp-open <url>; it appears in the app for them to open." : ""}`);
  if (shim) howto.push("- Ask for a sign-in: run the tool's own login command (gh auth login, gcloud auth login). It opens through $BROWSER, the person signs in on their computer, and the callback comes back here. Do not paste tokens into the terminal and do not ask for a password.");
  howto.push(cdHowto(input.agent));
  howto.push(`- Use a secret: $NAME is set from ${SECRETS_SH}. Never echo, log or commit a value, and never cat that file.`);

  return [
    CONTEXT_MARKER,
    "",
    "# This machine",
    "",
    "This is a Linux machine in the cloud that wsp set up from the recipe of the person's computer: the files, tools and agents they ticked. It is not that computer.",
    "",
    ...machine,
    "",
    "# This workspace",
    "",
    ...workspace,
    "",
    "# How to",
    "",
    ...howto,
    "",
  ].join("\n");
}


/** The always-loaded file: the facts an agent must not get wrong, and one line pointing at the skill for the rest. */
export function renderShortContext(input: ContextInput): string {
  const { probe } = input;
  const tmux = probe.has.has("tmux");
  const containers = ["docker", "podman"].filter(b => probe.has.has(b));
  const lines = [
    CONTEXT_MARKER,
    "",
    `This is a Linux machine in the cloud that wsp set up from the recipe of the person's computer; it is not that computer. The ${SKILL_NAME} skill has the full picture: what did not install, the secret names, the aliases whose commands are missing, and how the common things are done here.`,
    "",
    `- A background process started with a plain & inside a tool call dies when that tool call ends. Detach it: setsid nohup <cmd> > /tmp/<name>.log 2>&1 < /dev/null &${tmux ? ", or tmux new -d -s <name> '<cmd>'" : ""}.`,
    cdFact(input.agent),
    "- A server listening on a port shows in the app for the person to open; bind 0.0.0.0, not 127.0.0.1. A printed http://localhost:<port> link has its port forwarded to their computer. Ports below 1024 are not forwarded.",
  ];
  if (!probe.overlay) lines.push(`- Containers do not run here: the kernel has no overlayfs${containers.length === 0 ? ", and Docker and Podman are not installed" : ""}. Install services natively.`);
  else if (containers.length === 0) lines.push("- Docker and Podman are not installed.");
  lines.push(
    probe.disk !== undefined
      ? `- Disk: ${gib(probe.disk.sizeBytes)} root disk, ${gib(probe.disk.freeBytes)} free when this file was written. wsp keeps ${gib(TOOLS_DISK_FLOOR)} free.`
      : `- Disk: size unknown when this file was written. wsp keeps ${gib(TOOLS_DISK_FLOOR)} free.`,
    `- Secrets are exported by ${SECRETS_SH}. Use them by name ($NAME); never print, log or commit a value, and never read that file.`,
  );
  if (probe.has.has("wsp-open")) lines.push("- Sign-ins go through wsp: run the tool's own login command and the page opens on the person's computer. Do not paste tokens into the terminal and do not ask for a password.");
  lines.push("");
  return lines.join("\n");
}

/** The skill every agent lists by name and description and loads on demand: the full document as its body. */
export function renderSkill(doc: string): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${doc}`;
}

// --- per agent ---------------------------------------------------------------

export interface GuestFile {
  path: string;
  mode: number;
  content: string;
}

export type ContextOutcomeKind = "written" | "fallback" | "not-loaded";

/** What one agent gets: the files to land, how its always-loaded text arrives, and where its skill sits. */
export interface AgentFiles {
  outcome: ContextOutcomeKind;
  files: GuestFile[];
  /** The always-loaded hook, or the fallback that stands in for it. */
  path?: string;
  /** Why the always-loaded hook was not written. */
  note?: string;
  skill: string;
}

const MODE = 0o644;

/** The text as a TOML string: a literal multi-line string, which needs no escaping, unless the text holds the
 * one sequence that would end it. */
function tomlString(doc: string): string {
  if (!doc.includes("'''")) return `'''\n${doc}'''`;
  return JSON.stringify(doc);
}

/** What is written for each agent, from its source at the version the recipe pins. The always-loaded hook gets
 * the short text; when the person's own file sets the same key, that file wins, so the fallback hook carries the
 * short text instead, or nothing does and the result says so. The skill lands regardless, under wsp's own name. */
export function agentFiles(agent: ContextAgent, short: string, skill: string, probe: ContextProbe, roots: GuestRoots = GUEST_ROOTS): AgentFiles {
  const h = roots.home;
  const e = roots.etc;
  const source = contextPath(roots);
  const conflict = probe.conflicts.has(agent);
  const file = (path: string, content: string): GuestFile => ({ path, mode: MODE, content });
  const skillAt = (dir: string): GuestFile => file(`${dir}/${SKILL_NAME}/SKILL.md`, skill);
  switch (agent) {
    case "claude": {
      const s = skillAt(`${e}/claude-code/.claude/skills`);
      return { outcome: "written", path: `${e}/claude-code/CLAUDE.md`, files: [file(`${e}/claude-code/CLAUDE.md`, short), s], skill: s.path };
    }
    case "codex": {
      // Additive: the requirements layer's developer message lands beside the person's developer_instructions, never under them.
      const s = skillAt(`${e}/codex/skills`);
      return { outcome: "written", path: `${e}/codex/requirements.toml`, files: [file(`${e}/codex/requirements.toml`, `# ${CONTEXT_MARKER}\nadditional_developer_instructions = ${tomlString(short)}\n`), s], skill: s.path };
    }
    case "gemini": {
      const s = skillAt(`${h}/.gemini/skills`);
      if (conflict) {
        const dir = `${h}/.gemini/extensions/${SKILL_NAME}`;
        const manifest = `${JSON.stringify({ name: SKILL_NAME, version: "1.0.0", contextFileName: "WSP-MACHINE.md" }, null, 2)}\n`;
        return { outcome: "fallback", path: dir, note: "~/.gemini/settings.json sets context.fileName", files: [file(`${dir}/gemini-extension.json`, manifest), file(`${dir}/WSP-MACHINE.md`, short), s], skill: s.path };
      }
      return {
        outcome: "written",
        path: `${h}/.gemini/WSP-MACHINE.md`,
        files: [file(`${e}/gemini-cli/system-defaults.json`, `${JSON.stringify({ context: { fileName: ["GEMINI.md", "WSP-MACHINE.md"] } }, null, 2)}\n`), file(`${h}/.gemini/WSP-MACHINE.md`, short), s],
        skill: s.path,
      };
    }
    case "opencode": {
      const s = skillAt(`${h}/.config/opencode/skills`);
      return { outcome: "written", path: `${e}/opencode/opencode.json`, files: [file(`${e}/opencode/opencode.json`, `${JSON.stringify({ instructions: [source] }, null, 2)}\n`), s], skill: s.path };
    }
    case "pi": {
      const s = skillAt(`${h}/.pi/agent/skills`);
      if (conflict) {
        const ext = `${h}/.pi/agent/extensions/${SKILL_NAME}.ts`;
        const code = [
          `// ${CONTEXT_MARKER}`,
          'import { readFileSync } from "node:fs";',
          "export default function (pi) {",
          `  pi.on("before_agent_start", async event => ({ systemPrompt: \`\${event.systemPrompt}\\n\\n\${readFileSync(${JSON.stringify(source)}, "utf8")}\` }));`,
          "}",
          "",
        ].join("\n");
        return { outcome: "fallback", path: ext, note: "~/.pi/agent/APPEND_SYSTEM.md already exists", files: [file(ext, code), s], skill: s.path };
      }
      return { outcome: "written", path: `${h}/.pi/agent/APPEND_SYSTEM.md`, files: [file(`${h}/.pi/agent/APPEND_SYSTEM.md`, short), s], skill: s.path };
    }
    case "hermes": {
      const s = skillAt(`${h}/.hermes/skills`);
      if (conflict) return { outcome: "not-loaded", note: "~/.hermes/config.yaml sets agent.environment_hint", files: [s], skill: s.path };
      const files: GuestFile[] = [file(`${e}/profile.d/wsp-machine.sh`, `# ${CONTEXT_MARKER}\nexport HERMES_ENVIRONMENT_HINT="$(cat ${source})"\n`)];
      if (probe.has.has("fish")) files.push(file(`${e}/fish/conf.d/wsp-machine.fish`, `# ${CONTEXT_MARKER}\nset -gx HERMES_ENVIRONMENT_HINT (cat ${source} | string collect)\n`));
      files.push(s);
      return { outcome: "written", path: files[0]!.path, files, skill: s.path };
    }
  }
}

// --- the run -----------------------------------------------------------------

export interface ContextResult {
  agent: ContextAgent;
  outcome: ContextOutcomeKind;
  /** The always-loaded hook written, or the fallback standing in for it. */
  path?: string;
  /** Why the always-loaded hook was not written. */
  note?: string;
  /** Where the agent's copy of the skill sits. */
  skill: string;
}

/** The line the result reads as: `context.<agent>: <path>`, `context.<agent>: fallback <path>, <file> sets <key>`,
 * or `context.<agent>: not loaded, <file> sets <key>`, each ending with where the skill is. */
export function contextLine(r: ContextResult): string {
  const head = r.outcome === "written" ? `context.${r.agent}: ${r.path}` : r.outcome === "fallback" ? `context.${r.agent}: fallback ${r.path}, ${r.note}` : `context.${r.agent}: not loaded, ${r.note}; only the ${SKILL_NAME} skill's description is in the prompt`;
  return `${head}; skill ${r.skill}`;
}

export interface ContextOutcome {
  context: ContextResult[];
  /** One line for a stage detail. */
  summary: string;
  /** Set when the probe or the write did not run; nothing was changed on the guest then. */
  failure?: string;
}

export interface ApplyContextOptions {
  workspace?: { name: string };
  golden?: Pick<GoldenVersion, "version" | "createdAt" | "setupSha">;
  /** What this run installed or set aside, folded into the facts the guest keeps. */
  result?: ImportResult;
  roots?: GuestRoots;
  /** The upload's transport; tests inject one. */
  fetch?: typeof globalThis.fetch;
}

function summarize(results: readonly ContextResult[], agents: readonly ContextAgent[], bytes: number): string {
  if (agents.length === 0) return `${fmtBytes(bytes)} written; no agent on the machine`;
  const written = results.filter(r => r.outcome === "written").map(r => AGENT_NAMES[r.agent]);
  const parts = [written.length > 0 ? `${fmtBytes(bytes)} written for ${written.join(", ")}` : `${fmtBytes(bytes)} written`];
  for (const r of results) {
    if (r.outcome === "fallback") parts.push(`${AGENT_NAMES[r.agent]} by its fallback (${r.note})`);
    if (r.outcome === "not-loaded") parts.push(`${AGENT_NAMES[r.agent]} not loaded (${r.note}), skill only`);
  }
  return parts.filter(p => p !== "").join("; ");
}

const failed = (failure: string): ContextOutcome => ({ context: [], summary: `not written (${failure})`, failure });

/** Probes the guest, renders the short text and the skill once for the shared source files and once per agent, and
 * lands them with every agent's hooks as one archive through the upload road. Never throws: a guest that does not
 * answer is reported in the outcome and the caller decides what that means. */
export async function applyMachineContext(machine: Machine, opts: ApplyContextOptions = {}): Promise<ContextOutcome> {
  const roots = opts.roots ?? GUEST_ROOTS;
  let probed;
  try {
    probed = await machine.exec(probeCommand(roots), { timeoutMs: INLINE_EXEC_MS });
  } catch (e) {
    return failed(`probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const probe = parseProbe(probed.stdout);
  if (probe === undefined) return failed(`probe answered exit ${probed.exitCode} without its markers`);
  const facts = mergeFacts(probe.facts ?? EMPTY_FACTS, opts.result);
  const input: ContextInput = { ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}), ...(opts.golden !== undefined ? { golden: opts.golden } : {}), probe, facts };
  const files: GuestFile[] = [
    { path: contextPath(roots), mode: MODE, content: renderShortContext(input) },
    { path: skillPath(roots), mode: MODE, content: renderSkill(renderMachineContext(input)) },
    { path: factsPath(roots), mode: MODE, content: `${JSON.stringify(facts, null, 2)}\n` },
  ];
  const context: ContextResult[] = [];
  for (const agent of CONTEXT_AGENTS) {
    if (!probe.agents.includes(agent)) continue;
    const forAgent = { ...input, agent };
    const out = agentFiles(agent, renderShortContext(forAgent), renderSkill(renderMachineContext(forAgent)), probe, roots);
    files.push(...out.files);
    context.push({ agent, outcome: out.outcome, ...(out.path !== undefined ? { path: out.path } : {}), ...(out.note !== undefined ? { note: out.note } : {}), skill: out.skill });
  }
  const tar = tarOf(files);
  try {
    await importInto(machine, tar, "/", { overlay: true, ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}) });
  } catch (e) {
    // The road's message may end in the guest's stderr; the summary is one stage line.
    return failed(`write failed: ${(e instanceof Error ? e.message : String(e)).trim().replace(/\n+/g, "; ")}`);
  }
  return { context, summary: summarize(context, probe.agents, tar.length) };
}
