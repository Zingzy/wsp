// Vitest 2.x workspace: each entry runs under its own config/environment.
// Node packages + wspx use the root node config; apps/web carries its own
// vite config (react plugin + jsdom) so React component tests get a DOM.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_TMPDIR, TEST_ENV } from "./vitest.env.js";
import { CLOUD_ENV } from "./packages/protocol/src/env.js";

// Paths are pinned to this file, not the cwd, so a run started inside one package sees the same tree as a root run.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const pkg = (name: string) => here(`./packages/${name}/src/index.ts`);
/** A markdown import is its text, as tsup's text loader makes it in the host's build. */
const markdownText = () => ({
  name: "md-text",
  load: (id: string) => (id.endsWith(".md") ? `export default ${JSON.stringify(readFileSync(id, "utf8"))};` : undefined),
});

const alias = {
  "@wsp/engine": pkg("engine"),
  "@wsp/adapter-claude": pkg("adapter-claude"),
  "@wsp/adapter-codex": pkg("adapter-codex"),
  "@wsp/adapter-cursor": pkg("adapter-cursor"),
  "@wsp/adapter-opencode": pkg("adapter-opencode"),
  "@wsp/keys": pkg("keys"),
  "@wsp/own-file": pkg("own-file"),
  "@wsp/protocol/slate": here("./packages/protocol/src/slate/index.ts"),
  "@wsp/protocol": pkg("protocol"),
  "@wsp/runtime": pkg("runtime"),
  "@wsp/host": pkg("host"),
  "@wsp/collect": pkg("collect"),
  "@wsp/catalog": pkg("catalog"),
};

export default [
  {
    root: here("./"),
    plugins: [markdownText()],
    resolve: { alias },
    test: {
      name: "node",
      include: ["packages/*/test/**/*.test.ts", "infra/*/test/**/*.test.ts", "apps/wspx/**/*.test.ts", "apps/desktop/test/**/*.test.ts"],
      environment: "node",
      // Anything a test writes to the OS-local config dir (the install id) lands here, never in the developer's own.
      env: { XDG_CONFIG_HOME: join(RUN_TMPDIR, "wsp-test-config"), ...TEST_ENV },
      // A budget, not a retry, as apps/web's: a case that starts a git, a node or a stub waits on the scheduler, and a
      // gate at a load near 30 stretched cases of 1.4 s idle past vitest's 5 s default.
      testTimeout: 20_000,
    },
  },
  {
    // The cloud on: the node project runs every file with it off, and these run again with it on, the contract
    // between the command line, the tools and the skill and every file with a case on the cloud's own road.
    root: here("./"),
    plugins: [markdownText()],
    resolve: { alias },
    test: {
      name: "cloud",
      include: [
        "cloud",
        "parity",
        "skill",
        "contract",
        "verbs*",
        "mcp",
        "mcp-install",
        "places*",
        "service",
        "up",
        "host-lock",
        "servers-acts",
        "keyless",
        "init-local",
        "keys",
        "providers",
        "provider-swap",
      ].map(name => `packages/host/test/${name}.test.ts`),
      // The globs take in the files verbs.test.ts and places.test.ts were cut into; places-add predates them and stays out.
      exclude: ["packages/host/test/places-add.test.ts"],
      environment: "node",
      env: { XDG_CONFIG_HOME: join(RUN_TMPDIR, "wsp-test-config"), ...TEST_ENV, [CLOUD_ENV]: "1" },
      testTimeout: 20_000,
    },
  },
  here("./apps/web/vite.config.ts"),
  here("./apps/www/vite.config.ts"),
];
