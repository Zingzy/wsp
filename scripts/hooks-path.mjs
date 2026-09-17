// SPDX-License-Identifier: AGPL-3.0-only
// The hooks are versioned under .githooks and git is pointed at them once,
// in the repository's own config, which every worktree shares. An install
// with no git around it, which is what a package installed from a registry
// sees, has nothing to wire and is not a failed install.
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  console.log("hooks: git reads this repository's .githooks");
} catch {
  console.log("hooks: no git repository here, nothing to wire");
}
