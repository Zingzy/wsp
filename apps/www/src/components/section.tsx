// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Every section's head: one claim, one or two sentences under it. */
export function Head({ title, children, className, center = false }: { title: ReactNode; children?: ReactNode; className?: string; center?: boolean }) {
  return (
    <div className={cn("max-w-[600px]", center && "mx-auto text-center", className)}>
      <h2 className="heading text-[32px] sm:text-[44px]">{title}</h2>
      {children !== undefined && <div className="lede mt-5 text-[17px] sm:text-[18px]">{children}</div>}
    </div>
  );
}

export function Section({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn("relative mx-auto max-w-[1200px] px-4 py-20 sm:px-6 sm:py-28", className)}>
      {children}
    </section>
  );
}
