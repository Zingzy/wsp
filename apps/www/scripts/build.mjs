// SPDX-License-Identifier: AGPL-3.0-only
// The site's build: the client bundle, then a server bundle of the same pages that renders every route to its own
// HTML, then the sitemap, robots.txt and llms.txt from the same route table. `node scripts/build.mjs [outDir]`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(process.argv[2] ?? join(root, "dist"));
const server = join(out, ".server");

await build({ root, logLevel: "warn", build: { outDir: out, emptyOutDir: true } });
// One file with React inside, so it runs from an out folder outside the repo with no node_modules beside it.
await build({ root, logLevel: "warn", ssr: { noExternal: true }, build: { ssr: "src/server.tsx", outDir: server, emptyOutDir: true } });

const site = await import(pathToFileURL(join(server, "server.js")).href);
const template = readFileSync(join(out, "index.html"), "utf8");
const write = (file, text) => {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  writeFileSync(join(out, file), text);
};
for (const route of site.ROUTES) {
  const { head, html } = site.render(route);
  write(site.fileOf(route.path), template.replace("<!--head-->", head).replace("<!--app-->", html));
}
write("sitemap.xml", site.sitemap());
write("robots.txt", site.robots());
write("llms.txt", site.llms());
rmSync(server, { recursive: true });
console.log(`prerendered ${site.ROUTES.map(r => r.path).join(" ")} into ${out}`);
