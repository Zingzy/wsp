// SPDX-License-Identifier: AGPL-3.0-only
import { NODE_BUILD_OUTPUTS, type EcosystemModule } from "./module.js";

/** pnpm leaves the lockfile it installed from, byte for byte, in node_modules/.pnpm/lock.yaml. */
export const PNPM: EcosystemModule = { id: "pnpm", lockfiles: ["pnpm-lock.yaml"], carry: ["node_modules"], never: NODE_BUILD_OUTPUTS, installed: "node_modules/.pnpm/lock.yaml", rebuild: "pnpm install --frozen-lockfile --prefer-offline" };
