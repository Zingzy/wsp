// Adapted from pingdotgg/t3code apps/web/src/components/files/filePath.test.ts at 57a66608 (MIT).
import { describe, expect, it } from "vitest";

import type { LevelState } from "../../files/listing";
import { fileBreadcrumbChildren, fileBreadcrumbs } from "./filePath";

describe("fileBreadcrumbs", () => {
  it("builds project, directory, and file crumbs below the daemon root", () => {
    expect(fileBreadcrumbs("wsp", "/root", "/root/apps/web/src/main.tsx")).toEqual([
      { label: "wsp", path: "/root", kind: "project" },
      { label: "apps", path: "/root/apps", kind: "directory" },
      { label: "web", path: "/root/apps/web", kind: "directory" },
      { label: "src", path: "/root/apps/web/src", kind: "directory" },
      { label: "main.tsx", path: "/root/apps/web/src/main.tsx", kind: "file" },
    ]);
  });

  it("normalizes repeated separators", () => {
    expect(fileBreadcrumbs("workspace", "/root", "/root/src//index.ts").map((crumb) => crumb.label)).toEqual([
      "workspace",
      "src",
      "index.ts",
    ]);
  });
});

describe("fileBreadcrumbChildren", () => {
  const level = (entries: LevelState["entries"]): LevelState => ({ entries, truncated: false, total: entries?.length ?? 0, isPending: false, error: null });
  const levels = new Map<string, LevelState>([
    ["/root", level([{ path: "/root/README.md", kind: "file" }, { path: "/root/src", kind: "directory" }, { path: "/root/src-old", kind: "directory" }])],
    ["/root/src/lib", level([{ path: "/root/src/lib/file10.ts", kind: "file" }, { path: "/root/src/lib/file2.ts", kind: "file" }])],
  ]);

  it("labels a listed folder's children by name, folders first", () => {
    expect(fileBreadcrumbChildren(levels, "/root")).toEqual([
      { path: "/root/src", kind: "directory", label: "src" },
      { path: "/root/src-old", kind: "directory", label: "src-old" },
      { path: "/root/README.md", kind: "file", label: "README.md" },
    ]);
  });

  it("uses natural file-name ordering", () => {
    expect(fileBreadcrumbChildren(levels, "/root/src/lib")!.map((entry) => entry.label)).toEqual(["file2.ts", "file10.ts"]);
  });

  it("is null for a folder nobody listed yet", () => {
    expect(fileBreadcrumbChildren(levels, "missing")).toBeNull();
  });
});
