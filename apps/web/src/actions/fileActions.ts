// SPDX-License-Identifier: AGPL-3.0-only
// The Files pane's actions, one registry: what a row's context menu offers
// for one entry, by the absolute path the daemon names it with.
import { CopyIcon, FileDiffIcon, FileIcon } from "lucide-react";
import type { ProjectEntry } from "../files/entries.js";
import { FILE_WORDS, FOLDER_OPENS_IN_TREE, ONLY_FILES_HAVE_DIFFS } from "./format.js";
import type { ActionEntry } from "./registry.js";

export interface FileVerbs {
  readonly open: (path: string) => void;
  readonly revealInDiff: (path: string) => void;
  readonly copyText: (text: string) => Promise<void>;
}

export const fileActions: ReadonlyArray<ActionEntry<ProjectEntry, FileVerbs>> = [
  {
    id: "open",
    group: "open",
    icon: () => FileIcon,
    title: () => FILE_WORDS.open,
    refusal: entry => (entry.kind === "directory" ? FOLDER_OPENS_IN_TREE : null),
    run: (entry, verbs) => verbs.open(entry.path),
  },
  {
    id: "show-diff",
    group: "open",
    icon: () => FileDiffIcon,
    title: () => FILE_WORDS.showDiff,
    refusal: entry => (entry.kind === "directory" ? ONLY_FILES_HAVE_DIFFS : null),
    run: (entry, verbs) => verbs.revealInDiff(entry.path),
  },
  {
    id: "copy-path",
    group: "copy",
    icon: () => CopyIcon,
    title: () => FILE_WORDS.copyPath,
    refusal: () => null,
    run: (entry, verbs) => verbs.copyText(entry.path),
  },
];
