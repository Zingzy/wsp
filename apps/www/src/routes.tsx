// SPDX-License-Identifier: AGPL-3.0-only
// Every page the site serves, and what search engines, crawlers and link previews read about it. The build renders each
// one to its own HTML file and lists the indexed ones in the sitemap and llms.txt.
import type { ComponentType } from "react";
import { DOWNLOADS } from "./downloads";
import { EMAIL, ORG, SITE, X } from "./links";
import { Home } from "./pages/home";
import { Privacy, Security, Terms } from "./pages/legal";
import { NotFound } from "./pages/not-found";

export type Route = {
  path: string;
  title: string;
  description: string;
  /** The link-preview image under public/, and the line `pnpm images` writes on it. */
  image: { path: string; line: string; alt: string };
  /** False keeps the page out of the sitemap and out of search. */
  index: boolean;
  data?: Record<string, unknown>[];
  Page: ComponentType;
};

const PITCH = "Run Claude Code, Codex and more on your Mac, an old laptop or a server you rent, from one window. Your agents can start each other on any of them.";
const MAIN_IMAGE = { path: "/og.png", line: "Coding agents on every computer you own.", alt: "wsp: coding agents on every computer you own." };

const ORGANIZATION = {
  "@type": "Organization",
  "@id": `${SITE}/#org`,
  name: "wsp labs",
  url: `${SITE}/`,
  logo: `${SITE}/logo.png`,
  email: EMAIL,
  sameAs: [ORG, X],
};

export const ROUTES: readonly Route[] = [
  {
    path: "/",
    title: "wsp: coding agents on every computer you own",
    description: PITCH,
    image: MAIN_IMAGE,
    index: true,
    data: [
      ORGANIZATION,
      { "@type": "WebSite", "@id": `${SITE}/#site`, name: "wsp", url: `${SITE}/`, publisher: { "@id": ORGANIZATION["@id"] } },
      {
        "@type": "SoftwareApplication",
        name: "wsp",
        url: `${SITE}/`,
        description: PITCH,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS, Linux",
        license: "https://www.gnu.org/licenses/agpl-3.0.html",
        downloadUrl: [DOWNLOADS.mac.href, DOWNLOADS.linux.href],
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@id": ORGANIZATION["@id"] },
      },
    ],
    Page: Home,
  },
  { path: "/privacy", title: "Privacy: wsp", description: "What wsp collects and sends, where it goes, and how to turn each part off.", image: MAIN_IMAGE, index: true, Page: Privacy },
  { path: "/terms", title: "Terms: wsp", description: "The terms for usewsp.com, the docs, the relay and the waitlist.", image: MAIN_IMAGE, index: true, Page: Terms },
  { path: "/security", title: "Security: wsp", description: "How the parts of wsp trust each other, what it does with your keys, and how to report a problem.", image: MAIN_IMAGE, index: true, Page: Security },
  {
    path: "/404",
    title: "Not found: wsp",
    description: "There is no page at this address on usewsp.com.",
    image: MAIN_IMAGE,
    index: false,
    Page: NotFound,
  },
];

const NOT_FOUND = ROUTES.find(r => r.path === "/404")!;

/** The page a path shows; any path not in the table shows the 404, as the host serves 404.html for it. */
export function routeAt(pathname: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ROUTES.find(r => r.path === path) ?? NOT_FOUND;
}

/** Where a route's HTML lands in the build: `/` at index.html, the 404 at 404.html, the rest at <path>/index.html. */
export function fileOf(path: string): string {
  if (path === "/") return "index.html";
  if (path === "/404") return "404.html";
  return `${path.slice(1)}/index.html`;
}
