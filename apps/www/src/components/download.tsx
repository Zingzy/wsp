// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowDownToLine } from "lucide-react";
import { cn } from "cn";
import { buttonVariants } from "@/components/ui/button";
import { DOWNLOADS, OTHER, platformOf } from "@/downloads";

// Both are plain anchors: they go somewhere, so a reader is told they are links, and the button's own look is
// borrowed from its variants rather than a second copy of the classes.
export function Download() {
  const first = platformOf(navigator.userAgent);
  const second = OTHER[first];
  return (
    <>
      <a
        href={DOWNLOADS[first].href}
        className={cn(buttonVariants({ size: "lg" }), "h-12 gap-2 rounded-none bg-sky px-5 text-base font-medium text-sky-foreground hover:bg-sky/85")}
      >
        <ArrowDownToLine data-icon="inline-start" />
        {DOWNLOADS[first].label}
      </a>
      <a href={DOWNLOADS[second].href} className="text-[15px] text-muted-foreground transition-colors hover:text-foreground">
        {DOWNLOADS[second].label}
      </a>
    </>
  );
}
