// SPDX-License-Identifier: AGPL-3.0-only
// What a road says about reading a row back off a machine: whether the road
// has a presence test of its own, and which directories it links the commands
// it installs into. Both are read by the recipe job and by the doctor through
// one planned step, so a computers row and a doctor line cannot disagree about
// a tool.
import { describe, expect, it } from "vitest";
import { PNPM_HOME } from "@wsp/protocol";
import { APT_BIN, BREW_PREFIX, CARGO_BIN, FROM_A_READABLE_DIR, HOME_BIN, LOCAL_BIN, ROADS, ROAD_MODULES, asLinuxbrew, roadModule, type InstallRoad } from "../src/index.js";

const present = (road: InstallRoad, bin = "x"): string | undefined => roadModule(road).present?.(road, bin);
const bins = (road: InstallRoad): readonly string[] => roadModule(road).bins(road);
const check = (road: InstallRoad, bin = "x"): string | undefined => roadModule(road).check?.(road, bin);

describe("a road's own presence read", () => {
  it("is the prefix's link for a core formula and the link or the command for a tap formula, and no other road has one", () => {
    // A core formula is never read by its name: node comes from the base stage's own installer and gh from the
    // release road, both under the name a formula of the same name would carry, so a command read would call a box
    // green for a Homebrew row Homebrew never installed. That is the row this rule was filed on.
    expect(present({ road: "brew", formula: "go" })).toBe(`test -e ${BREW_PREFIX}/opt/go`);
    expect(present({ road: "brew", formula: "felixkratz/formulae/sketchybar" })).toBe(`test -e ${BREW_PREFIX}/opt/sketchybar || command -v 'sketchybar' >/dev/null 2>&1`);
    // Every other road puts its own command on PATH under the name the row carries, so the command is the read and
    // the step's own check is what runs after an install.
    for (const road of ROADS.filter(r => r !== "brew")) expect(ROAD_MODULES[road].present, road).toBeUndefined();
  });
});

describe("a road's own check", () => {
  it("is Homebrew's own list for a formula, on the one linuxbrew line, and no other road has one", () => {
    // The read after an install, which runs brew and so cannot be answered inside a workspace; a row read by a
    // command written beside it reads whatever that command said on the day it was written.
    expect(check({ road: "brew", formula: "bat" })).toBe(asLinuxbrew("list --versions bat"));
    expect(check({ road: "brew", formula: "bat" })).toContain(FROM_A_READABLE_DIR);
    for (const road of ROADS.filter(r => r !== "brew")) expect(ROAD_MODULES[road].check, road).toBeUndefined();
  });
});

describe("the directories a road links its commands into", () => {
  it("is answered by every road, as absolute paths, and is not the visibility list", () => {
    expect(Object.keys(ROAD_MODULES).sort()).toEqual([...ROADS].sort());
    for (const road of ROADS) {
      const module = ROAD_MODULES[road];
      // The script road alone answers off its own row, since no two of its installers link into one directory.
      if (road !== "script") expect(module.bins({ road } as never).length, road).toBeGreaterThan(0);
      for (const dir of module.bins({ road, script: "x" } as never)) expect(dir.startsWith("/"), `${road} links into ${dir}, which is no absolute path`).toBe(true);
    }
    // Homebrew's prefix is where a formula lands, and the road to /usr/local/bin is what a tap formula with no
    // Linux bottle takes; its roots are the trees a workspace has to see, which is the coarser question.
    expect(bins({ road: "brew", formula: "go" })).toEqual([`${BREW_PREFIX}/bin`, `${BREW_PREFIX}/sbin`, LOCAL_BIN]);
    expect(bins({ road: "apt", packages: ["ffmpeg"] })).toEqual([APT_BIN, "/usr/sbin", "/bin", "/sbin"]);
    expect(bins({ road: "npm", package: "pnpm" })).toEqual([LOCAL_BIN]);
    expect(bins({ road: "release", repo: "cli/cli" })).toEqual([LOCAL_BIN]);
    expect(bins({ road: "pnpm", package: "wrangler" })).toEqual([PNPM_HOME]);
    expect(bins({ road: "uv", package: "ruff" })).toEqual([HOME_BIN]);
    expect(bins({ road: "cargo", package: "ripgrep" })).toEqual([CARGO_BIN]);
  });

  it("is the script road's own row, and nothing for a script whose row names none", () => {
    expect(bins({ road: "script", script: "curl -o node.tar.gz ...", bins: [LOCAL_BIN] })).toEqual([LOCAL_BIN]);
    expect(bins({ road: "script", script: "apt-get install -y docker-ce" })).toEqual([]);
  });
});
