// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/ChatMarkdown.tsx at 57a66608 (MIT).
// Differs from upstream: useTheme is the resolvedTheme prop, getClientSettings().wordWrap is the wordWrap prop, the right-panel store is the onOpenFile prop; citations, the selection toolbar, asset images, the video player, toasts and PR link resolution are removed.
import { CheckIcon, CopyIcon, FileIcon, PlayIcon, WrapTextIcon } from "lucide-react";
import { Children, isValidElement, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { type DiffThemeName } from "../../lib/diffRendering";
import { fnv1a32 } from "../../lib/diffRendering";
import { LRUCache } from "../../lib/lruCache";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { errorText } from "../../lib/utils";
import { RUN_WORDS, runBlockKey, runnableCommand } from "@wsp/protocol";
import { useStore } from "../../protocol/store";
import { InlineRun, ReplyRunContext } from "../chat/InlineRun";
import { startRun } from "../chat/replyRun";
import { noticeFailure, noticeFailureOnce, notCopied } from "../../notices/store";

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

/** A code block's frame, which a command the agent ran takes too, so a command it ran and one it wrote read alike. */
export const CODE_BLOCK_SURFACE = "rounded-[var(--radius)] border border-border/70 bg-secondary dark:border-transparent dark:bg-input/32";

export const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);

export function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

/** Pulls a filename out of fence meta: ```ts title="x.ts" / ```ts src/main.ts */
export function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];
  if (attrTitle) return attrTitle;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

export function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (
    node as
      | {
          children?: Array<{
            type?: string;
            tagName?: string;
            data?: { meta?: unknown };
            properties?: { dataCodeMeta?: unknown };
          }>;
        }
      | undefined
  )?.children;
  const codeNode = children?.find((child) => child?.type === "element" && child.tagName === "code");
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta;
  return typeof meta === "string" && meta.trim().length > 0 ? meta.trim() : undefined;
}

export function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

export function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode; node?: { tagName?: string } }>(
      onlyChild,
    )
  ) {
    return null;
  }
  // With a custom `code` component the child's type is that component, not
  // the "code" tag; the hast node react-markdown attaches still names it.
  if (onlyChild.type !== "code" && onlyChild.props.node?.tagName !== "code") {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

export function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

export function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

/** Filename titles render icon + text; language-only titles render the language text. */
function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
}: {
  fenceTitle: string | null;
  language: string;
}) {
  if (fenceTitle) {
    return (
      <>
        <FileIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  return <span className="truncate">{language}</span>;
}

export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  wordWrap,
  offset,
  isStreaming,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  wordWrap: boolean;
  /** Where the block's fence starts in the message's text, which names it on the thread's record of its runs. */
  offset: number;
  isStreaming: boolean;
  children: ReactNode;
}) {
  // A shell block in an agent's reply runs where it stands; a block still streaming is not the command yet.
  const scope = use(ReplyRunContext);
  const command = scope !== null && !isStreaming ? runnableCommand(language, code) : null;
  const block = scope !== null ? runBlockKey(scope.messageId, offset) : "";
  const run = command !== null ? scope?.runs.get(block) : undefined;
  const api = useStore(s => s.api);
  const [runRefusal, setRunRefusal] = useState<string | null>(null);
  const handleRun = useCallback(() => {
    if (api === null || scope === null || command === null) return;
    setRunRefusal(null);
    startRun(api, { workspaceId: scope.workspaceId, threadId: scope.threadId, turnId: scope.turnId, block, command, ...(scope.cwd !== undefined ? { cwd: scope.cwd } : {}) }).catch((cause: unknown) => setRunRefusal(errorText(cause)));
  }, [api, block, command, scope]);
  const runLabel = run === undefined ? RUN_WORDS.run : RUN_WORDS.runAgain;
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(wordWrap);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        noticeFailure(cause, notCopied);
      });
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      className={`chat-markdown-codeblock my-[0.65rem] overflow-hidden leading-snug ${CODE_BLOCK_SURFACE}`}
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none">
        <span className="inline-flex min-w-0 items-center gap-[0.4rem] [font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace)] [font-size:0.6875rem]">
          <MarkdownCodeBlockTitleContent fenceTitle={fenceTitle} language={language} />
        </span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          {command !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    data-reply-run-button
                    disabled={run?.state === "running"}
                    onClick={handleRun}
                    aria-label={runLabel}
                  />
                }
              >
                <PlayIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{runLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={wrapped}
                  onClick={() => setWrapped((value) => !value)}
                  aria-label={wrapLabel}
                />
              }
            >
              <WrapTextIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {children}
      {command !== null ? <InlineRun run={run} /> : null}
      {runRefusal !== null ? (
        <p data-reply-run-refusal className="m-0 px-3 py-1.5 text-[12px] leading-4 text-error-foreground">
          {runRefusal}
        </p>
      ) : null}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

export function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;
  const cached = useMemo(() => (cachedHighlightedHtml == null ? null : { __html: cachedHighlightedHtml }), [cachedHighlightedHtml]);

  if (cached !== null) {
    return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={cached} />;
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const { highlightedHtml, failed } = useMemo((): { highlightedHtml: string; failed: unknown } => {
    try {
      // shiki cuts a line at 500 ms with no signal, and a cold grammar compiling its regexes on a busy main thread takes longer than that.
      return { highlightedHtml: highlighter.codeToHtml(code, { lang: language, theme: themeName, tokenizeTimeLimit: 0 }), failed: null };
    } catch (error) {
      return { highlightedHtml: highlighter.codeToHtml(code, { lang: "text", theme: themeName }), failed: error };
    }
  }, [code, highlighter, language, themeName]);

  // A streaming block draws again with every chunk, so a language that fails is said once.
  useEffect(() => {
    if (failed !== null) noticeFailureOnce(`highlight:${language}`, failed, said => `Code shown as plain text, ${language} not highlighted: ${said}`);
  }, [failed, language]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  const html = useMemo(() => ({ __html: highlightedHtml }), [highlightedHtml]);
  return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={html} />;
}
