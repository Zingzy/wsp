// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/** What a workspace's machine is: cloud, a fork wsp made at a provider or on a computer somebody joined; local, this
 * computer itself; or place, a folder on a computer the person joined, reached over that computer's link. The one
 * fact every road that varies by machine kind reads; nothing switches on it outside the backend registry. Its own
 * module, imported by the wire and the views alike, so neither reaches the other for it. */
export const WorkspaceKind = z.enum(["cloud", "local", "place"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;
