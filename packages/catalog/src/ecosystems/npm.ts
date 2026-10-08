// SPDX-License-Identifier: AGPL-3.0-only
import { NODE_BUILD_OUTPUTS, type EcosystemModule } from "./module.js";

/** --no-save keeps package-lock.json as the branch has it, where npm install alone rewrites a stale one; npm ci would
 * delete the node_modules carried in and install every package again. */
export const NPM: EcosystemModule = { id: "npm", lockfiles: ["package-lock.json", "npm-shrinkwrap.json"], carry: ["node_modules"], never: NODE_BUILD_OUTPUTS, rebuild: "npm install --no-save --prefer-offline --no-audit --no-fund" };
