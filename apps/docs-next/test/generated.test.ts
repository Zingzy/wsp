// SPDX-License-Identifier: AGPL-3.0-only
// A generated page or table is what its script writes now, so a change to its source that nobody generated, or a
// hand edit to the page, fails here. With WSP_WRITE_DOCS=1, which pnpm --filter @wsp/docs-next generate sets, each
// script writes its files first.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_VERBS, CLI_VERBS } from "../../../packages/host/src/verbs.js";
import { COMMAND_LINES } from "../../../packages/host/src/cli.js";
import { CLI_DIR, NO_PAGE, pageName } from "../scripts/cli.js";
import { DOCS } from "../scripts/generated.js";
import { SCRIPTS } from "../scripts/index.js";
import { drawnCards, LISTS } from "../scripts/settings.js";

const WRITE = process.env["WSP_WRITE_DOCS"] === "1";

const committed = (file: string): string | undefined => (existsSync(join(DOCS, file)) ? readFileSync(join(DOCS, file), "utf8") : undefined);

describe("the generated pages", () => {
  for (const [script, run] of Object.entries(SCRIPTS)) {
    it(`are what scripts/${script} writes now`, async () => {
      const files = await run();
      if (WRITE) {
        const changed = files.filter(({ file, text }) => committed(file) !== text);
        for (const { file, text } of changed) writeFileSync(join(DOCS, file), text);
        console.log(`scripts/${script}: ${files.length} files, ${changed.length} rewritten${changed.map(({ file }) => `\n  ${file}`).join("")}`);
      }
      const behind = files.filter(({ file, text }) => committed(file) !== text).map(({ file }) => file);
      expect(behind, `differ from what scripts/${script} writes: run pnpm --filter @wsp/docs-next generate`).toEqual([]);
    });
  }
});

describe("the command pages", () => {
  const pages = (): string[] => readdirSync(join(DOCS, CLI_DIR)).filter(f => f !== "index.mdx").map(f => f.replace(/\.mdx$/, ""));

  it("are one per line the command line answers, init aside, and nothing else", () => {
    const wanted = COMMAND_LINES.map(l => l.words).filter(w => !NO_PAGE.includes(w)).map(pageName);
    if (WRITE)
      for (const stale of pages().filter(p => !wanted.includes(p))) {
        rmSync(join(DOCS, CLI_DIR, `${stale}.mdx`));
        console.log(`removed ${CLI_DIR}/${stale}.mdx`);
      }
    expect(pages().sort()).toEqual([...wanted].sort());
  });

  it("cover every verb the command line takes, and no cloud verb", () => {
    expect(CLI_VERBS.map(v => pageName(v.name)).filter(p => !pages().includes(p))).toEqual([]);
    const cloud = ALL_VERBS.filter(v => "cloud" in v && v.cloud === true).map(v => pageName(v.name));
    expect(cloud.length).toBeGreaterThan(0);
    expect(pages().filter(p => cloud.includes(p))).toEqual([]);
  });

  it("give init no page of its own and print its help on the index", () => {
    expect(pages()).not.toContain("init");
    expect(readFileSync(join(DOCS, CLI_DIR, "index.mdx"), "utf8")).toContain("usage: wsp init");
  });
});

describe("the settings page", () => {
  it("says what a card lists only for cards the app draws with the cloud off", () => {
    const drawn = drawnCards();
    const spoken = Object.entries(LISTS).flatMap(([id, { also = [] }]) => [id, ...also]);
    expect(spoken.filter(id => !drawn.includes(id))).toEqual([]);
  });
});
