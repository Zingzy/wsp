// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleNames, changeLines, compareVersions, previousTag, releaseNotes, unsignedNote } from "../scripts/release-notes.mjs";

const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
const published = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).name as string;

const FAKE_LOG = [
  "fix(host): --port moves the pair, a busy default steps aside",
  "chore: v0.1.4",
  "",
  "feat(app): the palette runs the same verbs as the command line",
  "fix(host): --port moves the pair, a busy default steps aside",
];

function notes(): string {
  return releaseNotes({ version: "0.1.4", previous: "v0.1.3", changes: changeLines(FAKE_LOG), unsigned: unsignedNote(readme) });
}

describe("the tag a change list starts from", () => {
  it("is the highest release tag below this one", () => {
    expect(previousTag(["v0.1.1", "v0.1.3", "v0.1.2"], "v0.1.4")).toBe("v0.1.3");
    expect(previousTag(["v0.1.9", "v0.1.10"], "v0.2.0")).toBe("v0.1.10");
    expect(previousTag(["v0.1.3", "v0.2.0", "v0.3.0"], "v0.2.0")).toBe("v0.1.3");
  });

  it("skips tags that are not releases, and the empty lines git leaves", () => {
    expect(previousTag(["v0.1.3", "nightly", "prototype/design", "", "  "], "v0.1.4")).toBe("v0.1.3");
  });

  it("is nothing at all for the first release", () => {
    expect(previousTag([], "v0.1.3")).toBeUndefined();
    expect(previousTag(["v0.2.0"], "v0.1.3")).toBeUndefined();
  });

  it("puts a release above its own prereleases", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("0.1.3", "0.1.3")).toBe(0);
    expect(previousTag(["v1.0.0-rc.1", "v0.9.0"], "v1.0.0")).toBe("v1.0.0-rc.1");
  });
});

describe("the change list", () => {
  it("is each commit subject once, without the renumbering commit", () => {
    expect(changeLines(FAKE_LOG)).toEqual([
      "fix(host): --port moves the pair, a busy default steps aside",
      "feat(app): the palette runs the same verbs as the command line",
    ]);
  });

  it("is empty when nothing landed between the tags", () => {
    expect(changeLines(["", "chore: v0.1.4"])).toEqual([]);
  });
});

describe("the lines about unsigned bundles", () => {
  it("come out of the README, so the page and the notes cannot drift", () => {
    expect(unsignedNote(readme)).toContain("not signed yet");
    expect(unsignedNote(readme)).toContain("chmod +x");
    expect(unsignedNote(readme).startsWith("<!--")).toBe(false);
  });

  it("say so when the README no longer marks them", () => {
    expect(() => unsignedNote("# wsp\n\nno markers here\n")).toThrow(/no unsigned:start and unsigned:end markers/);
  });
});

describe("the notes on the draft release", () => {
  it("name the tag they start from and list what landed", () => {
    expect(notes()).toContain("## What changed since v0.1.3");
    expect(notes()).toContain("- feat(app): the palette runs the same verbs as the command line");
    expect(notes()).not.toContain("chore: v0.1.4");
  });

  it("name every bundle and the command line install for this version", () => {
    const names = bundleNames("0.1.4");
    expect(names).toEqual({ macArm64: "wsp-0.1.4-mac-arm64.zip", macX64: "wsp-0.1.4-mac-x64.zip", appImage: "wsp-0.1.4.AppImage" });
    for (const name of Object.values(names)) expect(notes()).toContain(name);
    expect(published).toBe("@zingzy/wsp");
    expect(notes()).toContain(`npm i -g ${published}@0.1.4`);
  });

  it("carry the README's lines on opening an unsigned bundle", () => {
    expect(notes()).toContain(unsignedNote(readme));
  });

  it("say it is the first release when there is no tag before it", () => {
    const first = releaseNotes({ version: "0.1.3", previous: undefined, changes: [], unsigned: unsignedNote(readme) });
    expect(first).toContain("## What changed\n");
    expect(first).toContain("- The first release.");
  });

  it("are plain: no em-dash, no tool or model names", () => {
    for (const word of ["—", "–", "Claude", "Anthropic", "AI", "agent-written"]) expect(notes()).not.toContain(word);
  });
});
