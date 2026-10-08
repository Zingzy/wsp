// SPDX-License-Identifier: AGPL-3.0-only
// Prints the CSS a production build of the given stylesheets writes, through the Tailwind plugin the app builds with,
// with one more class scanned when --extra names it. A child process, since esbuild refuses jsdom's TextEncoder.
import { parseArgs } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const { values, positionals } = parseArgs({ options: { extra: { type: "string" } }, allowPositionals: true });
const extra = values.extra;
const scan = {
  name: "extra-class",
  enforce: "pre",
  transform: (code, id) => (extra !== undefined && id.endsWith("/src/index.css") ? `${code}\n@source inline(${JSON.stringify(extra)});` : undefined),
};
const out = await build({
  configFile: false,
  root: new URL("..", import.meta.url).pathname,
  logLevel: "silent",
  plugins: [scan, tailwindcss()],
  build: { write: false, cssMinify: false, rollupOptions: { input: positionals } },
});
process.stdout.write(out.output.flatMap(o => (o.type === "asset" && o.fileName.endsWith(".css") ? [String(o.source)] : [])).join("\n"));
