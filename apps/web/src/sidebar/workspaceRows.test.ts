// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { type Capabilities, type PlaceView, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { branchLine, computerName, madeOfLine } from "./workspaceRows";

const workspace = (over: Partial<WorkspaceView>): WorkspaceView =>
  ({ id: "ws_1", name: "a", machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-12T00:00:00.000Z", ...over }) as WorkspaceView;

const MAC = "zingzy's MacBook Pro";

/** What a computer that copies by directory and shares its network says about itself, which is the Mac. */
const SHARES: Pick<Capabilities, "copies" | "ownNetwork"> = { copies: true, ownNetwork: false };
const OWN: Pick<Capabilities, "copies" | "ownNetwork"> = { copies: false, ownNetwork: true };

const row = (over: Partial<WorkspaceView>): Pick<SidebarProjectSnapshot, "workspace"> => ({ workspace: workspace(over) });

describe("what a workspace row says it is made of", () => {
  it("joins the computer where it is not this one and the ports word, all off the protocol's table", () => {
    expect(madeOfLine({ project: row({}), landing: SHARES, computer: null, here: MAC })).toEqual(["shares zingzy's MacBook Pro's ports"]);
    expect(madeOfLine({ project: row({}), landing: SHARES, computer: "spoo", here: MAC })).toEqual(["spoo", "shares spoo's ports"]);
    expect(madeOfLine({ project: row({}), landing: OWN, computer: "spoo", here: MAC })).toEqual(["spoo", "own network"]);
  });

  it("says the network alone for a fork", () => {
    expect(madeOfLine({ project: row({}), landing: OWN, computer: "solari", here: MAC })).toEqual(["solari", "own network"]);
  });

  it("says nothing about the network until the host has answered where this project lands", () => {
    expect(madeOfLine({ project: row({}), landing: null, computer: null, here: MAC })).toEqual([]);
    expect(madeOfLine({ project: row({}), landing: null, computer: "spoo", here: MAC })).toEqual(["spoo"]);
  });

  it("carries no figure of any kind: a machine's shape and its cost are its computer's row in Settings", () => {
    const line = madeOfLine({ project: row({}), landing: SHARES, computer: null, here: MAC });
    expect(line.join(" ")).not.toMatch(/\$|GB|cores|vCPU/);
  });
});

describe("the branch a tile's row three names", () => {
  it("is the branch the worktree was made on where the record carries one, and empty where it carries none", () => {
    expect(branchLine(row({ worktree: { path: "/w", branch: "agent/pricing-page", made: true } }))).toBe("agent/pricing-page");
    expect(branchLine(row({}))).toBe("");
  });
});

describe("where a row says a workspace runs", () => {
  const mac: PlaceView = { id: "here", kind: "computer", name: "zingzys-macbook-pro.local", label: MAC, default: true };
  const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false };
  const onMac = { machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, facts: { os: "macOS 26.4" } } as WorkspaceStatus;

  it("names the computer the host runs on by its own name, a Mac included, and a cloud by its row's name", () => {
    expect(computerName([mac, solari], { workspace: workspace({ kind: "local" }), status: onMac })).toBe(MAC);
    expect(computerName([mac, solari], { workspace: workspace({ kind: "cloud", provider: "solari" }), status: null })).toBe("Solari");
  });

  it("with no places list, as while a host that just restarted reads its rows, names a provider by the name its words row gives it and never by the id its record holds, and leaves the computer the host runs on unnamed rather than saying a stand-in", () => {
    expect(computerName([], { workspace: workspace({ kind: "cloud", provider: "solari" }), status: null })).toBe("Solari");
    expect(computerName([], { workspace: workspace({ kind: "cloud", provider: "box" }), status: null })).toBe("Boat");
    expect(computerName([], { workspace: workspace({ kind: "local" }), status: null })).toBe("");
    expect(computerName([], { workspace: workspace({ kind: "local" }), status: onMac })).toBe("");
    expect(madeOfLine({ project: row({}), landing: SHARES, computer: null, here: "" })).toEqual([]);
  });
});
