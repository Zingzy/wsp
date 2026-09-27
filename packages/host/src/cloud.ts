// SPDX-License-Identifier: AGPL-3.0-only
// Whether the cloud is on in this process, read once when it loads. The provider
// table registers the clouds on this and nothing else; the verbs, the pages and
// the skill read the same reading, since the tool server loads them without the
// table, whose rows build the engine's backends.
import { cloudFromEnv } from "@wsp/protocol";

export const CLOUD_ON: boolean = cloudFromEnv(process.env);
