// SPDX-License-Identifier: AGPL-3.0-only
// On macOS the frame row is the window's drag region and leaves room for the traffic lights; every control in it is
// no-drag. The frame row carries the sidebar toggle: at its start when the row is the page's, where the toggle
// stands where the sidebar would open; at its end when the row is the sidebar's, on the edge the toggle shuts.
import type { ComponentPropsWithoutRef } from "react";
import { SidebarTrigger } from "../components/ui/sidebar.js";
import { isDesktopMac } from "../lib/desktopShell.js";
import { cn } from "../lib/utils.js";

export function HeaderRow({ frame, toggleAt = "start", className, children, ...props }: ComponentPropsWithoutRef<"div"> & { readonly frame: boolean; readonly toggleAt?: "start" | "end" }) {
  return (
    <div
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] min-w-0 shrink-0 items-center gap-[calc(var(--header-gap)-var(--workspace-titlebar-control-size)/2)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
        frame ? "pl-[var(--header-frame-inset)]" : "pl-[calc(env(safe-area-inset-left)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)]",
        isDesktopMac() && "drag-region",
        className,
      )}
      data-header-row={frame ? "frame" : ""}
      {...props}
    >
      {frame && toggleAt === "start" ? <SidebarTrigger aria-label="Toggle main sidebar" /> : null}
      {children}
      {frame && toggleAt === "end" ? <SidebarTrigger aria-label="Toggle main sidebar" className="ml-auto" /> : null}
    </div>
  );
}
