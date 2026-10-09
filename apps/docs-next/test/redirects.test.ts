// SPDX-License-Identifier: AGPL-3.0-only
// A link to the old docs lands on a page of the new tree: its new home, or the docs home for a page that was cut.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pagePaths } from "./tree.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OLD_CONFIG = join(ROOT, "../docs/scalar.config.json");

/** The 28 pages the old docs published (wsp-map#1920 part 2, section 2). */
const OLD = [
  "/", "/start/install", "/start/first-workspace", "/start/the-model",
  "/setup/init", "/setup/recipes", "/setup/sign-ins", "/setup/keys", "/setup/the-host", "/setup/reach-your-box",
  "/work/workspaces", "/work/threads", "/work/the-app", "/work/import-export", "/work/costs",
  "/agents/inside", "/agents/mcp", "/agents/driving", "/agents/building",
  "/reference/cli", "/reference/contract", "/reference/providers", "/reference/reach", "/reference/configuration", "/reference/troubleshooting",
  "/project/contributing", "/project/releases", "/project/license",
];

const pages = pagePaths(join(ROOT, "scalar.config.json"));
const config = JSON.parse(readFileSync(join(ROOT, "scalar.config.json"), "utf8"));
const redirects: { from: string; to: string }[] = config.siteConfig.routing.redirects;

describe("redirects from the old docs", () => {
  it("cover the old navigation's 28 pages", () => {
    expect(OLD).toHaveLength(28);
    expect([...pagePaths(OLD_CONFIG).keys()].sort()).toEqual([...OLD].sort());
  });

  it("land each old path on a page of the new tree", () => {
    const landing = (path: string): string | undefined => (pages.has(path) ? path : redirects.find(r => r.from === path)?.to);
    expect(OLD.filter(path => landing(path) === undefined || !pages.has(landing(path)!))).toEqual([]);
  });

  it("never start at a page the new tree serves, and start at each path once", () => {
    expect(redirects.filter(r => pages.has(r.from))).toEqual([]);
    expect(new Set(redirects.map(r => r.from)).size).toBe(redirects.length);
  });
});

describe("the tree", () => {
  it("names a stub for every page and a page for every stub", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : [relative(ROOT, join(dir, e.name))]));
    const named = [...pages.values()];
    expect(named.filter(file => !existsSync(join(ROOT, file)))).toEqual([]);
    expect(files(join(ROOT, "content")).filter(file => !named.includes(file))).toEqual([]);
  });
});
