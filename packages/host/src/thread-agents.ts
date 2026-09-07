// SPDX-License-Identifier: AGPL-3.0-only
// Which catalog agents this host can open a thread on. The adapter registry
// is typed by this list, so an id here without a factory there does not build
// and a factory there without an id here does not either; the wizard, the
// recipe verbs and the MCP server read the list because it needs no runtime.

export const THREAD_AGENTS = ["claude"] as const;
export type ThreadAgent = (typeof THREAD_AGENTS)[number];
