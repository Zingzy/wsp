// SPDX-License-Identifier: AGPL-3.0-only
// What the host writes into the page's one inline script before serving it.
export interface BootPayload {
  wsPort: number;
  token: string;
  /** The family the person's terminal draws with, when the saved recipe ticks its row; the terminal pane defaults to it. */
  terminalFont?: string;
}

/** The boot object, or undefined where no host served the page (tests). */
export function bootPayload(): BootPayload | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { __WSP__?: BootPayload }).__WSP__;
}
