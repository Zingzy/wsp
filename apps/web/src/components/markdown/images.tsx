// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/ChatMarkdown.tsx at 57a66608 (MIT).
// Differs from upstream: useTheme is the resolvedTheme prop, getClientSettings().wordWrap is the wordWrap prop, the right-panel store is the onOpenFile prop; citations, the selection toolbar, asset images, the video player, toasts and PR link resolution are removed.
import { TriangleAlertIcon } from "lucide-react";
import React, { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { cn } from "../../lib/utils";

/** Resolves protocol-relative web references against the page's own protocol. */
export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
export const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

export function markdownImageCopy(alt: string, src: string, title: string | undefined): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const titleSuffix =
    title === undefined ? "" : ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `![${escapedAlt}](${src}${titleSuffix})`;
}

export function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(30 * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

export const MarkdownLinkContext = React.createContext(false);

export function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  src: string,
  alt: string,
  originalUrl?: string,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    onImageExpand({
      images: [
        {
          src,
          name: previewName,
          ...(originalUrl ? { originalUrl } : {}),
        },
      ],
      index: 0,
    });
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

export function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly kind?: "image" | "video";
}) {
  const label = props.kind === "video" ? "Video unavailable" : "Image unavailable";
  return (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        {props.alt.length > 0 ? `${label}: ${props.alt}` : label}
      </span>
    </span>
  );
}
