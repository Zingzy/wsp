// SPDX-License-Identifier: AGPL-3.0-only
// What slate_catalog answers, as text (10, "The catalog call").
export function slateCatalog(name?: string): string {
  return name === undefined ? "slate catalog: not built yet" : `${name}: not built yet`;
}
