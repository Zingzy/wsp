// SPDX-License-Identifier: AGPL-3.0-only
import { track } from "@/lib/analytics";
import { useState, type FormEvent } from "react";
import { ArrowRight, Check } from "lucide-react";
import { CopyCommand } from "@/components/copy-command";
import { DOWNLOADS, platformOf, type Platform } from "@/downloads";
import { INSTALL } from "@/links";
import { cn } from "@/lib/utils";

const visitor = (): Platform => (typeof navigator === "undefined" ? "mac" : platformOf(navigator.userAgent));

function AppleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 814 1000" fill="currentColor" className={className} aria-hidden>
      <path d="M788 341c-6 4-108 62-108 190 0 149 131 202 135 203-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-164-40c-76 0-104 41-166 41s-106-57-156-127C46 792 0 666 0 546c0-193 125-295 249-295 66 0 121 43 162 43 39 0 101-46 176-46 29 0 131 3 201 93zM555 159c31-37 53-88 53-139 0-7-1-14-2-20-50 2-110 34-146 76-28 32-55 83-55 135 0 8 1 16 2 18 3 1 8 1 13 1 45 0 101-30 135-71z" />
    </svg>
  );
}

function LinuxGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4 17l6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  );
}

/** Where a Windows visitor leaves an email. The function behind /api/waitlist adds it to the list we write to once. */
export function Waitlist({ className }: { className?: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">("idle");

  const join = async (event: FormEvent) => {
    event.preventDefault();
    setState("sending");
    try {
      const sent = await fetch("/api/waitlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      setState(sent.ok ? "done" : "failed");
      if (sent.ok) track("waitlist_joined");
    } catch {
      setState("failed");
    }
  };

  if (state === "done")
    return (
      <p className={cn("flex h-11 items-center gap-2 text-[15px] text-foreground", className)}>
        <Check className="size-4 text-success" /> You're on the list. We'll write once, when it's ready.
      </p>
    );

  return (
    <div className={className}>
      <form onSubmit={join} className="flex w-full max-w-[420px] items-center gap-2">
        <label htmlFor="waitlist-email" className="sr-only">
          Email
        </label>
        <input
          id="waitlist-email"
          type="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="keycap h-11 min-w-0 flex-1 rounded-[10px] px-3.5 text-[15px] placeholder:text-faint focus:outline-none focus-visible:border-foreground/30"
        />
        <button
          type="submit"
          disabled={state === "sending"}
          className="key inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[10px] px-4 text-[15px] font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          Join the waitlist <ArrowRight className="size-4" />
        </button>
      </form>
      <p className="mt-3 text-[13px] text-muted-foreground">
        {state === "failed" ? "That didn't go through. Write to hello@usewsp.com and we'll add you." : "wsp for Windows is on the way. Mac and Linux run it today."}
      </p>
    </div>
  );
}

/** The install, matched to the visitor: the app's own download on a Mac or Linux, the waitlist on Windows. */
export function Install({ className, align = "start" }: { className?: string; align?: "start" | "center" }) {
  const platform = visitor();
  if (platform === "windows") return <Waitlist className={cn(align === "center" && "flex flex-col items-center text-center", className)} />;
  const other = platform === "mac" ? "linux" : "mac";
  return (
    <div className={cn("flex flex-wrap items-center gap-3", align === "center" && "justify-center", className)}>
      <a
        href={DOWNLOADS[platform].href}
        className="key inline-flex h-11 items-center gap-2 rounded-[10px] px-4.5 text-[15px] font-medium transition-opacity duration-150 hover:opacity-90"
      >
        {platform === "mac" ? <AppleGlyph className="size-4 -translate-y-px" /> : <LinuxGlyph className="size-4" />}
        {DOWNLOADS[platform].label}
      </a>
      <CopyCommand command={INSTALL} shown="curl -fsSL usewsp.com/install | sh" className="hidden sm:inline-flex" />
      <a href={DOWNLOADS[other].href} aria-label={DOWNLOADS[other].label} className="px-1 text-[14px] text-muted-foreground transition-colors duration-150 hover:text-foreground">
        or {DOWNLOADS[other].label.replace("Download for", "for")}
      </a>
    </div>
  );
}
