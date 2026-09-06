// Vitest 2.x workspace: each entry runs under its own config/environment.
// Node packages + wspx use the root node config; apps/web carries its own
// vite config (react plugin + jsdom) so React component tests get a DOM.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
const alias = {
  "@wsp/engine": pkg("engine"),
  "@wsp/adapter-claude": pkg("adapter-claude"),
  "@wsp/daemon": pkg("daemon"),
  "@wsp/protocol": pkg("protocol"),
  "@wsp/runtime": pkg("runtime"),
  "@wsp/host": pkg("host"),
  "@wsp/collect": pkg("collect"),
  "@wsp/catalog": pkg("catalog"),
};

export default [
  {
    resolve: { alias },
    test: {
      name: "node",
      include: ["packages/*/test/**/*.test.ts", "apps/wspx/**/*.test.ts", "apps/desktop/test/**/*.test.ts"],
      environment: "node",
      // Anything a test writes to the OS-local config dir (the install id) lands here, never in the developer's own.
      env: { XDG_CONFIG_HOME: join(tmpdir(), "wsp-test-config") },
    },
  },
  "./apps/web/vite.config.ts",
];
