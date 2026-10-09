// SPDX-License-Identifier: AGPL-3.0-only
// What every workflow in this repository is held to, whatever it runs: each action pinned to a commit sha, each job
// holding the grant its own steps use and no other, each cargo line taking the lockfile as it stands, and each
// runner image and toolchain named at a version nothing moves under a run.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...path: string[]): string => readFileSync(join(repo, ...path), "utf8");
/** Every workflow the folder carries and every action of this repository's own they run, so a file added later is
 * held to the rules below without an edit here. `folder` is the directory Dependabot is pointed at to find it. */
const workflows = [
  ...readdirSync(join(repo, ".github", "workflows"))
    .filter(name => /\.ya?ml$/.test(name))
    .map(name => ({ name, folder: "/", text: read(".github", "workflows", name) })),
  ...readdirSync(join(repo, ".github", "actions")).map(name => ({ name: `${name}/action.yml`, folder: `/.github/actions/${name}`, text: read(".github", "actions", name, "action.yml") })),
].sort((a, b) => a.name.localeCompare(b.name));
/** A `uses:` line the run time cannot move: a full commit sha, and the version it was resolved from beside it, which
 * is what the update service rewrites as a pair, or an action of this repository's own, read from the same commit. */
const PINNED = /^ *- uses: (?:[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+|\.\/\.github\/actions\/[\w-]+)$/;
/** What each release job may hold, and nothing else: no job holds the identity token npm trusts beside a write. */
const RELEASE_GRANTS: Record<string, Record<string, string>> = {
  daemon: {},
  draft: { contents: "write" },
  mac: { contents: "write" },
  linux: { contents: "write" },
  npm: { contents: "read", "id-token": "write" },
  publish: { contents: "write" },
};

/** Each job of a workflow by name, as its own two-space key and every line under it, so a block read here is that
 * job's and never the next one's. */
function jobs(workflow: string): Record<string, string> {
  const at = workflow.indexOf("\njobs:\n");
  const body = workflow.slice(at + "\njobs:\n".length);
  const keys = [...body.matchAll(/^ {2}([\w-]+):$/gm)];
  return Object.fromEntries(keys.map((key, i) => [key[1], body.slice(key.index, keys[i + 1]?.index)]));
}

/** The grants a permissions block names, read off the lines indented under it; an empty table where there is none. */
function grants(block: string, indent: string): Record<string, string> {
  const found = new RegExp(`^${indent}permissions:\\n((?:${indent}  .*\\n)+)`, "m").exec(block);
  if (found === null) return {};
  return Object.fromEntries(found[1]!.trim().split("\n").map(line => line.trim().split(": ") as [string, string]));
}

describe("every workflow's actions, grants, cargo lines and images", () => {
  it("reads every workflow the folder carries, so a file added later meets these rules unnamed", () => {
    expect(workflows.map(w => w.name)).toContain("release.yml");
    expect(workflows.length).toBeGreaterThanOrEqual(3);
  });

  it("pins every action to a commit sha with the version beside it, and names what moves them", () => {
    const uses = workflows.flatMap(({ name, text }) => text.split("\n").filter(line => line.includes("uses:")).map(line => ({ name, line })));
    expect(uses.length).toBeGreaterThan(0);
    for (const { name, line } of uses) expect(line, `${name}: ${line}`).toMatch(PINNED);
    const dependabot = read(".github", "dependabot.yml");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot).toContain("interval: weekly");
    const scanned = [...(/^ {4}directories:\n((?: {6}- .*\n)+)/m.exec(dependabot)?.[1] ?? "").matchAll(/- "([^"]+)"/g)].map(m => m[1]!);
    for (const { name, folder } of new Map(uses.map(({ name }) => [name, workflows.find(w => w.name === name)!])).values()) {
      expect(touches(scanned, folder), `${name}: Dependabot scans no folder matching ${folder}`).toBe(true);
    }
  });

  it("starts every job at contents read and grants each release job the one thing its steps use", () => {
    const release = workflows.find(w => w.name === "release.yml")!.text;
    expect(grants(release, "")).toEqual({ contents: "read" });
    const perJob = jobs(release);
    expect(Object.keys(perJob)).toEqual(Object.keys(RELEASE_GRANTS));
    for (const [name, expected] of Object.entries(RELEASE_GRANTS)) {
      expect(grants(perJob[name]!, "    "), name).toEqual(expected);
    }
  });

  it("lets no job hold the identity token beside a write on the repository", () => {
    for (const { name, text } of workflows) {
      expect(grants(text, "")["id-token"], name).toBeUndefined();
      for (const [job, block] of Object.entries(jobs(text))) {
        const held = grants(block, "    ");
        if (held["id-token"] === undefined) continue;
        const writes = Object.entries(held).filter(([grant, level]) => grant !== "id-token" && level === "write");
        expect(writes, `${name}: ${job}`).toEqual([]);
      }
    }
  });

  it("takes the lockfile as it stands on every cargo line that resolves one", () => {
    const lines = workflows.flatMap(({ name, text }) => text.split("\n").filter(line => /\bcargo (build|test|clippy)\b/.test(line)).map(line => ({ name, line })));
    expect(lines.length).toBeGreaterThan(0);
    for (const { name, line } of lines) expect(line, `${name}: ${line}`).toContain("--locked");
  });

  it("names a runner image, since a moving one is a different machine each run", () => {
    for (const { name, text } of workflows) {
      for (const line of text.split("\n").filter(line => /(runs-on|os):/.test(line))) {
        expect(line, `${name}: ${line}`).not.toContain("-latest");
      }
    }
  });

  it("names the rust toolchain down to its patch, which the runs above install from the file", () => {
    expect(read("daemon", "rust-toolchain.toml")).toMatch(/^channel = "\d+\.\d+\.\d+"$/m);
  });
});

/** Whether a changed file matches one of a push trigger's path globs, as GitHub reads them: `**` crosses folders and
 * `*` stays inside one. */
const touches = (globs: readonly string[], file: string): boolean =>
  globs.some(glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`).test(file));

describe("the flows run", () => {
  const flows = read(".github", "workflows", "flows.yml");
  const push = flows.slice(flows.indexOf("\n  push:\n"), flows.indexOf("\n  workflow_dispatch:"));
  const listed = (key: string): string[] => [...(new RegExp(`^ {4}${key}:\\n((?: {6}- .*\\n)+)`, "m").exec(`${push}\n`)?.[1] ?? "").matchAll(/- "([^"]+)"/g)].map(m => m[1]!);

  it("runs on every land/** push that changes the app, its shell, the runtime or the host, and on no other", () => {
    expect(listed("branches")).toEqual(["land/**"]);
    const paths = listed("paths");
    for (const file of ["apps/web/src/App.tsx", "apps/desktop/src/main.ts", "packages/runtime/src/runtime.ts", "packages/host/src/verbs.ts", ".github/workflows/flows.yml"]) expect(touches(paths, file), file).toBe(true);
    for (const file of ["apps/www/src/index.ts", "daemon/src/main.rs", "packages/engine/src/index.ts", "README.md"]) expect(touches(paths, file), file).toBe(false);
  });

  it("walks the flows file in the packaged Linux app under a screen, and the Mac smoke walks it every night", () => {
    expect(flows).toContain("--linux dir");
    expect(flows).toContain("xvfb-run --auto-servernum pnpm --filter @wsp/desktop flows");
    const scripts = (JSON.parse(read("apps", "desktop", "package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["flows"]).toContain("WSP_DESKTOP_FLOWS=1");
    expect(scripts["flows"]).toContain("apps/desktop/test/flows.electron.test.ts");
    expect(read(".github", "workflows", "desktop-smoke.yml")).toContain("pnpm --filter @wsp/desktop flows");
  });

  it("runs the Mac smoke on a land/** push that changes the smoke, the flows or any helper of theirs beside them", () => {
    const smoke = read(".github", "workflows", "desktop-smoke.yml");
    const paths = [...(/^ {4}paths:\n((?: {6}- .*\n)+)/m.exec(smoke)?.[1] ?? "").matchAll(/- "([^"]+)"/g)].map(m => m[1]!);
    const helpers = (file: string): string[] => [...read("apps", "desktop", "test", file).matchAll(/from "\.\/([\w-]+)\.js"/g)].map(m => `${m[1]!}.ts`);
    const seen = new Set<string>();
    for (let next = ["smoke.electron.test.ts", "flows.electron.test.ts"]; next.length > 0; next = next.flatMap(helpers).filter(file => !seen.has(file))) for (const file of next) seen.add(file);
    for (const file of seen) expect(touches(paths, `apps/desktop/test/${file}`), file).toBe(true);
  });
});
