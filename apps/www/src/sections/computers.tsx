// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import { Head, Section } from "@/components/section";
import { WALL } from "@/wall";
import mp4 from "@/assets/clips/setup.mp4";
import webm from "@/assets/clips/setup.webm";
import poster from "@/assets/clips/setup-poster.jpg";

/** What Add a computer copies, in the order its steps ask, each with what the step offers. */
const COPIED = [
  ["Coding agents, signed in", "Claude Code, Codex, OpenCode and Cursor. Copy your key over or sign in fresh."],
  ["MCP servers", "The servers your agents call, along with their sign-ins."],
  ["Command line tools", "One click picks the ones your agents ran on your Mac."],
  ["Skills and plugins", "Copied from your Mac, so a skill does the same job on both."],
  ["GitHub sign-in", "Your Mac's token, or a new sign-in on the other computer."],
  ["Your repos", "Cloned there with the name, icon and colour you gave each one."],
  ["Git and shell settings", "Your git name and email, your prompt, tmux and the rest."],
] as const;

/** The wizard as it was used, recorded in the real app; still, on its first frame, under reduced motion. */
function Clip() {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (el === null) return;
    // The poster waits until the clip is a screen away; in the markup a phone would fetch it before the hero paints.
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        el.poster = poster;
        near.disconnect();
      },
      { rootMargin: "100% 0px" },
    );
    near.observe(el);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => near.disconnect();
    const seen = new IntersectionObserver(([entry]) => (entry?.isIntersecting ? void el.play().catch(() => {}) : el.pause()), { threshold: 0.3 });
    seen.observe(el);
    return () => {
      near.disconnect();
      seen.disconnect();
    };
  }, []);
  return (
    <video
      ref={video}
      muted
      loop
      playsInline
      preload="metadata"
      width={1000}
      height={1094}
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
          <img {...WALL} sizes="(min-width: 1024px) 640px, 100vw" alt="" aria-hidden loading="lazy" decoding="async" draggable={false} className="absolute inset-0 -z-10 size-full object-cover select-none" />
          <Clip />
        </div>
        <div className="lg:pt-2">
          <dl>
            {COPIED.map(([what, how]) => (
              <div key={what} className="border-t border-rule py-3.5 first:border-t-0 first:pt-0">
                <dt className="text-[16px] tracking-[-0.01em] text-foreground">{what}</dt>
                <dd className="mt-0.5 text-[14.5px] leading-relaxed text-muted-foreground">{how}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 text-[14px] leading-relaxed text-faint">A computer behind a firewall can dial out to you instead, so nothing on it has to be open.</p>
        </div>
      </div>
    </Section>
  );
}
