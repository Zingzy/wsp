// Adapted from pingdotgg/t3code apps/web/src/components/chat/ChangedFilesTree.test.tsx at 57a66608 (MIT).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChangedFilesCard, ChangedFilesTree } from "./ChangedFilesTree";

describe("ChangedFilesCard", () => {
  const card = (files: ReadonlyArray<{ path: string; kind: string; additions: number; deletions: number }>, allDirectoriesExpanded = false) =>
    renderToStaticMarkup(
      <ChangedFilesCard
        turnId={"turn-1"}
        files={files}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

  it("is a header over the tree, the header the count, the additions in green, the deletions in red and a borderless Open diff", () => {
    const markup = card([{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }]);
    expect(markup).toContain('data-changed-files-state="tree"');
    expect(markup).toContain("1 changed file");
    expect(markup).not.toContain("1 changed files");
    const header = markup.slice(markup.indexOf("data-changed-files-header"), markup.indexOf("data-changed-file="));
    expect(header).toMatch(/text-success[^"]*">\+2</);
    expect(header).toMatch(/text-error-foreground[^"]*">-1</);
    expect(header).toContain('aria-label="Open diff"');
    expect(header).not.toMatch(/Show files|Hide files|aria-expanded/);
    expect(markup).toContain('data-changed-file="README.md"');
  });

  it("offers expand-all only where the files sit in folders", () => {
    expect(card([{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }])).not.toContain("all folders");
    expect(card([{ path: "src/a.ts", kind: "modified", additions: 2, deletions: 1 }])).toContain('aria-label="Expand all folders"');
    expect(card([{ path: "src/a.ts", kind: "modified", additions: 2, deletions: 1 }], true)).toContain('aria-label="Collapse all folders"');
  });

  it("shows a move-only turn as its quiet lines alone: no file tree, no count and no Open diff", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        turnId={"turn-1"}
        files={[]}
        moved={["Checked out pr-889", "Pulled"]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );
    expect(markup).toContain("data-changed-files-moved");
    expect(markup).toContain("Checked out pr-889");
    expect(markup).toContain("Pulled");
    // No file tree: the move named itself, and no file is its own.
    expect(markup).not.toContain("data-changed-file=");
    expect(markup).not.toContain("data-changed-files-header");
    expect(markup).not.toContain("changed file");
    expect(markup).not.toContain("Open diff");
  });

  it("lists a large turn as its top-level rows, with no chips and no Show all", () => {
    const files = [
      ...Array.from({ length: 30 }, (_, n) => ({ path: `apps/web/src/f${n}.ts`, kind: "modified", additions: 3, deletions: 1 })),
      ...Array.from({ length: 19 }, (_, n) => ({ path: `packages/protocol/src/p${n}.ts`, kind: "modified", additions: 1, deletions: 1 })),
      { path: "README.md", kind: "modified", additions: 3, deletions: 0 },
    ];
    const markup = card(files);
    expect(markup).toContain("50 changed files");
    expect(markup).toContain("apps/web/src");
    expect(markup).toContain("packages/protocol/src");
    expect(markup).toContain("README.md");
    expect(markup).not.toContain("f0.ts");
    expect(markup).not.toMatch(/Show all|2 files|root/);
  });
});

describe("ChangedFilesTree", () => {
  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src"],
      hiddenLabels: ["index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        {
          path: "apps/server/src/git/Layers/GitCore.ts",
          kind: "modified",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          kind: "modified",
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: ["apps/server/src"],
      hiddenLabels: ["git", "provider", "GitCore.ts", "CodexAdapter.ts"],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", kind: "modified", additions: 8, deletions: 2 },
        {
          path: "packages/contracts/src/orchestration.ts",
          kind: "modified",
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: ["README.md", "packages"],
      hiddenLabels: ["shared/src", "contracts/src", "git.ts", "orchestration.ts"],
    },
  ])(
    "renders $name collapsed on the first render when collapse-all is active",
    ({ files, visibleLabels, hiddenLabels }) => {
      const markup = renderToStaticMarkup(
        <ChangedFilesTree
          turnId={"turn-1"}
          files={files}
          allDirectoriesExpanded={false}
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(markup).toContain(label);
      }
      for (const label of hiddenLabels) {
        expect(markup).not.toContain(label);
      }
    },
  );

  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src", "index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        {
          path: "apps/server/src/git/Layers/GitCore.ts",
          kind: "modified",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          kind: "modified",
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: [
        "apps/server/src",
        "git/Layers",
        "provider/Layers",
        "GitCore.ts",
        "CodexAdapter.ts",
      ],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", kind: "modified", additions: 8, deletions: 2 },
        {
          path: "packages/contracts/src/orchestration.ts",
          kind: "modified",
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: [
        "README.md",
        "packages",
        "shared/src",
        "contracts/src",
        "git.ts",
        "orchestration.ts",
      ],
    },
  ])(
    "renders $name expanded on the first render when expand-all is active",
    ({ files, visibleLabels }) => {
      const markup = renderToStaticMarkup(
        <ChangedFilesTree
          turnId={"turn-1"}
          files={files}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(markup).toContain(label);
      }
    },
  );
});
