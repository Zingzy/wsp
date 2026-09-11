// SPDX-License-Identifier: AGPL-3.0-only
// The version in the hello is the only thing that tells a host a machine's
// daemon is behind, so content that changes under an unchanged version reaches
// no machine already running. This hashes what a deploy installs and holds it
// against the last sha in the protocol's DAEMON_CONTENTS. Sources, not the
// built bundle: dist carries the version constant itself, so a sha of it would
// move again the moment it was recorded, and it would need a build to say
// anything at all.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_CONTENT_SHA, DAEMON_ROOTS_PATH, DAEMON_VERSION, workScoreLine } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CLOUD_PLACE, deployScript, openShimScript, startMjs } from "../src/doctor.js";

const DAEMON_PKG = fileURLToPath(new URL("../../daemon/", import.meta.url));
// A fixed hex token: the deploy writes the token it is given, and which one cannot be what moves the sha.
const TOKEN = "aabbcc";
// The suffixed script carries every line the bare one has and two of its own.
const SUFFIX = ".preview.example.com";

function srcRelPaths(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? srcRelPaths(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}

/** What a deploy leaves on a guest and this can hash: the daemon's sources, which its dist is built from; the
 * dependency pins the bundle's package.json copies out of the daemon's, which the guest's npm install reads; the
 * scripts the host writes beside them, whose content outlives the deploy that wrote it; and DAEMON_ROOTS_PATH and
 * the work-score line, which the daemon reads from the protocol and its dist bundles in. Left out, and on the guest anyway inside that
 * same bundle: the rest of the protocol, the DaemonAuthRequest schema the daemon reads, and zod. Hashing the
 * protocol whole would make every edit to it a redeploy of every machine, so those change under an unchanged
 * version and only the op set the version stands for holds them. */
function daemonContentSha(daemonPkgDir: string, scripts: string[]): string {
  const h = createHash("sha256");
  const src = join(daemonPkgDir, "src");
  for (const rel of srcRelPaths(src)) h.update(`${rel}\n${readFileSync(join(src, rel), "utf8")}\n`);
  const pkg = JSON.parse(readFileSync(join(daemonPkgDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  h.update(`${JSON.stringify(pkg.dependencies)}\n`);
  h.update(`${DAEMON_ROOTS_PATH}\n`);
  h.update(`${workScoreLine()}\n`);
  for (const s of scripts) h.update(`${s}\n`);
  return h.digest("hex");
}

// A fork's place, which is what a golden is built under: the sha pins what lands on a guest, and a
// machine somebody owns carries its own place and no golden.
const deployedScripts = (): string[] => [startMjs(CLOUD_PLACE), openShimScript(CLOUD_PLACE), deployScript(CLOUD_PLACE, TOKEN, SUFFIX)];

describe("the daemon version names the content the host deploys", () => {
  it("holds the recorded sha, so a changed daemon cannot ship under a version no machine reads as behind", () => {
    const sha = daemonContentSha(DAEMON_PKG, deployedScripts());
    expect(
      sha,
      `what a deploy installs on a guest changed. Append ${sha} to DAEMON_CONTENTS in packages/protocol/src/index.ts, which cuts the next DAEMON_VERSION; leave it at v${DAEMON_VERSION} and every machine already running keeps the daemon it has`,
    ).toBe(DAEMON_CONTENT_SHA);
    // The version is the count of recorded contents, so the current one is a sha and not a placeholder.
    expect(DAEMON_CONTENT_SHA).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("what the recorded sha covers", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function copyOfDaemonPkg(): string {
    dir = mkdtempSync(join(tmpdir(), "wsp-daemon-content-"));
    cpSync(join(DAEMON_PKG, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(DAEMON_PKG, "package.json"), join(dir, "package.json"));
    return dir;
  }

  it("moves when a daemon source moves, when one is added, and when a dependency pin moves", () => {
    const pkgDir = copyOfDaemonPkg();
    // A copy hashes as the original does: the walk reads relative paths, so where the package sits cannot move it.
    const base = daemonContentSha(pkgDir, deployedScripts());
    expect(base).toBe(daemonContentSha(DAEMON_PKG, deployedScripts()));

    const main = join(pkgDir, "src", "main.ts");
    const body = readFileSync(main, "utf8");
    writeFileSync(main, `${body}\nexport const added = 1;\n`);
    expect(daemonContentSha(pkgDir, deployedScripts())).not.toBe(base);
    writeFileSync(main, body);

    writeFileSync(join(pkgDir, "src", "new-op.ts"), "export const op = 1;\n");
    expect(daemonContentSha(pkgDir, deployedScripts())).not.toBe(base);
    rmSync(join(pkgDir, "src", "new-op.ts"));

    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies["ws"] = "^9.0.0";
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg));
    expect(daemonContentSha(pkgDir, deployedScripts())).not.toBe(base);
  });

  it("moves when any script the deploy writes moves, one at a time", () => {
    const scripts = deployedScripts();
    const base = daemonContentSha(DAEMON_PKG, scripts);
    expect(scripts).toHaveLength(3);
    for (let i = 0; i < scripts.length; i++) {
      const changed = scripts.map((s, j) => (i === j ? `${s}\necho changed\n` : s));
      expect(daemonContentSha(DAEMON_PKG, changed)).not.toBe(base);
    }
  });
});
