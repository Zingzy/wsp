// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowUpRight } from "lucide-react";
import { CopyCommand } from "@/components/copy-command";
import clouds from "@/assets/clouds.webp";
import { Dither } from "@/components/dither";
import { AUTHOR, EMAIL, INSTALL, ISSUES, NPM, README, RELEASES, REPO, SOLARI, X } from "@/links";
import { Wordmark } from "./nav";

const NEXT = [
  "Your own computer as a workspace, so agents start each other locally too",
  "Spaces: one workspace at a time in the sidebar, with its own tint",
  "Images in threads",
  "Pi and Gemini threads",
];

const CLOSING_FADE = [0.4, 0.12] as const;

export function Closing() {
  return (
    <section>
      <div className="relative isolate overflow-hidden">
        <Dither src={clouds} fade={CLOSING_FADE} hole={0.97} className="absolute top-0 left-0 -z-10" />
        <div className="rise mx-auto flex min-h-[70svh] max-w-7xl flex-col items-center justify-center px-5 py-24 text-center sm:px-8 lg:py-32">
          <h2 className="font-display text-[clamp(3rem,10vw,6rem)] leading-none">Fork it.</h2>
          <p className="mt-6 max-w-xl text-lg text-foreground/85">
            Node 22 or newer, a{" "}
            <a href={SOLARI} className="text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground">
              Solari
            </a>{" "}
            account for the machines, and a way for Claude Code or Codex to sign in. Twenty minutes to the first thread,
            most of it the image building.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <CopyCommand command={INSTALL} size="lg" />
            <a
              href={RELEASES}
              className="inline-flex h-12 items-center gap-1.5 px-4 text-base text-muted-foreground transition-colors hover:text-foreground"
            >
              Desktop app for macOS and Linux
              <ArrowUpRight className="size-4" />
            </a>
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-5 pb-16 sm:px-8">
        <div className="rise grid gap-10 border-t border-border pt-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <h3 className="font-display-low text-2xl">What is next</h3>
            <ul className="mt-4 flex flex-col gap-2 text-[16px] text-muted-foreground">
              {NEXT.map(item => (
                <li key={item} className="flex gap-3">
                  <span aria-hidden="true" className="mt-[0.7em] size-1.5 shrink-0 bg-sky" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="md:col-span-7 md:pl-10">
            <h3 className="font-display-low text-2xl">Bugs</h3>
            <p className="mt-4 max-w-xl text-[16px] text-muted-foreground">
              File them at{" "}
              <a href={ISSUES} className="text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground">
                github.com/Zingzy/wsp/issues
              </a>
              . Say what you ran, what you saw, and the output of <code className="font-mono text-[14px]">wsp --version</code>.
              Never paste a key.
            </p>
          </div>
        </div>

        <footer className="mt-20 grid gap-10 border-t border-border pt-10 font-mono text-[13px] text-muted-foreground md:grid-cols-12">
          <div className="flex flex-col gap-3 md:col-span-6">
            <Wordmark />
            <p>your setup, on cloud machines, for coding agents</p>
          </div>
          <div className="flex flex-col gap-2 md:col-span-3">
            <p className="text-foreground">project</p>
            <a href={REPO} className="hover:text-foreground">
              github
            </a>
            <a href={NPM} className="hover:text-foreground">
              npm
            </a>
            <a href={README} className="hover:text-foreground">
              readme
            </a>
            <a href={RELEASES} className="hover:text-foreground">
              releases
            </a>
            <a href={`${REPO}/blob/main/LICENSE`} className="hover:text-foreground">
              agpl-3.0
            </a>
          </div>
          <div className="flex flex-col gap-2 md:col-span-3">
            <p className="text-foreground">made by zingzy</p>
            <a href={X} className="hover:text-foreground">
              @AdityaSinghi5 on x
            </a>
            <a href={`mailto:${EMAIL}`} className="hover:text-foreground">
              {EMAIL}
            </a>
            <a href={AUTHOR} className="hover:text-foreground">
              github.com/Zingzy
            </a>
          </div>
        </footer>
        <p className="mt-10 font-mono text-[12px] text-muted-foreground/70">
          Type set in Redaction (MCKL, OFL). Clouds from Wikimedia Commons, CC0, dithered on your GPU.
        </p>
      </div>
    </section>
  );
}
