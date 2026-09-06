// SPDX-License-Identifier: AGPL-3.0-only
// Which catalog agents this host can open a thread on. This list is the one
// home for that fact: the adapter registry is typed by it, so adding an id
// here does not build until its adapter exists, and nothing else needs the
// runtime to ask the question.

export const THREAD_AGENTS = ["claude"] as const;
export type ThreadAgent = (typeof THREAD_AGENTS)[number];
