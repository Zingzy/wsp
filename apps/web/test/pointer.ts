// SPDX-License-Identifier: AGPL-3.0-only
import { createEvent, fireEvent } from "@testing-library/react";

/** A pointerleave from a mouse or a touch: jsdom has no PointerEvent, and the one setup.ts stands in drops the pointerType it is handed. */
export function pointerLeave(element: Element, pointerType: "mouse" | "touch" = "mouse"): void {
  const event = createEvent.pointerLeave(element);
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(element, event);
}
