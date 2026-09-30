// SPDX-License-Identifier: AGPL-3.0-only
// What daemon-content.mjs hands a TypeScript reader. The module itself stays
// plain JavaScript because the landing's cut runs it with no build behind it.
/** The pieces of a deploy the host renders, which the sha reads beside the daemon tree. */
export interface Deployed {
  rootsPath: string;
  workScoreLine: string;
  scripts: string[];
}
/** Where those pieces are recorded, relative to the daemon tree. */
export const DEPLOYED_PATH: string;
/** The pieces as recorded beside the daemon tree. */
export function readDeployed(daemonTree: string): Deployed;
/** The sha of what a deploy installs on a guest, over the daemon tree and those pieces. */
export function daemonContentSha(daemonTree: string, deployed?: Deployed): string;
