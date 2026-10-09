// SPDX-License-Identifier: AGPL-3.0-only
// The writing rules every page is held to: unslop's words, Simple English's modals in a page of steps, no em dash,
// and every picture a scene the shooter makes.
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pagePaths } from "./tree.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** unslop's banned words and phrases, copied from its SKILL.md; "seamless" is the ticket's own. A verb is listed by its
 * stem, so its -ing and -ion forms are caught too ("leverag" catches leveraging). Left out on purpose: "underscore",
 * since these pages name the `_` character by it; "features", the title of a group of pages; "harness" and "surface",
 * words of the code these pages document. */
const BANNED = [
  "pivotal moment", "testament to", "evolving landscape", "setting the stage for", "indelible mark", "deeply rooted",
  "nestled", "vibrant", "breathtaking", "groundbreaking", "renowned", "stunning", "must-visit",
  "additionally", "crucial", "delv", "enduring", "enhanc", "foster", "garner", "interplay", "intricate",
  "landscape", "pivotal", "showcas", "tapestry", "testament",
  "serves as", "stands as", "boasts",
  "I hope this helps", "let me know if", "certainly",
  "in order to", "due to the fact that", "it is important to note",
  "substrate", "wedge", "vector", "locus", "vantage", "nexus", "bedrock", "paradigm", "modality", "gold-plating",
  "evacuat", "endgame", "north star", "flywheel",
  "utiliz", "leverag", "facilitat", "numerous", "in the event that",
  "highlighting", "ensur", "reflecting", "experts believe", "industry reports suggest", "some critics argue",
  "despite challenges", "of course", "great question", "absolutely right", "while specific details are limited",
  "the future looks bright", "primitive", "scaffolding", "ratchet",
  "seamless",
];

const MODALS = ["should", "would", "may", "might", "could"];

/** The folders whose pages are steps to follow, where Simple English allows no modal. */
const PROCEDURAL = ["content/install/", "content/start/", "content/guides/"];

type Scene = { name: string; pages: string[]; steps?: boolean };
const SCENES: Scene[] = JSON.parse(readFileSync(join(ROOT, "shots.json"), "utf8")).scenes;

const pages = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? pages(join(dir, e.name)) : /\.mdx?$/.test(e.name) ? [join(dir, e.name)] : []));

const prose = (text: string): string => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

const isScene = (src: string): boolean => {
  const stem = basename(src, extname(src));
  return SCENES.some(s => stem === s.name || (s.steps === true && stem.startsWith(`${s.name}-`)));
};

/** Every rule a page at that path breaks, one line each. */
function problems(path: string, text: string): string[] {
  const found: string[] = [];
  if (text.includes("\u2014")) found.push(`${path}: an em dash`);
  const words = prose(text);
  for (const word of BANNED) if (new RegExp(`\\b${word}`, "i").test(words)) found.push(`${path}: "${word}"`);
  if (PROCEDURAL.some(dir => path.startsWith(dir)))
    for (const modal of MODALS) if (new RegExp(`\\b${modal}\\b`, "i").test(words)) found.push(`${path}: "${modal}" in a page of steps`);
  const pictures = [
    ...[...text.matchAll(/<(?:Image|img|video|source)\b[^>]*?\bsrc=\{?\s*["']([^"']+)["']/g)].map(m => m[1]!),
    ...[...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map(m => m[1]!),
  ];
  for (const src of pictures) if (!isScene(src)) found.push(`${path}: ${src} names no scene in shots.json`);
  return found;
}

describe("the prose checker", () => {
  it("passes every page", () => {
    const all = pages(join(ROOT, "content"));
    expect(all.length).toBeGreaterThan(140);
    expect(all.flatMap(p => problems(relative(ROOT, p), readFileSync(p, "utf8")))).toEqual([]);
  });

  it("fails a page holding an em dash", () => {
    expect(problems("content/features/threads.mdx", "# Threads\n\nA thread \u2014 one conversation.\n")).toEqual(["content/features/threads.mdx: an em dash"]);
  });

  it("fails a page holding a banned word, in any case, but not inside code", () => {
    expect(problems("content/features/threads.mdx", "Threads move seamlessly.\n")).toEqual(['content/features/threads.mdx: "seamless"']);
    expect(problems("content/features/threads.mdx", "Additionally, it runs.\n")).toEqual(['content/features/threads.mdx: "additionally"']);
    expect(problems("content/features/threads.mdx", "Run `leverage --now` and\n\n```sh\nseamless\n```\n")).toEqual([]);
    expect(problems("content/install/linux.mdx", "It installs by leveraging the script and utilizing npm.\n")).toEqual(['content/install/linux.mdx: "utiliz"', 'content/install/linux.mdx: "leverag"']);
  });

  it("fails a modal in a page of steps and leaves it to every other page", () => {
    expect(problems("content/install/mac.mdx", "You should see the app.\n")).toEqual(['content/install/mac.mdx: "should" in a page of steps']);
    expect(problems("content/guides/own-relay.mdx", "It may ask for a zone.\n")).toEqual(['content/guides/own-relay.mdx: "may" in a page of steps']);
    expect(problems("content/features/threads.mdx", "A thread may run for hours.\n")).toEqual([]);
  });

  it("fails a picture or a recording that names no scene", () => {
    expect(problems("content/features/threads.mdx", '<Image src="/shots/docs-composer.png" />\n<video src="/shots/docs-queue.mp4" muted loop playsinline />\n')).toEqual([]);
    expect(problems("content/start/first-computer.mdx", '<Image src="/shots/wizard-00-where.png" />\n')).toEqual([]);
    expect(problems("content/features/threads.mdx", '<Image src="/shots/composer-old.png" />\n')).toEqual(["content/features/threads.mdx: /shots/composer-old.png names no scene in shots.json"]);
    expect(problems("content/features/threads.mdx", '<video muted src="/shots/queue.mp4" />\n')).toEqual(["content/features/threads.mdx: /shots/queue.mp4 names no scene in shots.json"]);
    expect(problems("content/features/threads.mdx", "![The composer](/shots/hero-two.png)\n")).toEqual(["content/features/threads.mdx: /shots/hero-two.png names no scene in shots.json"]);
    expect(problems("content/features/threads.mdx", '<Image src={"/shots/x.png"} />\n')).toEqual(["content/features/threads.mdx: /shots/x.png names no scene in shots.json"]);
    expect(problems("content/features/threads.mdx", '<img src="/shots/y.png" />\n')).toEqual(["content/features/threads.mdx: /shots/y.png names no scene in shots.json"]);
  });
});

describe("the shot list", () => {
  it("names each scene once, on pages the tree has", () => {
    const paths = pagePaths(join(ROOT, "scalar.config.json"));
    expect(new Set(SCENES.map(s => s.name)).size).toBe(SCENES.length);
    expect(SCENES.flatMap(s => s.pages).filter(p => !paths.has(p))).toEqual([]);
  });
});
