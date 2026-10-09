// SPDX-License-Identifier: AGPL-3.0-only
// The security page: SECURITY.md whole, as the contributing page carries CONTRIBUTING.md.
import { repoFile } from "./contributing.js";
import { page, type Generated } from "./generated.js";

export default function security(): Generated[] {
  return [page("content/project/security.mdx", "Security", "security.ts", repoFile(new URL("../../../SECURITY.md", import.meta.url)))];
}
