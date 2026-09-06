// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { moveKeyedDirectories, type ProjectStateResolver } from "./resolver.js";

/** The sessions directory name: two dashes, the resolved path without its leading slash with every slash,
 * backslash and colon replaced by a dash, two dashes; dots and underscores stay. */
export const piProjectKey = (path: string): string => `--${path.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;

export const piResolver: ProjectStateResolver = {
  agent: "pi",
  states: ["sessions"],
  async move(home, from, to) {
    const { files, changed } = await moveKeyedDirectories(join(home, "sessions"), piProjectKey, from, to);
    return changed > 0 ? [{ state: "sessions", files, changed }] : [];
  },
};
