// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { BASE_FLOOR, CURL_NET, NODE_RELEASES, ROAD_STEPS, UV_INSTALL } from "@wsp/catalog";
import { PRELUDE } from "../src/dotfiles-presets.js";
import { BASE_VERSIONS_CMD, baseInstalls, installBase, parseVersions, versionsLine } from "../src/golden-base.js";
import { TOOLS_PATH } from "../src/golden-import.js";
import { FREE_KB_CMD, guardedRoad, reasonOf, roadLimitS } from "../src/golden-tools.js";
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
      ["base/login-path", "script", undefined, undefined],
      ["base/node", "script", undefined, "node"],
      ["base/pnpm", "npm", "base/node", "pnpm"],
      ["base/uv", "script", undefined, "uv"],
      ["base/python", "script", "base/uv", "python3"],
      ["base/apt-index", "apt", undefined, undefined],
      ["base/git", "apt", "base/apt-index", "git"],
      ["base/jq", "apt", "base/apt-index", "jq"],
      ["base/ripgrep", "apt", "base/apt-index", "rg"],
      ["base/curl", "apt", "base/apt-index", "curl"],
      ["base/docker", "script", "base/apt-index", "docker"],
      ["base/build-essential", "apt", "base/apt-index", "cc"],
      ["base/fd", "script", "base/apt-index", "fd"],
      ["base/sqlite3", "apt", "base/apt-index", "sqlite3"],
      ["base/wget", "apt", "base/apt-index", "wget"],
      ["base/zip", "apt", "base/apt-index", "zip"],
      ["base/xz", "apt", "base/apt-index", "xz"],
      ["base/rsync", "apt", "base/apt-index", "rsync"],
    ]);
    expect(plan.map(t => t.label)).toEqual(["login shell PATH", "Node 22 with npm", "pnpm", "uv", "Python 3.12", "apt index", "git", "jq", "ripgrep", "curl", "Docker engine and compose", "C toolchain with cmake and ninja", "fd", "sqlite3", "wget", "zip and unzip", "xz", "rsync"]);
    expect(BASE_FLOOR.map(e => `base/${e.id}`)).toEqual(plan.filter(t => t.bin !== undefined).map(t => t.id));
  });

  it("writes the login shell's PATH before the floor, on every golden, so a thread's terminal finds what the stages install", () => {
    const step = baseInstalls().find(t => t.id === "base/login-path")!;
    expect(step.cmd).toContain(`printf '%s\\n' 'export PATH=${TOOLS_PATH} PNPM_HOME=/root/.local/share/pnpm' > /etc/profile.d/wsp-golden.sh`);
    expect(step.shown).toBe("the tools PATH in /etc/profile.d/wsp-golden.sh");
    // cargo comes by rustup on a golden with no Homebrew formula at all, and a login shell still finds it.
    expect(TOOLS_PATH).toContain("/root/.cargo/bin");
  });

  it("every step, the apt index included, names one line a person reads for what it runs, so the Build screen's step row is one row", () => {
    for (const t of baseInstalls()) {
      expect(t.shown, t.id).toBeDefined();
      expect(t.shown, t.id).not.toContain("\n");
    }
    const shown = (id: string) => baseInstalls().find(t => t.id === id)!.shown;
    expect(shown("base/apt-index")).toBe("apt-get update");
    expect(shown("base/git")).toBe("apt-get install git");
    expect(shown("base/uv")).toMatch(/^if ! command -v uv >\/dev\/null 2>&1; then; .*; fi$/);
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
    const docker = cmd("base/docker");
    expect(docker).toContain("\nexport DEBIAN_FRONTEND=noninteractive\napt-get install -y -qq docker.io\n");
    expect(docker).toContain('curl -o /tmp/docker-compose "https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-linux-$arch"');
    expect(docker).toContain('echo "$sha  /tmp/docker-compose" | sha256sum -c - >/dev/null');
    expect(docker).toMatch(/\ninstall -D -m 0755 \/tmp\/docker-compose \/usr\/libexec\/docker\/cli-plugins\/docker-compose\nrm -f \/tmp\/docker-compose$/);
  });
});

describe("a download that fails", () => {
  it("every base step that downloads runs under the one curl function, which fails loud on an HTTP error, and types no flags of its own", () => {
    const downloads = baseInstalls().filter(t => /\bcurl +-/.test(t.cmd));
    expect(downloads.map(t => t.id)).toEqual(["base/node", "base/uv", "base/python", "base/docker"]);
    for (const t of downloads) {
      const run = guardedRoad(t.manager, t.cmd);
      expect(run, t.id).toContain(CURL_NET);
      expect(CURL_NET).toContain("--fail --silent --show-error --location");
      expect(run.indexOf(CURL_NET), t.id).toBeLessThan(run.indexOf("curl -o"));
      expect(t.cmd, t.id).not.toMatch(/\bcurl +-[A-Za-z]*[fsSL]\b/);
    }
  });

  it("leaves curl's own error as the step's reason: the uv script under bash, with a curl on PATH that fails the way a 404 does", () => {
    // uname answers x86_64 so the script reaches its download on this Mac; the curl stand-in fails as curl 7.88 does on a 404.
    const dir = mkdtempSync(join(tmpdir(), "wsp-base-curl-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "uname"), "#!/bin/sh\necho x86_64\n", { mode: 0o755 });
    writeFileSync(join(dir, "curl"), '#!/bin/sh\necho "curl: (22) The requested URL returned error: 404" >&2\nexit 22\n', { mode: 0o755 });
    const script = [PRELUDE, ...ROAD_STEPS.script.env, UV_INSTALL].join("\n");
    const res = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin` } });
    expect(res.status).toBe(22);
    expect(reasonOf({ exitCode: res.status ?? -1, stdout: res.stdout, stderr: res.stderr }, roadLimitS("script"))).toBe("curl: (22) The requested URL returned error: 404");
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
    expect(BASE_VERSIONS_CMD.split("\n").filter(l => l.startsWith("echo \"VERSION"))).toHaveLength(21);
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
    expect(line).toBe("node 22.23.2 (250.0 MB), npm 10.9.4, pnpm 11.9.0 (30.0 MB), uv 0.12.9 (42.0 MB), python3 3.12.13 (70.0 MB), git 2.43.0, jq 1.7.1 (2.0 MB), rg 14.1.0 (6.0 MB), curl 8.5.0; Docker engine and compose failed (E: Unable to locate package docker-compose-v2)");
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
    expect(stages[0]).toBe("deploying-daemon:login shell PATH (1/18)");
    expect(stages).toContain("deploying-daemon:Node 22 with npm (2/18)");
    expect(stages).toContain("deploying-daemon:Docker engine and compose (11/18)");
    expect(stages).toContain("deploying-daemon:rsync (18/18)");
    expect(stages.every(s => s.startsWith("deploying-daemon"))).toBe(true);
    expect(out.tools.map(t => [t.id, t.outcome, t.bytes])).toEqual([
      ["base/login-path", "installed", 0],
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
      ["base/build-essential", "installed", 0],
      ["base/fd", "installed", 0],
      ["base/sqlite3", "installed", 0],
      ["base/wget", "installed", 0],
      ["base/zip", "installed", 0],
      ["base/xz", "installed", 0],
      ["base/rsync", "installed", 0],
    ]);
    expect(out.line).toBe("node 22.23.2 (250.0 MB), npm 10.9.4, pnpm 11.9.0, uv 0.12.9, python3 3.12.13, git 2.43.0, jq 1.7.1, rg 14.1.0, curl 8.5.0, docker 27.5.1 (400.0 MB), docker compose 2.29.2");
    expect(g.cmds.filter(c => c.includes("VERSION node:"))).toHaveLength(1);
    expect(g.ran).toHaveLength(19);
  });

  it("reads df once between installs, and sizes an install after the rescue from the reading the cleanup left", async () => {
    let free = 1800;
    const g = guest(script => {
      if (script.includes("rm -rf /root/.npm")) {
        free = 3000;
        return ok;
      }
      if (script.includes("nodejs.org/dist")) {
        free -= 250;
        return { exitCode: 0, stdout: "NODE_INSTALLED v22.23.2\n", stderr: "" };
      }
      return undefined;
    }, () => mb(free));
    const { stages, stage } = recorder();
    const out = await installBase(g.machine, stage);
    expect(stages[0]).toBe("deploying-daemon:1.8 GB free, under the 2.0 GB floor; cleaning up before skipping");
    expect(out.tools.map(t => [t.id, t.outcome, t.bytes])).toEqual([
      ["base/login-path", "installed", 0],
      ["base/node", "installed", 250 * 1024 * 1024],
      ["base/pnpm", "installed", 0],
      ["base/uv", "installed", 0],
      ["base/python", "installed", 0],
      ["base/apt-index", "installed", 0],
      ["base/git", "installed", 0],
      ["base/jq", "installed", 0],
      ["base/ripgrep", "installed", 0],
      ["base/curl", "installed", 0],
      ["base/docker", "installed", 0],
      ["base/build-essential", "installed", 0],
      ["base/fd", "installed", 0],
      ["base/sqlite3", "installed", 0],
      ["base/wget", "installed", 0],
      ["base/zip", "installed", 0],
      ["base/xz", "installed", 0],
      ["base/rsync", "installed", 0],
    ]);
    // One read before the loop; the rescue's sweep reads before and after itself and the loop reads once more after
    // it; one after each of the eighteen installs; the closing sweep and line read three more.
    expect(g.cmds.filter(c => c === FREE_KB_CMD)).toHaveLength(25);
  });

  it("a step that fails is named on the stage and in the line, and what waited on it is skipped by its name", async () => {
    const g = guest(script => (script.includes("apt-get update -qq") ? { exitCode: 100, stdout: "", stderr: "E: Could not get lock /var/lib/apt/lists/lock" } : script.includes("VERSION node:") ? { exitCode: 0, stdout: "VERSION node: v22.23.2\nVERSION npm: 10.9.4\nVERSION pnpm: 11.9.0\nVERSION uv: uv 0.12.9\nVERSION python3: Python 3.12.13\n", stderr: "" } : undefined));
    const { stages, stage } = recorder();
    const out = await installBase(g.machine, stage);
    expect(out.tools.map(t => [t.id, t.outcome, t.note])).toEqual([
      ["base/login-path", "installed", undefined],
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
      ["base/build-essential", "skipped", "apt index did not install"],
      ["base/fd", "skipped", "apt index did not install"],
      ["base/sqlite3", "skipped", "apt index did not install"],
      ["base/wget", "skipped", "apt index did not install"],
      ["base/zip", "skipped", "apt index did not install"],
      ["base/xz", "skipped", "apt index did not install"],
      ["base/rsync", "skipped", "apt index did not install"],
    ]);
    expect(out.line).toBe("node 22.23.2, npm 10.9.4, pnpm 11.9.0, uv 0.12.9, python3 3.12.13; git skipped (apt index did not install); jq skipped (apt index did not install); ripgrep skipped (apt index did not install); curl skipped (apt index did not install); Docker engine and compose skipped (apt index did not install); C toolchain with cmake and ninja skipped (apt index did not install); fd skipped (apt index did not install); sqlite3 skipped (apt index did not install); wget skipped (apt index did not install); zip and unzip skipped (apt index did not install); xz skipped (apt index did not install); rsync skipped (apt index did not install)");
    expect(stages).toContain("deploying-daemon:5 installed, 1 failed: apt index (E: Could not get lock /var/lib/apt/lists/lock), 12 skipped: git, jq, ripgrep, curl, Docker engine and compose, C toolchain with cmake and ninja, fd, sqlite3, wget, zip and unzip, xz, rsync (apt index did not install); caches swept; 2.9 GB free");
  });

  it("a floor step that fails is recorded by the last line its installer wrote, not a generic one", async () => {
    const g = guest(script => (script.includes("apt-get install -y -qq docker.io") ? { exitCode: 100, stdout: "Reading package lists...\n", stderr: "E: Unable to locate package docker.io\n" } : script.includes("VERSION node:") ? { exitCode: 0, stdout: "VERSION node: v22.23.2\n", stderr: "" } : undefined));
    const out = await installBase(g.machine, () => {});
    expect(out.tools.find(t => t.id === "base/docker")).toMatchObject({ outcome: "failed", note: "E: Unable to locate package docker.io" });
    expect(out.line).toBe("node 22.23.2; Docker engine and compose failed (E: Unable to locate package docker.io)");
  });

  it("an install that exits 0 without its command on PATH is a failure, not a version", async () => {
    const g = guest(script => (script.includes("for b in") && script.includes("command -v") ? { exitCode: 0, stdout: "missing docker\n", stderr: "" } : script.includes("VERSION node:") ? { exitCode: 0, stdout: "VERSION node: v22.23.2\n", stderr: "" } : undefined));
    const out = await installBase(g.machine, () => {});
    expect(out.tools.find(t => t.id === "base/docker")).toMatchObject({ outcome: "failed", note: "docker is not on PATH after the install" });
    expect(out.line).toBe("node 22.23.2; Docker engine and compose failed (docker is not on PATH after the install)");
  });
});
