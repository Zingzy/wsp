// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { SystemDiagram, type Step } from "@/components/system-diagram";

type Beat = { id: Step; kicker: string; title: string; body: string; command?: string };

const BEATS: Beat[] = [
  {
    id: "seal",
    kicker: "wsp init",
    title: "Seal your setup once.",
    body: "Six screens, every row already ticked from what this computer runs: the agents, their tools, what else to bring, the sign-ins. Enter through them. The image builds once and rebuilds when your setup changes.",
    command: "wsp init",
  },
  {
    id: "fork",
    kicker: "wsp fork",
    title: "Fork it in about twenty seconds.",
    body: "A workspace is a fork of that image, with your agents, tools and logins already there. Snapshot one with a project loaded and fork from that. As many as you want to pay for.",
    command: "wsp fork b1 --name b2",
  },
  {
    id: "thread",
    kicker: "wsp thread",
    title: "Talk to what is inside.",
    body: "Claude Code and Codex run headless on the machine. Open a thread with a task, read the reply, send the next message, stop it. From the app, the command line, or the machine's own shell and ports, opened as tabs beside the thread.",
    command: 'wsp thread new --in b1 --agent claude "Fix the flaky terminal test"',
  },
  {
    id: "signin",
    kicker: "BROWSER=wsp-open",
    title: "Sign in on the machine, from your own browser.",
    body: "A tool on the machine asks for a browser. wsp catches the request, opens the page on your computer once you click, and tunnels the callback port back to the machine, so the token lands where the tool is waiting. Only the URL and the port travel, never the code. Claude Code, Codex, gh, gcloud and aws all sign in this way.",
  },
  {
    id: "agents",
    kicker: "over MCP",
    title: "Agents starting agents.",
    body: "The agent on your computer gets the same verbs as MCP tools. It forks a workspace, opens a Codex thread there for a second opinion, and reads it back. Every thread it opens shows up in your sidebar, marked with who opened it.",
  },
  {
    id: "keys",
    kicker: "no hosted service",
    title: "Your keys never leave your computer.",
    body: "wsp talks to the machine provider with your key. Your sign-ins go from your disk into your image and from there to your machines, nowhere else. There is no server of ours and no wsp account. The whole thing is AGPL.",
  },
  {
    id: "naps",
    kicker: "idle",
    title: "Naps and wakes.",
    body: "An idle workspace naps with its RAM intact and stops costing you. The next message wakes it. A machine the provider loses comes back from the image with your files on it.",
  },
];

export function Story() {
  const [active, setActive] = useState<Step>("seal");
  const refs = useRef<Map<Step, HTMLElement>>(new Map());

  useEffect(() => {
    // The active beat is the one nearest the lower half of the viewport, where the text sits under the pinned picture.
    const pick = () => {
      const target = window.innerHeight * 0.5;
      let best: { id: Step; distance: number } | null = null;
      for (const [id, el] of refs.current) {
        const rect = el.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - target);
        if (!best || distance < best.distance) best = { id, distance };
      }
      if (best) setActive(best.id);
    };
    pick();
    window.addEventListener("scroll", pick, { passive: true });
    window.addEventListener("resize", pick);
    return () => {
      window.removeEventListener("scroll", pick);
      window.removeEventListener("resize", pick);
    };
  }, []);

  return (
    <section id="story" className="scroll-mt-16 px-5 pt-24 sm:px-8 lg:pt-32">
      <div className="rise mx-auto max-w-3xl text-center">
        <h2 className="font-display-mid text-[clamp(2rem,5vw,3.5rem)] leading-[1.02]">Init once. Fork often. Talk to what is inside.</h2>
        <p className="mt-5 text-lg text-muted-foreground">
          The whole model in one picture. Your computer on the left, the provider on the right, and the one line your key crosses.
        </p>
      </div>

      <div className="-mx-5 mt-14 overflow-x-auto px-5 lg:hidden">
        <SystemDiagram step="all" className="min-w-[760px]" />
      </div>

      <div className="mx-auto mt-10 hidden max-w-[1560px] gap-10 lg:grid lg:grid-cols-12 lg:px-10 xl:gap-16 xl:px-16">
        <ol className="flex flex-col lg:col-span-4">
          {BEATS.map(beat => (
            <li
              key={beat.id}
              data-step={beat.id}
              ref={el => {
                if (el) refs.current.set(beat.id, el);
                else refs.current.delete(beat.id);
              }}
              className={cn("flex min-h-[72svh] flex-col justify-center py-8 transition-opacity duration-500", active === beat.id ? "opacity-100" : "opacity-35")}
            >
              <Beat beat={beat} />
            </li>
          ))}
        </ol>
        <div className="lg:col-span-8">
          <div className="sticky top-0 flex h-svh items-center">
            <SystemDiagram step={active} className="w-full" />
          </div>
        </div>
      </div>

      <ol className="mx-auto mt-12 flex max-w-2xl flex-col gap-14 lg:hidden">
        {BEATS.map(beat => (
          <li key={beat.id}>
            <Beat beat={beat} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Beat({ beat }: { beat: Beat }) {
  return (
    <>
      <p className="font-mono text-[12.5px] text-sky">{beat.kicker}</p>
      <h3 className="mt-3 font-display-mid text-[clamp(1.6rem,2.6vw,2.4rem)] leading-[1.05]">{beat.title}</h3>
      <p className="mt-4 max-w-md text-[17px] leading-relaxed text-muted-foreground">{beat.body}</p>
      {beat.command && (
        <p className="mt-4 font-mono text-[14px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
          <span className="text-sky">$ </span>
          {beat.command}
        </p>
      )}
    </>
  );
}
