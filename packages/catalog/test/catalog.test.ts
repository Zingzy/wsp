// SPDX-License-Identifier: AGPL-3.0-only
// The catalog's own invariants: ids are unique, every road is a known one,
// every browser or device sign-in has a status that proves it, the agents are
// the six whose project state has a measured resolver, every default names
// its evidence, and the seeded rows are what the snapshot says they are.
import { describe, expect, it } from "vitest";
import { BASE_FLOOR, CATALOG, CATALOG_AGENTS, HISTORY_FORMATS, LINUX_CASKS, LOGIN_ROWS, ROADS, SIGN_IN_ROWS, baseEntryFor, baseNote, catalogEntry, catalogToolFor, hasLogin, installAfter, installLine, keysIdOf, keysRowOf, loginIdOf, loginRow, smokeOf } from "../src/index.js";

describe("catalog", () => {
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

  it("sends every entry down a known road with its argument", () => {
    for (const e of CATALOG) {
      const road = e.installRoad;
      expect(ROADS, e.id).toContain(road.road);
      switch (road.road) {
        case "brew":
          expect(road.formula, e.id).toMatch(/^[\w@.+-]+$/);
          break;
        case "npm":
          expect(road.package, e.id).toMatch(/^(@[\w.-]+\/)?[\w.-]+$/);
          break;
        case "release":
          if ("github" in road.asset) expect(road.asset.github, e.id).toMatch(/^[\w.-]+\/[\w.-]+$/);
          else expect(LINUX_CASKS, e.id).toContain(road.asset.vendor);
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
      expect(hasLogin(a.signIn), a.id).toBe(true);
      expect(smokeOf(a)).toBe(`${a.id} --version`);
      expect(a.size, a.id).toBeGreaterThan(0);
    }
    expect(installLine(catalogEntry("codex")!)).toBe("npm install -g @openai/codex@0.153.0");
    expect(installLine(catalogEntry("pi")!)).toBe("npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4");
    expect(installLine(catalogEntry("claude")!)).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(installLine(catalogEntry("hermes")!)).toMatch(/git clone -q --depth 1 --branch v[\d.]+ https:\/\/github\.com\/NousResearch\/hermes-agent\.git/);
    expect(() => installLine({ ...catalogEntry("codex")!, installRoad: { road: "npm", package: "wrangler" } })).toThrow(/no version/);
  });

  it("gives every pinned road one install line, and refuses the roads that install through Homebrew or a release", () => {
    expect(installLine(catalogEntry("git")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq git");
    expect(installLine(catalogEntry("docker")!)).toBe("export DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq docker.io docker-compose-v2");
    expect(installLine(catalogEntry("pnpm")!)).toBe("npm install -g pnpm@11.9.0");
    expect(() => installLine(catalogEntry("go")!)).toThrow(/brew road/);
    expect(() => installLine(catalogEntry("gh")!)).toThrow(/release road/);
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
      return road.version === undefined ? road.package : `${road.package}@${road.version}`;
    case "release":
      return "github" in road.asset ? road.asset.github : road.asset.vendor.bin;
    case "apt":
      return road.packages.join(" ");
    case "script":
      return `${road.script.split("\n").length} lines`;
  }
}
