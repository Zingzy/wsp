// SPDX-License-Identifier: AGPL-3.0-only
// The last question before the build, as the terminal's last screen asks it:
// the first cloud workspace's name, and a folder on this computer whose
// project lands on it, which may stay empty. Two bare fields in the key
// field's grammar, 24 px apart, the folder's Choose keycap inside its right
// end where the desktop bridge is there; a folder dragged onto it or typed
// works everywhere.
import { useState, type DragEvent } from "react";
import { CLOUD_SETUP_WORDS, FIRST_WORKSPACE, initForkLine, type InitSetup } from "@wsp/protocol";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { desktopBridge } from "../../lib/desktopShell.js";
import { cn } from "../../lib/utils.js";
import { carriesFiles, droppedFolder } from "../folderDrag.js";
import { FIELD_LABEL, LONE_FIELD, STATE_WORD } from "./rows.js";
import { SetupScreen } from "./SetupScreen.js";

export function SetupAsk({ setup, counter, onBuild, onBack, refusal }: { setup: InitSetup; counter: string; onBuild: (o: { firstWorkspace: string; importFolder?: string }) => void; onBack: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.ask;
  const bridge = desktopBridge();
  const [name, setName] = useState(FIRST_WORKSPACE);
  const [folder, setFolder] = useState("");
  const ready = name.trim() !== "";
  const build = (): void => onBuild({ firstWorkspace: name.trim(), ...(folder.trim() !== "" ? { importFolder: folder.trim() } : {}) });
  const choose = async (): Promise<void> => {
    const picked = await bridge?.pickFolder?.();
    if (picked !== undefined) setFolder(picked);
  };
  const drop = (e: DragEvent<HTMLElement>): void => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    const file = droppedFolder(e.dataTransfer);
    const path = file !== null ? bridge?.droppedPath?.(file) : undefined;
    if (path !== undefined) setFolder(path);
  };
  const canChoose = bridge?.pickFolder !== undefined;
  return (
    <SetupScreen k="ask" counter={counter} headline={words.headline} top={setup.pricing !== null ? initForkLine(setup.pricing.size) : words.top} refusal={refusal} primary={{ word: CLOUD_SETUP_WORDS.screen.build, onPress: build, disabled: !ready, focus: false, title: words.needsName }} secondary={{ word: CLOUD_SETUP_WORDS.screen.back, onPress: onBack }}>
      <div className="flex w-full flex-col gap-2">
        <label htmlFor="setup-first-name" className={FIELD_LABEL}>
          {words.name}
        </label>
        <Input id="setup-first-name" size="compact" autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => (e.key === "Enter" && ready ? build() : undefined)} className={LONE_FIELD} />
      </div>
      <div className="mt-6 flex w-full flex-col gap-2" onDragOver={e => (carriesFiles(e.dataTransfer) ? e.preventDefault() : undefined)} onDrop={drop} data-k="folder-row">
        <label htmlFor="setup-first-folder" className={FIELD_LABEL}>
          {words.folder}
          <span className={cn(STATE_WORD, "ml-2")}>{words.optional}</span>
        </label>
        <div className="relative w-full">
          <Input id="setup-first-folder" size="compact" value={folder} placeholder={`${setup.home}/code/project`} spellCheck={false} onChange={e => setFolder(e.target.value)} onKeyDown={e => (e.key === "Enter" && ready ? build() : undefined)} className={cn(LONE_FIELD, "min-w-0", canChoose && "[&_input]:pr-[96px]")} />
          {canChoose ? (
            <Button data-k="choose" size="sm" variant="outline" className="absolute top-2 right-2 h-8 font-mono text-xs sm:h-8 sm:text-xs" onClick={() => void choose()}>
              {words.choose}
            </Button>
          ) : null}
        </div>
      </div>
    </SetupScreen>
  );
}
