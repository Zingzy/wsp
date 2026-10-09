// SPDX-License-Identifier: AGPL-3.0-only
import { Head, Section } from "@/components/section";
import { Peek, type At } from "@/components/peek";
import { cn } from "@/lib/utils";
import agents from "@/assets/shots/w-agents.webp";
import browser from "@/assets/shots/w-browser.webp";
import terminal from "@/assets/shots/w-terminal.webp";
import editor from "@/assets/shots/w-editor.webp";
import pr from "@/assets/shots/w-pr.webp";
import usage from "@/assets/shots/w-usage.webp";

type Feature = { title: string; line: string; src: string; alt: string; at: At; scale: number; wall: string; wide?: boolean; size?: [number, number] };

const FEATURES: Feature[] = [
  {
    title: "Your terminal, your config.",
    line: "The terminal pane reads your Ghostty config, so the font, colours and transparency are yours. On your other computers too.",
    src: terminal,
    at: "tr",
    scale: 2.1,
    wall: "20% 40%",
    alt: "A thread with its terminal open in the colours from the person's Ghostty config, showing git log for the branch.",
  },
  {
    title: "Open it in your editor.",
    line: "VS Code, Cursor, Zed or JetBrains open the thread's folder, even when it's on another computer, over SSH.",
    src: editor,
    at: "tr",
    scale: 2.6,
    wall: "75% 30%",
    alt: "The Open menu on a Codex thread that runs on gpu-box, offering VS Code, Cursor and Zed.",
  },
  {
    title: "The pull request, beside the thread.",
    line: "Checks, review and merge without a browser tab. A failed check goes back to the agent in one press.",
    src: pr,
    at: "top",
    scale: 0.9,
    wall: "50% 60%",
    wide: true,
    alt: "Pull request #1161 beside the thread that built it: approved, eight checks passed, ready to merge, with its description.",
  },
  {
    title: "Every agent on every computer.",
    line: "See which agents are signed in where, and install another from the same pane.",
    src: agents,
    at: "tr",
    scale: 2.1,
    wall: "30% 70%",
    alt: "The Agents pane: Claude Code and Codex signed in, and Gemini CLI, OpenCode, Pi, Hermes, Crush and more to install.",
  },
  {
    title: "A browser for the dev server.",
    line: "The page the thread is building, open next to the thread that's building it.",
    src: browser,
    at: "tr",
    scale: 2.1,
    wall: "85% 55%",
    alt: "The browser pane showing the site the thread is serving on localhost:5420, beside the thread.",
  },
  {
    title: "Know what every agent used.",
    line: "Tokens and cost at list price, by agent, account, computer, project and model, with each plan's limits a tab away.",
    src: usage,
    at: "top",
    scale: 0.9,
    wall: "40% 40%",
    wide: true,
    alt: "The usage page: tokens a day for Claude Code and Codex, and the table by agent and model.",
  },
];

export function Features() {
  return (
    <Section id="features">
      <Head title="Everything around the thread.">The panes and pages that make a dozen agents on six computers feel like one desk.</Head>
      <div className="mt-14 grid gap-5 md:grid-cols-2">
        {FEATURES.map(f => (
          <figure key={f.title} className={cn("flex flex-col overflow-hidden rounded-[16px] border border-white/[0.08] bg-[#171513]", f.wide && "md:col-span-2")}>
            <figcaption className={cn("px-7 pt-7 pb-6", f.wide ? "md:flex md:items-end md:justify-between md:gap-10" : "min-h-[124px]")}>
              <h3 className="text-[18px] font-medium tracking-[-0.012em] text-foreground">{f.title}</h3>
              <p className={cn("mt-1.5 text-[15px] leading-relaxed text-muted-foreground", f.wide && "md:mt-0 md:max-w-[520px] md:text-right")}>{f.line}</p>
            </figcaption>
            <Peek src={f.src} alt={f.alt} at={f.at} scale={f.scale} size={f.size} wall={f.wall} className={cn("mt-auto", f.wide ? "aspect-[2.1]" : "aspect-[1.45]")} />
          </figure>
        ))}
      </div>
    </Section>
  );
}
