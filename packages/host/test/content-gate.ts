// SPDX-License-Identifier: AGPL-3.0-only
// The daemon content gate can only be met on the tree that lands. No branch
// carries a version: the landing cuts it on main right before the squash, one
// landing at a time, so a gate that failed on a branch would say nothing about
// the branch while hiding a real failure behind an expected one.

/** What the gate is read off: ci's own two words for where it runs, and the one the landing gate sets. */
type GateEnv = Partial<Record<"GITHUB_ACTIONS" | "GITHUB_REF" | "WSP_DAEMON_CUT", string>>;

/**
 * Whether the daemon content gate fails here rather than printing the sha the cut will append. On main in ci, and in
 * the landing gate, which runs on its own computer after the cut and says so with WSP_DAEMON_CUT=1; not on a pull
 * request, where GITHUB_REF names the merge ref, nor on a branch anywhere else.
 */
export function contentGateEnforced(env: GateEnv = { GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, GITHUB_REF: process.env.GITHUB_REF, WSP_DAEMON_CUT: process.env.WSP_DAEMON_CUT }): boolean {
  if (env.WSP_DAEMON_CUT === "1") return true;
  return env.GITHUB_ACTIONS !== undefined && env.GITHUB_REF === "refs/heads/main";
}
