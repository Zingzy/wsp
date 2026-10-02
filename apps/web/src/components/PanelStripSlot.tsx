// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's tab strip keeps one place at its right for the open pane's own control, as the Pull request pane's
// refresh: the strip draws the place and the pane fills it through a portal, so the pane keeps its state and acts.
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const PanelStripSlot = createContext<HTMLElement | null>(null);

/** What the open pane stands in the strip's place; nothing where the pane is drawn outside a strip. */
export function PanelStripControl({ children }: { children: ReactNode }) {
  const slot = useContext(PanelStripSlot);
  return slot === null ? null : createPortal(children, slot);
}
