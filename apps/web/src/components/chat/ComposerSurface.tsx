// Adapted from pingdotgg/t3code apps/web/src/components/chat/ComposerSurface.tsx at 57a66608 (MIT).
// Differs from upstream: the two class strings scoped to upstream's own named theme are dropped; ours has no such theme id.
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/** One glass backdrop until a top attachment needs the composer to cover its overlap. */
function Shell({
  contextStrip = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextStrip?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      className={cn(
        "group/composer-surface relative isolate mx-auto w-full max-w-3xl",
        // Glass the page shows through: a faint tint of the ink over the blur, never a slab of the card, and a hairline.
        // The one pane that frosts on the Mac too: the owner wants the page under it to show (2026-09-27, 2026-09-30).
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-glass-opacity:55%] [--chat-composer-outline:rgb(0_0_0/10%)]",
        "dark:[--chat-composer-glass-surface:var(--foreground)] dark:[--chat-composer-glass-opacity:3%] dark:[--chat-composer-highlight:rgb(255_255_255/4%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_9%,transparent)]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-[22px] before:bg-[color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--chat-composer-glass-opacity),transparent)] before:glass-backdrop before:transition-[background-color] before:duration-200 before:ease-out motion-reduce:before:transition-none",
        "not-supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden",
        // The strip under the box is quiet text on the page, so the glass stops at the box's own foot.
        contextStrip && "[--chat-composer-context-extension:2rem] sm:[--chat-composer-context-extension:1.75rem] before:bottom-(--chat-composer-context-extension)",
        className,
      )}
      {...props}
    />
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:shadow-[inset_0_1px_var(--chat-composer-highlight)]";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-[22px] shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] after:z-1 dark:shadow-none",
        outlineClasses,
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "group relative z-10 rounded-[22px] p-px transition-colors duration-200",
        outlineClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:bg-[color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--chat-composer-glass-opacity),transparent)] group-has-data-[composer-banner-surface=attached]/composer-surface:glass-backdrop",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "not-supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}

/** The line under the box: the folder, the access and the branch as quiet text on the page, no tray around them. */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "@container/strip relative mx-auto mt-1 flex h-7 w-[calc(100%-2*var(--chat-composer-drawer-inset))] items-center gap-1 overflow-x-clip overflow-y-visible ps-1 pe-2 sm:h-6",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
