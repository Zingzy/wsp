// SPDX-License-Identifier: AGPL-3.0-only
// The whole chat takes a dropped file, not the box alone, and says so while a
// file is over it: the settings card drawn large over the chat, with the
// attach glyph, what a drop does and the caps a file meets. The chat is the view the composer stands in
// ([data-chat-view]), or the composer's own box where it stands in none. A
// file let go anywhere in it is the browser's to open otherwise, which in the
// desktop app would load the file in place of the app, so a drop that the
// composer cannot take now is swallowed and no frame is drawn for it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PaperclipIcon } from "lucide-react";
import { FILE_MAX_WORDS, FILES_MAX, IMAGE_MAX_WORDS, IMAGE_TYPE_WORDS } from "@wsp/protocol";
import { GLYPH_FRAME } from "../../settings/grid";
import { NOTE, SETTING_TITLE } from "../../settings/layout";
import { CARD_SURFACE } from "../../settings/rows";
import { cn } from "../../lib/utils";

export const DROP_WORDS = {
  title: "Drop files to attach",
  caps: `At most ${FILES_MAX}: an image (${IMAGE_TYPE_WORDS}) up to ${IMAGE_MAX_WORDS}, any other file up to ${FILE_MAX_WORDS}.`,
} as const;

const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") === true;

/** Listens on the chat around `anchor` for files dragged over it, hands a drop to `take` while `enabled`, and returns
 * the frame to render while a file is over it. */
export function useChatDropZone(anchor: RefObject<HTMLElement | null>, take: (files: File[]) => void, enabled: boolean): ReactNode {
  const [chat, setChat] = useState<HTMLElement | null>(null);
  const [over, setOver] = useState(false);
  const takeRef = useRef(take);
  takeRef.current = take;
  useLayoutEffect(() => {
    const at = anchor.current;
    setChat(at?.closest<HTMLElement>("[data-chat-view]") ?? at);
  }, [anchor]);
  useEffect(() => {
    if (chat === null) return;
    // Enter and leave fire for every child the pointer crosses, so the frame goes when the count of open enters does.
    let depth = 0;
    const onEnter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth += 1;
      if (enabled) setOver(true);
    };
    const onOver = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = enabled ? "copy" : "none";
    };
    const onLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth = event.relatedTarget === null ? 0 : Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const onDrop = (event: DragEvent): void => {
      depth = 0;
      setOver(false);
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (enabled) takeRef.current([...(event.dataTransfer?.files ?? [])]);
    };
    chat.addEventListener("dragenter", onEnter);
    chat.addEventListener("dragover", onOver);
    chat.addEventListener("dragleave", onLeave);
    chat.addEventListener("drop", onDrop);
    return () => {
      chat.removeEventListener("dragenter", onEnter);
      chat.removeEventListener("dragover", onOver);
      chat.removeEventListener("dragleave", onLeave);
      chat.removeEventListener("drop", onDrop);
      setOver(false);
    };
  }, [chat, enabled]);
  return over && chat !== null ? createPortal(<ChatDropFrame />, chat) : null;
}

function ChatDropFrame() {
  return (
    <div data-chat-drop-zone className="pointer-events-none absolute inset-0 z-30 flex bg-background/80 p-3 off-mac:glass-backdrop sm:p-5">
      <div className={cn(CARD_SURFACE, "flex flex-1 flex-col items-center justify-center gap-3 bg-foreground/[0.03] px-6 text-center")}>
        <span className={GLYPH_FRAME}>
          <PaperclipIcon aria-hidden className="size-4 text-foreground/80" />
        </span>
        <div className="flex max-w-80 flex-col gap-1">
          <p className={SETTING_TITLE}>{DROP_WORDS.title}</p>
          <p className={NOTE}>{DROP_WORDS.caps}</p>
        </div>
      </div>
    </div>
  );
}
