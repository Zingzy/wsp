// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { LevelState } from "../../files/listing";
import { fileTreeRows, NOTE_PREFIX, sortTreeRows } from "./fileTreeRows";

const level = (entries: NonNullable<LevelState["entries"]>, extra: Partial<LevelState> = {}): LevelState => ({
  entries,
  truncated: false,
  total: entries.length,
  isPending: false,
  error: null,
  ...extra,
});

describe("fileTreeRows", () => {
  it("shows the listed folders under the root, relative to it, and leaves unlisted folders childless", () => {
    const levels = new Map<string, LevelState>([
      ["/root/app", level([{ path: "/root/app/src", kind: "directory" }, { path: "/root/app/node_modules", kind: "directory" }, { path: "/root/app/package.json", kind: "file" }])],
      ["/root/app/src", level([{ path: "/root/app/src/index.ts", kind: "file" }])],
    ]);
    const rows = fileTreeRows("/root/app", levels);
    expect(rows.paths).toEqual(["src/", "node_modules/", "package.json", "src/index.ts"]);
    expect(rows.kinds.get("package.json")).toBe("file");
    expect(rows.kinds.get("src")).toBe("directory");
    expect(rows.directories.get("node_modules/")).toBe("/root/app/node_modules");
    expect(rows.loaded).toEqual(["/root/app", "/root/app/src"]);
  });

  it("puts one note row under a folder the daemon cut, with the count", () => {
    const levels = new Map<string, LevelState>([
      ["/root", level([{ path: "/root/wide", kind: "directory" }])],
      ["/root/wide", level([{ path: "/root/wide/a.txt", kind: "file" }], { truncated: true, total: 10_001 })],
    ]);
    expect(fileTreeRows("/root", levels).paths).toEqual(["wide/", "wide/a.txt", `wide/${NOTE_PREFIX}10,000 more entries not shown`]);
  });

  it("keeps a folder's listing error out of the rows and reports it beside them", () => {
    const levels = new Map<string, LevelState>([
      ["/root", level([{ path: "/root/locked", kind: "directory" }])],
      ["/root/locked", { entries: null, truncated: false, total: 0, isPending: false, error: "EACCES: permission denied, scandir '/root/locked'" }],
    ]);
    const rows = fileTreeRows("/root", levels);
    expect(rows.paths).toEqual(["locked/"]);
    expect(rows.errors).toEqual([{ dir: "locked", message: "EACCES: permission denied, scandir '/root/locked'" }]);
  });

  it("sorts folders first, note rows last, names naturally", () => {
    const entry = (basename: string, isDirectory: boolean) => ({ basename, isDirectory, depth: 1, path: basename, segments: [basename] });
    const sorted = [entry(`${NOTE_PREFIX}3 more`, false), entry("b10.ts", false), entry("b2.ts", false), entry("zed", true)].toSorted(sortTreeRows);
    expect(sorted.map(e => e.basename)).toEqual(["zed", "b2.ts", "b10.ts", `${NOTE_PREFIX}3 more`]);
  });
});
