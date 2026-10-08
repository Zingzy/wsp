// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useCallback, useContext, useLayoutEffect, useState, type RefCallback } from "react";

/** The element a tree's popups portal into instead of body. The shell hides the thread and the sidebar under Settings
 * rather than taking them down, and a popup portaled to body stood outside that hiding, drawn over Settings. */
export const PortalHostContext = createContext<HTMLElement | null>(null);

export function usePortalHost(): HTMLElement | undefined {
  return useContext(PortalHostContext) ?? undefined;
}

const BASE_UI_PORTAL = "[data-base-ui-portal]";

/** A host for one tree's popups, hidden while `hidden` holds, and the ref to put on an element of that tree outside
 * anything the shell hides. The host goes where Base UI would nest the tree's own portals: inside the Base UI portal
 * that element stands in (the narrow window's sidebar sheet), after the sheet's layers, so what opens from the sheet
 * stacks over it and stays out of the aria-hidden its modal puts on the rest of body; on body otherwise. */
export function usePlacedPortalHost(hidden: boolean): readonly [HTMLElement, RefCallback<HTMLElement>] {
  const [host] = useState(newPortalHost);
  const place = useCallback(
    (anchor: HTMLElement | null) => {
      if (anchor === null) return;
      (anchor.closest(BASE_UI_PORTAL) ?? document.body).append(host);
      // Made here rather than drawn, so a body a test has already emptied cannot make the removal throw.
      return () => host.remove();
    },
    [host],
  );
  useLayoutEffect(() => {
    host.hidden = hidden;
  }, [host, hidden]);
  return [host, place];
}

function newPortalHost(): HTMLElement {
  const host = document.createElement("div");
  host.setAttribute("data-portal-host", "");
  // Base UI's own mark for a portal: a sheet's modal keeps the portals nested in its own readable when it hides the rest
  // of body from a screen reader, and finds them by this.
  host.setAttribute("data-base-ui-portal", "");
  return host;
}
