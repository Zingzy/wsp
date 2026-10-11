// SPDX-License-Identifier: AGPL-3.0-only
// The sheet a project's image is chosen in: the file fitted to the one PNG a
// project wears, shown at the sizes it draws at on the person's own light and
// dark themes, and kept only on Use image. Another file dropped or pasted on
// the sheet replaces the one shown.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { PROJECT_ICON_TYPES } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Spinner } from "../components/ui/spinner.js";
import { useStore } from "../protocol/store.js";
import { PROJECTS_WORDS, SETTINGS_WORDS } from "../settings/format.js";
import { RefusalSlot, type Refusal } from "../settings/sheetParts.js";
import { themeFor } from "../themes/index.js";
import { fitProjectIcon } from "./imageFile.js";
import { ProjectIconImage } from "./look.js";

/** The types the file chooser offers. */
export const IMAGE_ACCEPT = PROJECT_ICON_TYPES.join(",");

/** One theme's ground in its own sidebar fill, the image on it at 12, 16 and 40 px on one baseline. */
function Ground({ side, src, fitting }: { side: "light" | "dark"; src: string | undefined; fitting: boolean }) {
  const picked = useStore(s => (side === "light" ? s.preferences.lightTheme : s.preferences.darkTheme));
  const theme = themeFor(side, picked);
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <div data-theme={theme.id} data-k={`project-icon-${side}`} className="flex h-20 w-full items-end justify-center gap-4 rounded-lg border border-border bg-sidebar px-4 pb-5 text-sidebar-foreground">
        {fitting ? (
          <Spinner className="mb-1 size-4 self-center text-muted-foreground" />
        ) : src === undefined ? null : (
          <>
            <ProjectIconImage src={src} className="size-3" />
            <ProjectIconImage src={src} className="size-4" />
            <ProjectIconImage src={src} className="size-10" />
          </>
        )}
      </div>
      <span className="text-xs text-muted-foreground">{theme.word}</span>
    </div>
  );
}

/** The sheet over a file the person picked. `use` keeps the fitted PNG and answers a refusal, or nothing once kept. */
export function ProjectIconDialog({ file, onFile, onClose, use }: { file: Blob | null; onFile: (file: Blob) => void; onClose: () => void; use: (png: Blob) => Promise<Refusal | null> }) {
  const [fitted, setFitted] = useState<{ png: Blob; src: string } | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (file === null) return;
    let live = true;
    let src: string | undefined;
    setFitted(null);
    setRefusal(null);
    void fitProjectIcon(file).then(fit => {
      if (!live) return;
      if ("refusal" in fit) {
        setRefusal(fit.refusal);
        return;
      }
      src = URL.createObjectURL(fit.png);
      setFitted({ png: fit.png, src });
    });
    return () => {
      live = false;
      if (src !== undefined) URL.revokeObjectURL(src);
    };
  }, [file]);
  const save = async (): Promise<void> => {
    if (fitted === null || saving) return;
    setSaving(true);
    const said = await use(fitted.png);
    setSaving(false);
    if (said === null) onClose();
    else setRefusal(said);
  };
  const fitting = file !== null && fitted === null && refusal === null;
  const take = (picked: File | undefined, event: { preventDefault(): void }): void => {
    if (picked === undefined) return;
    event.preventDefault();
    onFile(picked);
  };
  return (
    <Dialog open={file !== null} onOpenChange={next => (next ? undefined : onClose())}>
      <DialogPopup
        data-k="project-icon-sheet"
        onDragOver={(event: DragEvent) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event: DragEvent) => take(event.dataTransfer.files[0], event)}
        onPaste={(event: ClipboardEvent) => take(event.clipboardData.files[0], event)}
      >
        <DialogHeader>
          <DialogTitle>{PROJECTS_WORDS.imageTitle}</DialogTitle>
          <DialogDescription>{PROJECTS_WORDS.imageLine}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 pb-0">
          <div className="flex gap-3">
            <Ground side="light" src={fitted?.src} fitting={fitting} />
            <Ground side="dark" src={fitted?.src} fitting={fitting} />
          </div>
          <RefusalSlot k="project-icon-refusal" {...(refusal ?? {})} note={PROJECTS_WORDS.imageNote} />
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {SETTINGS_WORDS.cancel}
          </Button>
          <Button type="button" data-k="project-icon-use" disabled={fitted === null || saving} onClick={() => void save()}>
            {PROJECTS_WORDS.useImage}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A hidden file chooser and the sheet it opens: `choose` opens the chooser, `take` a file dropped or pasted. */
export function useImagePick(use: (png: Blob) => Promise<Refusal | null>): { choose: () => void; take: (file: Blob) => void; node: ReactNode } {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<Blob | null>(null);
  const node = (
    <>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        hidden
        data-k="project-icon-file"
        onChange={event => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (picked !== undefined) setFile(picked);
        }}
      />
      <ProjectIconDialog file={file} onFile={setFile} onClose={() => setFile(null)} use={use} />
    </>
  );
  return { choose: () => input.current?.click(), take: setFile, node };
}

