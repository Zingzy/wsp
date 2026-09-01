// node-pty 1.1.0 ships darwin prebuilds without the exec bit on spawn-helper,
// so pty spawn dies with posix_spawnp. Linux compiles from source, unaffected.
import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
try {
  const pkg = dirname(require.resolve("node-pty/package.json"));
  const helper = join(pkg, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
} catch {
  // node-pty absent or built from source; nothing to fix
}
