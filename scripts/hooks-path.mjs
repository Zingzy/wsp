// SPDX-License-Identifier: AGPL-3.0-only
// The hooks are versioned under .githooks and git is pointed at them once,
// in the repository's own config, which every worktree shares. An install
// with no git around it, which is what a package installed from a registry
// sees, has nothing to wire; a git that will not take the setting leaves the
// hooks unwired and says so. Neither is a failed install.
import { execFileSync } from "node:child_process";

function wire() {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  } catch {
    return "hooks: no git repository here, nothing to wire";
  }
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  } catch {
    return "hooks: git would not take core.hooksPath, so the hooks under .githooks are not wired";
  }
  return "hooks: git reads this repository's .githooks";
}

console.log(wire());
