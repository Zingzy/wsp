// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/ChatMarkdown.tsx at 57a66608 (MIT).
// Differs from upstream: useTheme is the resolvedTheme prop, getClientSettings().wordWrap is the wordWrap prop, the right-panel store is the onOpenFile prop; citations, the selection toolbar, asset images, the video player, toasts, PR link resolution and the link favicon fetched from Google are removed.
import { FileIcon, GlobeIcon } from "lucide-react";
import React, { Children, memo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { extractMarkdownLinkHrefs, normalizeMarkdownLinkDestination, resolveInlineCodeFileLinkMeta, resolveMarkdownFileLinkMeta, rewriteMarkdownFileUriHref, type MarkdownFileLinkMeta } from "../../lib/markdownLinks";
import { cn } from "../../lib/utils";
import { Spaced } from "../ui/spaced";
import { WINDOWS_DRIVE_PATH_REGEX } from "./plugins";

interface MarkdownFileLinkProps {
  targetPath: string;
  displayPath: string;
  /** What the files panel opens: workspace-relative inside the workspace, the
      absolute host path outside it, null when the panel cannot show the file. */
  panelPath: string | null;
  line?: number | undefined;
  label: ReadonlyArray<string>;
  copyMarkdown: string;
  onOpenFile?: ((path: string, line?: number) => void) | undefined;
  className?: string | undefined;
}

const CHAT_FILE_TAG_CHIP_CLASS_NAME = CHAT_INLINE_CHIP_CLASS_NAME;
const MARKDOWN_FILE_CHIP_CLASS_NAME = "chat-markdown-file-link";
const MARKDOWN_FILE_LINK_CLASS_NAME = `${MARKDOWN_FILE_CHIP_CLASS_NAME} cursor-pointer transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70`;

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

/** The file chips a message draws, read off its text the way the page resolves them: the links and the inline code
 * that name a file, and the folder each chip adds to tell apart two files of one name. */
export interface MessageFileChips {
  readonly byHref: ReadonlyMap<string, MarkdownFileLinkMeta>;
  readonly byCode: ReadonlyMap<string, MarkdownFileLinkMeta>;
  readonly suffixByPath: ReadonlyMap<string, string>;
}

export function messageFileChips(text: string, cwd: string | undefined, baseDir: string | undefined = cwd): MessageFileChips {
  const byHref = new Map<string, MarkdownFileLinkMeta>();
  for (const href of extractMarkdownLinkHrefs(text)) {
    const key = normalizeMarkdownLinkHrefKey(href);
    if (byHref.has(key)) continue;
    const meta = resolveMarkdownFileLinkMeta(key, cwd, baseDir);
    if (meta) byHref.set(key, meta);
  }
  const byCode = new Map<string, MarkdownFileLinkMeta>();
  for (const span of extractInlineCodeSpans(text)) {
    if (byCode.has(span)) continue;
    const meta = resolveInlineCodeFileLinkMeta(span, cwd, baseDir);
    if (meta) byCode.set(span, meta);
  }
  const suffixByPath = buildFileLinkParentSuffixByPath([...byHref.values(), ...byCode.values()].map(meta => meta.filePath));
  return { byHref, byCode, suffixByPath };
}

/** What a file chip shows: the file's name, the folder that tells it from another file of that name, and its line. */
export function fileChipLabel(meta: MarkdownFileLinkMeta, suffixByPath: ReadonlyMap<string, string>): string[] {
  const parts = [meta.basename];
  const suffix = suffixByPath.get(meta.filePath.replaceAll("\\", "/"));
  if (typeof suffix === "string" && suffix.length > 0) parts.push(suffix);
  if (meta.line) parts.push(`L${meta.line}${meta.column ? `:C${meta.column}` : ""}`);
  return parts;
}

export function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const normalizedPath = filePath.replaceAll("\\", "/");
    const pathSegments = normalizedPath.split("/").filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(normalizedPath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$))/;
const INLINE_CODE_SPAN_PATTERN = /`([^`\n]+)`/g;

export function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  const segments = text.split(FENCED_CODE_SEGMENT_PATTERN);
  for (let index = 0; index < segments.length; index += 2) {
    for (const match of (segments[index] ?? "").matchAll(INLINE_CODE_SPAN_PATTERN)) {
      const span = match[1]?.trim();
      if (span) spans.push(span);
    }
  }
  return spans;
}

export function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

export function resolveExternalWebLinkHost(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

function MarkdownLinkGlyph() {
  return (
    <span
      className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
      aria-hidden
    >
      <GlobeIcon className="block size-full shrink-0 select-none" />
    </span>
  );
}

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text, (character, index) => (
    <React.Fragment key={`${index}:${character}`}>
      {character}
      <wbr />
    </React.Fragment>
  ));
}

export function plainHastText(node: unknown): string | null {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return null;
  }
  const parts = node.children.map((child) => {
    if (
      child &&
      typeof child === "object" &&
      "type" in child &&
      child.type === "text" &&
      "value" in child &&
      typeof child.value === "string"
    ) {
      return child.value;
    }
    return null;
  });
  return parts.every((part) => part !== null) ? parts.join("") : null;
}

/**
 * Whether the link carries any words of its own. An anchor that is only an image (a badge, a
 * "Fix in Cursor" button) already shows its identity, and a glyph bolted on in front of it
 * is a stray mark rather than a hint.
 */
export function hastHasText(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (
    "type" in node &&
    node.type === "text" &&
    "value" in node &&
    typeof node.value === "string" &&
    node.value.trim().length > 0
  ) {
    return true;
  }
  return "children" in node && Array.isArray(node.children) && node.children.some(hastHasText);
}

const SANITIZED_FRAGMENT_PREFIX = "user-content-";

function decodeMarkdownFragmentId(href: string): string {
  const encodedId = href.slice(1);
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

function normalizeSanitizedFragmentId(id: string): string {
  let normalizedId = id;
  while (normalizedId.startsWith(SANITIZED_FRAGMENT_PREFIX)) {
    normalizedId = normalizedId.slice(SANITIZED_FRAGMENT_PREFIX.length);
  }
  return normalizedId;
}

function findMarkdownFragmentTarget(anchor: HTMLAnchorElement, href: string): HTMLElement | null {
  const decodedId = decodeMarkdownFragmentId(href);
  const normalizedId = normalizeSanitizedFragmentId(decodedId);
  const matchesFragment = (element: HTMLElement) =>
    element.id === decodedId || normalizeSanitizedFragmentId(element.id) === normalizedId;
  const markdownRoot = anchor.closest<HTMLElement>(".chat-markdown");
  if (markdownRoot) {
    const localTargets = Array.from(markdownRoot.querySelectorAll<HTMLElement>("[id]"));
    const localTarget = localTargets.find(matchesFragment);
    if (localTarget) return localTarget;
  }

  return (
    document.getElementById(decodedId) ??
    Array.from(document.querySelectorAll<HTMLElement>("[id]")).find(matchesFragment) ??
    null
  );
}

export function handleMarkdownFragmentClick(event: ReactMouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  const target = findMarkdownFragmentTarget(event.currentTarget, href);
  if (!target) return;

  event.preventDefault();
  // The page's address is the app's one record of which thread is open, so a heading inside a reply scrolls to
  // itself and writes nothing: its fragment over that address would cost the person their place on the next load.
  target.scrollIntoView({ block: "nearest" });
}

export function MarkdownExternalLinkContent({
  plainText,
  children,
}: {
  plainText: string | null;
  children: ReactNode;
}) {
  if (plainText) {
    const leadingLength = leadingExternalLinkTextLength(plainText);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkGlyph />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    );
  }

  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];

  if (typeof firstChild === "string" && firstChild.length > 0) {
    const leadingLength = leadingExternalLinkTextLength(firstChild);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkGlyph />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    );
  }

  return (
    <>
      <span className="whitespace-nowrap">
        <MarkdownLinkGlyph />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  );
}

function MarkdownFileChipContent({ label }: { label: ReadonlyArray<string> }) {
  return (
    <>
      <FileIcon aria-hidden className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME} data-find-text>
        <Spaced parts={label} />
      </span>
    </>
  );
}

export const MarkdownFileLink = memo(function MarkdownFileLink({
  targetPath,
  panelPath,
  line,
  label,
  copyMarkdown,
  onOpenFile,
  className,
}: MarkdownFileLinkProps) {
  const openPath = onOpenFile && panelPath ? panelPath : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          openPath ? (
            <button
              type="button"
              className={cn(
                CHAT_FILE_TAG_CHIP_CLASS_NAME,
                MARKDOWN_FILE_LINK_CLASS_NAME,
                className,
              )}
              data-markdown-copy={copyMarkdown}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenFile?.(openPath, line);
              }}
            >
              <MarkdownFileChipContent label={label} />
            </button>
          ) : (
            <span
              className={cn(
                CHAT_FILE_TAG_CHIP_CLASS_NAME,
                MARKDOWN_FILE_CHIP_CLASS_NAME,
                "select-text",
                className,
              )}
              data-markdown-copy={copyMarkdown}
            >
              <MarkdownFileChipContent label={label} />
            </span>
          )
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        {/* The full path: the chip already shows the shortened form, and a link
            to the workspace root collapses to a bare label that repeats it. */}
        <div className="overflow-x-auto whitespace-nowrap [scrollbar-color:color-mix(in_srgb,var(--border)_78%,transparent)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--border)_78%,transparent)] [&::-webkit-scrollbar-track]:bg-transparent">
          {targetPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.targetPath === next.targetPath &&
    previous.displayPath === next.displayPath &&
    previous.panelPath === next.panelPath &&
    previous.line === next.line &&
    previous.label.join("\n") === next.label.join("\n") &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.onOpenFile === next.onOpenFile &&
    previous.className === next.className
  );
}
