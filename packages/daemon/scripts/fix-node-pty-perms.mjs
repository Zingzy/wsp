// node-pty 1.1.0 ships darwin prebuilds without the exec bit on spawn-helper,
// so pty spawn dies with posix_spawnp. Every prebuild is fixed, not just this
// machine's: the desktop package carries both mac arches, and the arch it is
// not built on would otherwise ship a helper nobody can run. Linux compiles
// from source and has no helper.
import { createRequire } from "node:module";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
try {
  const prebuilds = join(dirname(require.resolve("node-pty/package.json")), "prebuilds");
  if (existsSync(prebuilds)) {
    for (const target of readdirSync(prebuilds)) {
      const helper = join(prebuilds, target, "spawn-helper");
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
} catch {
  // node-pty absent or built from source; nothing to fix
}
