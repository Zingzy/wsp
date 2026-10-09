// SPDX-License-Identifier: AGPL-3.0-only
// The one way the page shows the app: a photograph of the real app at twice its size, inside a hairline shell. A shot
// of the whole window wears the Mac's own buttons where the app asks for them (apps/desktop/src/window.ts).
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Shot = { src: string; width: number; height: number; alt: string };

function Lights({ width, height }: { width: number; height: number }) {
  const w = width / 2;
  const h = height / 2;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden>
      {["#ff5f57", "#febc2e", "#28c840"].map((fill, i) => (
        <circle key={fill} cx={22 + i * 20} cy={25} r={6} fill={fill} stroke="rgb(0 0 0 / 0.18)" strokeWidth={0.5} />
      ))}
    </svg>
  );
}

export function Frame({ shot, className, priority = false, window = false, children }: { shot?: Shot; className?: string; priority?: boolean; window?: boolean; children?: ReactNode }) {
  return (
    <div
      className={cn(
        "relative rounded-[16px] border border-white/[0.09] bg-[#1d1a17]/70 p-[5px] shadow-[0_50px_100px_-30px_rgb(0_0_0/0.75),0_0_0_1px_rgb(0_0_0/0.55)]",
        className,
      )}
    >
      <div className="relative overflow-hidden rounded-[11px] border border-black/60 bg-background">
        {shot !== undefined && (
          <>
            <img
              src={shot.src}
              width={shot.width / 2}
              height={shot.height / 2}
              alt={shot.alt}
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              decoding="async"
              className="block h-auto w-full select-none"
              draggable={false}
            />
            {window && <Lights width={shot.width} height={shot.height} />}
          </>
        )}
        {children}
      </div>
    </div>
  );
}
