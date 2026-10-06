// SPDX-License-Identifier: AGPL-3.0-only
import { inReview } from "../fixture-kit.mjs";

export default { build: inReview(false), changes: ["spoo"], pulls: "failed" };
