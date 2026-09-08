// SPDX-License-Identifier: AGPL-3.0-only
import { CopyCommand } from "@/components/copy-command";
import { SPRITES, SpriteIcon } from "@/components/pixel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const AGENTS = [
  { id: "claude", label: "Claude Code", rows: SPRITES.claude, body: "fill-[oklch(0.75_0.15_40)]" },
  { id: "codex", label: "Codex", rows: SPRITES.codex, body: "fill-sky" },
  { id: "gemini", label: "Gemini CLI", rows: SPRITES.gemini, body: "fill-[oklch(0.72_0.16_300)]" },
  { id: "opencode", label: "OpenCode", rows: SPRITES.opencode, body: "fill-foreground" },
];

export function AgentSetup() {
  return (
    <section id="agents" className="scroll-mt-16">
      <div className="mx-auto flex max-w-7xl flex-col items-center px-5 py-24 text-center sm:px-8 lg:py-32">
        <h2 className="rise font-display-mid text-[clamp(2.25rem,5.4vw,4rem)] leading-[1.02]">Let your agent set you up.</h2>
        <p className="rise mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
          Give the agent you already use the wsp tools, then ask it. It reads what you use on this computer, writes the
          recipe, asks you about the heavy rows, builds the image, and hands you each sign-in link as the build reaches
          it. You click the links. That is the whole setup.
        </p>

        <Tabs defaultValue="claude" className="rise mt-14 w-full max-w-3xl items-center">
          <TabsList variant="line" className="h-auto gap-1 sm:gap-6">
            {AGENTS.map(agent => (
              <TabsTrigger key={agent.id} value={agent.id} className="h-auto gap-2 px-1.5 py-2 text-[13px] sm:px-2 sm:text-base">
                <SpriteIcon rows={agent.rows} body={agent.body} className="size-[18px] shrink-0" />
                {agent.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {AGENTS.map(agent => (
            <TabsContent key={agent.id} value={agent.id} className="mt-6 flex w-full flex-col items-center">
              <CopyCommand command={`wsp mcp install --agent ${agent.id}`} size="lg" className="text-[15px] sm:h-14 sm:px-6 sm:text-lg" />
            </TabsContent>
          ))}
        </Tabs>

        <p className="rise mt-12 font-serif text-3xl leading-snug text-foreground italic sm:text-4xl">"set up wsp for me"</p>
        <p className="mt-3 font-mono text-[13px] text-muted-foreground">the only thing you type after that</p>

        <p className="rise mt-16 max-w-2xl text-[16px] leading-relaxed text-muted-foreground">
          wsp installs into Claude Code, Codex, Gemini CLI and OpenCode, and all four get the same tools: the verbs the
          command line runs. Inside the machines, Claude Code and Codex run as threads today, with Pi and Gemini next.
        </p>
      </div>
    </section>
  );
}
