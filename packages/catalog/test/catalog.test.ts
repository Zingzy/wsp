// SPDX-License-Identifier: AGPL-3.0-only
// The catalog's own invariants: ids are unique, every road is a known one,
// every browser or device sign-in has a status that proves it, the agents are
// the six whose project state has a measured resolver, every default names
// its evidence, and the seeded rows are what the snapshot says they are.
import { describe, expect, it } from "vitest";
import { APT_INDEX, APT_UPDATE, BASE_FLOOR, CATALOG, CATALOG_AGENTS, CLAUDE_CONFIG_DIR, DEFAULT_AGENT, GCLOUD, HISTORY_FORMATS, HOMEBREW_STEP, KUBECTL, LINUX_CASKS, LOGIN_ROWS, ROADS, ROAD_MODULES, SIGN_IN_ROWS, agentName, baseEntryFor, baseNote, catalogEntry, catalogToolFor, guestEnv, hasLogin, installAfter, installLine, keysIdOf, keysRowOf, loginIdOf, loginRow, roadModule, smokeOf, type AgentEntry, type InstallRoad } from "../src/index.js";

describe("catalog", () => {
  it("the default agent is the first entry, and it is an agent with a context module", () => {
    expect(DEFAULT_AGENT).toBe(CATALOG_AGENTS[0]);
    expect(DEFAULT_AGENT.id).toBe("claude");
    expect(DEFAULT_AGENT.context).toBeDefined();
  });

  it("names a session history for the agents with a reader, in a known format under a home path", () => {
    expect(CATALOG_AGENTS.filter(a => a.history !== undefined).map(a => a.id)).toEqual(["claude", "codex", "hermes"]);
    for (const a of CATALOG_AGENTS) {
      if (a.history === undefined) continue;
      expect(HISTORY_FORMATS, a.id).toContain(a.history.format);
      expect(a.history.root, a.id).toMatch(/^~\/\./);
    }
  });

  it("finds the tool a package name stands for by id, command, road name, cover or brought command; the floor is the subset on it", () => {
    expect(catalogToolFor("rg")?.id).toBe("ripgrep");
    expect(catalogToolFor("cli/cli")).toBeUndefined();
    expect(catalogToolFor("awscli")?.id).toBe("aws");
    expect(catalogToolFor("npm")?.id).toBe("node");
    expect(catalogToolFor("openjdk@21")?.id).toBe("java");
    expect(catalogToolFor("cargo")?.id).toBe("rust");
    expect(baseEntryFor("cargo")).toBeUndefined();
    expect(baseEntryFor("npm")?.id).toBe("node");
    expect(catalogToolFor("claude")).toBeUndefined();
  });

  it("gives every entry its own id", () => {
    const ids = CATALOG.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(catalogEntry("gh")?.name).toBe("GitHub CLI");
    expect(catalogEntry("nothing")).toBeUndefined();
  });

  it("names an entry as the catalog does and an id it does not know as itself", () => {
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("gemini")).toBe("Gemini CLI");
    expect(agentName("gh")).toBe("GitHub CLI");
    expect(agentName("zed")).toBe("zed");
  });

  it("a golden's env for an agent points it at its guest state home only when the entry names the variable", () => {
    expect(guestEnv(catalogEntry("claude") as AgentEntry)).toEqual({ CLAUDE_CONFIG_DIR });
    for (const a of CATALOG_AGENTS.slice(1)) expect(guestEnv(a), a.id).toEqual({});
  });

  it("sends every entry down a known road with its argument", () => {
    for (const e of CATALOG) {
      const road = e.installRoad;
      expect(ROADS, e.id).toContain(road.road);
      switch (road.road) {
        case "brew":
          expect(road.formula, e.id).toMatch(/^[\w@.+-]+$/);
          break;
        case "npm":
        case "pnpm":
        case "bun":
        case "uv":
        case "pipx":
        case "cargo":
          expect(road.package, e.id).toMatch(/^(@[\w.-]+\/)?[\w.-]+$/);
          break;
        case "go":
          expect(road.module, e.id).toMatch(/^[\w.-]+\.[a-z]+\//);
          break;
        case "release":
          expect(road.repo, e.id).toMatch(/^[\w.-]+\/[\w.-]+$/);
          break;
        case "vendor":
          expect(LINUX_CASKS, e.id).toContain(road.cask);
          break;
        case "apt":
          expect(road.packages.length, e.id).toBeGreaterThan(0);
          break;
        case "script":
          expect(road.script, e.id).not.toBe("");
          break;
        default: {
          const _exhaustive: never = road;
          return _exhaustive;
        }
      }
    }
  });

  it("proves every browser or device sign-in with a status check", () => {
    for (const e of CATALOG) {
      if (e.signIn.kind === "oauth" || e.signIn.kind === "device") expect(e.signIn.status, e.id).toBeDefined();
    }
    for (const [name, row] of Object.entries(SIGN_IN_ROWS)) expect(catalogEntry(name)?.signIn, name).toBe(row);
  });

  it("files one sign-in row per login id, and a keys row beside a login whose key files travel only by copy", () => {
    // Every entry with a login or a note about having none has a row under its login id; a plain tool has none.
    for (const e of CATALOG) {
      const own = loginRow(loginIdOf(e.id));
      if (hasLogin(e.signIn) || e.signIn.note !== undefined) expect(own?.signIn, e.id).toBe(e.signIn);
      else expect(own, e.id).toBeUndefined();
    }
    expect(loginRow("kube")?.entry.id).toBe("kubectl");
    expect(loginRow("kubectl")).toBeUndefined();
    // Hermes keeps provider keys in a file beside its device login, so it alone has a keys row: nothing to run on the
    // machine, the login's own status proves the copy, and the row says why only a copy brings the keys.
    const keyed = LOGIN_ROWS.filter(r => r.keys !== undefined);
    expect(keyed.map(r => [r.id, r.entry.id])).toEqual([["hermes-keys", "hermes"]]);
    expect(keysIdOf("hermes")).toBe("hermes-keys");
    const hermes = catalogEntry("hermes")!.signIn;
    expect(hasLogin(hermes) && hermes.keys).toEqual({ paths: ["~/.hermes/.env"], note: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" });
    expect(loginRow("hermes-keys")?.signIn).toEqual({ kind: "none", sources: ["file"], note: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them", status: hasLogin(hermes) ? hermes.status : undefined });
    expect(keysRowOf({ paths: ["~/.x/keys"], note: "why" }, undefined)).toEqual({ kind: "none", sources: ["file"], note: "why" });
    // A keys row's note fits the detail pane beside its path line.
    for (const r of keyed) expect(r.keys!.note.length, r.id).toBeLessThanOrEqual(76);
    expect(new Set(LOGIN_ROWS.map(r => r.id)).size).toBe(LOGIN_ROWS.length);
  });

  it("ships exactly the six agents whose project state a move can follow, each with a pinned road, a smoke and a resolver", () => {
    expect(CATALOG_AGENTS.map(a => a.id)).toEqual(["claude", "codex", "gemini", "opencode", "pi", "hermes"]);
    for (const a of CATALOG_AGENTS) {
      expect(a.projectState.length, a.id).toBeGreaterThan(0);
      expect(a.stateHome, a.id).toMatch(/^\.[\w./-]*[\w-]$/);
      if (a.guestStateHome !== undefined) expect(a.guestStateHome, a.id).toMatch(/^\/root\//);
      expect(hasLogin(a.signIn), a.id).toBe(true);
      expect(smokeOf(a)).toBe(`${a.id} --version`);
      expect(a.size, a.id).toBeGreaterThan(0);
    }
    expect(CATALOG_AGENTS.filter(a => a.guestStateHome !== undefined).map(a => [a.id, a.guestStateHome])).toEqual([["claude", "/root/.claude-cfg"]]);
    expect(installLine(catalogEntry("codex")!)).toBe("npm install -g @openai/codex@0.153.0");
    expect(installLine(catalogEntry("pi")!)).toBe("npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4");
    expect(installLine(catalogEntry("claude")!)).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(installLine(catalogEntry("hermes")!)).toMatch(/git clone -q --depth 1 --branch v[\d.]+ https:\/\/github\.com\/NousResearch\/hermes-agent\.git/);
    // An agent's npm road is pinned in the data; an unpinned one would install whatever the registry serves that day.
    for (const a of CATALOG_AGENTS) if (a.installRoad.road === "npm") expect(a.installRoad.version, a.id).toMatch(/^\d/);
  });

  it("gives every entry one install line from its road's module: apt, npm, Homebrew as linuxbrew, a release at its current tag, a vendor's download", () => {
    expect(installLine(catalogEntry("git")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq git");
    expect(installLine(catalogEntry("docker")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq docker.io docker-compose-v2");
    expect(installLine(catalogEntry("pnpm")!)).toBe("npm install -g pnpm@11.9.0");
    expect(installLine(catalogEntry("wrangler")!)).toBe("npm install -g wrangler");
    expect(installLine(catalogEntry("go")!)).toMatch(/^su -s \/bin\/bash linuxbrew -c '.*HOMEBREW_NO_AUTO_UPDATE=1.*brew install go'$/);
    const gh = installLine(catalogEntry("gh")!);
    expect(gh).toContain("name='gh'");
    // A failed API call (the rate limit, a network blip) leaves the release empty and falls through to go install.
    expect(gh).toContain(`release="$(curl -fsSL 'https://api.github.com/repos/cli/cli/releases/latest' || true)"`);
    expect(gh).toContain(`tag="$(printf '%s\\n' "$release" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4 || true)"`);
    expect(gh).toContain('echo "WSP_ROAD release ${asset:-$url} $sum $tag"');
    // The fall-through installs the entry's main package, not the repository root, which for gh is no package.
    expect(gh).toContain("go install 'github.com/cli/cli/v2/cmd/gh@latest'");
    expect(installLine(catalogEntry("cloudflared")!)).toContain("go install 'github.com/cloudflare/cloudflared/cmd/cloudflared@latest'");
    expect(installLine(catalogEntry("yq")!)).toContain("go install 'github.com/mikefarah/yq/v4@latest'");
    // An entry that names no Go module has no fall-through and says only what is true.
    const supabase = installLine(catalogEntry("supabase")!) as string;
    expect(supabase).not.toContain("go install");
    expect(supabase).not.toContain("command -v go");
    expect(supabase).toContain(`echo "Error: the current release of "'supabase/cli'" has no Linux build" >&2`);
    expect(gh).not.toContain('[ "$sum" =');
    expect(installLine(catalogEntry("gcloud")!)).toBe(GCLOUD.install(undefined, undefined));
    expect(installLine(catalogEntry("kubectl")!)).toBe(KUBECTL.install(undefined, undefined));
    // The floor runs before Homebrew or the release machinery exist on the machine.
    for (const e of BASE_FLOOR) expect(["brew", "release", "vendor"], e.id).not.toContain(e.installRoad.road);
  });

  it("has one module per road with its words, and each module writes the install and its uninstall twin from a row", () => {
    expect(Object.keys(ROAD_MODULES).sort()).toEqual([...ROADS].sort());
    for (const road of ROADS) expect(ROAD_MODULES[road].words, road).toMatch(/^(by|with|as|from) /);
    const line = (road: InstallRoad, bin = "x") => roadModule(road).install(road, bin);
    const off = (road: InstallRoad, bin = "x") => roadModule(road).uninstall(road, bin);
    const row = (name: string, version?: string) => ({ name, ...(version !== undefined ? { version } : {}), paths: [], label: name });
    const npm = ROAD_MODULES.npm.fromRow!(row("bun", "1.4.0"));
    expect([line(npm), off(npm)]).toEqual(["npm install -g bun@1.4.0", { cmd: "npm uninstall -g bun" }]);
    expect(line({ road: "npm", package: "@earendil-works/pi-coding-agent", version: "0.84.4", ignoreScripts: true })).toBe("npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4");
    const pnpm = ROAD_MODULES.pnpm.fromRow!(row("turbo", "2.5.0"));
    expect([line(pnpm), off(pnpm)]).toEqual(["pnpm add -g turbo@2.5.0", { cmd: "pnpm remove -g turbo" }]);
    const bun = ROAD_MODULES.bun.fromRow!(row("eslint"));
    expect([line(bun), off(bun)]).toEqual(["bun add -g eslint", { cmd: "bun remove -g eslint" }]);
    const uv = ROAD_MODULES.uv.fromRow!(row("ty", "0.0.56"));
    expect([line(uv), off(uv)]).toEqual(["uv tool install ty==0.0.56", { cmd: "uv tool uninstall ty" }]);
    const pipx = ROAD_MODULES.pipx.fromRow!(row("black", "24.1.0"));
    expect([line(pipx), off(pipx)]).toEqual(["pipx install black==24.1.0", { cmd: "pipx uninstall black" }]);
    expect(line(ROAD_MODULES.cargo.fromRow!(row("bat", "0.24.0")))).toBe("cargo install bat --version 0.24.0");
    expect([line(ROAD_MODULES.cargo.fromRow!(row("bat"))), off(ROAD_MODULES.cargo.fromRow!(row("bat")))]).toEqual(["cargo install bat", { cmd: "cargo uninstall bat" }]);
    // A Go row carries its module in its first path (or an older label); the row's version wins over the module's; no module, nothing to run.
    const gopls = ROAD_MODULES.go.fromRow!({ name: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"], label: "gopls" });
    expect([line(gopls), ROAD_MODULES.go.bin!(gopls), off(gopls)]).toEqual(["go install golang.org/x/tools/gopls@v0.16.2", "gopls", { note: "go has no uninstall; the binary stays in /root/go/bin" }]);
    expect(line(ROAD_MODULES.go.fromRow!({ name: "gopls", version: "v0.17.0", paths: ["golang.org/x/tools/gopls@v0.16.2"], label: "gopls" }))).toBe("go install golang.org/x/tools/gopls@v0.17.0");
    expect(line(ROAD_MODULES.go.fromRow!({ name: "gopls", paths: [], label: "gopls (golang.org/x/tools/gopls@v0.16.2)" }))).toBe("go install golang.org/x/tools/gopls@v0.16.2");
    expect(ROAD_MODULES.go.bin!(ROAD_MODULES.go.fromRow!({ name: "spoo", paths: ["github.com/spoo-me/spoo/v2@v2.0.0"], label: "spoo" }))).toBe("spoo");
    const junk = ROAD_MODULES.go.fromRow!({ name: "junk", paths: [], label: "junk (no module info)" });
    expect([junk, line(junk), ROAD_MODULES.go.bin!(junk)]).toEqual([{ road: "go" }, { note: "no module to install from" }, undefined]);
    // Homebrew runs as its own user; a tap formula that took the road comes off from /usr/local/bin when the cellar never had it.
    const gh = ROAD_MODULES.brew.fromRow!(row("gh"));
    expect(line(gh)).toMatch(/^su -s \/bin\/bash linuxbrew -c 'HOMEBREW_NO_AUTO_UPDATE=1 .*brew install gh'$/);
    expect(off(gh)).toEqual({ cmd: expect.stringMatching(/brew uninstall gh'$/) });
    expect(off({ road: "brew", formula: "zingzy/tap/diskbloom" })).toEqual({ cmd: expect.stringMatching(/^if \[ -x \/home\/linuxbrew\/.linuxbrew\/bin\/brew \] && su .*brew list --formula zingzy\/tap\/diskbloom.* >\/dev\/null 2>&1; then su .*brew uninstall zingzy\/tap\/diskbloom.*; else rm -f \/usr\/local\/bin\/'diskbloom'; fi$/) });
    // A release at a tag fetches that tag and prints it; with a pin for the same tag the sum is checked; a row that names no repository only comes off.
    const tagged = line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1", go: "github.com/spoo-me/spoo-cli" }, "spoo");
    expect(tagged).toContain(`release="$(curl -fsSL 'https://api.github.com/repos/spoo-me/spoo-cli/releases/tags/v0.4.1' || true)"`);
    expect(tagged).not.toContain("tag=\"$(");
    expect(tagged).toContain(`echo "WSP_ROAD release \${asset:-$url} $sum "'v0.4.1'`);
    // A bare module goes in at the tag; one that carries its own version keeps it; a road with none has no go branch.
    expect(tagged).toContain("go install 'github.com/spoo-me/spoo-cli@v0.4.1'");
    expect(tagged).toContain(`echo "Error: release "'v0.4.1'" of "'spoo-me/spoo-cli'" has no Linux build, and go is not on the machine" >&2`);
    expect(line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1", go: "github.com/spoo-me/spoo-cli@v0.4.0" }, "spoo")).toContain("go install 'github.com/spoo-me/spoo-cli@v0.4.0'");
    expect(line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1" }, "spoo")).not.toContain("command -v go");
    // A road that pins a version takes a row's through at(); Homebrew, apt and a script install what their source serves and have none.
    expect(ROAD_MODULES.npm.at!({ road: "npm", package: "wrangler" }, "4.1.0")).toEqual({ road: "npm", package: "wrangler", version: "4.1.0" });
    expect(ROAD_MODULES.cargo.at!({ road: "cargo", package: "bat", version: "0.23.0" }, "0.24.0")).toEqual({ road: "cargo", package: "bat", version: "0.24.0" });
    expect(ROAD_MODULES.release.at!({ road: "release", repo: "cli/cli" }, "v2.86.0")).toEqual({ road: "release", repo: "cli/cli", version: "v2.86.0" });
    // A bare row's version is the tool's own, not a Mac cask's, so the vendor road takes it whether or not the cask's Mac version names the Linux build.
    expect(ROAD_MODULES.vendor.at!({ road: "vendor", cask: GCLOUD }, "575.0.0")).toEqual({ road: "vendor", cask: GCLOUD, version: "575.0.0" });
    expect(ROAD_MODULES.vendor.at!({ road: "vendor", cask: KUBECTL }, "v1.37.0")).toEqual({ road: "vendor", cask: KUBECTL, version: "v1.37.0" });
    for (const road of ["npm", "pnpm", "bun", "uv", "pipx", "cargo", "go", "release", "vendor"] as const) expect(ROAD_MODULES[road].at, road).toBeDefined();
    for (const road of ["brew", "apt", "script"] as const) expect(ROAD_MODULES[road].at, road).toBeUndefined();
    expect(line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1", pin: { tag: "v0.4.1", sha256: "c".repeat(64) } }, "spoo")).toContain(`[ "$sum" = '${"c".repeat(64)}' ]`);
    expect(line({ road: "release", repo: "spoo-me/spoo-cli", version: "v0.4.1", pin: { tag: "v0.4.0", sha256: "c".repeat(64) } }, "spoo")).not.toContain('[ "$sum" =');
    // No version: a pin fixes the tag and is checked, as a vendor install does; none at all takes the current release.
    expect(line({ road: "release", repo: "cli/cli", pin: { tag: "v2.86.0", sha256: "d".repeat(64) } }, "gh")).toContain("releases/tags/v2.86.0");
    expect(line({ road: "release", repo: "cli/cli", pin: { tag: "v2.86.0", sha256: "d".repeat(64) } }, "gh")).toContain(`[ "$sum" = '${"d".repeat(64)}' ]`);
    expect(line({ road: "release" }, "spoo")).toEqual({ note: "no GitHub release to install from" });
    expect(off({ road: "release" }, "spoo")).toEqual({ cmd: "rm -f /usr/local/bin/'spoo'" });
    // A vendor's download is the cask's own script, at the road's version when it names one, else the pinned or current one.
    const gcloud: InstallRoad = { road: "vendor", cask: GCLOUD, version: "575.0.0" };
    expect([line(gcloud), off(gcloud), ROAD_MODULES.vendor.bin!(gcloud)]).toEqual([GCLOUD.install("575.0.0", undefined), { cmd: GCLOUD.uninstall }, "gcloud"]);
    const kubectl: InstallRoad = { road: "vendor", cask: KUBECTL, pin: { tag: "v1.37.0", sha256: "c".repeat(64) } };
    expect(line(kubectl)).toBe(KUBECTL.install(undefined, { tag: "v1.37.0", sha256: "c".repeat(64) }));
    // apt rows wait on the one index read; purge takes what the package alone pulled in.
    const apt: InstallRoad = { road: "apt", packages: ["neovim"] };
    expect([line(apt), off(apt), ROAD_MODULES.apt.after]).toEqual(["export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq neovim", { cmd: "export DEBIAN_FRONTEND=noninteractive\napt-get purge -y -qq neovim && apt-get autoremove -y -qq --purge" }, APT_INDEX]);
    expect(APT_UPDATE).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get update -qq");
    expect([ROAD_MODULES.brew.after, ROAD_MODULES.npm.after]).toEqual([HOMEBREW_STEP, "node"]);
    expect([line({ road: "script", script: "echo hi" }), off({ road: "script", script: "echo hi" }, "hi")]).toEqual(["echo hi", { note: "hi has no uninstaller; left on the machine" }]);
  });

  it("names the evidence behind every default: sessions on this Mac and lab images that ship it", () => {
    for (const e of CATALOG) {
      expect(Number.isInteger(e.source.sessions) && e.source.sessions >= 0, e.id).toBe(true);
      expect(e.source.images, e.id).toBeGreaterThanOrEqual(0);
      expect(e.source.images, e.id).toBeLessThanOrEqual(5);
    }
    expect(CATALOG.filter(e => e.kind === "tool" && e.defaultOn).map(e => e.id)).toEqual(["node", "pnpm", "uv", "python", "git", "jq", "ripgrep", "curl", "docker", "gh", "agent-browser"]);
    expect(catalogEntry("agent-browser")?.source.note).toMatch(/one Mac/);
  });

  it("seeds every golden with the base floor: the entries flagged for it, in catalog order, each default-on by a pinned road", () => {
    expect(BASE_FLOOR.map(e => e.id)).toEqual(["node", "pnpm", "uv", "python", "git", "jq", "ripgrep", "curl", "docker"]);
    expect(BASE_FLOOR).toEqual(CATALOG.filter(e => e.kind === "tool" && e.floor));
    for (const e of BASE_FLOOR) {
      expect(e.defaultOn, e.id).toBe(true);
      expect(e.installRoad.road, e.id).not.toBe("release");
      if (e.installRoad.road === "npm") expect(e.installRoad.version, e.id).toBeDefined();
      // A row that waits on another floor row waits on one the catalog lists before it.
      const dep = installAfter(e);
      if (dep !== undefined && dep !== "apt-index") expect(BASE_FLOOR.findIndex(x => x.id === dep), e.id).toBeLessThan(BASE_FLOOR.indexOf(e));
    }
    expect(CATALOG.filter(e => e.kind === "tool" && e.defaultOn && !e.floor).map(e => e.id)).toEqual(["gh", "agent-browser"]);
    // The npm road runs on the floor's node, an apt package on the index read once, a script on what its entry names.
    expect(BASE_FLOOR.map(e => installAfter(e))).toEqual([undefined, "node", undefined, "uv", "apt-index", "apt-index", "apt-index", "apt-index", "apt-index"]);
    expect(BASE_FLOOR.find(e => e.id === "node")!.brings).toEqual([{ bin: "npm", version: "npm --version" }]);
    expect(BASE_FLOOR.find(e => e.id === "docker")!.brings).toEqual([{ bin: "docker compose", version: "docker compose version" }]);
    // Python comes as uv's managed 3.12, pinned by uv's own release, and python3 on PATH is that interpreter.
    const python = catalogEntry("python")!;
    expect(python.installRoad.road).toBe("script");
    expect(python.installRoad.road === "script" && python.installRoad.script).toContain("uv python install 3.12");
    expect(python.installRoad.road === "script" && python.installRoad.script).toContain('ln -sfn "$(uv python find --managed-python 3.12)" /usr/local/bin/python3');
    expect(python.installRoad.road === "script" && python.installRoad.script).toContain("sha256sum -c");
    expect(python.size).toBeUndefined();
  });

  it("names the base row a recipe's tools row stands for: by id, command, road argument or a name it covers", () => {
    expect(baseEntryFor("jq")?.id).toBe("jq");
    expect(baseEntryFor("rg")?.id).toBe("ripgrep");
    expect(baseEntryFor("python@3.12")?.id).toBe("python");
    expect(baseEntryFor("python3")?.id).toBe("python");
    expect(baseEntryFor("docker-compose-v2")?.id).toBe("docker");
    expect(baseEntryFor("docker-compose")?.id).toBe("docker");
    expect(baseEntryFor("pnpm")?.id).toBe("pnpm");
    expect(baseEntryFor("node")?.id).toBe("node");
    expect(baseEntryFor("node@22")?.id).toBe("node");
    expect(baseEntryFor("node@24")).toBeUndefined();
    expect(baseEntryFor("python@3.14")).toBeUndefined();
    expect(baseEntryFor("git")?.id).toBe("git");
    expect(baseEntryFor("npm")?.id).toBe("node");
    expect(baseEntryFor("gh")).toBeUndefined();
    expect(baseEntryFor("agent-browser")).toBeUndefined();
  });

  it("a covered row's note names both majors when this Mac runs another one, and the base row alone otherwise", () => {
    const node = baseEntryFor("node")!;
    const python = baseEntryFor("python")!;
    expect(baseNote(node, "24.1.0")).toBe("Node 22 is part of the base; this Mac runs Node 24");
    expect(baseNote(node, "v22.23.2")).toBe("Node 22 with npm is part of the base");
    expect(baseNote(node, undefined)).toBe("Node 22 with npm is part of the base");
    expect(baseNote(python, "3.14.0")).toBe("Python 3.12 is part of the base; this Mac runs Python 3.14");
    expect(baseNote(python, "3.12.7")).toBe("Python 3.12 is part of the base");
    // Only a row that pins a major has one to compare; the rest name the base row whatever version the Mac has.
    expect(baseNote(baseEntryFor("pnpm")!, "10.0.0")).toBe("pnpm is part of the base");
    expect(baseNote(baseEntryFor("jq")!, "1.6")).toBe("jq is part of the base");
  });

  it("says which roads no guest has run yet", () => {
    const unmeasured = CATALOG.filter(e => e.source.road === "unmeasured").map(e => e.id);
    expect(unmeasured).toEqual([
      "pnpm", "uv", "python", "git", "jq", "ripgrep", "curl", "docker", "gh", "agent-browser",
      "rust", "maven", "wrangler", "cloudflared", "kubectl", "aws", "vercel", "netlify", "fly", "supabase", "railway", "doppler", "op", "ffmpeg", "yq", "git-lfs", "tmux",
    ]);
    for (const e of CATALOG_AGENTS) expect(e.source.road, e.id).toBe("measured");
  });

  it("carries no token-looking value", () => {
    expect(JSON.stringify(CATALOG, (_k, v: unknown) => (typeof v === "function" ? String(v) : v))).not.toMatch(/gho_|sk-ant|ya29\.|AKIA/);
  });

  it("is the seeded catalog", () => {
    const rows = CATALOG.map(e => ({
      id: e.id,
      kind: e.kind,
      road: e.installRoad.road,
      argument: roadArgument(e.installRoad),
      signIn: e.signIn.kind,
      status: e.signIn.status?.command,
      ...(e.kind === "tool" ? { defaultOn: e.defaultOn, floor: e.floor, ...(e.covers !== undefined ? { covers: e.covers } : {}), ...(e.major !== undefined ? { major: e.major } : {}) } : {}),
      source: e.source,
      size: e.size,
      configPaths: e.configPaths.length,
      ...(e.kind === "agent" ? { projectState: e.projectState.map(p => p.state) } : {}),
    }));
    expect(rows).toMatchSnapshot();
  });
});

type Road = (typeof CATALOG)[number]["installRoad"];
function roadArgument(road: Road): string {
  switch (road.road) {
    case "brew":
      return road.formula;
    case "npm":
    case "pnpm":
    case "bun":
    case "uv":
    case "pipx":
    case "cargo":
      return road.version === undefined ? road.package : `${road.package}@${road.version}`;
    case "go":
      return `${road.module}@${road.version}`;
    case "release":
      return road.repo ?? "";
    case "vendor":
      return road.cask.bin;
    case "apt":
      return road.packages.join(" ");
    case "script":
      return `${road.script.split("\n").length} lines`;
  }
}
