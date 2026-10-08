// SPDX-License-Identifier: AGPL-3.0-only
// The marks on text that only means something on a cloud, and the two readings
// of them. Nothing imported, so the host's build reads the same rule when a
// public build strips the skill it inlines.

/** The mark on the skill's text that only means something on a cloud: a line that ends in it, a heading that ends in
 * it with its whole section, or a span it opens and CLOUD_SPAN_END closes. An HTML comment, so a markdown reader of
 * the file shows the text and not the mark. */
export const CLOUD_MARK = "<!-- cloud -->";
export const CLOUD_SPAN_END = "<!-- /cloud -->";
/** A span said only with the cloud off, where the road it stands in for reads otherwise without one. */
export const NO_CLOUD_MARK = "<!-- no cloud -->";
export const NO_CLOUD_SPAN_END = "<!-- /no cloud -->";

/** Text as a process with or without a cloud reads it: each span kept or dropped by its mark, the marks gone. What the
 * skill's lines and every verb's own words go through, so both follow one rule. */
export function cloudText(text: string, cloud: boolean): string {
  return text.replace(/<!-- cloud -->(.*?)<!-- \/cloud -->/g, (_, kept: string) => (cloud ? kept : "")).replace(/<!-- no cloud -->(.*?)<!-- \/no cloud -->/g, (_, kept: string) => (cloud ? "" : kept));
}

/** The skill as a process with or without a cloud reads it: the marks gone either way, and with no cloud everything
 * they mark gone too. */
export function skillFor(skill: string, cloud: boolean): string {
  const out: string[] = [];
  let dropping: number | undefined;
  let fenced = false;
  for (const line of skill.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#+) /.exec(line);
    if (dropping !== undefined) {
      if (heading === null || heading[1]!.length > dropping) continue;
      dropping = undefined;
    }
    const marked = line.endsWith(` ${CLOUD_MARK}`);
    if (marked && !cloud) {
      if (heading !== null) dropping = heading[1]!.length;
      continue;
    }
    const bare = marked ? line.slice(0, -CLOUD_MARK.length - 1) : line;
    out.push(cloudText(bare, cloud));
  }
  return out.join("\n");
}
