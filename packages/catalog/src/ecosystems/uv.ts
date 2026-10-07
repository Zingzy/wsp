// SPDX-License-Identifier: AGPL-3.0-only
import type { EcosystemModule } from "./module.js";

/** A virtualenv writes its own path into every script it holds, so it is made again in the worktree. --locked refuses
 * a uv.lock that no longer matches pyproject.toml, where --frozen installs it as it stands. */
export const UV: EcosystemModule = { id: "uv", lockfiles: ["uv.lock"], carry: [], never: [".venv"], rebuild: "uv sync --locked" };
