// Adapted from pingdotgg/t3code apps/web/src/components/ChatMarkdown.tsx at 57a66608 (MIT).
// Differs from upstream: useTheme is the resolvedTheme prop, getClientSettings().wordWrap is the wordWrap prop, the right-panel store is the onOpenFile prop; citations, the selection toolbar, asset images, the video player, toasts and PR link resolution are removed.
import { Suspense, type ClipboardEvent as ReactClipboardEvent, lazy, use, useCallback, memo, useEffect, useMemo, useState } from "react";
import type { Components, Options as ReactMarkdownOptions } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkGithubAlerts } from "../lib/markdownGithubAlerts";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import type { ProviderSkill } from "./chat/adapt";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { chatMarkdownClipboardPayload } from "../lib/markdownClipboard";
import { remarkNormalizeListItemIndentation } from "../lib/markdownListIndentation";
import { extractMarkdownLinkHrefs, isWindowsDrivePathHref, normalizeMarkdownLinkDestination, resolveInlineCodeFileLinkMeta, resolveMarkdownFileLinkMeta, rewriteMarkdownFileUriHref, type MarkdownFileLinkMeta } from "../lib/markdownLinks";
import { classifyMarkdownImageSource } from "../lib/markdownImages";
import { mediaKindFromPath } from "../lib/filePreview";
import { isAbsolutePath } from "../terminal-links";
import { cn } from "../lib/utils";
import { noticeFailureOnce } from "../notices/store";
import { LoopbackLinks } from "../browser/loopbackLinks";
import { hasMath, rehypePreserveImageSourceMeta, rehypeRestrict, remarkNormalizeLinksAndTagInlineCode, remarkPandocMath, remarkPreserveCodeMeta, RESTRICTED_FACT_CLASS, restrictedImageSrc } from "./markdown/plugins";
import { findTaskListMarkerOffset, GITHUB_ALERT_PRESENTATIONS, MarkdownDetails, MarkdownTable, orderedListGutterStyle } from "./markdown/blocks";
import { extractCodeBlock, extractFenceLanguage, extractFenceTitle, extractPreCodeMeta, MarkdownCodeBlock, nodeToPlainText, SuspenseShikiCodeBlock } from "./markdown/codeBlocks";
import { authoredImageSizeStyle, CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME, ChatMarkdownImageFallback, expandableMarkdownImageProps, MarkdownLinkContext, markdownImageCopy, resolveProtocolRelativeMediaUrl } from "./markdown/images";
import { buildFileLinkParentSuffixByPath, extractInlineCodeSpans, handleMarkdownFragmentClick, hastHasText, MarkdownExternalLinkContent, MarkdownFileLink, normalizeMarkdownLinkHrefKey, plainHastText, resolveExternalWebLinkHost } from "./markdown/links";

export { hasMath } from "./markdown/plugins";
export { orderedListGutterStyle } from "./markdown/blocks";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<ProviderSkill>;
  className?: string;
  /** Treat single newlines as hard breaks (chat-style user input). */
  lineBreaks?: boolean;
  /** Parse sanitized raw HTML instead of displaying its source text. */
  parseRawHtml?: boolean;
  /** Directory that anchors relative links and images; defaults to `cwd`. Set
      to the file's own directory when rendering a markdown file. */
  imageBaseDir?: string | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  /** Picks the shiki theme for fenced code. */
  resolvedTheme: "light" | "dark";
  /** Initial value of the per-block wrap toggle; default true. */
  wordWrap?: boolean;
  /** A file link was clicked. Absent means file links render as plain text chips. */
  onOpenFile?: ((path: string, line?: number) => void) | undefined;
  /** A file nobody here wrote, a skill's SKILL.md: no raw HTML, no image fetched, no link but to a web page, a mail
   * address or a heading, and nothing resolved against a folder. */
  restricted?: boolean;
  /** With restricted, no image renders at all, a GitHub host's included: each is a link to its address. A slate's
   * markdown, which the agent writes and the person only views, fetches nothing by being shown. */
  noImages?: boolean;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<ProviderSkill> = [];
const EMPTY_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    // The default's language class, and the two marks remark-math puts on a formula, which KaTeX reads after this.
    code: [["className", /^language-./, "math-inline", "math-display"], "dataCodeMeta", "dataInlineCode"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    img: [...(defaultSchema.attributes?.img ?? []), "dataLocalSrc", "dataMarkdownTitle"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
    src: [...(defaultSchema.protocols?.src ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

const CHAT_MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkMath,
  remarkPandocMath,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS = [
  remarkGfm,
  remarkMath,
  remarkPandocMath,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  rehypeRaw,
  rehypePreserveImageSourceMeta,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

type RehypePlugin = NonNullable<ReactMarkdownOptions["rehypePlugins"]>[number];

let katexLoad: Promise<RehypePlugin> | null = null;
let katexLoaded: RehypePlugin | null = null;

/** KaTeX's plugin once a message with math has asked for it; nothing for a message without, which never loads it. */
function useKatex(wanted: boolean): RehypePlugin | null {
  const [plugin, setPlugin] = useState<RehypePlugin | null>(katexLoaded);
  useEffect(() => {
    if (!wanted || plugin !== null) return;
    let live = true;
    katexLoad ??= import("./markdownMath").then(m => (katexLoaded = m.REHYPE_KATEX as unknown as RehypePlugin));
    void katexLoad.then(
      loaded => {
        if (live) setPlugin(() => loaded);
      },
      (e: unknown) => {
        // The import holds its rejection for good; dropped, the next message with math tries again.
        katexLoad = null;
        noticeFailureOnce("katex", e, said => `Math not drawn: ${said}`);
      },
    );
    return () => {
      live = false;
    };
  }, [plugin, wanted]);
  return wanted ? plugin : null;
}

const MermaidBlock = lazy(() => import("./chat/MermaidBlock"));

/** The sanitizer's schema for a restricted file: links only to web pages and mail addresses, an image only over https
 * (the restricted plugin below has already turned every one but a GitHub image host's into a link), and the span the
 * plugin writes for a link it took apart. The skill viewer reads this schema too, so a skill file's GitHub-hosted
 * image renders the same way a pull request's does. */
const SKILL_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
    span: [...(defaultSchema.attributes?.span ?? []), "dataK", "className"],
  },
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"], src: ["https"] },
} satisfies Parameters<typeof rehypeSanitize>[0];

const SKILL_MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkGithubAlerts, remarkNormalizeListItemIndentation, remarkPreserveCodeMeta] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const SKILL_MARKDOWN_REHYPE_PLUGINS = [rehypeRestrict, [rehypeSanitize, SKILL_SANITIZE_SCHEMA]] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
const IMAGELESS_MARKDOWN_REHYPE_PLUGINS = [[rehypeRestrict, { noImages: true }], [rehypeSanitize, SKILL_SANITIZE_SCHEMA]] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

function ChatMarkdown({
  text,
  cwd: givenCwd,
  onTaskListChange: givenTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  className,
  lineBreaks = false,
  parseRawHtml = true,
  imageBaseDir: givenImageBaseDir,
  onImageExpand: givenImageExpand,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  resolvedTheme,
  wordWrap = true,
  onOpenFile: givenOpenFile,
  restricted = false,
  noImages = false,
}: ChatMarkdownProps) {
  // A restricted file is resolved against no folder and opens nothing of this computer's.
  const cwd = restricted ? undefined : givenCwd;
  const imageBaseDir = restricted ? undefined : givenImageBaseDir;
  const onTaskListChange = restricted ? undefined : givenTaskListChange;
  const onImageExpand = restricted ? undefined : givenImageExpand;
  const onOpenFile = restricted ? undefined : givenOpenFile;
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    if (restricted) return metaByHref;
    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, imageBaseDir, restricted, text]);
  const inlineCodeFileLinkMetaByText = useMemo(() => {
    const metaByText = new Map<string, MarkdownFileLinkMeta>();
    if (restricted) return metaByText;
    for (const span of extractInlineCodeSpans(text)) {
      if (metaByText.has(span)) continue;
      const meta = resolveInlineCodeFileLinkMeta(span, cwd, imageBaseDir ?? cwd);
      if (meta) {
        metaByText.set(span, meta);
      }
    }
    return metaByText;
  }, [cwd, imageBaseDir, restricted, text]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [
      ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
      ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
    ];
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [inlineCodeFileLinkMetaByText, markdownFileLinkMetaByHref]);
  const markdownUrlTransform = useCallback(
    (href: string) => {
      if (restricted) return defaultUrlTransform(href);
      if (isWindowsDrivePathHref(href)) return href;
      return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
    },
    [restricted],
  );
  // Re-emit highlighted content as markdown so copying out of the rendered
  // view keeps links, emphasis, lists, and code fences intact.
  const handleCopy = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
  }, []);
  /* eslint-disable react/no-unstable-nested-components -- ReactMarkdown requires component
   * renderers that close over this message's metadata. useMemo keeps them stable until that
   * metadata changes. */
  const loopbackLinks = use(LoopbackLinks);
  const markdownComponents = useMemo<Components>(() => {
    const fileLinkChip = (
      fileLinkMeta: MarkdownFileLinkMeta,
      copyMarkdown: string,
      className?: string,
      options?: { readonly inert?: boolean },
    ) => {
      const parentSuffix = fileLinkParentSuffixByPath.get(
        fileLinkMeta.filePath.replaceAll("\\", "/"),
      );
      const labelParts = [fileLinkMeta.basename];
      if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
        labelParts.push(parentSuffix);
      }
      if (fileLinkMeta.line) {
        labelParts.push(
          `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
        );
      }
      // Host files outside the workspace (a report in a temp dir) open by
      // their absolute path.
      const panelPath =
        fileLinkMeta.workspaceRelativePath ??
        (isAbsolutePath(fileLinkMeta.filePath) ? fileLinkMeta.filePath : null);

      return (
        <MarkdownFileLink
          targetPath={fileLinkMeta.targetPath}
          displayPath={fileLinkMeta.displayPath}
          panelPath={panelPath}
          line={fileLinkMeta.line}
          label={labelParts}
          copyMarkdown={copyMarkdown}
          onOpenFile={options?.inert ? undefined : onOpenFile}
          className={className}
        />
      );
    };

    return {
      p({ node: _node, children, ...props }) {
        return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
      },
      blockquote({ node: _node, children, ...props }) {
        const alert =
          GITHUB_ALERT_PRESENTATIONS[
            String((props as Record<string, unknown>)["data-alert"] ?? "")
          ];
        if (!alert) {
          return <blockquote {...props}>{children}</blockquote>;
        }
        // Not a <blockquote>: the stylesheet mutes those, and an alert's body is ordinary
        // text under a colored title, which is how the host renders it.
        return (
          <div role="note" className={cn("my-1 border-l-2 pl-3", alert.borderClassName)}>
            <p className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}>
              <alert.Icon aria-hidden className="size-3.5 shrink-0" />
              {alert.label}
            </p>
            {children}
          </div>
        );
      },
      ol({ node, start, style, ...props }) {
        const itemCount =
          node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
            .length ?? 0;
        const gutterStyle = orderedListGutterStyle(itemCount, start);
        return (
          <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
        );
      },
      li({ node, children, ...props }) {
        const listItemStart = node?.position?.start.offset;
        const markerOffset =
          typeof listItemStart === "number" ? findTaskListMarkerOffset(text, listItemStart) : null;
        return (
          <li {...props} data-task-marker-offset={markerOffset ?? undefined}>
            {renderSkillInlineMarkdownChildren(children, skills)}
          </li>
        );
      },
      input({ node: _node, type, checked, disabled: _disabled, ...props }) {
        if (type !== "checkbox" || !onTaskListChange) {
          return (
            <input
              {...props}
              type={type}
              checked={checked}
              disabled={_disabled}
              readOnly={type === "checkbox"}
            />
          );
        }
        return (
          <input
            {...props}
            type="checkbox"
            name="markdown-task"
            aria-label="Toggle task"
            checked={checked}
            onChange={(event) => {
              const markerOffset = Number(
                event.currentTarget.closest("li")?.dataset.taskMarkerOffset,
              );
              if (!Number.isSafeInteger(markerOffset)) return;
              onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
            }}
          />
        );
      },
      a({ node, href, children, title: _title, ...props }) {
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLinkMeta =
          normalizedHref && !restricted
            ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
              resolveMarkdownFileLinkMeta(normalizedHref, cwd, imageBaseDir ?? cwd))
            : null;
        if (!fileLinkMeta) {
          const webHost = resolveExternalWebLinkHost(href);
          // A restricted file's page draws no favicon: that is an image fetched from Google naming the host.
          const faviconHost = restricted ? null : webHost;
          const isSameDocumentLink = href?.startsWith("#") ?? false;
          const onClick = props.onClick;
          const linkChildren = <MarkdownLinkContext value>{children}</MarkdownLinkContext>;
          const link = (
            <a
              {...props}
              href={href}
              target={isSameDocumentLink ? undefined : "_blank"}
              rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
              onClick={(event) => {
                onClick?.(event);
                if (isSameDocumentLink && href) {
                  handleMarkdownFragmentClick(event, href);
                } else if (href && loopbackLinks?.(href) === true) {
                  event.preventDefault();
                }
              }}
            >
              {faviconHost && hastHasText(node) ? (
                <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
                  {linkChildren}
                </MarkdownExternalLinkContent>
              ) : (
                linkChildren
              )}
            </a>
          );
          if (!webHost || !href) {
            return link;
          }
          return (
            <Tooltip>
              <TooltipTrigger render={link} />
              <TooltipPopup
                side="top"
                className="max-w-[min(36rem,calc(100vw-2rem))] whitespace-normal leading-tight wrap-anywhere"
              >
                {href}
              </TooltipPopup>
            </Tooltip>
          );
        }

        return fileLinkChip(
          fileLinkMeta,
          `[${fileLinkMeta.basename}](${normalizedHref})`,
          props.className,
        );
      },
      code({ node, children, className, ...props }) {
        if (!restricted && node?.properties?.dataInlineCode != null) {
          const codeText = nodeToPlainText(children);
          const fileLinkMeta =
            inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
            resolveInlineCodeFileLinkMeta(codeText, cwd, imageBaseDir ?? cwd);
          if (fileLinkMeta) {
            return fileLinkChip(fileLinkMeta, `\`${codeText}\``);
          }
        }
        return (
          <code {...props} className={className}>
            {children}
          </code>
        );
      },
      img: function MarkdownImage({ node, title, src, alt, ...props }) {
        if (restricted) {
          // The restrict plugin turned every image but a GitHub image host's into a link, so one that reaches here is
          // that host's and renders; anything else stays its alt and address as text.
          if (restrictedImageSrc(src)) {
            return (
              <img
                {...props}
                src={src}
                alt={typeof alt === "string" ? alt : ""}
                loading="lazy"
                className={cn(props.className, CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME)}
                style={authoredImageSizeStyle(props.width, props.height)}
              />
            );
          }
          return (
            <span data-k="skill-image" className={RESTRICTED_FACT_CLASS.join(" ")}>
              {[alt, typeof src === "string" ? src : ""].filter(Boolean).join(" ")}
            </span>
          );
        }
        const imageExpand = use(MarkdownLinkContext) ? undefined : onImageExpand;
        const localSrc = node?.properties?.dataLocalSrc;
        const markdownTitle = node?.properties?.dataMarkdownTitle;
        const authoredSrc = typeof localSrc === "string" ? localSrc : src;
        const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
        const srcString =
          typeof authoredSrc === "string" ? normalizeMarkdownLinkDestination(authoredSrc) : "";
        const classifiedSrc =
          typeof localSrc === "string" ? srcString.replaceAll("\\", "/") : srcString;
        const altText = alt ?? "";
        const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle);
        const authoredSizeStyle = authoredImageSizeStyle(props.width, props.height);
        const imageSource = classifyMarkdownImageSource(classifiedSrc, imageBaseDir ?? cwd);
        const kind = mediaKindFromPath(classifiedSrc) ?? "image";
        if (imageSource._tag === "Direct") {
          if (kind === "video") {
            return (
              <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind="video" />
            );
          }
          const mediaSrc = resolveProtocolRelativeMediaUrl(imageSource.uri);
          const originalUrl =
            resolveExternalWebLinkHost(imageSource.uri) !== null ? imageSource.uri : undefined;
          return (
            <img
              {...props}
              src={mediaSrc}
              alt={altText}
              data-markdown-copy={copyMarkdown}
              loading="lazy"
              className={cn(
                props.className,
                CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
                imageExpand && "cursor-zoom-in",
              )}
              style={authoredSizeStyle}
              {...expandableMarkdownImageProps(imageExpand, mediaSrc, altText, originalUrl)}
            />
          );
        }
        if (imageSource._tag === "WorkspaceFile") {
          const fileLinkMeta = resolveMarkdownFileLinkMeta(imageSource.path, cwd, imageBaseDir ?? cwd);
          if (fileLinkMeta) {
            return fileLinkChip(fileLinkMeta, copyMarkdown, undefined, { inert: true });
          }
        }
        return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} kind={kind} />;
      },
      table({ node: _node, ...props }) {
        return <MarkdownTable {...props} wordWrap={wordWrap} />;
      },
      details({ node: _node, children, open: detailsOpen }) {
        return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
      },
      pre({ node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        const language = extractFenceLanguage(codeBlock.className);
        const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
        // A diagram is drawn once its reply has settled; half a fence is not a diagram, and redrawing each chunk is waste.
        if (language === "mermaid" && !isStreaming && !restricted) {
          const source = <pre {...props}>{children}</pre>;
          return (
            <MarkdownCodeBlock code={codeBlock.code} language={language} fenceTitle={fenceTitle} wordWrap={wordWrap} offset={node?.position?.start.offset ?? 0} isStreaming={isStreaming}>
              <RenderErrorBoundary fallback={source}>
                <Suspense fallback={source}>
                  <MermaidBlock code={codeBlock.code} resolvedTheme={resolvedTheme} source={source} />
                </Suspense>
              </RenderErrorBoundary>
            </MarkdownCodeBlock>
          );
        }
        return (
          <MarkdownCodeBlock
            code={codeBlock.code}
            language={language}
            fenceTitle={fenceTitle}
            wordWrap={wordWrap}
            offset={node?.position?.start.offset ?? 0}
            isStreaming={isStreaming}
          >
            <RenderErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </RenderErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    };
  }, [
    cwd,
    diffThemeName,
    fileLinkParentSuffixByPath,
    inlineCodeFileLinkMetaByText,
    imageBaseDir,
    isStreaming,
    loopbackLinks,
    markdownFileLinkMetaByHref,
    onTaskListChange,
    onImageExpand,
    onOpenFile,
    resolvedTheme,
    restricted,
    skills,
    text,
    wordWrap,
  ]);
  /* eslint-enable react/no-unstable-nested-components */

  const remarkPlugins = useMemo(
    () =>
      restricted
        ? SKILL_MARKDOWN_REMARK_PLUGINS
        : [
            ...(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS),
            ...extraRemarkPlugins,
          ],
    [extraRemarkPlugins, lineBreaks, restricted],
  );

  const katex = useKatex(!restricted && hasMath(text));
  const rehypePlugins = useMemo(() => {
    if (restricted) return noImages ? IMAGELESS_MARKDOWN_REHYPE_PLUGINS : SKILL_MARKDOWN_REHYPE_PLUGINS;
    const base = parseRawHtml ? CHAT_MARKDOWN_REHYPE_PLUGINS : [];
    return katex === null ? (parseRawHtml ? base : undefined) : [...base, katex];
  }, [katex, noImages, parseRawHtml, restricted]);

  // react-markdown converts unparsed HTML nodes to text when skipHtml is false.
  // Keep that behavior explicit because literal mode depends on escaping the
  // complete source token instead of dropping it from the rendered message.
  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 select-text text-[length:var(--font-size-chat,0.875rem)] leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      )}
      onCopy={handleCopy}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml={false}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
