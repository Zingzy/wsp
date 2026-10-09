// SPDX-License-Identifier: AGPL-3.0-only
// The built site as a crawler reads it, with no JavaScript run: every route's own HTML and head, the structured data,
// and the sitemap, robots.txt and llms.txt the build writes from the same route table.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { act, screen } from "@testing-library/react";
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { DOWNLOADS, platformOf } from "../src/downloads";
import { DOCS, EMAIL, ORG, REPO, X } from "../src/links";
import { aheadOf, KINDS, ROWS, sources, TOOLS, WSP } from "../src/compare";
import { fileOf, ROUTES } from "../src/routes";
import { QUESTIONS } from "../src/sections/close";

const www = join(__dirname, "..");
let out = "";
const built = (file: string): string => readFileSync(join(out, file), "utf8");

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "www-build-"));
  execFileSync(process.execPath, ["scripts/build.mjs", out], { cwd: www, stdio: "pipe" });
}, 180_000);
afterAll(() => {
  if (out !== "") rmSync(out, { recursive: true, force: true });
});

const unescape = (text: string): string => text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const meta = (html: string, key: string): string | undefined => {
  const found = new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`).exec(html)?.[1];
  return found === undefined ? undefined : unescape(found);
};
const text = (html: string): string => unescape(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/<!-- -->/g, "")).replace(/\s+/g, " ");

describe("every route, as raw HTML", () => {
  for (const route of ROUTES) {
    it(`carries ${route.path}'s own head`, () => {
      const html = built(fileOf(route.path));
      const url = `https://usewsp.com${route.path}`;
      expect(html.match(/<title>([^<]*)<\/title>/g)).toEqual([`<title>${route.title}</title>`]);
      expect(meta(html, "description")).toBe(route.description);
      expect(html).toContain(`<link rel="canonical" href="${url}" />`);
      expect(meta(html, "og:title")).toBe(route.title);
      expect(meta(html, "og:description")).toBe(route.description);
      expect(meta(html, "og:url")).toBe(url);
      expect(meta(html, "og:image")).toBe(`https://usewsp.com${route.image.path}`);
      expect(meta(html, "twitter:card")).toBe("summary_large_image");
      expect(meta(html, "twitter:image")).toBe(`https://usewsp.com${route.image.path}`);
      expect(meta(html, "theme-color")).toBe("#121110");
      expect(meta(html, "robots")).toBe(route.index ? undefined : "noindex");
      expect(html).not.toContain("<!--head-->");
      expect(html).not.toContain("<!--app-->");
    });
  }

  it("keeps every title and description short enough for a search result", () => {
    for (const r of ROUTES) {
      expect(r.title.length, r.title).toBeLessThanOrEqual(60);
      expect(r.description.length, r.description).toBeLessThanOrEqual(155);
    }
  });

  it("gives no two routes the same title or description", () => {
    expect(new Set(ROUTES.map(r => r.title)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map(r => r.description)).size).toBe(ROUTES.length);
  });

  it("serves / with its headline, its section heads and the whole FAQ before any script runs", () => {
    const html = built("index.html");
    const body = text(html);
    expect(html).toMatch(/<h1[^>]*>Coding agents on every computer you own\.<\/h1>/);
    const heads = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map(m => m[1]);
    expect(heads).toEqual(["Your agents hand work to each other.", "Add a computer. Your setup comes with it.", "Other tools reach your other computers too.", "A mini app inside every thread.", "Everything around the thread.", "Questions", "Put your other computers to work."]);
    for (const { q, a } of QUESTIONS) {
      expect(body).toContain(q);
      expect(body).toContain(a);
    }
    expect(html).toContain(`href="${DOWNLOADS.mac.href}"`);
    expect(html).toMatch(/<a href="\/compare"[^>]*>Compare with Conductor/);
  });

  it("serves /compare as one card per tool, under its kind, each opening the tool's page", () => {
    const html = built(fileOf("/compare"));
    const body = text(html);
    expect(html).toMatch(/<h1[^>]*>Where wsp sits\.<\/h1>/);
    expect(body).toContain("The vendors run them on their own VM, from your repo, a setup script, and on Claude and Cursor some skills you turn on.");
    for (const kind of KINDS) expect(html).toMatch(new RegExp(`<h2[^>]*>${kind.name.replace(/'/g, "&#x27;")}</h2>`));
    for (const tool of TOOLS) {
      expect(html).toContain(`href="/compare/${tool.slug}"`);
      expect(body).toContain(tool.line);
    }
    expect(html.match(/<a href="\/compare\/[^"]+"/g)).toHaveLength(TOOLS.length);
    expect(body).not.toContain("\u2014");
  });

  for (const tool of TOOLS) {
    it(`serves /compare/${tool.slug} with the eight questions, wsp in the raised column, and no citation numbers in a cell`, () => {
      const html = built(fileOf(`/compare/${tool.slug}`));
      const body = text(html);
      expect(html).toMatch(new RegExp(`<h1[^>]*>wsp vs ${tool.name}</h1>`));
      expect(body).toContain(tool.differs);
      const table = /<table[\s\S]*<\/table>/.exec(html)![0];
      expect(table).not.toMatch(/<a |<sup/);
      const rows = [...table.matchAll(/<tr class="border-t[\s\S]*?<\/tr>/g)].map(m => m[0]);
      expect(rows).toHaveLength(ROWS.length);
      ROWS.forEach((r, i) => {
        const cells = [...rows[i]!.matchAll(/<td title="([^"]*)" class="([^"]*)">([\s\S]*?)<\/td>/g)];
        expect(unescape(/<th[^>]*>([^<]*)<\/th>/.exec(rows[i]!)![1]!)).toBe(r.label);
        expect(cells).toHaveLength(2);
        const [theirs, ours] = cells.map(m => ({ title: unescape(m[1]!), raised: m[2]!.includes("bg-raised"), text: text(m[3]!).trim(), mark: /aria-label="(yes|no)"/.exec(m[3]!)![1] }));
        for (const [seen, cell] of [[theirs!, tool.cells[r.key]], [ours!, WSP[r.key]]] as const) {
          expect(seen.text).toBe(cell.short);
          expect(seen.mark).toBe(cell.good ? "yes" : "no");
          expect(seen.title.split("\n")[0]).toBe(cell.says[0]);
          expect(seen.title.split("\n")).toHaveLength(cell.says.length);
        }
        expect([theirs!.raised, ours!.raised]).toEqual([false, true]);
      });
      expect(body).toContain(tool.well);
      expect(body).toContain(tool.fit);
      for (const a of aheadOf(tool)) expect(body).toContain(`${a.title} ${a.said[0]} ${a.wsp}`);
      expect(html).toMatch(/<details class="[^"]*">/);
      const details = /<details[\s\S]*<\/details>/.exec(html)![0];
      for (const url of sources(tool)) expect(details).toContain(`href="${url}"`);
      expect(body).not.toContain("\u2014");
      expect(body).not.toMatch(/\bAI\b/);
    });
  }

  it("says on / what /compare says about the other kinds", () => {
    const body = text(built("index.html"));
    expect(body).toContain("Your computer; most reach a second computer over ssh or a relay");
    expect(body).toContain("Your repo, a setup script, and on Claude and Cursor some skills you turn on");
    expect(body).toContain("The vendors bring your repo, a setup script, and on Claude and Cursor some skills you turn on. wsp brings your setup.");
    expect(body).not.toContain("some reach a box");
    expect(body).not.toContain("Your repo and a setup script");
    expect(KINDS[0]!.name).toBe("Apps on the computer you sit at");
    expect(body).toContain("Apps on the computer you sit at");
  });

  it("answers an unknown path's page with a way home, kept out of search", () => {
    const html = built("404.html");
    expect(text(html)).toContain("Nothing lives at this address.");
    expect(html).toMatch(/<a href="\/"[^>]*>Go to usewsp\.com/);
  });
});

type Thing = Record<string, unknown> & { "@type": string };

describe("structured data", () => {
  const graph = (): Thing[] => {
    const scripts = [...built("index.html").matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]!) as { "@graph"?: Thing[] } & Thing);
    return scripts.flatMap(s => s["@graph"] ?? [s]);
  };
  const of = (type: string): Thing => {
    const found = graph().find(t => t["@type"] === type);
    if (found === undefined) throw new Error(`no ${type} in the JSON-LD on /`);
    return found;
  };

  it("names the organisation, its logo and where else it lives", () => {
    expect(of("Organization")).toMatchObject({ name: "wsp labs", url: "https://usewsp.com/", logo: "https://usewsp.com/logo.png", email: EMAIL, sameAs: [ORG, X] });
    const logo = readFileSync(join(out, "logo.png"));
    expect([logo.readUInt32BE(16), logo.readUInt32BE(20)]).toEqual([512, 512]);
  });

  it("describes the app: free, AGPL, on macOS and Linux, with the release's own downloads", () => {
    expect(of("SoftwareApplication")).toMatchObject({
      name: "wsp",
      operatingSystem: "macOS, Linux",
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
      offers: { price: "0", priceCurrency: "USD" },
      downloadUrl: [DOWNLOADS.mac.href, DOWNLOADS.linux.href],
    });
  });

  it("describes the site, and keeps the FAQ the page shows", () => {
    expect(of("WebSite")).toMatchObject({ name: "wsp", url: "https://usewsp.com/" });
    expect((of("FAQPage").mainEntity as { name: string }[]).map(e => e.name)).toEqual(QUESTIONS.map(q => q.q));
  });
});

describe("what crawlers read beside the pages", () => {
  const indexed = ROUTES.filter(r => r.index);

  it("lists every indexed route in the sitemap and never the 404", () => {
    const locs = [...built("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    expect(locs).toEqual(indexed.map(r => `https://usewsp.com${r.path}`));
    expect(locs).not.toContain("https://usewsp.com/404");
  });

  it("names the sitemap in robots.txt", () => {
    expect(built("robots.txt")).toContain("Sitemap: https://usewsp.com/sitemap.xml");
  });

  it("links every indexed route and the docs from llms.txt", () => {
    const llms = built("llms.txt");
    expect(llms.startsWith("# wsp\n")).toBe(true);
    for (const r of indexed) expect(llms).toContain(`(https://usewsp.com${r.path})`);
    for (const link of [DOCS, REPO]) expect(llms).toContain(`(${link})`);
  });

  it("has a 1200x630 preview image for every route", () => {
    for (const r of ROUTES) {
      const png = readFileSync(join(out, r.image.path));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    }
  });
});

describe("the built page in a visitor's browser", () => {
  const AGENTS = {
    linux: "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
    windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  } as const;
  const realAgent = navigator.userAgent;
  /** The build names an asset by its hash and vitest by its source path; the page is the same either way. */
  const sources = new Map(readdirSync(join(www, "src/assets"), { recursive: true, encoding: "utf8" }).map(f => [basename(f), `/src/assets/${f}`]));
  const asSource = (html: string): string => html.replace(/\/assets\/([\w.-]+?)-[\w-]{8}\.(\w+)/g, (url, name, ext) => sources.get(`${name}.${ext}`) ?? url);

  for (const [platform, agent] of Object.entries(AGENTS)) {
    it(`hydrates / with no mismatch and no warning, then shows the ${platform} install`, async () => {
      expect(platformOf(agent)).toBe(platform);
      Object.defineProperty(navigator, "userAgent", { value: agent, configurable: true });
      const page = new DOMParser().parseFromString(built("index.html"), "text/html");
      const container = document.createElement("div");
      container.innerHTML = asSource(page.getElementById("root")!.innerHTML);
      document.body.append(container);
      const mismatches: unknown[] = [];
      const warned = vi.spyOn(console, "error");
      try {
        const root = await act(async () => hydrateRoot(container, createElement(App, { path: "/" }), { onRecoverableError: error => mismatches.push(error) }));
        expect(mismatches).toEqual([]);
        expect(warned).not.toHaveBeenCalled();
        if (platform === "windows") expect(screen.getAllByRole("button", { name: /Join the waitlist/ })).toHaveLength(2);
        else expect(screen.getAllByRole("link", { name: DOWNLOADS[platform as "mac" | "linux"].label })[0]!.className).toContain("key");
        act(() => root.unmount());
      } finally {
        warned.mockRestore();
        container.remove();
        Object.defineProperty(navigator, "userAgent", { value: realAgent, configurable: true });
      }
    });
  }

  for (const path of ["/compare", ...TOOLS.map(t => `/compare/${t.slug}`)]) {
    it(`hydrates ${path} with no mismatch and no warning`, async () => {
      const page = new DOMParser().parseFromString(built(fileOf(path)), "text/html");
      const container = document.createElement("div");
      container.innerHTML = asSource(page.getElementById("root")!.innerHTML);
      document.body.append(container);
      const mismatches: unknown[] = [];
      const warned = vi.spyOn(console, "error");
      try {
        const root = await act(async () => hydrateRoot(container, createElement(App, { path }), { onRecoverableError: error => mismatches.push(error) }));
        expect(mismatches).toEqual([]);
        expect(warned).not.toHaveBeenCalled();
        act(() => root.unmount());
      } finally {
        warned.mockRestore();
        container.remove();
      }
    });
  }
});
