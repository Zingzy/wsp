// SPDX-License-Identifier: AGPL-3.0-only
// Rendered view of a markdown file from fs.read. Images stay as their alt
// text: a relative image path has no route from the browser into the
// workspace, and an absolute one would leave it.
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";

const PROSE =
  "text-sm leading-6 text-foreground break-words " +
  "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight " +
  "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight " +
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold " +
  "[&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:font-semibold " +
  "[&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 " +
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 " +
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground " +
  "[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] " +
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border/70 [&_pre]:bg-[var(--code-background)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_hr]:my-6 [&_hr]:border-border " +
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 " +
  "[&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:align-middle";

export function FileMarkdownPreview(props: { readonly text: string; readonly className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-4xl px-6 py-5", PROSE, props.className)} data-markdown-preview>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={defaultUrlTransform}
        components={{
          a: ({ href, children }) =>
            href && /^https?:/i.test(href) ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span className="text-primary">{children}</span>
            ),
          img: ({ alt, src }) => (
            <span className="inline-block rounded-sm border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {alt || (typeof src === "string" ? src : "image")}
            </span>
          ),
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
