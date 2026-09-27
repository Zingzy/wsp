// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from shadcn/ui's sonner.tsx (MIT): Sonner's stack, timers and swipe, each toast on the popover glass.
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

/** The stack sits in the box it is mounted in rather than over the window, and under the dialogs rather than over them. */
const IN_PLACE = { position: "absolute", zIndex: 60 } as const;
/** Sonner's Alt+T is Option+T on a Mac, which types a character, so no key pulls the focus into the stack. */
const NO_HOTKEY: string[] = [];

function Toaster({ style, toastOptions, ...props }: ToasterProps) {
  return (
    <Sonner
      position="top-right"
      hotkey={NO_HOTKEY}
      style={{ ...IN_PLACE, ...style }}
      toastOptions={{
        unstyled: true,
        ...toastOptions,
        className:
          "group/toast w-(--width) rounded-[12px] dropdown-glass popover-shadow text-popover-foreground data-[expanded=false]:data-[front=false]:*:opacity-0",
      }}
      {...props}
    />
  );
}

export { Toaster, toast };
