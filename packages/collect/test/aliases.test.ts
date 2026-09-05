// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { LIST_SCRIPTS, collect, parseShell, programOf, shellAliases } from "../src/index.js";
import type { ManifestEntry } from "../src/index.js";
import { EMPTY_HOME, fakeHost } from "./fake-host.js";

const SHELLS = "/bin/bash\n/bin/zsh\n/opt/homebrew/bin/fish\n";

const tool = (id: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({ rung: "tools", id, label: id.slice(id.lastIndexOf("/") + 1), paths: [], bytes: 0, default: "bring", linux: "yes", ...over });
const rc = (id: string, path: string): ManifestEntry => ({ rung: "shell", id, label: path, paths: [path], bytes: 10, default: "bring" });

/** What `alias -L; alias -Ls; functions ...` prints in a shell with oh-my-zsh's git, eza and kubectl plugins. */
const ZSH_LISTING = [
  "alias -- -='cd -'",
  "alias ...=../..",
  "alias g=git",
  "alias grt='cd \"$(git rev-parse --show-toplevel || echo .)\"'",
  "alias ls=eza",
  "alias ll='eza -l'",
  "alias la='eza -la'",
  "alias k=kubectl",
  "alias kca='_kca(){ kubectl \"$@\" --all-namespaces;  unset -f _kca; }; _kca'",
  "alias cat='bat --paging=never'",
  "alias grep='grep --color=auto'",
  "alias please='sudo '",
  "alias pip='noglob pip3'",
  "alias x=extract",
  "alias google='web_search google'",
  "alias claude-mem='bun \"/Users/dev/.claude/plugins/worker.cjs\"'",
  "alias o=open",
  "alias -g G='| grep'",
  "alias -g L='| bat'",
  "alias -s md=glow",
  "extract () {",
  "\tlocal remove_archive=1",
  "\tif (( $# == 0 )); then",
  "\t\treturn 1",
  "\tfi",
  "\ttar -xzf \"$1\"",
  "}",
  "web_search () {",
  "\temulate -L zsh",
  "\topen \"$url\"",
  "}",
  "y () {",
  "\tlocal tmp=\"$(mktemp -t yazi-cwd.XXXXXX)\"",
  "\tyazi \"$@\" --cwd-file=\"$tmp\"",
  "}",
  "mkcd () {",
  "\tmkdir -p \"$1\" && cd \"$1\"",
  "}",
  "",
].join("\n");

describe("parseShell", () => {
  it("reads alias lines in every form the shell writes or a person types: bare, quoted, several per line, global and suffix", () => {
    const text = [
      "alias ls=eza",
      "alias ll='eza -l' la=\"eza -la\"",
      "alias -g G='| grep'",
      "alias -s md=glow",
      "alias -- -='cd -'",
      "  alias   v=nvim  # the editor",
      "alias 'q'='exit'",
      "alias -L",
      "echo alias not=here",
    ].join("\n");
    expect(parseShell(text)).toEqual([
      { name: "ls", kind: "alias", body: "eza" },
      { name: "ll", kind: "alias", body: "eza -l" },
      { name: "la", kind: "alias", body: "eza -la" },
      { name: "G", kind: "alias", body: "| grep" },
      { name: "md", kind: "suffix", body: "glow" },
      { name: "-", kind: "alias", body: "cd -" },
      { name: "v", kind: "alias", body: "nvim" },
      { name: "q", kind: "alias", body: "exit" },
    ]);
  });

  it("reads functions as an rc file, zsh's functions listing and bash's declare -f write them, with the whole body", () => {
    const text = [
      "y() {",
      "  yazi \"$@\"",
      "}",
      "function serve {",
      "  python3 -m http.server \"${1:-8000}\"",
      "}",
      "function up() { docker compose up -d; }",
      "web_search () {",
      "\temulate -L zsh",
      "\topen \"$url\"",
      "}",
      "mkcd () ",
      "{ ",
      "    mkdir -p \"$1\" && cd \"$1\"",
      "}",
    ].join("\n");
    expect(parseShell(text)).toEqual([
      { name: "y", kind: "function", body: "yazi \"$@\"" },
      { name: "serve", kind: "function", body: "python3 -m http.server \"${1:-8000}\"" },
      { name: "up", kind: "function", body: "docker compose up -d;" },
      { name: "web_search", kind: "function", body: "emulate -L zsh\nopen \"$url\"" },
      { name: "mkcd", kind: "function", body: "mkdir -p \"$1\" && cd \"$1\"" },
    ]);
  });

  it("a nested brace block stays inside its function", () => {
    const text = ["f() {", "  if true; then { ls; }; fi", "  eza", "}", "alias after=bat"].join("\n");
    expect(parseShell(text)).toEqual([
      { name: "f", kind: "function", body: "if true; then { ls; }; fi\neza" },
      { name: "after", kind: "alias", body: "bat" },
    ]);
  });
});

describe("programOf", () => {
  it.each([
    ["eza --icons", "eza"],
    ["sudo eza", "eza"],
    ["noglob pip3", "pip3"],
    ["FOO=1 BAR=2 env rg -n", "rg"],
    ["command nvim", "nvim"],
    ["\\bat -p", "bat"],
    ["| bat", "bat"],
    ["sudo apt update", undefined],
    ["cd \"$(git rev-parse --show-toplevel)\"", undefined],
    ["../..", undefined],
    ["./run.sh", undefined],
    ["", undefined],
    ["_kca(){ kubectl \"$@\"; }; _kca", "kubectl"],
    ["exit", undefined],
    ["history | grep", undefined],
    ["mkdir -p x && cd x", undefined],
  ])("%j names %j", (body, program) => {
    expect(programOf(body, new Set())).toBe(program);
  });

  it("a function is a wrapper or nothing: past its declarations its first line is the alias body, and one that opens by branching names no program", () => {
    expect(programOf("local tmp=\"$(mktemp -t x)\"\nyazi \"$@\" --cwd-file=\"$tmp\"", new Set(), "function")).toBe("yazi");
    expect(programOf("emulate -L zsh\nweb_search google", new Set(["web_search"]), "function")).toBeUndefined();
    expect(programOf("if (( $# == 0 )); then\nreturn 1\nfi\nyazi \"$1\"", new Set(), "function")).toBeUndefined();
    expect(programOf("[[ -z \"$1\" ]] && return\nyazi", new Set(), "function")).toBeUndefined();
    expect(programOf("setopt localoptions\nCOLOR=1 bat \"$@\" | less", new Set(), "function")).toBe("bat");
    expect(programOf("git diff @{upstream}", new Set())).toBeUndefined();
    expect(programOf("kgp -o wide", new Set(["kgp"]))).toBeUndefined();
    expect(programOf("__git_prompt_git status", new Set())).toBeUndefined();
    expect(programOf("zshz 2>&1", new Set(["zshz"]))).toBeUndefined();
    expect(programOf("rg --smart-case", new Set(["rg"]), "alias", "rg")).toBe("rg");
    expect(programOf("hooks=(chpwd precmd)\nlocal -a names\nyazi", new Set(), "function")).toBe("yazi");
    expect(programOf(Array.from({ length: 9 }, (_, i) => `echo ${i} >/dev/null`).concat("yazi").join("\n"), new Set(), "function")).toBeUndefined();
  });
});

/** What zsh prints from the system rc files alone in a terminal that adds nothing: its own two aliases. */
const ZSH_OWN = "alias run-help=man\nalias which-command=whence\n";

/** What zsh prints from the system rc files alone under Terminal.app: its two aliases and functions /etc/zshrc_Apple_Terminal defines. */
const APPLE_TERMINAL_OWN = [
  "alias run-help=man",
  "alias which-command=whence",
  "update_terminal_cwd () {",
  "\tlocal url_path='' ",
  "\t{",
  "\t\tlocal i ch hexch LC_CTYPE=C LC_COLLATE=C LC_ALL= LANG= ",
  "\t\tfor ((i = 1; i <= ${#PWD}; ++i)) do",
  "\t\t\tch=\"$PWD[i]\" ",
  "\t\t\tif [[ \"$ch\" =~ [/._~A-Za-z0-9-] ]]",
  "\t\t\tthen",
  "\t\t\t\turl_path+=\"$ch\" ",
  "\t\t\telse",
  "\t\t\t\tprintf -v hexch \"%02X\" \"'$ch\"",
  "\t\t\t\turl_path+=\"%$hexch\" ",
  "\t\t\tfi",
  "\t\tdone",
  "\t}",
  "\tprintf '\\e]7;%s\\a' \"file://$HOST$url_path\"",
  "}",
  "shell_session_history_enable () {",
  "\t(",
  "\t\tumask 077",
  "\t\t/usr/bin/touch \"$SHELL_SESSION_HISTFILE_NEW\"",
  "\t)",
  "\tHISTFILE=\"$SHELL_SESSION_HISTFILE_NEW\" ",
  "\tSHELL_SESSION_HISTORY=1 ",
  "}",
  "",
].join("\n");

const LISTING = (shell: "zsh" | "bash"): string => `WSP_COLLECT=1 /bin/${shell} -ic ${LIST_SCRIPTS[shell]}`;
const BASELINE = (shell: "zsh" | "bash"): string => `WSP_COLLECT=1 HOME=${EMPTY_HOME} ZDOTDIR=${EMPTY_HOME} /bin/${shell} -ic ${LIST_SCRIPTS[shell]}`;

describe("shellAliases", () => {
  const laptop = (over: Parameters<typeof fakeHost>[0] = {}) =>
    fakeHost({
      shell: "/bin/zsh",
      terminal: "ghostty",
      ...over,
      files: { "/etc/shells": SHELLS, "~/.zshrc": "plugins=(git eza)\n", "/opt/homebrew/opt/bat/bin/bat": 1, "/opt/homebrew/opt/python@3.13/bin/pip3": 1, "/opt/homebrew/opt/python@3.13/bin/python3": 1, ...over.files },
      exec: { [LISTING("zsh")]: ZSH_LISTING, [BASELINE("zsh")]: ZSH_OWN, ...over.exec },
    });
  const tools = [tool("tools/brew/eza"), tool("tools/brew/bat"), tool("tools/brew/python@3.13"), tool("tools/cli/kubectl", { default: "skip" }), tool("tools/brew/glow", { default: "skip", reason: "no Linux bottle" })];

  it("lists what the interactive shell defines that runs a program, matched to the tools row that installs it, on the login shell's rc row", async () => {
    const entries = [rc("shell/zshrc", "~/.zshrc"), rc("shell/zshenv", "~/.zshenv"), ...tools];
    const host = laptop();
    await shellAliases(host, entries);
    expect(host.calls.filter(c => c.startsWith("run "))).toEqual([`run ${LISTING("zsh")} (10000 ms, SIGKILL)`, `run ${BASELINE("zsh")} (10000 ms, SIGKILL)`]);
    expect(entries[1]).not.toHaveProperty("aliases");
    expect(entries[1]).not.toHaveProperty("aliasesFrom");
    expect(entries[0]!.aliasesFrom).toBe("shell");
    expect(entries[0]!.aliases).toEqual([
      { name: "L", kind: "alias", runs: "bat", tool: "tools/brew/bat" },
      { name: "cat", kind: "alias", runs: "bat", tool: "tools/brew/bat" },
      { name: "claude-mem", kind: "alias", runs: "bun" },
      { name: "k", kind: "alias", runs: "kubectl", tool: "tools/cli/kubectl" },
      { name: "kca", kind: "alias", runs: "kubectl", tool: "tools/cli/kubectl" },
      { name: "la", kind: "alias", runs: "eza", tool: "tools/brew/eza" },
      { name: "ll", kind: "alias", runs: "eza", tool: "tools/brew/eza" },
      { name: "ls", kind: "alias", runs: "eza", tool: "tools/brew/eza" },
      { name: "md", kind: "suffix", runs: "glow", tool: "tools/brew/glow" },
      { name: "o", kind: "alias", runs: "open" },
      { name: "pip", kind: "alias", runs: "pip3", tool: "tools/brew/python@3.13" },
      { name: "web_search", kind: "function", runs: "open" },
      { name: "y", kind: "function", runs: "yazi" },
    ]);
  });

  it("an alias or function whose command the machine has anyway, a builtin, a path or another function is not listed", async () => {
    const entries = [rc("shell/zshrc", "~/.zshrc"), ...tools];
    await shellAliases(laptop(), entries);
    const names = entries[0]!.aliases!.map(a => a.name);
    for (const n of ["-", "...", "g", "grt", "grep", "please", "x", "google", "G", "extract", "mkcd"]) expect(names).not.toContain(n);
  });

  it("falls back to the rc files, what they source and the oh-my-zsh custom dir when the shell does not answer", async () => {
    const host = fakeHost({
      shell: "/bin/zsh",
      files: {
        "/etc/shells": SHELLS,
        "~/.zshrc": "source ~/.aliases\nalias v=nvim\nfunction serve { python3 -m http.server; }\n",
        "~/.zshenv": "alias e=eza\n",
        "~/.aliases": "alias cat=bat\n",
        "~/.oh-my-zsh/custom/mine.zsh": "alias o=open\n",
        "~/.oh-my-zsh/custom/plugins/x/x.plugin.zsh": "alias never=seen\n",
      },
    });
    const entries = [rc("shell/zshrc", "~/.zshrc"), tool("tools/brew/neovim"), tool("tools/brew/bat")];
    await shellAliases(host, entries);
    expect(entries[0]!.aliasesFrom).toBe("files");
    expect(entries[0]!.aliases).toEqual([
      { name: "cat", kind: "alias", runs: "bat", tool: "tools/brew/bat" },
      { name: "e", kind: "alias", runs: "eza" },
      { name: "o", kind: "alias", runs: "open" },
      { name: "serve", kind: "function", runs: "python3" },
      { name: "v", kind: "alias", runs: "nvim" },
    ]);
  });

  it("a formula whose command has another name is found through Homebrew's opt links, on either prefix", async () => {
    const host = laptop({ files: { "/usr/local/opt/ripgrep/bin/rg": 1, "/opt/homebrew/opt/neovim/bin/nvim": 1 }, exec: { [LISTING("zsh")]: "alias rg='rg --smart-case'\nalias v=nvim\n" } });
    const entries = [rc("shell/zshrc", "~/.zshrc"), tool("tools/brew/ripgrep"), tool("tools/brew/neovim")];
    await shellAliases(host, entries);
    expect(entries[0]!.aliases).toEqual([
      { name: "rg", kind: "alias", runs: "rg", tool: "tools/brew/ripgrep" },
      { name: "v", kind: "alias", runs: "nvim", tool: "tools/brew/neovim" },
    ]);
  });

  it("bash is listed through bash, on its rc row", async () => {
    const host = fakeHost({ shell: "/bin/bash", files: { "/etc/shells": SHELLS }, exec: { [LISTING("bash")]: "alias ls='eza'\nserve () \n{ \n    python3 -m http.server\n}\n", [BASELINE("bash")]: "" } });
    const entries = [rc("shell/zshrc", "~/.zshrc"), rc("shell/bashrc", "~/.bashrc"), tool("tools/brew/eza")];
    await shellAliases(host, entries);
    expect(entries[0]).not.toHaveProperty("aliases");
    expect(entries[1]!.aliasesFrom).toBe("shell");
    expect(entries[1]!.aliases).toEqual([
      { name: "ls", kind: "alias", runs: "eza", tool: "tools/brew/eza" },
      { name: "serve", kind: "function", runs: "python3" },
    ]);
  });

  it("in a terminal that adds nothing, a listing of only zsh's own two aliases, as an rc file that returns on WSP_COLLECT leaves it, matches the baseline from an empty home and is read from the files; a row with no definitions still says where it looked", async () => {
    const host = laptop({ files: { "~/.zshrc": "[ \"$WSP_COLLECT\" = 1 ] && return\nalias v=nvim\n" }, exec: { [LISTING("zsh")]: ZSH_OWN } });
    const entries = [rc("shell/zshrc", "~/.zshrc"), tool("tools/brew/neovim")];
    await shellAliases(host, entries);
    expect(host.calls.filter(c => c.startsWith("run "))).toHaveLength(2);
    expect(entries[0]).toMatchObject({ aliasesFrom: "files", aliases: [{ name: "v", kind: "alias", runs: "nvim" }] });
    const bare = [rc("shell/zshrc", "~/.zshrc")];
    await shellAliases(laptop({ exec: { [LISTING("zsh")]: "alias g=git\n" } }), bare);
    expect(bare[0]).toEqual({ ...rc("shell/zshrc", "~/.zshrc"), aliasesFrom: "shell" });
  });

  it("under Terminal.app the system rc files define functions too: a listing of exactly the baseline is read from the files, one line beyond it is the shell's own", async () => {
    const apple = (listing: string) => laptop({ terminal: "Apple_Terminal", files: { "~/.zshrc": "[ \"$WSP_COLLECT\" = 1 ] && return\nalias v=nvim\n" }, exec: { [LISTING("zsh")]: listing, [BASELINE("zsh")]: APPLE_TERMINAL_OWN } });
    const returned = [rc("shell/zshrc", "~/.zshrc"), tool("tools/brew/neovim")];
    await shellAliases(apple(APPLE_TERMINAL_OWN), returned);
    expect(returned[0]).toMatchObject({ aliasesFrom: "files", aliases: [{ name: "v", kind: "alias", runs: "nvim" }] });
    const listed = [rc("shell/zshrc", "~/.zshrc"), tool("tools/brew/neovim")];
    await shellAliases(apple(`${APPLE_TERMINAL_OWN}alias v=nvim\n`), listed);
    expect(listed[0]).toMatchObject({ aliasesFrom: "shell", aliases: [{ name: "v", kind: "alias", runs: "nvim" }] });
  });

  it("a baseline the shell did not give leaves nothing to take away: the listing stands as the person's own", async () => {
    const host = fakeHost({ shell: "/bin/zsh", files: { "/etc/shells": SHELLS, "~/.zshrc": "alias v=nvim\n" }, exec: { [LISTING("zsh")]: ZSH_OWN } });
    const entries = [rc("shell/zshrc", "~/.zshrc")];
    await shellAliases(host, entries);
    expect(host.calls.filter(c => c.startsWith("run "))).toHaveLength(2);
    expect(entries[0]).toEqual({ ...rc("shell/zshrc", "~/.zshrc"), aliasesFrom: "shell" });
  });

  it("bash with nothing defined prints an empty listing, which is read from the files with no baseline asked for", async () => {
    const host = fakeHost({ shell: "/bin/bash", files: { "/etc/shells": SHELLS, "~/.bashrc": "alias ls=eza\n" }, exec: { [LISTING("bash")]: "" } });
    const entries = [rc("shell/bashrc", "~/.bashrc"), tool("tools/brew/eza")];
    await shellAliases(host, entries);
    expect(host.calls.filter(c => c.startsWith("run "))).toHaveLength(1);
    expect(entries[0]).toMatchObject({ aliasesFrom: "files", aliases: [{ name: "ls", kind: "alias", runs: "eza", tool: "tools/brew/eza" }] });
  });

  it("nothing runs for fish, an unlisted shell or a shell with no rc row", async () => {
    const fish = fakeHost({ shell: "/opt/homebrew/bin/fish", files: { "/etc/shells": SHELLS, "~/.config/fish/config.fish": "alias ls eza\n" } });
    const fishRows = [rc("shell/fish", "~/.config/fish")];
    await shellAliases(fish, fishRows);
    expect(fish.calls.some(c => c.startsWith("run "))).toBe(false);
    expect(fishRows[0]).not.toHaveProperty("aliases");
    expect(fishRows[0]).not.toHaveProperty("aliasesFrom");
    const noRow = laptop();
    const rows = [...tools];
    await shellAliases(noRow, rows);
    expect(noRow.calls.some(c => c.startsWith("run "))).toBe(false);
  });

  it("collect puts the list on the shell row and the manifest still validates", async () => {
    const host = laptop({ which: [] });
    const manifest = await collect(host);
    const zshrc = manifest.entries.find(e => e.id === "shell/zshrc");
    expect(zshrc?.aliases?.map(a => a.name)).toContain("ls");
    expect(manifest.entries.filter(e => e.aliases !== undefined)).toHaveLength(1);
  });
});
