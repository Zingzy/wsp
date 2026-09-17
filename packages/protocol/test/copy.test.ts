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
  copyPathFor,
  copyRoadWord,
  folderSlug,
  networkLine,
  sharesPortsLine,
  thisComputer,
} from "../src/index.js";

/** A computer that copies and shares its ports, which is what this Mac is. */
const here = { copies: true, ownNetwork: false } as const;

const flags = {
  liveCloneForks: false,
  replacesMachine: false,
  previewUrls: false,
  signedUrls: false,
  callbackRelay: false,
  diskSnapshots: false,
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
  it("is the shared-ports line only where the computer copies and a copy gets no network of its own", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(networkLine(here, platform)).toBe(sharesPortsLine(platform));
      expect(networkLine({ copies: true, ownNetwork: true }, platform)).toBe("");
      expect(networkLine({ copies: false, ownNetwork: false }, platform)).toBe("");
      expect(networkLine({ copies: false, ownNetwork: true }, platform)).toBe("");
    }
  });

  it("names this computer the way every other line naming it does, off the platform and never a word of its own", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(sharesPortsLine(platform)).toBe(`shares ports with ${thisComputer(platform)}`);
    }
  });
});

describe("the road word on a row", () => {
  it("is one word per road", () => {
    expect(copyRoadWord("clonefile")).toBe("clone");
    expect(copyRoadWord("worktree")).toBe("worktree");
    expect(copyRoadWord("in-place")).toBe("in place");
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

  it("rides the workspace's own view beside the port its apps bind", () => {
    const view = WorkspaceView.parse({
      id: "ws_1",
      name: "pricing page",
      machineId: "local",
      phase: "running",
      kind: "local",
      golden: "",
      createdAt: "2026-09-17T00:00:00.000Z",
      project: { id: "pr_1", name: "repo", path: "/Users/dev/repo", computer: "here" },
      copy: ProjectCopy.parse({ ...report, source: "/Users/dev/repo" }),
      portBase: 3100,
    });
    expect(view.copy?.road).toBe("clonefile");
    expect(view.portBase).toBe(3100);
    // A port base is a port, so nothing under one parses.
    expect(WorkspaceView.safeParse({ ...view, portBase: 0 }).success).toBe(false);
  });
});

describe("where a copy's folder lands and what it is called", () => {
  it("is a sibling of the folder under the work's own name", () => {
    expect(copyPathFor("/Users/dev/spoo-landing", "pricing-page")).toBe("/Users/dev/spoo-landing-pricing-page");
    expect(copyPathFor("/Users/dev/spoo-landing/", "qr-codes")).toBe("/Users/dev/spoo-landing-qr-codes");
  });

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
