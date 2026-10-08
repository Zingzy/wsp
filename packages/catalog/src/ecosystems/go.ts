// SPDX-License-Identifier: AGPL-3.0-only
import type { EcosystemModule } from "./module.js";

/** Modules and builds live in caches outside the project, so nothing is carried. go mod download writes go.sum even
 * under -mod=readonly; listing the packages fetches what they import and refuses a go.sum that lacks an entry. */
export const GO: EcosystemModule = { id: "go", lockfiles: ["go.sum"], carry: [], never: [], rebuild: "go list -mod=readonly -deps -test ./... > /dev/null" };
