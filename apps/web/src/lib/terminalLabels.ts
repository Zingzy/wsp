// Adapted from pingdotgg/t3code packages/shared/src/terminalLabels.ts at 57a66608 (MIT).

/** Human-readable label for a terminal tab; matches mobile and web sidebars. */
export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = /^term(?:inal)?-(\d+)$/i.exec(terminalId)?.[1];
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}
