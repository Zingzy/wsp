// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import { Head, Section } from "@/components/section";
import wall from "@/assets/wall/wall.webp";
import mp4 from "@/assets/clips/setup.mp4";
import webm from "@/assets/clips/setup.webm";
import poster from "@/assets/clips/setup-poster.jpg";

/** What Add a computer copies, in the order its steps ask. */
const COPIED = ["Coding agents, signed in", "MCP servers", "Command line tools", "Skills and plugins", "GitHub sign-in", "Your repos", "Git and shell settings"] as const;

/** The wizard as it was used, recorded in the real app; still, on its first frame, under reduced motion. */
function Clip() {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (el === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const seen = new IntersectionObserver(([entry]) => (entry?.isIntersecting ? void el.play().catch(() => {}) : el.pause()), { threshold: 0.3 });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return (
    <video
      ref={video}
      muted
      loop
      playsInline
      preload="metadata"
      poster={poster}
      aria-label="Adding a Linux computer called office-pc in wsp: picking it from the ssh config, the checks, then agents, MCP servers, command line tools, skills, plugins, GitHub, projects and shell settings, the setup running step by step, and office-pc ready."
      className="block h-auto w-full rounded-[12px] shadow-[0_30px_80px_-20px_rgb(0_0_0/0.7),0_0_0_1px_rgb(0_0_0/0.45)]"
    >
      <source src={webm} type="video/webm" />
      <source src={mp4} type="video/mp4" />
    </video>
  );
}

export function Computers() {
  return (
    <Section id="computers">
      <Head title="Add a computer. Your setup comes with it.">
        Point wsp at a Linux computer you can reach over SSH. You pick what comes along, and it joins your sidebar ready to work.
      </Head>
      <div className="mt-14 grid items-start gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14">
        <div className="relative isolate overflow-hidden rounded-[20px] border border-white/[0.08] p-[6%] sm:rounded-[24px]">
          <img src={wall} alt="" aria-hidden decoding="async" draggable={false} className="absolute inset-0 -z-10 size-full object-cover select-none" />
          <Clip />
        </div>
        <div className="lg:pt-2">
          <ul>
            {COPIED.map(what => (
              <li key={what} className="border-t border-rule py-3.5 text-[16px] tracking-[-0.01em] text-foreground first:border-t-0 first:pt-0">
                {what}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[14px] leading-relaxed text-faint">A computer behind a firewall can dial out to you instead, so nothing on it has to be open.</p>
        </div>
      </div>
    </Section>
  );
}
