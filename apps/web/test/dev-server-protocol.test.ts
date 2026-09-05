// SPDX-License-Identifier: AGPL-3.0-only
// The render tests spawn this dev server in a fresh worktree, which has no
// built @wsp/protocol dist; the server must serve the package from source or
// the browser page never renders and the test dies at its timeout instead.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { stopVite } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`vite did not serve ${url} in time`);
}

let vite: ChildProcess | undefined;
let base = "";

beforeAll(async () => {
  const port = await freePort();
  vite = spawn(join(WEB_DIR, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort", "--logLevel", "silent"], { cwd: WEB_DIR, stdio: "ignore" });
  base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/test/shell/index.html`, vite);
}, 60_000);

afterAll(() => stopVite(vite));

it("the dev server serves @wsp/protocol from source, so a worktree needs no dist", async () => {
  const response = await fetch(`${base}/src/shell/signInStore.ts`);
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(body).toContain("/packages/protocol/src/index.ts");
}, 30_000);
