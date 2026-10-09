// SPDX-License-Identifier: AGPL-3.0-only
// What scripts/build.mjs renders each route with: its head and its page as HTML, and the files crawlers read.
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { App } from "./App";
import { DOCS, NPM, REPO, SITE } from "./links";
import { ROUTES, type Route } from "./routes";

export { fileOf, ROUTES } from "./routes";

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const urlOf = (path: string): string => `${SITE}${path}`;

export function head(route: Route): string {
  const meta = (key: "name" | "property", name: string, content: string) => `<meta ${key}="${name}" content="${escape(content)}" />`;
  const image = urlOf(route.image.path);
  const lines = [
    `<title>${escape(route.title)}</title>`,
    meta("name", "description", route.description),
    `<link rel="canonical" href="${urlOf(route.path)}" />`,
    route.index ? "" : meta("name", "robots", "noindex"),
    meta("name", "theme-color", "#121110"),
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", "wsp"),
    meta("property", "og:title", route.title),
    meta("property", "og:description", route.description),
    meta("property", "og:url", urlOf(route.path)),
    meta("property", "og:image", image),
    meta("property", "og:image:width", "1200"),
    meta("property", "og:image:height", "630"),
    meta("property", "og:image:alt", route.image.alt),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:site", "@wsplabs"),
    meta("name", "twitter:title", route.title),
    meta("name", "twitter:description", route.description),
    meta("name", "twitter:image", image),
    meta("name", "twitter:image:alt", route.image.alt),
    route.data === undefined
      ? ""
      : `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": route.data }).replace(/</g, "\\u003c")}</script>`,
  ];
  return lines.filter(Boolean).join("\n    ");
}

export function render(route: Route): { head: string; html: string } {
  return {
    head: head(route),
    html: renderToString(
      <StrictMode>
        <App path={route.path} />
      </StrictMode>,
    ),
  };
}

const indexed = (): Route[] => ROUTES.filter(r => r.index);

export function sitemap(): string {
  const urls = indexed().map(r => `  <url>\n    <loc>${urlOf(r.path)}</loc>\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function robots(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\nSitemap: ${SITE}/docs/sitemap.xml\n`;
}

export function llms(): string {
  return [
    "# wsp",
    "",
    "> wsp runs coding agents (Claude Code, Codex, OpenCode and Cursor) on every computer you own, from one desktop app on your Mac: the Mac itself, and any Linux computer you reach over ssh or that dials out to you. Claude Code, Codex and Cursor use the subscriptions they are already signed in to, and OpenCode uses a key from the model provider you pick. One thread can start another on a different computer or agent.",
    "",
    "wsp is free and open source under the AGPL-3.0. It runs on macOS and Linux; Windows is on a waitlist. Threads run on your computers and the app reaches them over your own network or ssh; a computer reached through the optional relay sends that connection through Cloudflare.",
    "",
    "## Pages",
    "",
    ...indexed().map(r => `- [${r.title}](${urlOf(r.path)}): ${r.description}`),
    "",
    "## Docs",
    "",
    `- [Documentation](${DOCS}): installing wsp, adding a computer, the command line and the MCP tools`,
    `- [Source on GitHub](${REPO}): the code, issues and releases`,
    `- [npm package](${NPM}): \`@wsp-labs/wsp\`, the \`wsp\` command line`,
    "",
  ].join("\n");
}
