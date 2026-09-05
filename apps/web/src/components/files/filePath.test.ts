// Adapted from pingdotgg/t3code apps/web/src/components/files/filePath.test.ts at 57a66608 (MIT).
import { describe, expect, it } from "vitest";

import type { LevelState } from "../../files/listing";
import { fileBreadcrumbChildren, fileBreadcrumbs } from "./filePath";

describe("fileBreadcrumbs", () => {
  it("builds project, directory, and file crumbs", () => {
    expect(fileBreadcrumbs("wsp", "apps/web/src/main.tsx")).toEqual([
      { label: "wsp", path: ".", kind: "project" },
      { label: "apps", path: "apps", kind: "directory" },
      { label: "web", path: "apps/web", kind: "directory" },
      { label: "src", path: "apps/web/src", kind: "directory" },
      { label: "main.tsx", path: "apps/web/src/main.tsx", kind: "file" },
    ]);
  });

  it("keeps an absolute file's directories absolute", () => {
    expect(fileBreadcrumbs("wsp", "/root/app/src/main.tsx").map(crumb => crumb.path)).toEqual([
      ".",
      "/root",
      "/root/app",
      "/root/app/src",
      "/root/app/src/main.tsx",
    ]);
  });

  it("normalizes repeated separators", () => {
    expect(fileBreadcrumbs("workspace", "src//index.ts").map((crumb) => crumb.label)).toEqual([
      "workspace",
      "src",
      "index.ts",
    ]);
  });
});

describe("fileBreadcrumbChildren", () => {
  const level = (entries: LevelState["entries"]): LevelState => ({ entries, truncated: false, total: entries?.length ?? 0, isPending: false, error: null });
  const levels = new Map<string, LevelState>([
    [".", level([{ path: "README.md", kind: "file" }, { path: "src", kind: "directory" }, { path: "src-old", kind: "directory" }])],
    ["src/lib", level([{ path: "src/lib/file10.ts", kind: "file" }, { path: "src/lib/file2.ts", kind: "file" }])],
    ["/root/app", level([{ path: "/root/app/b.ts", kind: "file" }, { path: "/root/app/a", kind: "directory" }])],
  ]);

  it("labels a listed folder's children by name, folders first", () => {
    expect(fileBreadcrumbChildren(levels, ".")).toEqual([
      { path: "src", kind: "directory", label: "src" },
      { path: "src-old", kind: "directory", label: "src-old" },
      { path: "README.md", kind: "file", label: "README.md" },
    ]);
    expect(fileBreadcrumbChildren(levels, "/root/app")).toEqual([
      { path: "/root/app/a", kind: "directory", label: "a" },
      { path: "/root/app/b.ts", kind: "file", label: "b.ts" },
    ]);
  });

  it("uses natural file-name ordering", () => {
    expect(fileBreadcrumbChildren(levels, "src/lib")!.map((entry) => entry.label)).toEqual(["file2.ts", "file10.ts"]);
  });

  it("is null for a folder nobody listed yet", () => {
    expect(fileBreadcrumbChildren(levels, "missing")).toBeNull();
  });
});
