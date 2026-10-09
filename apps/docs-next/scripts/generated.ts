// SPDX-License-Identifier: AGPL-3.0-only
// What every generator shares: where the docs and the repo sit, a generated page's head, the markers around a table
// a written page carries, and the escapes that keep source text from reading as MDX.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DOCS = fileURLToPath(new URL("..", import.meta.url));

/** A file a script writes: its path under apps/docs-next and the whole text it holds now. */
export interface Generated {
  file: string;
  text: string;
}

/** A source file's text. Each caller names its file as a literal `new URL(...)`, which is how
 * scripts/affected-tests.mjs sees that a change to it moves a page. */
export const read = (file: URL): string => readFileSync(file, "utf8");

const GENERATE = "pnpm --filter @wsp/docs-next generate";

/** A page a script writes whole: its title, the comment naming that script, then the body. */
export function page(file: string, title: string, script: string, body: string): Generated {
  return { file, text: `# ${title}\n\n{/* Written by apps/docs-next/scripts/${script}: change the script or its source and run ${GENERATE}. */}\n\n${body.trim()}\n` };
}

/** A written page with each named block written again between its `generated: <name>` and `end generated: <name>`
 * markers; the prose around them is the page's own. */
export function within(file: string, blocks: Record<string, string>): Generated {
  let text = readFileSync(join(DOCS, file), "utf8");
  for (const [name, body] of Object.entries(blocks)) {
    const open = `{/* generated: ${name} */}`;
    const close = `{/* end generated: ${name} */}`;
    const start = text.indexOf(open);
    const end = text.indexOf(close);
    if (start < 0 || end < start) throw new Error(`${file} holds no ${open} line with ${close} after it to write between`);
    text = `${text.slice(0, start + open.length)}\n\n${body.trim()}\n\n${text.slice(end)}`;
  }
  return { file, text };
}

/** Markdown whose prose MDX reads as markdown: a <, { or } outside code is escaped, an HTML comment goes and an
 * autolink becomes a link. Fenced blocks and code spans are left as they are, since MDX reads neither. */
export function mdxSafe(markdown: string): string {
  let fenced = false;
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map(line => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 === 1 ? part : proseSafe(part))).join("");
    })
    .join("\n");
}

const proseSafe = (text: string): string =>
  text
    .replace(/<(https?:\/\/[^>\s]+)>/g, "[$1]($1)")
    .split(/(https?:\/\/\S*<\S*)/)
    .map((part, i) => (i % 2 === 1 ? `\`${part}\`` : part.replace(/[<{}]/g, c => `\\${c}`)))
    .join("");

/** One cell of a markdown table: on one line, its pipes escaped. */
export const cell = (text: string): string => mdxSafe(text.replace(/\s*\n\s*/g, " ")).replace(/\|/g, "\\|");

/** A markdown table from its header and rows, each cell already written. */
export function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map(r => `| ${r.join(" | ")} |`)].join("\n");
}

/** A fenced block of plain text. */
export const block = (text: string, lang = "text"): string => `\`\`\`${lang}\n${text.trimEnd()}\n\`\`\``;
