// SPDX-License-Identifier: AGPL-3.0-only
// Where the window has no title bar, the frame row is its drag region and leaves room for the window's controls; every
// control in it is no-drag.
import type { ComponentPropsWithoutRef } from "react";
import { SidebarTrigger } from "../components/ui/sidebar.js";
import { headerIsWindowFrame } from "../lib/desktopShell.js";
import { cn } from "../lib/utils.js";

export function HeaderRow({ frame, className, children, ...props }: ComponentPropsWithoutRef<"div"> & { readonly frame: boolean }) {
  return (
    <div
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] min-w-0 shrink-0 items-center gap-[calc(var(--header-gap)-var(--workspace-titlebar-control-size)/2)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
        frame ? "pl-[var(--header-frame-inset)]" : "pl-[calc(env(safe-area-inset-left)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)]",
        headerIsWindowFrame() && "drag-region",
        className,
      )}
      data-header-row={frame ? "frame" : ""}
      {...props}
    >
      {frame ? <SidebarTrigger aria-label="Toggle main sidebar" /> : null}
      {children}
    </div>
  );
}
