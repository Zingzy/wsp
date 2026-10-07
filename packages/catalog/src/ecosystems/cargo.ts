// SPDX-License-Identifier: AGPL-3.0-only
import type { EcosystemModule } from "./module.js";

/** target holds the absolute paths of what it built, so the worktree builds its own; the crates come from the
 * registry every project on the computer shares. --locked refuses a stale Cargo.lock where cargo fetch would rewrite it. */
export const CARGO: EcosystemModule = { id: "cargo", lockfiles: ["Cargo.lock"], carry: [], never: ["target"], rebuild: "cargo fetch --locked" };
