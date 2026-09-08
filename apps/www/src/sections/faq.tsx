// SPDX-License-Identifier: AGPL-3.0-only
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { EMAIL, REPO, SOLARI, X } from "@/links";

const QUESTIONS = [
  {
    q: "What does a workspace cost?",
    a: "Solari bills the machine while it runs. The two-core, 4 GB machines in the screenshots ran at $0.11 an hour and cost nothing while napping. wsp itself is free software; there is no plan and no seat.",
  },
  {
    q: "Do I need an account with wsp?",
    a: "No. There is no wsp service to sign up for. You need a Solari account for the machines and your own Claude or Codex sign-in, and both stay yours.",
  },
  {
    q: "Where do my sign-ins go?",
    a: "From your disk into your image, sent to the provider with your own key. wsp never sees them and has no server to send them to. The source is open, so you can read the exact path they take.",
  },
  {
    q: "Can I use my Claude subscription instead of an API key?",
    a: "Yes. During the first build the sign-in opens in your browser and lands on the machine, the same as it would on a new laptop. Codex signs in the same way. An API key works too.",
  },
  {
    q: "What happens when a machine is lost or I stop paying attention?",
    a: "An idle workspace naps with its RAM intact and wakes on the next message. A machine the provider loses is rebuilt from the image with your files back. Threads you left running are still there in the morning.",
  },
  {
    q: "Which agents run inside?",
    a: "Claude Code and Codex today, headless, as threads. Pi and Gemini are next. The agent on your own computer can be anything that speaks MCP: Claude Code, Codex, Gemini or OpenCode.",
  },
  {
    q: "Does it run on Linux?",
    a: "wsp runs on macOS and Linux with Node 22 or newer, and the desktop app ships for both. The machines themselves are Debian.",
  },
  {
    q: "What does AGPL mean for me?",
    a: "You can read, run, change and ship it. If you host a changed wsp for other people, they get the source too. Using it for your own work changes nothing about your code.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="scroll-mt-16 border-t border-border">
      <div className="mx-auto grid max-w-7xl gap-12 px-5 py-24 sm:px-8 lg:grid-cols-12 lg:py-32">
        <div className="rise lg:col-span-4">
          <h2 className="font-display-mid text-[clamp(2rem,4.6vw,3.25rem)] leading-[1.02]">Questions.</h2>
          <p className="mt-5 text-lg text-muted-foreground">
            The ones people ask before the first fork. Anything else, open an issue on{" "}
            <a href={REPO} className="text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground">
              GitHub
            </a>
            , write to{" "}
            <a href={`mailto:${EMAIL}`} className="text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground">
              {EMAIL}
            </a>{" "}
            or find me on{" "}
            <a href={X} className="text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground">
              X
            </a>
            . Machine prices are on the{" "}
            <a href={SOLARI} className="text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground">
              Solari
            </a>{" "}
            site.
          </p>
        </div>
        <div className="rise lg:col-span-8">
          <Accordion className="border-t border-border">
            {QUESTIONS.map(item => (
              <AccordionItem key={item.q} value={item.q} className="border-b border-border">
                <AccordionTrigger className="py-5 text-left text-[17px] font-medium hover:no-underline sm:text-lg">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="pb-6 text-[16px] leading-relaxed text-muted-foreground">
                  <p className="max-w-2xl">{item.a}</p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  );
}
