// SPDX-License-Identifier: AGPL-3.0-only
import { inReview } from "../fixture-kit.mjs";

export default { build: inReview(true), changes: ["spoo"], pulls: "failed" };
