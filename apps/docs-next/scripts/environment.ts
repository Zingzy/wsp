// SPDX-License-Identifier: AGPL-3.0-only
// The environment page: every variable PUBLIC_ENV names, with the doc comment its constant carries in
// packages/protocol/src/env.ts. The rest of that file is for a harness, a test or the cloud.
import { PUBLIC_ENV } from "../../../packages/protocol/src/env.js";
import { cell, page, read, table, type Generated } from "./generated.js";

const SOURCE = new URL("../../../packages/protocol/src/env.ts", import.meta.url);

/** Each variable's doc comment, by the variable's name, as one paragraph. */
export function envComments(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of text.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*export const [A-Z_]+ = "([A-Z_]+)";/g))
    found.set(m[2]!, m[1]!.split("\n").map(l => l.replace(/^\s*\*?\s?/, "").trim()).filter(Boolean).join(" "));
  return found;
}

export default function environment(): Generated[] {
  const comments = envComments(read(SOURCE));
  const rows = PUBLIC_ENV.map(name => {
    const said = comments.get(name);
    if (said === undefined) throw new Error(`${name} has no doc comment in ${SOURCE}`);
    return [`\`${name}\``, cell(said)];
  });
  const body = [
    "The variables wsp reads that are yours to set, and the ones a thread's turn carries. A switch also works as a line of the `.env` beside the state file. The desktop app's host reads its switches from that file alone.",
    table(["Variable", "What it does"], rows),
  ];
  return [page("content/reference/environment.mdx", "Environment variables", "environment.ts", body.join("\n\n"))];
}
