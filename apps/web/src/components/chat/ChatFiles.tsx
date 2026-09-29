// SPDX-License-Identifier: AGPL-3.0-only
// The one way a file is drawn in the chat, above the composer for what is
// about to go and inside a person's message for what went: an image as a
// square thumbnail that opens it at full size in a dialog, any other file as a
// tile of the same height holding its name and its weight. A message whose
// image bytes this tab does not hold, a transcript replayed after a reload or
// one another client sent, has the runtime's record instead of pixels and
// draws the same muted mono line the command line prints.
import { FileTextIcon, FileXIcon, XIcon } from "lucide-react";
import { attachmentLine, fmtBytes, isImage, type AttachmentRecord } from "@wsp/protocol";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";
import type { ComposerFile } from "./composerFiles";
import { COMPOSER_WORDS } from "./composerWords";

function RemoveButton({ label, title, onRemove }: { label: string; title: string; onRemove: () => void }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label={label}
      title={title}
      onClick={onRemove}
      className="-end-1.5 -top-1.5 absolute size-5 rounded-full border border-border/60 bg-card opacity-0 transition-opacity group-hover/thumb:opacity-100 focus-visible:opacity-100"
    >
      <XIcon />
    </Button>
  );
}

/** One image at full size behind its thumbnail. The labels count the files of the message, as the refusal words do,
 * since two pastes of one clipboard carry the same name and a name alone would not tell the two buttons apart; the
 * name is the title and the alt text. */
export function ChatImageThumb({ image, at, onRemove }: { image: ComposerFile; at: number; onRemove?: () => void }) {
  return (
    <div className="group/thumb relative" data-chat-image={image.name}>
      <Dialog>
        <DialogTrigger
          render={
            <button
              type="button"
              aria-label={`Open image ${at} at full size`}
              title={image.name}
              className="block size-14 overflow-hidden rounded-lg border border-border/60 bg-card/50 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <img src={image.url} alt={image.name} className="size-full object-cover" />
        </DialogTrigger>
        <DialogPopup className="w-auto max-w-[90vw] p-2">
          <DialogTitle className="sr-only">{image.name}</DialogTitle>
          <img src={image.url} alt={image.name} className="max-h-[80vh] max-w-[86vw] rounded-md object-contain" />
        </DialogPopup>
      </Dialog>
      {onRemove ? <RemoveButton label={`Remove image ${at}`} title={`Remove ${image.name}`} onRemove={onRemove} /> : null}
    </div>
  );
}

/** A file that is not an image: a tile as tall as a thumbnail, its name over its weight. */
export function ChatFileTile({ name, size, at, onRemove }: { name: string; size: number; at: number; onRemove?: () => void }) {
  return (
    <div className="group/thumb relative" data-chat-file={name}>
      <div title={name} className="flex h-14 max-w-48 items-center gap-2 rounded-lg border border-border/60 bg-card/50 ps-2.5 pe-3">
        <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] leading-5 text-foreground">{name}</span>
          <span className="font-mono text-[11px] leading-4 text-muted-foreground tabular-nums">{fmtBytes(size)}</span>
        </div>
      </div>
      {onRemove ? <RemoveButton label={`Remove file ${at}`} title={`Remove ${name}`} onRemove={onRemove} /> : null}
    </div>
  );
}

/** What a message's files come to on screen: images as thumbnails where this tab holds their bytes, else one muted
 * mono line each, the words the command line prints on the person's turn; every other file as its tile, which its
 * record alone draws. */
export function ChatFileRow({ records, files }: { records: ReadonlyArray<AttachmentRecord>; files: ReadonlyArray<ComposerFile> }) {
  if (records.length === 0) return null;
  const held = files.length === records.length;
  const lines = held ? [] : records.filter(record => isImage(record.mediaType));
  const tiles = records.flatMap((record, index) => {
    const file = held ? files[index] : undefined;
    if (file?.url !== undefined) return [<ChatImageThumb key={file.id} image={file} at={index + 1} />];
    if (isImage(record.mediaType)) return [];
    return [<ChatFileTile key={`${record.name ?? "file"}:${index}`} name={record.name ?? "file"} size={record.bytes} at={index + 1} />];
  });
  return (
    <>
      {tiles.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5" data-chat-image-row="true">
          {tiles}
        </div>
      ) : null}
      {lines.length > 0 ? (
        <div className="mb-1 flex flex-col gap-0.5" data-chat-image-row="records">
          {lines.map((record, index) => (
            <span key={`${record.name ?? "image"}:${index}`} className="font-mono text-[11px] leading-4 text-muted-foreground">
              {attachmentLine(record)}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** A file the composer turned away: its name and the word Refused in the refusal's ink, the sentence why on its hover,
 * and its own remove. It is never sent. */
export function ChatRefusedFile({ name, why, onRemove }: { name: string; why: string; onRemove: () => void }) {
  return (
    <div className="group/thumb relative" data-composer-refused-file={name} title={why}>
      <div className="flex h-14 max-w-48 items-center gap-2 rounded-lg border border-border/60 ps-2.5 pe-3">
        <FileXIcon aria-hidden className="size-4 shrink-0 text-error-foreground" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] leading-5 text-muted-foreground">{name}</span>
          <span className="text-[11px] leading-4 text-error-foreground">{COMPOSER_WORDS.fileRefused}</span>
        </div>
      </div>
      <RemoveButton label={`Remove ${name}`} title={`Remove ${name}`} onRemove={onRemove} />
    </div>
  );
}
