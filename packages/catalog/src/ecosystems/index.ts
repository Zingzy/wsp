// SPDX-License-Identifier: AGPL-3.0-only
// The ecosystems a new worktree is read for, one module each. Adding one is its
// module and its line here.
import { BUN } from "./bun.js";
import { CARGO } from "./cargo.js";
import { COMPOSER } from "./composer.js";
import { GO } from "./go.js";
import type { EcosystemModule } from "./module.js";
import { NPM } from "./npm.js";
import { PNPM } from "./pnpm.js";
import { POETRY } from "./poetry.js";
import { UV } from "./uv.js";
import { YARN } from "./yarn.js";

export type { EcosystemModule } from "./module.js";

export const ECOSYSTEM_MODULES: readonly EcosystemModule[] = [NPM, PNPM, YARN, BUN, COMPOSER, UV, POETRY, CARGO, GO];
