// SPDX-License-Identifier: AGPL-3.0-only
// Every kind the agents lists draw, by the tab that lists it. A kind is its
// module and its line here.
import { AGENTS } from "./agents.js";
import type { AnyKind } from "./kind.js";
import { SERVERS } from "./servers.js";
import { PLUGINS } from "./plugins.js";
import { SKILLS } from "./skills.js";

export const AGENTS_KINDS = { agents: AGENTS, servers: SERVERS, skills: SKILLS, plugins: PLUGINS } satisfies Record<string, AnyKind>;
