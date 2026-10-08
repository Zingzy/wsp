// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { Field } from "@/components/field";
import { Peek } from "@/components/peek";
import { Head, Section } from "@/components/section";
import { cn } from "@/lib/utils";
import pr from "@/assets/shots/w-slate-pr.webp";
import deploy from "@/assets/shots/w-slate-deploy.webp";
import cart from "@/assets/shots/w-slate-cart.webp";
import traffic from "@/assets/shots/w-slate-traffic.webp";
import explain from "@/assets/shots/w-slate-explain.webp";

const shot = (src: string, alt: string) => ({ src, alt });

const EXAMPLES = [
  { name: "Pull request", line: "Checks as they finish. A failed one goes back to the agent in one press.", shot: shot(pr, "A slate for pull request #212: its checks, a failed e2e run with Send to agent beside it, and Auto-merge.") },
  { name: "Deploy setup", line: "A field for a token the agent never sees. It goes straight into .env.", shot: shot(deploy, "A slate walking through a Vercel deploy setup, with a password field for a token the agent never sees.") },
  { name: "A long fix", line: "The plan as a checklist you can edit, with the files it changed.", shot: shot(cart, "A slate for a cart rounding fix: progress, an editable checklist, the files changed and a button to go on.") },
  { name: "Live numbers", line: "Traffic that refreshes every minute, without spending a turn.", shot: shot(traffic, "A slate of live redirect traffic: six numbers and a line chart of requests a minute.") },
  { name: "Explain it", line: "A diagram drawn to answer a question about the code.", shot: shot(explain, "A slate with a diagram of how a short link becomes a redirect.") },
];

export function Slate() {
  const [at, setAt] = useState(0);
  const picked = EXAMPLES[at]!;
  return (
    <div id="slate" className="relative isolate overflow-hidden border-y border-rule bg-ground">
      <div className="absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,black,transparent_55%)] opacity-60">
        <Field seed={7} />
      </div>
      <Section>
        <Head title="A mini app inside every thread.">
          Chat fills up with status updates, and a separate file means another window. Slate is a panel beside the thread that the agent builds and keeps current: checklists, live numbers, charts, forms and buttons. You press, it reads what you pressed.
        </Head>

        <div role="tablist" aria-label="Slate examples" className="mt-12 flex flex-wrap gap-2">
          {EXAMPLES.map((e, i) => (
            <button
              key={e.name}
              role="tab"
              aria-selected={i === at}
              onClick={() => setAt(i)}
              className={cn(
                "h-9 rounded-[9px] border px-3.5 text-[14px] backdrop-blur-md transition-colors duration-150",
                i === at ? "border-white/[0.14] bg-[#2a2622]/70 text-foreground" : "border-transparent bg-[#1a1816]/40 text-muted-foreground hover:bg-[#2a2622]/50 hover:text-foreground",
              )}
            >
              {e.name}
            </button>
          ))}
        </div>
        <p className="mt-4 h-6 text-[15px] text-muted-foreground">{picked.line}</p>

        <div className="mt-6 grid">
          {EXAMPLES.map((e, i) => (
            <Peek key={e.name} src={e.shot.src} alt={e.shot.alt} at="top" scale={0.86} wall="30% 55%" className={cn("col-start-1 row-start-1 aspect-[1.75] rounded-[16px] border border-white/[0.08] transition-opacity duration-300", i === at ? "opacity-100" : "pointer-events-none opacity-0")} />
          ))}
        </div>

        <dl className="mt-14 grid gap-8 sm:grid-cols-3">
          {[
            ["It reaches what the agent reaches.", "Your files, your command line tools and your MCP servers, on the computer the thread runs on."],
            ["It asks before it runs.", "Every command a slate runs waits for your yes the first time."],
            ["Any agent can make one.", "Claude Code, Codex and the rest write it with the same few tools."],
          ].map(([t, d]) => (
            <div key={t}>
              <dt className="text-[15px] font-medium text-foreground">{t}</dt>
              <dd className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">{d}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}
