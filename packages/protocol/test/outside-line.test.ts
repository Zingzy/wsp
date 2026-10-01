// SPDX-License-Identifier: AGPL-3.0-only
// The one rule for what a moment says outside the app and under which choice,
// which the web app and the desktop shell both read.
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, NEEDS_YOU, outsideLine } from "../src/index.js";

const loud = { notifyNeeds: "notify-sound", notifyDone: "notify-sound", planAlerts: true } as const;

describe("a moment said outside the app", () => {
  it("a prompt, a question and a sign-in need the person, and sound by default", () => {
    expect(outsideLine({ kind: "asks", line: "Permission for Bash: ls" }, DEFAULT_PREFERENCES)).toEqual({ title: NEEDS_YOU, body: "Permission for Bash: ls", show: true, sound: true });
    expect(outsideLine({ kind: "signIn", what: "sign in to GitHub CLI" }, { ...loud, notifyNeeds: "notify" })).toEqual({ title: NEEDS_YOU, body: "sign in to GitHub CLI", show: true, sound: false });
    expect(outsideLine({ kind: "asks", line: "x" }, { ...loud, notifyNeeds: "off" })).toBeUndefined();
  });

  it("a finish, a failure and a machine that came up follow When a thread finishes, off by default", () => {
    expect(outsideLine({ kind: "finished", thread: "Fix login", where: "spoo" }, DEFAULT_PREFERENCES)).toBeUndefined();
    expect(outsideLine({ kind: "awake", workspace: "b1" }, DEFAULT_PREFERENCES)).toBeUndefined();
    expect(outsideLine({ kind: "finished", thread: "Fix login", where: "spoo" }, loud)).toEqual({ title: "Fix login finished", body: "spoo", show: true, sound: true });
    expect(outsideLine({ kind: "failed", thread: "Fix login", where: "spoo", error: "API Error: 529\n overloaded" }, loud)).toEqual({ title: "Fix login stopped", body: "API Error: 529 overloaded", show: true, sound: true });
    expect(outsideLine({ kind: "failed", thread: "Fix login", where: "spoo" }, { ...loud, notifyDone: "sound" })).toEqual({ title: "Fix login stopped", body: "spoo", show: false, sound: true });
    expect(outsideLine({ kind: "awake", workspace: "b1" }, { ...loud, notifyNeeds: "off" })).toEqual({ title: NEEDS_YOU, body: "b1 is awake", show: true, sound: true });
  });

  it("a plan alert shows with no sound under its own switch", () => {
    expect(outsideLine({ kind: "plan", label: "Claude Max", alert: { kind: "blocked" } }, { ...loud, notifyNeeds: "off", notifyDone: "off" })).toEqual({ title: "Claude Max reached its plan limit", body: "", show: true, sound: false });
    expect(outsideLine({ kind: "plan", label: "Claude Max", alert: { kind: "blocked" } }, { ...loud, planAlerts: false })).toBeUndefined();
  });
});
