// SPDX-License-Identifier: AGPL-3.0-only
export interface SlateCatalogAsk { piece?: string; source?: string; action?: string; step?: string; functions?: boolean; examples?: boolean }
export interface SlateCatalogAnswer { text: string; [part: string]: unknown }

export function slateCatalog(_ask: SlateCatalogAsk): SlateCatalogAnswer {
  return { text: "The slate catalog is not built yet." };
}
