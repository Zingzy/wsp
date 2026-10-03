// SPDX-License-Identifier: AGPL-3.0-only
// The wire and the words for a workspace that is a copy of a project folder:
// the two capability flags a computer declares about copies, the cell a row
// says about shared ports, the road word, and the two path rules a copy's
// folder is named by.
import { describe, expect, it } from "vitest";
import {
  Capabilities,
  CopyAsk,
  CopyReport,
  ProjectCopy,
  WorkspaceView,
  CopyRoad,
  COPY_WORD,
  folderSlug,
  madeOfWord,
  portsWord,
} from "../src/index.js";

/** A computer that copies and shares its ports, which is what a Mac is. */
const here = { copies: true, ownNetwork: false } as const;

const flags = {
  liveCloneForks: false,
  replacesMachine: false,
  previewUrls: false,
  signedUrls: false,
  callbackRelay: false,
  diskSnapshots: false,
  images: false,
  snapshotsAnyLife: false,
  snapshotListing: false,
  templates: false,
  sizes: [],
  kept: true,
  copies: true,
  ownNetwork: false,
};

const report = {
  road: "clonefile",
  path: "/Users/dev/repo-pricing-page",
  base: "1".repeat(40),
  branch: "main",
  fetched: true,
  carried: "deps-and-config",
  excluded: [".next"],
  bytes: 6_400_000_000,
  ms: 4900,
};

describe("the two flags a computer declares about copies", () => {
  it("are both required, so a backend that declares neither is refused rather than read as false", () => {
    expect(Capabilities.safeParse(flags).success).toBe(true);
    const { copies, ...withoutCopies } = flags;
    expect(copies).toBe(true);
    expect(Capabilities.safeParse(withoutCopies).success).toBe(false);
    const { ownNetwork, ...withoutNetwork } = flags;
    expect(ownNetwork).toBe(false);
    expect(Capabilities.safeParse(withoutNetwork).success).toBe(false);
  });
});

describe("what a row says about a copy's network", () => {
  it("is its own network, the computer's ports with the copy's port base, or those ports alone, and nothing where the computer copies nothing", () => {
    for (const computer of ["zingzy's MacBook Pro", "spoo"]) {
      expect(portsWord({ copies: false, ownNetwork: true }, computer)).toBe("own network");
      expect(portsWord(here, computer)).toBe(`shares ${computer}'s ports`);
      expect(portsWord({ copies: false, ownNetwork: false }, computer)).toBe("");
    }
  });

  it("gives a copy with its own network that word whatever road made it, since the ports inside one are its own", () => {
    expect(portsWord({ copies: true, ownNetwork: true }, "spoo")).toBe("own network");
  });
});

describe("what a row says a workspace is made of", () => {
  it("is a copy for both roads, the one word the first-run screen reads before any road is taken", () => {
    expect(madeOfWord("clonefile")).toBe("a copy");
    expect(madeOfWord("worktree")).toBe("a copy");
    expect(COPY_WORD).toBe("a copy");
  });

  it("has two roads, and a record or a report naming any other is refused", () => {
    expect(CopyRoad.options).toEqual(["clonefile", "worktree"]);
    expect(CopyRoad.safeParse("in-place").success).toBe(false);
    expect(ProjectCopy.safeParse({ road: "in-place", path: "/Users/dev/repo", source: "/Users/dev/repo", base: "", branch: "", carried: "nothing" }).success).toBe(false);
    expect(CopyReport.safeParse({ ...report, road: "in-place" }).success).toBe(false);
  });
});

describe("what the copy verb is asked for and what it answers", () => {
  it("takes the report the verb prints, with the reason a road was passed over as the one optional field", () => {
    expect(CopyReport.parse(report).fellBack).toBeUndefined();
    expect(CopyReport.parse({ ...report, fellBack: "the folder is 21.0 GB and a clone above 20.0 GB is not taken" }).fellBack).toContain("20.0 GB");
    // A road nothing here has, and a size that is not a whole count of bytes, are both refused.
    expect(CopyReport.safeParse({ ...report, road: "rsync" }).success).toBe(false);
    expect(CopyReport.safeParse({ ...report, bytes: 1.5 }).success).toBe(false);
    expect(CopyReport.safeParse({ ...report, carried: "everything" }).success).toBe(false);
  });

  it("carries the exclusions and the size line on the ask, and leaves the road to the verb when nobody named one", () => {
    const ask = CopyAsk.parse({ from: "/a", to: "/b", exclude: [".next"], sizeLineBytes: 1024 });
    expect(ask.road).toBeUndefined();
    expect(ask.base).toBeUndefined();
    expect(CopyAsk.safeParse({ from: "/a", to: "/b", sizeLineBytes: 1024 }).success).toBe(false);
  });

  it("is kept on the record as the road, the path, what it stands on and the folder it came from", () => {
    const copy = ProjectCopy.parse({ ...report, source: "/Users/dev/repo" });
    expect(copy).toEqual({
      road: "clonefile",
      path: "/Users/dev/repo-pricing-page",
      base: "1".repeat(40),
      branch: "main",
      carried: "deps-and-config",
      source: "/Users/dev/repo",
    });
    // What the verb measured is the verb's; the record keeps what a row and a delete need.
    expect("ms" in copy).toBe(false);
    expect("bytes" in copy).toBe(false);
  });
});

describe("what a piece of work's name is as a folder name", () => {
  it("turns a piece of work's name into a folder name and never into nothing", () => {
    expect(folderSlug("pricing page copy")).toBe("pricing-page-copy");
    expect(folderSlug("  QR codes: round 2!  ")).toBe("qr-codes-round-2");
    expect(folderSlug("...")).toBe("work");
    expect(folderSlug("")).toBe("work");
    // Cut short enough to stay typeable, and never left ending in a dash.
    const long = folderSlug("a".repeat(60));
    expect(long).toHaveLength(40);
    expect(folderSlug(`${"b".repeat(39)} tail`)).toBe("b".repeat(39));
  });
});
