// SPDX-License-Identifier: AGPL-3.0-only
// What a project folder's own files say it needs: the readers one by one, the
// names they land on in the catalog, the candidates the catalog has no row
// for, and the line each row shows.
import { describe, expect, it } from "vitest";
import { PROJECT_READERS, scanProject } from "../src/project/index.js";
import { fakeHost } from "./fake-host.js";

const PROJ = "/Users/dev/proj";
const project = (files: Record<string, string>) => fakeHost({ files: Object.fromEntries(Object.entries(files).map(([k, v]) => [`${PROJ}/${k}`, v])) });
const why = (scan: Awaited<ReturnType<typeof scanProject>>) => Object.fromEntries(scan.rows.map(n => [n.id, n.why]));

describe("scanProject", () => {
  it("a repo with a compose file, a pnpm lock and a go.mod ticks docker, pnpm and go, each saying which file asked", async () => {
    const scan = await scanProject(project({ "compose.yaml": "services:\n  db:\n    image: postgres\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "go.mod": "module example.com/x\n\ngo 1.24\n" }), PROJ);
    expect(scan.rows).toEqual([
      { id: "pnpm", name: "pnpm", why: "pnpm-lock.yaml needs pnpm" },
      { id: "go", name: "Go", why: "go.mod needs Go" },
      { id: "docker", name: "Docker engine and compose", why: "compose.yaml needs Docker" },
    ]);
    expect(scan.candidates).toEqual([]);
    expect(scan.dir).toBe(PROJ);
  });

  it("package.json: the manager it pins, every runtime its engines field accepts, and the catalog's own tools its scripts run", async () => {
    const scan = await scanProject(project({ "package.json": JSON.stringify({ packageManager: "pnpm@10.1.0", engines: { node: ">=22" }, scripts: { build: "tsup src/index.ts", deploy: "pnpm build && wrangler deploy", ci: "docker compose up -d" } }) }), PROJ);
    expect(why(scan)).toEqual({ pnpm: "packageManager pnpm@10.1.0", node: "engines.node >=22", wrangler: "package.json scripts run wrangler", docker: "package.json scripts run docker" });
    // A script's first word names a devDependency as often as a machine tool: tsup is not a candidate for a row of its own.
    expect(scan.candidates).toEqual([]);
  });

  it("the toolchain pins name a tool and its version, in asdf's syntax and in mise's", async () => {
    const asdf = await scanProject(project({ ".tool-versions": "# pinned\nnodejs 22.1.0\ngolang 1.24.0\n\nruby 3.3.5\n" }), PROJ);
    expect(why(asdf)).toEqual({ node: ".tool-versions names nodejs 22.1.0", go: ".tool-versions names golang 1.24.0" });
    expect(asdf.candidates).toEqual([{ id: "ruby", name: "ruby", why: ".tool-versions names ruby 3.3.5" }]);
    const mise = await scanProject(project({ "mise.toml": '[tools]\ngo = "1.24"\npython = ["3.12"]\n\n[env]\nGOFLAGS = "-mod=mod"\n' }), PROJ);
    expect(why(mise)).toEqual({ go: "mise.toml names go 1.24", python: "mise.toml names python 3.12" });
  });

  it("a workflow's setup actions and the tools its run steps call, inline and in a block", async () => {
    const yml = ["jobs:", "  build:", "    steps:", "      - uses: actions/setup-go@v5", "      - uses: pnpm/action-setup@v4", "      - run: go build ./...", "      - run: |", "          docker compose up -d", "          npm ci", "      - name: after", "        run: echo done"].join("\n");
    const scan = await scanProject(project({ ".github/workflows/ci.yml": yml }), PROJ);
    expect(why(scan)).toEqual({
      go: ".github/workflows/ci.yml sets up go",
      pnpm: ".github/workflows/ci.yml sets up pnpm",
      docker: ".github/workflows/ci.yml runs docker",
      node: ".github/workflows/ci.yml runs npm",
    });
  });

  it("an action named after its owner is that owner's tool, not a candidate for the action's own name", async () => {
    const yml = ["jobs:", "  build:", "    steps:", "      - uses: docker/setup-buildx-action@v3", "      - uses: docker/setup-qemu-action@v3", "      - uses: actions/setup-dotnet@v4"].join("\n");
    const scan = await scanProject(project({ ".github/workflows/ci.yml": yml }), PROJ);
    expect(why(scan)).toEqual({ docker: ".github/workflows/ci.yml sets up docker" });
    // A setup action nobody's catalog carries is still a real ask, under the toolchain it names.
    expect(scan.candidates).toEqual([{ id: "dotnet", name: "dotnet", why: ".github/workflows/ci.yml sets up dotnet" }]);
  });

  it("an engines key the catalog has no row for is not a custom row candidate: engines names a runtime, not something to install", async () => {
    const scan = await scanProject(project({ "package.json": JSON.stringify({ engines: { node: ">=22", vscode: "^1.80.0" } }) }), PROJ);
    expect(why(scan)).toEqual({ node: "engines.node >=22" });
    expect(scan.candidates).toEqual([]);
  });

  it("corepack's integrity suffix stays out of the line the row shows", async () => {
    const spec = `pnpm@10.15.0+sha512.${"1234567890".repeat(8)}abcdefgh`;
    const scan = await scanProject(project({ "package.json": JSON.stringify({ packageManager: spec }) }), PROJ);
    expect(why(scan)).toEqual({ pnpm: "packageManager pnpm@10.15.0" });
  });

  it("a candidate takes its ecosystem's own spelling, whichever file named it first", async () => {
    const scan = await scanProject(project({ ".tool-versions": "ruby 3.3.5\n", Gemfile: 'source "https://rubygems.org"\n' }), PROJ);
    expect(scan.candidates).toEqual([{ id: "ruby", name: "Ruby", why: ".tool-versions names ruby 3.3.5" }]);
  });

  it("a marker is read for its presence alone: a lockfile of megabytes, or bytes that are not text, is never opened", async () => {
    const host = project({ "package-lock.json": "{}", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    const scan = await scanProject(host, PROJ);
    expect(scan.rows.map(n => n.id)).toEqual(["pnpm", "node"]);
    expect(host.calls.filter(c => c.includes("lock"))).toEqual([]);
  });

  it("a manifest the catalog has no row for is a candidate, not a row, and the first file to name a tool writes its line", async () => {
    const scan = await scanProject(project({ Gemfile: 'source "https://rubygems.org"\n', "composer.json": "{}", "package.json": JSON.stringify({ packageManager: "pnpm@10.1.0" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }), PROJ);
    expect(why(scan)).toEqual({ pnpm: "packageManager pnpm@10.1.0" });
    expect(scan.candidates).toEqual([
      { id: "ruby", name: "Ruby", why: "Gemfile needs Ruby" },
      { id: "php", name: "PHP", why: "composer.json needs PHP" },
    ]);
  });

  it("a folder with nothing to read, and one that is not there at all, ask for nothing", async () => {
    expect(await scanProject(project({ "README.md": "# x" }), PROJ)).toEqual({ dir: PROJ, rows: [], candidates: [] });
    expect(await scanProject(project({}), `${PROJ}/`)).toEqual({ dir: PROJ, rows: [], candidates: [] });
  });

  it("every reader is registered once and names the files it reads", () => {
    expect(PROJECT_READERS.map(r => r.id)).toEqual(["package-json", "toolchain-pins", "marker", "workflows"]);
    expect(new Set(PROJECT_READERS.map(r => r.id)).size).toBe(PROJECT_READERS.length);
    for (const reader of PROJECT_READERS) expect(reader.files.length).toBeGreaterThan(0);
  });
});
