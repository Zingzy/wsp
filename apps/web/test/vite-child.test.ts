// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchRender, RENDER_ARGS, stopRender, stopVite } from "./vite-child";

// The child prints once its script has run, so a signal never races its handler.
const started = (script: string) => {
  const c = spawn(process.execPath, ["-e", `${script}; process.stdout.write("ready")`], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise<typeof c>(done => c.stdout.once("data", () => done(c)));
};

it("a child that honours SIGTERM is gone when stopVite returns", async () => {
  const c = await started("setInterval(() => {}, 1000)");
  await stopVite(c);
  expect(c.signalCode).toBe("SIGTERM");
});

it("a child that swallows SIGTERM is killed after the grace period", async () => {
  const c = await started("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  const t0 = Date.now();
  await stopVite(c);
  expect(c.signalCode).toBe("SIGKILL");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900);
}, 10_000);

it("an already exited child is left alone", async () => {
  const c = await started("");
  await new Promise(done => c.once("exit", done));
  await stopVite(c);
  expect(c.exitCode).toBe(0);
});

it("stopRender stops vite when the browser throws on close, and rethrows", async () => {
  const c = await started("setInterval(() => {}, 1000)");
  const browser = { close: () => Promise.reject(new Error("browser gone")) };
  await expect(stopRender(browser, c)).rejects.toThrow("browser gone");
  expect(c.signalCode).toBe("SIGTERM");
});

it("stopRender stops vite when the browser never finishes closing", async () => {
  const c = await started("setInterval(() => {}, 1000)");
  const browser = { close: () => new Promise<void>(() => {}) };
  await stopRender(browser, c, 100);
  expect(c.signalCode).toBe("SIGTERM");
});

it("stopRender with no browser still stops vite", async () => {
  const c = await started("setInterval(() => {}, 1000)");
  await stopRender(undefined, c);
  expect(c.signalCode).toBe("SIGTERM");
});

it("launchRender hands Chromium the cap on its shared memory, which no render file may spend a whole disk on", async () => {
  let got: string[] | undefined;
  await launchRender(options => {
    got = options.args;
    return Promise.resolve({} as never);
  });
  expect(got).toEqual(RENDER_ARGS);
  expect(RENDER_ARGS).toContain("--enable-low-end-device-mode");
});

it("every render file launches through launchRender, so the cap has one home", () => {
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const render = readdirSync(webDir, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".browser.test.ts") && !f.includes("node_modules"));
  expect(render.length).toBeGreaterThan(10);
  const bodies = render.map(f => [f, readFileSync(join(webDir, f), "utf8")] as const);
  expect(bodies.filter(([, body]) => body.includes("chromium.launch(")).map(([f]) => f)).toEqual([]);
  expect(bodies.filter(([, body]) => !body.includes("launchRender()")).map(([f]) => f)).toEqual([]);
});
