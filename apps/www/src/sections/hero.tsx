// SPDX-License-Identifier: AGPL-3.0-only
import { Install } from "@/components/download";
import { Field } from "@/components/field";
import hero from "@/assets/shots/w-hero.webp";
import hero800 from "@/assets/shots/w-hero-800.webp";
import hero1440 from "@/assets/shots/w-hero-1440.webp";
import { WALL } from "@/wall";

export function Hero() {
  return (
    <section id="top" className="relative isolate overflow-x-clip pt-32 pb-8 sm:pt-40">
      <div className="absolute inset-x-0 top-0 -z-10 h-[1100px] [mask-image:radial-gradient(110%_60%_at_50%_52%,black_25%,transparent_70%)] sm:h-[1240px]">
        <Field className="opacity-[0.85]" />
        <div className="absolute inset-0 bg-[radial-gradient(60%_42%_at_30%_22%,var(--background)_35%,transparent_100%)]" />
      </div>

      <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
        <h1 className="display rise max-w-[15ch] text-[44px] sm:text-[64px] lg:text-[76px]">Coding agents on every computer you own.</h1>
        <p className="lede rise mt-6 max-w-[560px] text-[17px] [animation-delay:80ms] sm:text-[19px]">
          Run Claude Code, Codex and more on your Mac, an old laptop or a server you rent, all from one window. They can start each other on any of them.
        </p>
        <Install className="rise mt-9 [animation-delay:160ms]" />
      </div>

      <div className="rise mx-auto mt-16 max-w-[1320px] px-3 [animation-delay:260ms] sm:mt-20 sm:px-6">
        <div className="relative isolate overflow-hidden rounded-[20px] border border-white/[0.08] px-[4%] pt-[4%] pb-[4%] sm:rounded-[24px]">
          <img
            {...WALL}
            sizes="(min-width: 1320px) 1272px, 100vw"
            alt=""
            aria-hidden
            fetchPriority="high"
            decoding="async"
            draggable={false}
            className="absolute inset-0 -z-10 size-full object-cover select-none"
          />
          <img
            src={hero}
            srcSet={`${hero800} 800w, ${hero1440} 1440w, ${hero} 2880w`}
            sizes="(min-width: 1320px) 1170px, 92vw"
            width={1440}
            height={900}
            alt="The wsp app: a coordinator thread on a MacBook Pro has handed its tickets to Claude Code and Codex threads on five computers, with its board of the night's landings in the slate beside it."
            fetchPriority="high"
            decoding="async"
            draggable={false}
            className="block h-auto w-full rounded-[1.2%/1.9%] shadow-[0_40px_90px_-20px_rgb(0_0_0/0.7),0_0_0_1px_rgb(0_0_0/0.45)] select-none"
          />
        </div>
      </div>
    </section>
  );
}
