// SPDX-License-Identifier: AGPL-3.0-only
import type { CarryModule } from "@wsp/protocol";

/** What a new worktree of a project in one ecosystem gets, picked by a lockfile in any of its folders: the ignored
 * directories under that folder it carries in from the project folder because they hold no path, the ones it never
 * carries because they do, where its install leaves a copy of the lockfile it installed from (with it, an install
 * whose copy is the branch's lockfile is not run again), and the command, run once in that folder, that rebuilds
 * what was left behind without writing a tracked file. A cache the ecosystem keeps outside the project is shared as
 * it stands and named nowhere here. */
export interface EcosystemModule extends CarryModule {
  rebuild: string;
}

/** What a build of any Node tool writes inside the project, which holds the path it was built at. */
export const NODE_BUILD_OUTPUTS = [".next", ".turbo", ".cache"];
