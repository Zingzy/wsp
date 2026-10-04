// SPDX-License-Identifier: AGPL-3.0-only
// The slate harness built by Vite into a folder of its own and served as files, no dev server: the build runs in a child
// process, since Vite's esbuild refuses jsdom's TextEncoder. Every asset fetched is kept, so a test can tell which chunks
// a page loaded.
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

export interface Harness {
  base: string;
  fetched: string[];
  stop(): void;
}

export async function serveHarness(): Promise<Harness> {
  const out = mkdtempSync(join(tmpdir(), "wsp-slate-harness-"));
  const built = spawnSync(process.execPath, [join(WEB_DIR, "node_modules/vite/bin/vite.js"), "build", "test/slate-render", "--config", "vite.config.ts", "--base", "./", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: WEB_DIR, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`the harness did not build: ${built.stderr}`);
  const fetched: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    fetched.push(path);
    const file = join(out, path);
    if (!file.startsWith(out) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/index.html`,
    fetched,
    stop: () => {
      server.close();
      rmSync(out, { recursive: true, force: true });
    },
  };
}
