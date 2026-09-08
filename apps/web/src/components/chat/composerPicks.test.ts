// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { contextWindowsFor, type HarnessCatalog, type SessionView } from "@wsp/protocol";
import { effectivePicks, resolveModel, runningPicks, startOptionsFrom } from "./composerPicks";

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.257",
  models: [
    { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] },
    { value: "claude-sonnet-5", label: "Sonnet 5", contextWindows: [] },
    { value: "claude-haiku-4-5", label: "Haiku", efforts: [], contextWindows: [] },
    { value: "claude-next", label: "Next", efforts: ["high"] },
  ],
  efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High", isDefault: true }],
  contextWindows: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }],
  permissionModes: [{ value: "plan", label: "Plan" }, { value: "bypassPermissions", label: "Bypass", isDefault: true }],
  steers: true,
  renames: true,
  images: true,
};

describe("resolveModel", () => {
  it("prefers the pick, then the running session's model, then the catalog's default", () => {
    expect(resolveModel(CLAUDE, { picked: "claude-sonnet-5", running: "claude-haiku-4-5" })?.value).toBe("claude-sonnet-5");
    expect(resolveModel(CLAUDE, { picked: undefined, running: "claude-haiku-4-5" })?.value).toBe("claude-haiku-4-5");
    expect(resolveModel(CLAUDE, { picked: undefined, running: undefined })?.value).toBe("claude-opus-5");
  });

  it("a pick the catalog does not list still resolves, as an option named by its slug; no pick and no default is null", () => {
    expect(resolveModel(CLAUDE, { picked: "claude-old-3", running: undefined })).toEqual({ value: "claude-old-3", label: "claude-old-3" });
    expect(resolveModel({ ...CLAUDE, models: [] }, { picked: undefined, running: undefined })).toBeNull();
    const noDefault = { ...CLAUDE, models: CLAUDE.models.map(({ isDefault: _d, ...m }) => m) };
    expect(resolveModel(noDefault, { picked: undefined, running: undefined })).toBeNull();
    expect(contextWindowsFor(noDefault, null)).toEqual([]);
    expect(startOptionsFrom(noDefault, { contextWindow: "1m" })).toEqual({});
  });
});

describe("runningPicks", () => {
  const session: SessionView = { id: "s1", workspaceId: "w", harness: "claude", status: "running", model: "claude-opus-5[1m]", effort: "high", permissionMode: "plan" };

  it("reads the CLI's 1M suffix off the announced model as the context window", () => {
    expect(runningPicks(session, true)).toEqual({ model: "claude-opus-5", contextWindow: "1m", effort: "high", permissionMode: "plan" });
    expect(runningPicks({ ...session, model: "claude-sonnet-5", contextWindow: "200k" }, true)).toEqual({ model: "claude-sonnet-5", contextWindow: "200k", effort: "high", permissionMode: "plan" });
  });

  it("is empty when no turn runs or the row is not running", () => {
    expect(runningPicks(session, false)).toEqual({});
    expect(runningPicks({ ...session, status: "completed" }, true)).toEqual({});
    expect(runningPicks(null, true)).toEqual({});
  });
});

describe("effectivePicks and startOptionsFrom", () => {
  it("shows the pick, else the running value, else the default, and drops a pick the model cannot take", () => {
    expect(effectivePicks(CLAUDE, { picked: {}, running: {} })).toEqual({ model: "claude-opus-5", effort: "high", contextWindow: "1m", permissionMode: "bypassPermissions" });
    const picks = effectivePicks(CLAUDE, { picked: { effort: "low", contextWindow: "200k" }, running: {} });
    expect(picks).toEqual({ model: "claude-opus-5", effort: "low", contextWindow: "200k", permissionMode: "bypassPermissions" });
    // Next takes only high, so the catalog's default survives the narrowing; Haiku takes none, so nothing is shown.
    expect(effectivePicks(CLAUDE, { picked: { model: "claude-next" }, running: {} }).effort).toBe("high");
    const haiku = effectivePicks(CLAUDE, { picked: { model: "claude-haiku-4-5", effort: "high", contextWindow: "1m" }, running: {} });
    expect(haiku).toEqual({ model: "claude-haiku-4-5", effort: null, contextWindow: null, permissionMode: "bypassPermissions" });
    const sonnet = effectivePicks(CLAUDE, { picked: { model: "claude-sonnet-5" }, running: { effort: "low" } });
    expect(sonnet).toEqual({ model: "claude-sonnet-5", effort: "low", contextWindow: null, permissionMode: "bypassPermissions" });
  });

  it("only picks ride the wire, except that a context window brings the model it rides on", () => {
    expect(startOptionsFrom(CLAUDE, {})).toEqual({});
    expect(startOptionsFrom(CLAUDE, { effort: "high", permissionMode: "plan" })).toEqual({ effort: "high", permissionMode: "plan" });
    expect(startOptionsFrom(CLAUDE, { contextWindow: "1m" })).toEqual({ model: "claude-opus-5", contextWindow: "1m" });
    expect(startOptionsFrom(CLAUDE, { model: "claude-sonnet-5", contextWindow: "1m" })).toEqual({ model: "claude-sonnet-5" });
    expect(startOptionsFrom(CLAUDE, { model: "claude-haiku-4-5", effort: "high" })).toEqual({ model: "claude-haiku-4-5" });
    expect(startOptionsFrom(CLAUDE, { harness: "claude", model: "claude-old-3", effort: "low" })).toEqual({ harness: "claude", model: "claude-old-3", effort: "low" });
  });

  it("a remembered access mode the catalog no longer lists is shown as nothing and not sent", () => {
    expect(effectivePicks(CLAUDE, { picked: { permissionMode: "auto" }, running: {} }).permissionMode).toBeNull();
    expect(startOptionsFrom(CLAUDE, { permissionMode: "auto", effort: "high" })).toEqual({ effort: "high" });
  });
});
