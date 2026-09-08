// SPDX-License-Identifier: AGPL-3.0-only
// Lays out build/app, the directory electron-builder packages: the bundled
// main and preload, the built web app, a copy of @wsp/daemon's package
// (package.json plus dist) that the host's require.resolve finds when it
// stages the guest bundle, and node-pty, the one package the bundle leaves
// external. Unpackaged runs find both under build/app/node_modules; the
// packaged app carries them as extra resources one directory above the app,
// on the same parent walk.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePty } from "./pty.mjs";

// The table of shipped assets lives in @wsp/host's build output, and build:app
// runs on its own from `start`, so a tree that has not built it is named here
// instead of in a resolver stack trace.
const { workspaceAsset } = await import("@wsp/host").catch(e => {
  if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
  throw new Error("@wsp/host is not built: run pnpm --filter @wsp/desktop build:deps first");
});

const root = fileURLToPath(new URL("..", import.meta.url));
const app = join(root, "build", "app");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const webDir = workspaceAsset("web");
const daemonDir = workspaceAsset("daemon");
for (const [what, path] of [
  ["main bundle", join(app, "main", "main.mjs")],
  ["web app", join(webDir, "index.html")],
  ["daemon dist", join(daemonDir, "dist", "index.js")],
]) {
  if (!existsSync(path)) throw new Error(`${what} not built: ${path} is missing`);
}

cpSync(join(root, "src", "setup.html"), join(app, "main", "setup.html"));

rmSync(join(app, "web"), { recursive: true, force: true });
cpSync(webDir, join(app, "web"), { recursive: true });

const daemonOut = join(app, "node_modules", "@wsp", "daemon");
rmSync(join(app, "node_modules"), { recursive: true, force: true });
mkdirSync(daemonOut, { recursive: true });
cpSync(join(daemonDir, "package.json"), join(daemonOut, "package.json"));
cpSync(join(daemonDir, "dist"), join(daemonOut, "dist"), { recursive: true });

// node-pty is the daemon's dependency, so it is resolved from the daemon's own folder: nothing above apps/desktop
// carries it under pnpm's layout.
stagePty(dirname(createRequire(join(daemonDir, "package.json")).resolve("node-pty/package.json")), app);

writeFileSync(
  join(app, "package.json"),
  `${JSON.stringify(
    {
      name: "wsp",
      productName: "wsp",
      version: pkg.version,
      private: true,
      type: "module",
      main: "main/main.mjs",
      license: pkg.license,
    },
    null,
    2,
  )}\n`,
);
console.log(`staged ${app}`);
