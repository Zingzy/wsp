// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyCommand } from "@/components/copy-command";
import clouds from "@/assets/clouds.webp";
import { Dither } from "@/components/dither";
import { Download } from "@/components/download";
import { DOCS, INSTALL } from "@/links";

const HERO_FADE = [0.2, 0.14] as const;

export function Hero() {
  return (
    <section id="top" className="relative isolate overflow-hidden">
      <Dither src={clouds} fade={HERO_FADE} hole={0.98} className="absolute top-0 left-0 -z-10" />
      <div className="hero-out mx-auto flex min-h-svh max-w-7xl flex-col items-center justify-center px-5 pt-48 pb-16 text-center sm:px-8">
        <h1
          className="dither-in font-display text-[clamp(2.6rem,8.6vw,6rem)] leading-[1.04] text-foreground"
          style={{ "--delay": "80ms" } as React.CSSProperties}
        >
          Give every agent{" "}
          <br className="hidden sm:inline" />
          its own copy{" "}
          <br className="hidden sm:inline" />
          of your machine.
        </h1>
        <p
          className="dither-in mt-16 max-w-[36rem] text-lg leading-[1.6] text-foreground/85 sm:text-xl"
          style={{ "--delay": "260ms" } as React.CSSProperties}
        >
          Your agents, tools and sign-ins, sealed into one image. Cloud machines forked from it in about twenty
          seconds, with Claude Code and Codex working inside as threads.
        </p>
        <div
          className="dither-in mt-16 flex flex-col items-center gap-5 sm:flex-row"
          style={{ "--delay": "420ms" } as React.CSSProperties}
        >
          <Download />
          <Button
            render={<a href={DOCS} />}
            nativeButton={false}
            variant="ghost"
            size="lg"
            className="h-12 gap-1.5 rounded-none px-4 text-base text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            Read the docs
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        </div>
        <div className="dither-in mt-6" style={{ "--delay": "500ms" } as React.CSSProperties}>
          <CopyCommand command={INSTALL} size="lg" />
        </div>
        <p
          className="dither-in mt-12 font-mono text-[12px] tracking-wide text-muted-foreground/80 uppercase"
          style={{ "--delay": "560ms" } as React.CSSProperties}
        >
          <span className="inline-flex flex-wrap justify-center gap-x-5 gap-y-1">
            <span>macOS and Linux</span>
            <span>Node 22</span>
            <span>AGPL-3.0</span>
            <span>no hosted service in between</span>
          </span>
        </p>
      </div>
    </section>
  );
}
