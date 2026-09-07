// SPDX-License-Identifier: AGPL-3.0-only
// The class rides in the renderer's argv: a sandboxed preload bundles all it imports, so the frame table stays in the main process.
const ARG = "--wsp-html-class=";

export const htmlClassArg = (htmlClass: string): string => `${ARG}${htmlClass}`;

export const htmlClassFrom = (argv: readonly string[]): string | undefined => argv.find(a => a.startsWith(ARG))?.slice(ARG.length);
