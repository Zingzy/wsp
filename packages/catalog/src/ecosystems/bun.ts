// SPDX-License-Identifier: AGPL-3.0-only
import { NODE_BUILD_OUTPUTS, type EcosystemModule } from "./module.js";

export const BUN: EcosystemModule = { id: "bun", lockfiles: ["bun.lock", "bun.lockb"], carry: ["node_modules"], never: NODE_BUILD_OUTPUTS, rebuild: "bun install --frozen-lockfile" };
