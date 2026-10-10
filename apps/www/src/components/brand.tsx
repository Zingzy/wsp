// SPDX-License-Identifier: AGPL-3.0-only
// The app's lockup (apps/web/src/brand): the tilde mark, raised like the brand avatar's, beside the stroked wordmark.
import { cn } from "@/lib/utils";

export function Lockup({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-[0.32em] text-foreground", className)}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="h-[0.86em] w-auto" aria-hidden>
        <path d="M1.6 8A3.4 3.4 0 0 1 8 8A3.4 3.4 0 0 0 14.4 8" transform="translate(0 0.5)" opacity="0.6" />
        <path d="M1.6 8A3.4 3.4 0 0 1 8 8A3.4 3.4 0 0 0 14.4 8" />
      </svg>
      <svg viewBox="0 0 34 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[0.78em] w-auto" aria-hidden>
        <path d="M1 1L3.5 9L6 3L8.5 9L11 1" />
        <path d="M20.9 3A2.4 2 0 1 0 18.5 5A2.4 2 0 1 1 16.1 7" />
        <path d="M26 1V13M26 1H29A4 4 0 0 1 29 9H26" />
      </svg>
      <span className="sr-only">wsp</span>
    </span>
  );
}

/** The prompt glyph the app puts before a project's name. */
export function Prompt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn("text-amber", className)} aria-hidden>
      <path d="M4 17l6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  );
}
