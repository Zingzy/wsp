// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { MIB, TOOLS_DISK_FLOOR } from "../src/golden-tools.js";
import { brewfileFor, pinState, toolInstallsFor, type BrewTable, type RecipeEntry } from "../src/golden-import.js";
import {
  BREW_TOOLCHAIN_BYTES,
  BUILDER_DISK_GB,
  BUILDER_FREE_BYTES,
  DISK_ROOM_BYTES,
  PACK_BUDGET_BYTES,
  agentSize,
  assumedSize,
  brewTable,
  estimateDisk,
  parseBrewInfo,
  parseDu,
  sourceOf,
  toolSize,
} from "../src/tool-sizes.js";

const GIB = 1024 * MIB;

function formula(over: Record<string, unknown>): Record<string, unknown> {
  return { tap: "homebrew/core", dependencies: [], build_dependencies: [], requirements: [], urls: { stable: { url: "https://example.org/src.tar.xz", tag: null } }, versions: { stable: "1.0", bottle: true }, installed: [{ version: "1.0", runtime_dependencies: [] }], ...over };
}

/** What `brew info --json=v2 --installed` says on a Mac with a few formulae and four tap formulae. */
const INFO = {
  formulae: [
    formula({ name: "ffmpeg", full_name: "ffmpeg", dependencies: ["x264", "openssl@3"], installed: [{ version: "8.1.2", runtime_dependencies: [{ full_name: "x264" }, { full_name: "openssl@3" }, { full_name: "ca-certificates" }] }] }),
    formula({ name: "x264", full_name: "x264" }),
    formula({ name: "openssl@3", full_name: "openssl@3", dependencies: ["ca-certificates"] }),
    formula({ name: "ca-certificates", full_name: "ca-certificates" }),
    formula({ name: "gh", full_name: "gh", build_dependencies: ["go"], urls: { stable: { url: "https://github.com/cli/cli/archive/refs/tags/v2.100.0.tar.gz", tag: null } } }),
    formula({ name: "llvm@21", full_name: "llvm@21", dependencies: ["zstd"] }),
    formula({ name: "zstd", full_name: "zstd" }),
    formula({ name: "diskbloom", full_name: "zingzy/tap/diskbloom", tap: "zingzy/tap", versions: { stable: "0.1.0", bottle: false }, urls: { stable: { url: "https://github.com/Zingzy/diskbloom/releases/download/v0.1.0/diskbloom_0.1.0_darwin_arm64.tar.gz", tag: null } } }),
    formula({ name: "sketchybar", full_name: "felixkratz/formulae/sketchybar", tap: "felixkratz/formulae", versions: { stable: "2.24.0", bottle: false }, urls: { stable: { url: "https://github.com/FelixKratz/SketchyBar/archive/refs/tags/v2.24.0.tar.gz", tag: null } } }),
    formula({ name: "macthing", full_name: "someone/tap/macthing", tap: "someone/tap", requirements: [{ name: "macos", version: "13" }], urls: { stable: { url: "https://github.com/someone/macthing/archive/refs/tags/v1.tar.gz", tag: null } } }),
    formula({ name: "gitonly", full_name: "someone/tap/gitonly", tap: "someone/tap", urls: { stable: { url: "https://github.com/someone/gitonly.git", tag: "v3.1.0" } } }),
    formula({ name: "elsewhere", full_name: "someone/tap/elsewhere", tap: "someone/tap", urls: { stable: { url: "https://dl.example.org/elsewhere-1.tar.gz", tag: null } } }),
  ],
  casks: [],
};

const DU = ["102400\t/opt/homebrew/Cellar/ffmpeg", "20480\t/opt/homebrew/Cellar/x264", "30720\t/opt/homebrew/Cellar/openssl@3", "1024\t/opt/homebrew/Cellar/ca-certificates", "51200\t/opt/homebrew/Cellar/gh", "2048000\t/opt/homebrew/Cellar/llvm@21", "5120\t/opt/homebrew/Cellar/zstd", "9800\t/opt/homebrew/Cellar/diskbloom", "1000\t/opt/homebrew/Cellar/sketchybar", ""].join("\n");

const TABLE: BrewTable = brewTable(INFO, parseDu(DU));

function row(over: Partial<RecipeEntry> & { id: string }): RecipeEntry {
  return { rung: "tools", label: over.id.slice(over.id.lastIndexOf("/") + 1), paths: [], bytes: 0, default: "bring", bring: true, ...over };
}
const brew = (name: string, linux: RecipeEntry["linux"] = "yes"): RecipeEntry => row({ id: `tools/brew/${name}`, linux });

describe("the Mac's Homebrew as a table", () => {
  it("reads name, dependencies, size and source per formula; a du line without a formula is dropped", () => {
    const rows = parseBrewInfo(INFO);
    expect(rows.map(f => f.fullName)).toContain("zingzy/tap/diskbloom");
    const ffmpeg = TABLE.get("ffmpeg")!;
    // Direct and transitive runtime dependencies, each once.
    expect(ffmpeg.deps.sort()).toEqual(["ca-certificates", "openssl@3", "x264"]);
    expect(ffmpeg.bytes).toBe(102400 * 1024);
    expect(TABLE.get("gh")!.source).toEqual({ repo: "cli/cli", tag: "v2.100.0" });
    expect(TABLE.get("zingzy/tap/diskbloom")!.source).toEqual({ repo: "Zingzy/diskbloom", tag: "v0.1.0" });
    expect(TABLE.get("someone/tap/gitonly")!.source).toEqual({ repo: "someone/gitonly", tag: "v3.1.0" });
    expect(TABLE.get("someone/tap/elsewhere")!.source).toBeUndefined();
    expect(TABLE.get("someone/tap/elsewhere")!.bytes).toBeUndefined();
    expect(TABLE.get("someone/tap/macthing")!.macosOnly).toBe(true);
    expect(TABLE.get("felixkratz/formulae/sketchybar")!.macosOnly).toBe(true);
    expect(TABLE.get("zingzy/tap/diskbloom")!.macosOnly).toBe(false);
    expect(parseBrewInfo({ nope: 1 })).toEqual([]);
    expect(parseDu("garbage\n\t\n12 /x")).toEqual(new Map([["x", 12 * 1024]]));
  });

  it("names the GitHub repository and tag behind a formula's url", () => {
    expect(sourceOf("https://github.com/cli/cli/archive/refs/tags/v2.100.0.tar.gz", null)).toEqual({ repo: "cli/cli", tag: "v2.100.0" });
    expect(sourceOf("https://github.com/a/b/releases/download/1.2.3/b_1.2.3_linux.zip", null)).toEqual({ repo: "a/b", tag: "1.2.3" });
    expect(sourceOf("https://github.com/a/b.git", "v9")).toEqual({ repo: "a/b", tag: "v9" });
    expect(sourceOf("https://github.com/a/b.git", null)).toBeUndefined();
    expect(sourceOf("https://gitlab.com/a/b/-/archive/v1/b-v1.tar.gz", null)).toBeUndefined();
  });
});

describe("toolSize", () => {
  it("a formula's number is its dependency closure, read from this Mac's Homebrew", () => {
    const s = toolSize(brew("ffmpeg"), TABLE)!;
    expect(s.bytes).toBe((102400 + 20480 + 30720 + 1024) * 1024);
    expect(s.deps).toBe(3);
    expect(s.road).toBe("mac");
  });

  it("a formula measured on Linux takes the measured number over the Mac's, and its dependencies still count", () => {
    const s = toolSize(brew("llvm@21"), TABLE)!;
    expect(s.bytes).toBe(2560 * MIB + 5120 * 1024);
    expect(s.road).toBe("measured");
    // Without a Mac table the measured formula still has a number, its dependencies unknown.
    expect(toolSize(brew("llvm@21"), new Map())).toEqual({ bytes: 2560 * MIB, road: "measured", deps: 0 });
  });

  it("a formula nothing measured or read has no size; taps, casks and a measured npm global are handled", () => {
    expect(toolSize(brew("gh"), new Map())).toBeUndefined();
    expect(toolSize(row({ id: "tools/brew-tap/zingzy/tap" }), TABLE)).toBeUndefined();
    expect(toolSize(row({ id: "tools/brew-cask/rectangle" }), TABLE)).toBeUndefined();
    expect(toolSize(row({ id: "tools/npm/bun" }), TABLE)).toEqual({ bytes: 78 * MIB, road: "measured", deps: 0 });
    expect(toolSize(row({ id: "tools/npm/left-pad" }), TABLE)).toBeUndefined();
  });

  it("Homebrew's own toolchain is left out of a closure: it is the group's own line", () => {
    const table: BrewTable = new Map([...TABLE, ["needs-gcc", { name: "needs-gcc", fullName: "needs-gcc", deps: ["gcc", "zstd"], bytes: 10 * MIB, macosOnly: false }]]);
    expect(toolSize(brew("needs-gcc"), table)).toEqual({ bytes: 10 * MIB + 5120 * 1024, road: "mac", deps: 1 });
  });
});

describe("agentSize", () => {
  it("measured install sizes by agent; an agent nobody measured has none", () => {
    expect(agentSize({ ...row({ id: "agents/opencode" }), rung: "agents" })).toBe(673 * MIB);
    expect(agentSize({ ...row({ id: "agents/claude" }), rung: "agents" })).toBe(208 * MIB);
    expect(agentSize({ ...row({ id: "agents/aider" }), rung: "agents" })).toBeUndefined();
  });
});

describe("the disk", () => {
  it("room is what the 20 GB builder had free less the tools floor; the pack budget is half of what the upload stage has", () => {
    expect(BUILDER_DISK_GB).toBe(20);
    // df -Pk on the real builder before the upload: 17,992,136 KiB, the base image and the reserved blocks already gone.
    expect(BUILDER_FREE_BYTES).toBe(17570 * MIB);
    expect(DISK_ROOM_BYTES).toBe(BUILDER_FREE_BYTES - TOOLS_DISK_FLOOR);
    expect(DISK_ROOM_BYTES).toBeLessThan(15.2 * GIB);
    expect(PACK_BUDGET_BYTES).toBe(Math.floor((BUILDER_FREE_BYTES - 256 * MIB) / 2));
    expect(PACK_BUDGET_BYTES).toBeGreaterThan(8 * GIB);
  });
});

describe("assumedSize", () => {
  it("a row nothing measured counts at the default for its kind, and says which kind", () => {
    expect(assumedSize(row({ id: "tools/go/gopls" }))).toEqual({ bytes: 500 * MIB, kind: "a go install" });
    expect(assumedSize(row({ id: "tools/uv/ty" }))).toEqual({ bytes: 100 * MIB, kind: "a uv tool" });
    expect(assumedSize(row({ id: "tools/npm/left-pad" }))).toEqual({ bytes: 50 * MIB, kind: "an npm global" });
    expect(assumedSize(row({ id: "tools/pnpm/left-pad" }))).toEqual({ bytes: 50 * MIB, kind: "an npm global" });
    expect(assumedSize(row({ id: "tools/cargo/ripgrep" }))).toEqual({ bytes: 100 * MIB, kind: "an install" });
    expect(assumedSize(row({ id: "tools/brew/nobody/tap/mystery" }))).toEqual({ bytes: 100 * MIB, kind: "an install" });
    expect(assumedSize({ ...row({ id: "agents/aider" }), rung: "agents" })).toEqual({ bytes: 350 * MIB, kind: "an agent" });
  });

  it("a command cask's row counts at the go default when it carries a go fallback, at the install default when it does not", () => {
    const spoo = row({ id: "tools/cli/spoo", paths: ["github.com/spoo-me/spoo-cli@v0.4.1", "github.com/spoo-me/spoo-cli/cmd/spoo@v0.3.0"] });
    expect(assumedSize(spoo)).toEqual({ bytes: 500 * MIB, kind: "a go install" });
    const ngrok = row({ id: "tools/cli/ngrok", paths: ["github.com/ngrok/ngrok@v3"] });
    expect(assumedSize(ngrok)).toEqual({ bytes: 100 * MIB, kind: "an install" });
    expect(assumedSize(row({ id: "tools/cargo/spoo", paths: spoo.paths }))).toEqual({ bytes: 100 * MIB, kind: "an install" });
  });
});

describe("estimateDisk", () => {
  const files = 300 * MIB;

  it("adds files, Homebrew's toolchain once, the tools' closures with shared dependencies once, and the agents", () => {
    const ticked = [brew("ffmpeg"), brew("openssl@3"), brew("llvm@21"), { ...row({ id: "agents/opencode" }), rung: "agents" as const }, { ...row({ id: "agents/gemini" }), rung: "agents" as const }];
    const est = estimateDisk(ticked, files, TABLE);
    expect(est.files).toBe(files);
    expect(est.toolchain).toBe(BREW_TOOLCHAIN_BYTES);
    // ffmpeg + x264 + openssl@3 + ca-certificates (openssl@3's own row adds nothing new) + llvm@21 measured + zstd.
    expect(est.tools).toBe((102400 + 20480 + 30720 + 1024 + 5120) * 1024 + 2560 * MIB);
    // The agents run on the base's Node 22, which is the base floor's cost, not theirs.
    expect(est.agents).toBe((673 + 189) * MIB);
    expect(est.unknown).toEqual([]);
    expect(est.assumed).toBe(0);
    expect(est.total).toBe(est.files + est.toolchain + est.tools + est.agents);
    expect(est.room).toBe(DISK_ROOM_BYTES);
    expect(est.over).toBe(0);
  });

  it("no Homebrew formula, no toolchain; an npm row and an agent nobody measured are named as unknown", () => {
    const est = estimateDisk([row({ id: "tools/npm/left-pad", label: "left-pad" }), row({ id: "tools/npm/bun", label: "bun" }), { ...row({ id: "agents/aider", label: "Aider" }), rung: "agents" as const }, { ...row({ id: "agents/zed", label: "Zed" }), rung: "agents" as const }], 0, TABLE);
    expect(est.toolchain).toBe(0);
    expect(est.tools).toBe(78 * MIB);
    // Zed has no installer, so nothing of it lands on the machine and nothing is unknown about it.
    expect(est.unknown).toEqual(["left-pad", "Aider"]);
    // The unknown rows still count, each at its kind's default, and the total carries them.
    expect(est.assumed).toBe((50 + 350) * MIB);
    expect(est.agents).toBe(0);
    expect(est.total).toBe(est.tools + est.assumed);
  });

  it("no agent brings a Node of its own: the base's 22 meets every pinned floor", () => {
    const codex = { ...row({ id: "agents/codex" }), rung: "agents" as const };
    expect(estimateDisk([codex], 0, TABLE).agents).toBe(455 * MIB);
    const pi = { ...row({ id: "agents/pi" }), rung: "agents" as const };
    expect(estimateDisk([codex, pi], 0, TABLE).agents).toBe((455 + 165) * MIB);
  });

  it("a manager the plan pulls in as a formula counts, and so does the toolchain it needs", () => {
    const est = estimateDisk([row({ id: "tools/cargo/bat", label: "bat" })], 0, new Map([["rust", { name: "rust", fullName: "rust", deps: [], bytes: 400 * MIB, macosOnly: false }]]));
    expect(est.toolchain).toBe(BREW_TOOLCHAIN_BYTES);
    expect(est.tools).toBe(400 * MIB);
    expect(est.unknown).toEqual(["bat"]);
    expect(est.assumed).toBe(100 * MIB);
    expect(est.total).toBe(BREW_TOOLCHAIN_BYTES + 400 * MIB + 100 * MIB);
  });

  it("says by how much a recipe overshoots the room", () => {
    const huge: BrewTable = new Map([["gh", { name: "gh", fullName: "gh", deps: [], bytes: 30 * GIB, macosOnly: false }]]);
    const est = estimateDisk([brew("gh")], 0, huge);
    expect(est.over).toBe(30 * GIB + BREW_TOOLCHAIN_BYTES - DISK_ROOM_BYTES);
  });

  it("a cask or a tap adds nothing and is not unknown", () => {
    const est = estimateDisk([row({ id: "tools/brew-cask/rectangle", label: "rectangle" }), row({ id: "tools/brew-tap/zingzy/tap", label: "zingzy/tap" })], 0, TABLE);
    expect(est.tools).toBe(0);
    expect(est.unknown).toEqual([]);
    expect(est.toolchain).toBe(BREW_TOOLCHAIN_BYTES);
  });
});

describe("tap formulae without a Linux bottle", () => {
  const rows = [
    brew("felixkratz/formulae/sketchybar", "unknown"),
    brew("zingzy/tap/diskbloom", "unknown"),
    brew("someone/tap/macthing", "unknown"),
    brew("someone/tap/elsewhere", "unknown"),
    brew("nobody/tap/mystery", "unknown"),
  ];

  it("a macOS-only formula says so, one with a GitHub source takes the release road, the rest stay skipped as before", () => {
    const b = brewfileFor(rows, TABLE);
    expect(b.formulae).toEqual([]);
    expect(b.skipped).toEqual([
      { id: "tools/brew/felixkratz/formulae/sketchybar", note: "macOS only" },
      { id: "tools/brew/someone/tap/macthing", note: "macOS only" },
      { id: "tools/brew/someone/tap/elsewhere", note: "no Linux bottle known" },
      { id: "tools/brew/nobody/tap/mystery", note: "no Linux bottle known" },
    ]);
    expect(b.roads).toEqual([{ id: "tools/brew/zingzy/tap/diskbloom", name: "diskbloom", source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]);
    // A core formula the snapshot does not know keeps its skip even when the Mac names a source: brew may bottle it by now.
    expect(brewfileFor([brew("gh", "unknown")], TABLE).skipped).toEqual([{ id: "tools/brew/gh", note: "no Linux bottle known" }]);
    // Without the Mac's table the known macOS-only list still speaks; everything else is as before.
    expect(brewfileFor(rows).skipped.map(s => s.note)).toEqual(["macOS only", "no Linux bottle known", "no Linux bottle known", "no Linux bottle known", "no Linux bottle known"]);
  });

  it("the road install is its own step after everything brew does: the release for this arch, else go install, and it names the road it took", () => {
    const plan = toolInstallsFor([brew("gh"), ...rows], TABLE);
    const road = plan.installs.at(-1)!;
    expect(road).toMatchObject({ id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", manager: "github" });
    expect(road.after).toBeUndefined();
    expect(road.cmd).toContain("https://api.github.com/repos/Zingzy/diskbloom/releases/tags/v0.1.0");
    expect(road.cmd).toContain("install -m 0755");
    expect(road.cmd).toContain("name='diskbloom'");
    expect(road.cmd).toContain('"/usr/local/bin/$name"');
    expect(road.cmd).toContain("go install 'github.com/Zingzy/diskbloom@v0.1.0'");
    // The asset's checksum rides on the WSP_ROAD line so the first install records it; nothing is checked yet.
    expect(road.cmd).toContain(`sum="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"`);
    expect(road.cmd).toContain(`echo "WSP_ROAD release \${asset:-$url} $sum "'v0.1.0'`);
    expect(road.cmd).not.toContain("checksum recorded");
    expect(road.cmd).toMatch(/WSP_ROAD go/);
    // Nothing is piped into a shell, and the tag and repository from the Mac's formula only ever reach the shell single-quoted.
    expect(road.cmd).not.toMatch(/\|\s*(ba)?sh\b/);
    const odd = { repo: "Zingzy/diskbloom", tag: "v0.1.0'; echo pwned; '" };
    const table: BrewTable = new Map([["zingzy/tap/diskbloom", { ...TABLE.get("zingzy/tap/diskbloom")!, source: odd }]]);
    const quoted = toolInstallsFor([{ ...brew("zingzy/tap/diskbloom", "unknown"), pin: { tag: odd.tag, sha256: "e".repeat(64) } }], table).installs.at(-1)!.cmd;
    const tagQ = `'v0.1.0'\\''; echo pwned; '\\'''`;
    expect(quoted).toContain(`releases/tags/v0.1.0'\\''; echo pwned; '\\'''`);
    expect(quoted).toContain(`first install of "${tagQ}`);
    expect(quoted).toContain(`$sum "${tagQ}`);
    expect(quoted).toContain(`go install 'github.com/Zingzy/diskbloom@v0.1.0'\\''; echo pwned; '\\'''`);
    expect(quoted).toContain(`echo "WSP_ROAD go "'github.com/Zingzy/diskbloom@v0.1.0'\\''; echo pwned; '\\'''`);
    expect(quoted).toContain(`echo "Error: release "${tagQ}" of "'Zingzy/diskbloom'" has no Linux build`);
    expect(quoted).not.toMatch(/[^']v0\.1\.0'; echo pwned/);
    expect(road.cmd).toContain("grep -viE '\\.(sha256|");
    expect(plan.installs.filter(t => t.manager === "brew").map(t => t.id)).toContain("tools/brew/gh");
    expect(plan.skipped.map(s => s.id)).not.toContain("tools/brew/zingzy/tap/diskbloom");
  });

  it("a recipe that recorded the checksum for this tag has the install check it before unpacking; a mismatch fails the tool", () => {
    const pin = { tag: "v0.1.0", sha256: "e".repeat(64) };
    const b = brewfileFor([{ ...brew("zingzy/tap/diskbloom", "unknown"), pin }], TABLE);
    expect(b.roads).toEqual([{ id: "tools/brew/zingzy/tap/diskbloom", name: "diskbloom", source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" }, pin }]);
    expect(pinState(pin, b.roads[0]!.source)).toBe("same");
    const road = toolInstallsFor([{ ...brew("zingzy/tap/diskbloom", "unknown"), pin }], TABLE).installs.at(-1)!;
    expect(road.cmd).toContain(`[ "$sum" = '${pin.sha256}' ] || { echo "Error: $asset does not match the checksum recorded on the first install of "'v0.1.0' >&2; exit 1; }`);
    // The check sits between the download and the unpack; the line the stage reads carries the checksum and the tag.
    expect(road.cmd.indexOf("curl -fsSL -o")).toBeLessThan(road.cmd.indexOf('[ "$sum" ='));
    expect(road.cmd.indexOf('[ "$sum" =')).toBeLessThan(road.cmd.indexOf('case "$asset" in'));
    expect(road.cmd).toContain(`echo "WSP_ROAD release \${asset:-$url} $sum "'v0.1.0'`);
  });

  it("a pin from an older tag is not checked against the new release: the tag moved, so it is a first install again", () => {
    const pin = { tag: "v0.0.9", sha256: "e".repeat(64) };
    const b = brewfileFor([{ ...brew("zingzy/tap/diskbloom", "unknown"), pin }], TABLE);
    expect(pinState(pin, b.roads[0]!.source)).toBe("moved");
    expect(pinState(undefined, b.roads[0]!.source)).toBe("none");
    const road = toolInstallsFor([{ ...brew("zingzy/tap/diskbloom", "unknown"), pin }], TABLE).installs.at(-1)!;
    expect(road.cmd).not.toContain('[ "$sum" =');
    expect(road.cmd).not.toContain("e".repeat(64));
    expect(road.cmd).toContain(`echo "WSP_ROAD release \${asset:-$url} $sum "'v0.1.0'`);
  });
});
