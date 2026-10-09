// SPDX-License-Identifier: AGPL-3.0-only
// A part of the app shown as the app: a photograph of the real window, its glass, corners and edge the Mac's own, over
// the wallpaper it was photographed on. `at` is where the
// window sits: a corner leaves that corner's two edges in view and runs the rest off the panel, `top` centres it with
// the wallpaper above it and runs it off the bottom. `scale` is the window's width over the panel's.
import { cn } from "@/lib/utils";
import dunes from "@/assets/wall/wall.webp";

export type At = "tl" | "tr" | "bl" | "br" | "top";

const PLACE: Record<At, string> = {
  tl: "top-[8%] left-[6%]",
  tr: "top-[8%] right-[6%]",
  bl: "bottom-[8%] left-[6%]",
  br: "bottom-[8%] right-[6%]",
  top: "top-[8%] left-1/2 -translate-x-1/2",
};

/** `size` is the window's own size in CSS pixels, which the shot is twice; `wall` is where in the wallpaper this panel
 * looks, so panels side by side are not the same picture. */
export function Peek({
  src,
  alt,
  at,
  scale = 1.3,
  size = [1280, 800],
  wall = "50% 50%",
  className,
}: {
  src: string;
  alt: string;
  at: At;
  scale?: number;
  size?: [number, number];
  wall?: string;
  className?: string;
}) {
  const [w, h] = size;
  return (
    <div className={cn("relative isolate overflow-hidden bg-[#1a0d06]", className)}>
      <img src={dunes} alt="" aria-hidden loading="lazy" decoding="async" draggable={false} className="absolute inset-0 -z-10 size-full scale-110 object-cover select-none" style={{ objectPosition: wall }} />
      <div
        className={cn("absolute shadow-[0_30px_80px_-10px_rgb(0_0_0/0.6)]", PLACE[at])}
        style={{ width: `${scale * 100}%`, aspectRatio: `${w} / ${h}`, borderRadius: `${(17 / w) * 100}% / ${(17 / h) * 100}%` }}
      >
        <img src={src} alt={alt} width={w} height={h} loading="lazy" decoding="async" draggable={false} className="block size-full select-none" />
      </div>
    </div>
  );
}
