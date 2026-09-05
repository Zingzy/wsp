// SPDX-License-Identifier: AGPL-3.0-only
// The catalog's own invariants: ids are unique, every road is a known one,
// every browser or device sign-in has a status that proves it, the agents are
// the six whose project state has a measured resolver, every default names
// its evidence, and the seeded rows are what the snapshot says they are.
import { describe, expect, it } from "vitest";
import { CATALOG, CATALOG_AGENTS, LINUX_CASKS, ROADS, SIGN_IN_ROWS, agentInstallLine, catalogEntry, hasLogin, smokeOf } from "../src/index.js";

describe("catalog", () => {
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

  it("ships exactly the six agents whose project state a move can follow, each with a pinned road, a smoke and a resolver", () => {
    expect(CATALOG_AGENTS.map(a => a.id)).toEqual(["claude", "codex", "gemini", "opencode", "pi", "hermes"]);
    for (const a of CATALOG_AGENTS) {
      expect(a.projectState.length, a.id).toBeGreaterThan(0);
      expect(hasLogin(a.signIn), a.id).toBe(true);
      expect(smokeOf(a)).toBe(`${a.id} --version`);
      expect(a.size, a.id).toBeGreaterThan(0);
    }
    expect(agentInstallLine(catalogEntry("codex")!)).toBe("npm install -g @openai/codex@0.153.0");
    expect(agentInstallLine(catalogEntry("pi")!)).toBe("npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4");
    expect(agentInstallLine(catalogEntry("claude")!)).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(agentInstallLine(catalogEntry("hermes")!)).toMatch(/git clone -q --depth 1 --branch v[\d.]+ https:\/\/github\.com\/NousResearch\/hermes-agent\.git/);
    expect(() => agentInstallLine(catalogEntry("git")!)).toThrow(/apt road/);
    expect(() => agentInstallLine({ ...catalogEntry("codex")!, installRoad: { road: "npm", package: "wrangler" } })).toThrow(/no version/);
  });

  it("names the evidence behind every default: sessions on this Mac and lab images that ship it", () => {
    for (const e of CATALOG) {
      expect(Number.isInteger(e.source.sessions) && e.source.sessions >= 0, e.id).toBe(true);
      expect(e.source.images, e.id).toBeGreaterThanOrEqual(0);
      expect(e.source.images, e.id).toBeLessThanOrEqual(5);
    }
    expect(CATALOG.filter(e => e.kind === "tool" && e.defaultOn).map(e => e.id)).toEqual(["git", "gh", "curl", "jq", "ripgrep", "node", "pnpm", "python", "uv", "docker", "agent-browser"]);
    expect(catalogEntry("agent-browser")?.source.note).toMatch(/one Mac/);
  });

  it("says which roads no guest has run yet", () => {
    const unmeasured = CATALOG.filter(e => e.source.road === "unmeasured").map(e => e.id);
    expect(unmeasured).toEqual([
      "git", "gh", "curl", "jq", "ripgrep", "pnpm", "python", "uv", "docker", "agent-browser",
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
      ...(e.kind === "tool" ? { defaultOn: e.defaultOn } : {}),
      source: e.source,
      size: e.size,
      configPaths: e.configPaths.length,
      projectState: e.kind === "agent" ? e.projectState.map(p => p.state) : [],
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
