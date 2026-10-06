// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/ChatMarkdown.tsx at 57a66608 (MIT).
// Differs from upstream: useTheme is the resolvedTheme prop, getClientSettings().wordWrap is the wordWrap prop, the right-panel store is the onOpenFile prop; citations, the selection toolbar, asset images, the video player, toasts and PR link resolution are removed.
import { isWindowsDrivePathHref } from "../../lib/markdownLinks";

export const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

type MarkdownImageHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageHastNode[];
};

/** Carries authored image source metadata through the sanitizer to the image renderer. */
export function rehypePreserveImageSourceMeta() {
  return (tree: MarkdownImageHastNode) => {
    const visit = (node: MarkdownImageHastNode) => {
      const src = node.properties?.src;
      const title = node.properties?.title;
      if (node.type === "element" && node.tagName === "img") {
        node.properties = {
          ...node.properties,
          ...(typeof src === "string" && isWindowsDrivePathHref(src) ? { dataLocalSrc: src } : {}),
          ...(typeof title === "string" ? { dataMarkdownTitle: title } : {}),
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

/** A display formula, or an inline one by Pandoc's rules: an opening dollar not followed by a space, a closing one not
 * after a space and not followed by a digit, so "$3 to $5" is prose. */
const DISPLAY_MATH = /\$\$[\s\S]*?\S[\s\S]*?\$\$/;
const INLINE_MATH = /(?<![\\$])\$(?![\s$])[^$\n]*?[^\s\\$]\$(?![\d$])/;

export function hasMath(text: string): boolean {
  return DISPLAY_MATH.test(text) || INLINE_MATH.test(text);
}

export const RESTRICTED_FACT_CLASS = ["font-mono", "text-[11px]", "text-muted-foreground"];

/** Whether a restricted file's link may stay one: a web page, a mail address, or a place in the same document. */
const restrictedHref = (href: unknown): href is string => typeof href === "string" && (/^(https?:|mailto:)/i.test(href) || href.startsWith("#"));

/** GitHub's own image hosts, the only sources a restricted file renders an image from (the owner's ruling); anything
 * else it shows as a link. github.com itself only for an uploaded attachment. */
export const restrictedImageSrc = (src: unknown): src is string => {
  if (typeof src !== "string") return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "github.com") return url.pathname.startsWith("/user-attachments/");
    return ["user-images.githubusercontent.com", "private-user-images.githubusercontent.com", "avatars.githubusercontent.com"].includes(url.hostname);
  } catch {
    return false;
  }
};

type RestrictedNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: RestrictedNode[] };

/** Takes apart what a restricted file may not do before the sanitizer sees it: raw HTML becomes its own source text,
 * an image becomes its alt text and its address, and a link to anything but a web page, a mail address or a heading
 * becomes its text and its address with no anchor. */
export function rehypeRestrict(options: { noImages?: boolean } = {}) {
  const text = (value: string): RestrictedNode => ({ type: "text", value });
  const fact = (value: string, k: string): RestrictedNode => ({ type: "element", tagName: "span", properties: { dataK: k, className: RESTRICTED_FACT_CLASS }, children: [text(value)] });
  const visit = (node: RestrictedNode): RestrictedNode => {
    if (node.type === "raw") return text(node.value ?? "");
    if (node.type === "element" && node.tagName === "img") {
      const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";
      const src = typeof node.properties?.src === "string" ? node.properties.src : "";
      // A GitHub image host's image renders; another web host's becomes a link to it; anything else (a non-web or
      // empty source) is its alt and address as text, the same fact a bad link reads as.
      if (options.noImages !== true && restrictedImageSrc(src)) return node;
      if (/^https?:\/\//i.test(src)) return { type: "element", tagName: "a", properties: { href: src }, children: [text(alt === "" ? src : alt)] };
      return fact([alt, src].filter((w) => w !== "").join(" "), "skill-image");
    }
    const children = node.children?.map(visit);
    if (node.type === "element" && node.tagName === "a" && !restrictedHref(node.properties?.href)) {
      const href = typeof node.properties?.href === "string" ? node.properties.href : "";
      return { type: "element", tagName: "span", properties: { dataK: "skill-link" }, children: [...(children ?? []), ...(href === "" ? [] : [text(" "), fact(href, "skill-link-href")])] };
    }
    return children === undefined ? node : { ...node, children };
  };
  return (tree: RestrictedNode) => visit(tree);
}

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  url?: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

/**
 * Pandoc's rules over remark-math's inline formulas, which read any two dollars as one: a formula whose opening
 * dollar is followed by a space, whose closing one follows a space, or is followed by a digit, is the prose it was
 * ("$3 to $5"), and one written between double dollars is a display formula wherever it stands.
 */
export function remarkPandocMath() {
  return (tree: MarkdownAstNode, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const visit = (node: MarkdownAstNode) => {
      if (node.children === undefined) return;
      node.children = node.children.map((child) => {
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (child.type !== "inlineMath" || start === undefined || end === undefined) return child;
        const raw = source.slice(start, end);
        if (raw.startsWith("$$")) {
          child.data = { ...child.data, hProperties: { ...child.data?.hProperties, className: ["language-math", "math-display"] } };
          return child;
        }
        const inner = raw.slice(1, -1);
        const prose = /^\s/.test(inner) || /\s$/.test(inner) || /\d/.test(source.charAt(end));
        return prose ? { type: "text", value: raw } : child;
      });
      node.children.forEach(visit);
    };
    visit(tree);
  };
}

export function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

/**
 * Preserve Windows drive links as allowed `file:` URLs before sanitization.
 * The same traversal tags inline code while it can still be distinguished
 * from fenced code. Code inside links stays untagged to avoid nested anchors.
 */
export function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (
        (node.type === "link" || node.type === "definition") &&
        typeof node.url === "string" &&
        WINDOWS_DRIVE_PATH_REGEX.test(node.url)
      ) {
        node.url = `file:///${node.url.replaceAll("\\", "/")}`;
      }
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}
