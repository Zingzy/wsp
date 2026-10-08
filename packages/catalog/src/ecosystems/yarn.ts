// SPDX-License-Identifier: AGPL-3.0-only
import { NODE_BUILD_OUTPUTS, type EcosystemModule } from "./module.js";

/** Classic and Plug'n'Play alike: Yarn's own .gitignore ignores .yarn/cache and .yarn/unplugged and never .yarn itself.
 * --frozen-lockfile is the one flag both Yarn 1 and Yarn 4 refuse a stale yarn.lock with and write nothing; Yarn 1
 * ignores --immutable and rewrites it. */
export const YARN: EcosystemModule = { id: "yarn", lockfiles: ["yarn.lock"], carry: ["node_modules", ".yarn/cache", ".yarn/unplugged"], never: NODE_BUILD_OUTPUTS, rebuild: "yarn install --frozen-lockfile" };
