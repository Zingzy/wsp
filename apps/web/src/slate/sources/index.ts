// SPDX-License-Identifier: AGPL-3.0-only
// The renderer's half of the source registry, by source name; state is the engine's own and needs no module.
import { cost } from "./cost.js";
import { git } from "./git.js";
import { pr } from "./pr.js";
import type { SourceModule } from "./source.js";
import { thread } from "./thread.js";
import { time } from "./time.js";
import { usage } from "./usage.js";

export const SLATE_SOURCE_VIEWS: Readonly<Record<string, SourceModule>> = Object.fromEntries([thread, usage, cost, time, git, pr].map(source => [source.name, source]));
