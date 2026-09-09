// SPDX-License-Identifier: AGPL-3.0-only
// The sixth screen, the build's own question as the terminal's last one asks
// it: the first workspace's name, and a folder on this computer whose project
// lands on it, which may stay empty.
import { useState } from "react";
import { CLOUD_SETUP_WORDS } from "@wsp/protocol";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";
import { CARD, ROW, ROW_LINE, STATE_WORD, SetupFrame } from "./grammar.js";

/** The name a first workspace takes when nobody names one; the terminal's own default. */
export const FIRST_WORKSPACE = "first";
export const ASK_WORDS = { title: CLOUD_SETUP_WORDS.build.label, headline: "Your first workspace", name: "Name", folder: "Project folder", optional: "optional", counter: "6/6" } as const;

export function SetupAsk({ onBuild, onBack, refusal }: { onBuild: (o: { firstWorkspace: string; importFolder?: string }) => void; onBack: () => void; refusal: string | null }) {
  const [name, setName] = useState(FIRST_WORKSPACE);
  const [folder, setFolder] = useState("");
  const ready = name.trim() !== "";
  const build = (): void => onBuild({ firstWorkspace: name.trim(), ...(folder.trim() !== "" ? { importFolder: folder.trim() } : {}) });
  return (
    <SetupFrame k="ask" label={ASK_WORDS.title} counter={ASK_WORDS.counter} headline={ASK_WORDS.headline} refusal={refusal} primary={{ word: CLOUD_SETUP_WORDS.screen.build, onPress: build, disabled: !ready, focus: false }} secondary={{ word: CLOUD_SETUP_WORDS.screen.back, onPress: onBack }}>
      <ul className={CARD}>
        <li className={cn(ROW, ROW_LINE)}>
          <label htmlFor="setup-first-name" className="w-48 shrink-0 text-sm text-foreground">
            {ASK_WORDS.name}
          </label>
          <Input id="setup-first-name" size="sm" autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => (e.key === "Enter" && ready ? build() : undefined)} className="min-w-0 flex-1 rounded-sm border border-input bg-transparent font-mono text-xs" />
        </li>
        <li className={cn(ROW, ROW_LINE)}>
          <label htmlFor="setup-first-folder" className="w-48 shrink-0 text-sm text-foreground">
            {ASK_WORDS.folder}
            <span className={cn(STATE_WORD, "ml-2")}>{ASK_WORDS.optional}</span>
          </label>
          <Input id="setup-first-folder" size="sm" value={folder} placeholder="~/code/project" spellCheck={false} onChange={e => setFolder(e.target.value)} onKeyDown={e => (e.key === "Enter" && ready ? build() : undefined)} className="min-w-0 flex-1 rounded-sm border border-input bg-transparent font-mono text-xs" />
        </li>
      </ul>
    </SetupFrame>
  );
}
