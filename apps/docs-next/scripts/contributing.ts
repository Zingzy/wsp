// SPDX-License-Identifier: AGPL-3.0-only
// The contributing page: CONTRIBUTING.md whole, its title off and its links into the repo pointed at GitHub.
import { mdxSafe, page, read, type Generated } from "./generated.js";

const BLOB = "https://github.com/wsp-labs/wsp/blob/main";

/** A file at the repo's top as a page here: its own title off, a link to a path in the repo made a link to GitHub. */
export function repoFile(file: URL): string {
  return mdxSafe(
    read(file)
      .replace(/\r\n/g, "\n")
      .replace(/^# .*\n/, "")
      .replace(/\]\((?![a-z]+:|#|\/)([^)]+)\)/g, `](${BLOB}/$1)`),
  ).trim();
}

export default function contributing(): Generated[] {
  return [page("content/project/contributing.mdx", "Contributing", "contributing.ts", repoFile(new URL("../../../CONTRIBUTING.md", import.meta.url)))];
}
