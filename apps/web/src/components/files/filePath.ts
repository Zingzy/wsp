// Adapted from pingdotgg/t3code apps/web/src/components/files/filePath.ts at 57a66608 (MIT).
// Differs from upstream: crumbs are absolute daemon paths below the daemon root, which the project crumb stands for.
import { baseName, pathSegments, type ProjectEntry } from "../../files/entries";
import type { Levels } from "../../files/listing";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild extends ProjectEntry {
  label: string;
}

/** Crumbs start at the project, which stands for the daemon root, then one per segment below it. */
export function fileBreadcrumbs(projectName: string, root: string, path: string): FileBreadcrumb[] {
  const segments = pathSegments(root, path);
  return [
    { label: projectName, path: root, kind: "project" as const },
    ...segments.map((segment, index) => ({
      label: segment.name,
      path: segment.path,
      kind: index === segments.length - 1 ? ("file" as const) : ("directory" as const),
    })),
  ];
}

/** The listed children of one folder, folders first, in natural order; null until that folder was listed. */
export function fileBreadcrumbChildren(levels: Levels, directoryPath: string): FileBreadcrumbChild[] | null {
  const entries = levels.get(directoryPath)?.entries;
  if (!entries) return null;
  return entries
    .map(entry => ({ ...entry, label: baseName(entry.path) }))
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" });
    });
}
