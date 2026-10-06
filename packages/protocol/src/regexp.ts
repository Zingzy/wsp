// SPDX-License-Identifier: AGPL-3.0-only

/** Text matched as itself inside a RegExp. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
