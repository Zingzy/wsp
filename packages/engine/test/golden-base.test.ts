// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { BASE_FLOOR, NODE_RELEASES } from "@wsp/catalog";
import { BASE_VERSIONS_CMD, baseInstalls, installBase, parseVersions, versionsLine } from "../src/golden-base.js";
import { FREE_KB_CMD } from "../src/golden-tools.js";
import type { ExecResult, Machine } from "../src/machine.js";
import type { GoldenStage } from "../src/golden.js";

const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
const mb = (n: number) => String(n * 1024);

/** A guest that answers df from `free`, runs every script with `answer`, and records both. */
function guest(answer: (script: string) => ExecResult | undefined, free: () => string = () => mb(3000)) {
  const ran: string[] = [];
  const cmds: string[] = [];
  const machine = {
    id: "m1",
    kind: "sandbox",
    streamUrl: undefined,
    exec: async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === FREE_KB_CMD) return { exitCode: 0, stdout: `${free()}\n`, stderr: "" };
      return answer(cmd) ?? ok;
    },
    run: async (script: string) => {
      ran.push(script);
      return answer(script) ?? ok;
    },
  } as unknown as Machine;
  return { machine, ran, cmds };
}

function recorder() {
  const stages: string[] = [];
  return { stages, stage: (s: GoldenStage, d?: string) => void stages.push(d === undefined ? s : `${s}:${d}`) };
}

const VERSIONS_OUT = [
  "VERSION node: v22.23.2",
  "VERSION npm: 10.9.4",
  "VERSION pnpm: 11.9.0",
  "VERSION uv: uv 0.12.9",
  "VERSION python3: Python 3.12.13",
  "VERSION git: git version 2.43.0",
  "VERSION jq: jq-1.7.1",
  "VERSION rg: ripgrep 14.1.0 (rev 4649aa9700)",
  "VERSION curl: curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0",
  "VERSION docker: Docker version 27.5.1, build 9f9e405",
  "VERSION docker compose: Docker Compose version v2.29.2",
  "",
].join("\n");

describe("the base floor's plan", () => {
  it("is every floor entry by its catalog road, in order, each waiting on what it needs", () => {
    const plan = baseInstalls();
    expect(plan.map(t => [t.id, t.manager, t.after, t.bin])).toEqual([
      ["base/node", "script", undefined, "node"],
      ["base/pnpm", "npm", "base/node", "pnpm"],
      ["base/uv", "script", undefined, "uv"],
      ["base/python", "script", "base/uv", "python3"],
      ["base/apt-index", "apt", undefined, undefined],
      ["base/git", "apt", "base/apt-index", "git"],
      ["base/jq", "apt", "base/apt-index", "jq"],
      ["base/ripgrep", "apt", "base/apt-index", "rg"],
      ["base/curl", "apt", "base/apt-index", "curl"],
      ["base/docker", "apt", "base/apt-index", "docker"],
    ]);
    expect(plan.map(t => t.label)).toEqual(["Node 22 with npm", "pnpm", "uv", "Python 3.12", "apt index", "git", "jq", "ripgrep", "curl", "Docker engine and compose"]);
    expect(BASE_FLOOR.map(e => `base/${e.id}`)).toEqual(plan.filter(t => t.bin !== undefined).map(t => t.id));
  });

  it("every step runs under set -e with a home and the tools PATH, and each road is the catalog's pinned one", () => {
    const cmd = (id: string) => baseInstalls().find(t => t.id === id)!.cmd;
    for (const t of baseInstalls()) {
      expect(t.cmd, t.id).toMatch(/^set -euo pipefail\nexport HOME=/);
      expect(t.cmd, t.id).toMatch(/\nexport PATH=\/root\/\.local\/bin:\/usr\/local\/sbin:\/usr\/local\/bin:/);
      expect(t.cmd, t.id).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
    }
    const node = cmd("base/node");
    expect(node).toContain(`if [ "\${node_major:-0}" -ge 22 ]; then echo "NODE_KEPT $node_have"; exit 0; fi`);
    expect(node).toContain(`https://nodejs.org/dist/v${NODE_RELEASES[22].version}/`);
    expect(node).toContain("sha256sum -c");
    expect(cmd("base/pnpm")).toMatch(/\nnpm install -g pnpm@11\.9\.0$/);
    expect(cmd("base/uv")).toContain("astral-sh/uv/releases/download/");
    expect(cmd("base/python")).toMatch(/\nuv python install 3\.12\nln -sfn "\$\(uv python find --managed-python 3\.12\)" \/usr\/local\/bin\/python3$/);
    expect(cmd("base/apt-index")).toMatch(/\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq$/);
    expect(cmd("base/jq")).toMatch(/\nexport DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq jq$/);
    expect(cmd("base/docker")).toMatch(/\napt-get install -y -qq docker\.io docker-compose-v2$/);
  });
});

describe("the versions read", () => {
  it("asks each floor command for its version on the tools PATH, npm with node and compose with docker", () => {
    expect(BASE_VERSIONS_CMD).toMatch(/^export PATH=\/root\/\.local\/bin:/);
    expect(BASE_VERSIONS_CMD).toContain('echo "VERSION node: $(node --version 2>/dev/null | head -n 1)"');
    expect(BASE_VERSIONS_CMD).toContain('echo "VERSION npm: $(npm --version 2>/dev/null | head -n 1)"');
    expect(BASE_VERSIONS_CMD).toContain('echo "VERSION python3: $(python3 --version 2>/dev/null | head -n 1)"');
    expect(BASE_VERSIONS_CMD).toContain('echo "VERSION rg: $(rg --version 2>/dev/null | head -n 1)"');
    expect(BASE_VERSIONS_CMD).toContain('echo "VERSION docker compose: $(docker compose version 2>/dev/null | head -n 1)"');
    expect(BASE_VERSIONS_CMD).toContain('echo "VERSION git: $(git --version 2>/dev/null | head -n 1)"');
    expect(BASE_VERSIONS_CMD.split("\n").filter(l => l.startsWith("echo \"VERSION"))).toHaveLength(11);
  });

  it("keeps the version number out of each tool's own wording, and leaves out a command that printed nothing", () => {
    expect(parseVersions(VERSIONS_OUT)).toEqual([
      { name: "node", version: "22.23.2" },
      { name: "npm", version: "10.9.4" },
      { name: "pnpm", version: "11.9.0" },
      { name: "uv", version: "0.12.9" },
      { name: "python3", version: "3.12.13" },
      { name: "git", version: "2.43.0" },
      { name: "jq", version: "1.7.1" },
      { name: "rg", version: "14.1.0" },
      { name: "curl", version: "8.5.0" },
      { name: "docker", version: "27.5.1" },
      { name: "docker compose", version: "2.29.2" },
    ]);
    expect(parseVersions("VERSION node: v22.23.2\nVERSION docker: \nVERSION rg: no digits here\nnoise\n")).toEqual([{ name: "node", version: "22.23.2" }]);
    expect(parseVersions("")).toEqual([]);
  });

  it("the stage line names each version with what its install cost, and a floor entry that did not land by its reason", () => {
    const versions = parseVersions(VERSIONS_OUT).filter(v => v.name !== "docker" && v.name !== "docker compose");
    const line = versionsLine(versions, [
      { id: "base/node", label: "Node 22 with npm", outcome: "installed", bytes: 250 * 1024 * 1024 },
      { id: "base/pnpm", label: "pnpm", outcome: "installed", bytes: 30 * 1024 * 1024 },
      { id: "base/uv", label: "uv", outcome: "installed", bytes: 42 * 1024 * 1024 },
      { id: "base/python", label: "Python 3.12", outcome: "installed", bytes: 70 * 1024 * 1024 },
      { id: "base/apt-index", label: "apt index", outcome: "installed" },
      { id: "base/git", label: "git", outcome: "installed", bytes: 0 },
      { id: "base/jq", label: "jq", outcome: "installed", bytes: 2 * 1024 * 1024 },
      { id: "base/ripgrep", label: "ripgrep", outcome: "installed", bytes: 6 * 1024 * 1024 },
      { id: "base/curl", label: "curl", outcome: "installed", bytes: 0 },
      { id: "base/docker", label: "Docker engine and compose", outcome: "failed", note: "E: Unable to locate package docker-compose-v2" },
    ]);
    expect(line).toBe("node 22.23.2 (250 MB), npm 10.9.4, pnpm 11.9.0 (30 MB), uv 0.12.9 (42 MB), python3 3.12.13 (70 MB), git 2.43.0, jq 1.7.1 (2 MB), rg 14.1.0 (6 MB), curl 8.5.0; Docker engine and compose failed (E: Unable to locate package docker-compose-v2)");
    expect(versionsLine([], [])).toBe("");
  });
});

describe("installBase", () => {
  it("runs the floor under the base stage, reads the versions once after, and its line carries them with the sizes df saw", async () => {
    let free = 3000;
    const g = guest(script => {
      if (script.includes("nodejs.org/dist")) {
        free -= 250;
        return { exitCode: 0, stdout: "NODE_HAVE v18.20.4\nNODE_INSTALLED v22.23.2\n", stderr: "" };
      }
      if (script.includes("apt-get install -y -qq docker.io")) {
        free -= 400;
        return ok;
      }
      if (script.startsWith("export PATH=") && script.includes("VERSION node:")) return { exitCode: 0, stdout: VERSIONS_OUT, stderr: "" };
      return undefined;
    }, () => mb(free));
    const { stages, stage } = recorder();
    const out = await installBase(g.machine, stage);
    expect(stages[0]).toBe("deploying-daemon:Node 22 with npm (1/10)");
    expect(stages).toContain("deploying-daemon:Docker engine and compose (10/10)");
    expect(stages.every(s => s.startsWith("deploying-daemon"))).toBe(true);
    expect(out.tools.map(t => [t.id, t.outcome, t.bytes])).toEqual([
      ["base/node", "installed", 250 * 1024 * 1024],
      ["base/pnpm", "installed", 0],
      ["base/uv", "installed", 0],
      ["base/python", "installed", 0],
      ["base/apt-index", "installed", 0],
      ["base/git", "installed", 0],
      ["base/jq", "installed", 0],
      ["base/ripgrep", "installed", 0],
      ["base/curl", "installed", 0],
      ["base/docker", "installed", 400 * 1024 * 1024],
    ]);
    expect(out.line).toBe("node 22.23.2 (250 MB), npm 10.9.4, pnpm 11.9.0, uv 0.12.9, python3 3.12.13, git 2.43.0, jq 1.7.1, rg 14.1.0, curl 8.5.0, docker 27.5.1 (400 MB), docker compose 2.29.2");
    expect(g.cmds.filter(c => c.includes("VERSION node:"))).toHaveLength(1);
    expect(g.ran).toHaveLength(11);
  });

  it("a step that fails is named on the stage and in the line, and what waited on it is skipped by its name", async () => {
    const g = guest(script => (script.includes("apt-get update -qq") ? { exitCode: 100, stdout: "", stderr: "E: Could not get lock /var/lib/apt/lists/lock" } : script.includes("VERSION node:") ? { exitCode: 0, stdout: "VERSION node: v22.23.2\nVERSION npm: 10.9.4\nVERSION pnpm: 11.9.0\nVERSION uv: uv 0.12.9\nVERSION python3: Python 3.12.13\n", stderr: "" } : undefined));
    const { stages, stage } = recorder();
    const out = await installBase(g.machine, stage);
    expect(out.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["base/node", "installed", undefined],
      ["base/pnpm", "installed", undefined],
      ["base/uv", "installed", undefined],
      ["base/python", "installed", undefined],
      ["base/apt-index", "failed", "E: Could not get lock /var/lib/apt/lists/lock"],
      ["base/git", "skipped", "apt index did not install"],
      ["base/jq", "skipped", "apt index did not install"],
      ["base/ripgrep", "skipped", "apt index did not install"],
      ["base/curl", "skipped", "apt index did not install"],
      ["base/docker", "skipped", "apt index did not install"],
    ]);
    expect(out.line).toBe("node 22.23.2, npm 10.9.4, pnpm 11.9.0, uv 0.12.9, python3 3.12.13; git skipped (apt index did not install); jq skipped (apt index did not install); ripgrep skipped (apt index did not install); curl skipped (apt index did not install); Docker engine and compose skipped (apt index did not install)");
    expect(stages).toContain("deploying-daemon:4 installed, 1 failed: apt index (E: Could not get lock /var/lib/apt/lists/lock), 5 skipped: git, jq, ripgrep, curl, Docker engine and compose (apt index did not install); caches swept; 3000 MB free");
  });

  it("an install that exits 0 without its command on PATH is a failure, not a version", async () => {
    const g = guest(script => (script.includes("for b in") && script.includes("command -v") ? { exitCode: 0, stdout: "missing docker\n", stderr: "" } : script.includes("VERSION node:") ? { exitCode: 0, stdout: "VERSION node: v22.23.2\n", stderr: "" } : undefined));
    const out = await installBase(g.machine, () => {});
    expect(out.tools.find(t => t.id === "base/docker")).toMatchObject({ outcome: "failed", note: "docker is not on PATH after the install" });
    expect(out.line).toBe("node 22.23.2; Docker engine and compose failed (docker is not on PATH after the install)");
  });
});
