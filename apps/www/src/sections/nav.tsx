// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { Lockup } from "@/components/brand";
import { DOWNLOADS, useVisitor } from "@/downloads";
import { DOCS, REPO } from "@/links";
import { cn } from "@/lib/utils";

function GithubGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const platform = useVisitor();

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-30 border-b transition-[background-color,border-color] duration-200",
        scrolled ? "border-rule bg-background/80 backdrop-blur-md" : "border-transparent",
      )}
    >
      <nav className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 sm:px-6">
        <a href="/#top" aria-label="wsp" className="text-[22px]">
          <Lockup />
        </a>
        <div className="flex items-center gap-1 sm:gap-2">
          <a href={DOCS} className="rounded-md px-3 py-2 text-[14px] text-muted-foreground transition-colors duration-150 hover:text-foreground">
            Docs
          </a>
          <a href={REPO} aria-label="GitHub" className="flex items-center gap-2 rounded-md px-3 py-2 text-[14px] text-muted-foreground transition-colors duration-150 hover:text-foreground">
            <GithubGlyph className="size-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          <a
            href={platform === "windows" ? "/#get" : DOWNLOADS[platform].href}
            className="key ml-1 inline-flex h-8 items-center rounded-[8px] px-3 text-[13px] font-medium transition-opacity duration-150 hover:opacity-90"
          >
            {platform === "windows" ? "Get wsp" : "Download"}
          </a>
        </div>
      </nav>
    </header>
  );
}
