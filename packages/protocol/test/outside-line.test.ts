// SPDX-License-Identifier: AGPL-3.0-only
// The one rule for what a moment says outside the app and under which choice,
// which the web app and the desktop shell both read.
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, NEEDS_YOU, OutsideLine, outsideLine } from "../src/index.js";

const loud = { notifyNeeds: "notify-sound", notifyDone: "notify-sound", planAlerts: true } as const;

describe("a moment said outside the app", () => {
  it("a prompt, a question and a sign-in need the person, and sound by default", () => {
    expect(outsideLine({ kind: "asks", line: "Permission for Bash: ls" }, DEFAULT_PREFERENCES)).toEqual({ title: NEEDS_YOU, body: "Permission for Bash: ls", show: true, sound: true });
    expect(outsideLine({ kind: "signIn", what: "sign in to GitHub CLI" }, { ...loud, notifyNeeds: "notify" })).toEqual({ title: NEEDS_YOU, body: "sign in to GitHub CLI", show: true, sound: false });
    expect(outsideLine({ kind: "asks", line: "x" }, { ...loud, notifyNeeds: "off" })).toBeUndefined();
  });

  it("a finish, a failure and a machine that came up follow When a thread finishes, shown with no sound by default", () => {
    expect(outsideLine({ kind: "finished", thread: "Fix login", where: "spoo" }, DEFAULT_PREFERENCES)).toEqual({ title: "Fix login finished", body: "spoo", show: true, sound: false });
    expect(outsideLine({ kind: "awake", workspace: "b1" }, DEFAULT_PREFERENCES)).toEqual({ title: NEEDS_YOU, body: "b1 is awake", show: true, sound: false });
    expect(outsideLine({ kind: "finished", thread: "Fix login", where: "spoo" }, { ...loud, notifyDone: "off" })).toBeUndefined();
    expect(outsideLine({ kind: "finished", thread: "Fix login", where: "spoo" }, loud)).toEqual({ title: "Fix login finished", body: "spoo", show: true, sound: true });
    expect(outsideLine({ kind: "failed", thread: "Fix login", where: "spoo", error: "API Error: 529\n overloaded" }, loud)).toEqual({ title: "Fix login stopped", body: "API Error: 529 overloaded", show: true, sound: true });
    expect(outsideLine({ kind: "failed", thread: "Fix login", where: "spoo" }, { ...loud, notifyDone: "sound" })).toEqual({ title: "Fix login stopped", body: "spoo", show: false, sound: true });
    expect(outsideLine({ kind: "awake", workspace: "b1" }, { ...loud, notifyNeeds: "off" })).toEqual({ title: NEEDS_YOU, body: "b1 is awake", show: true, sound: true });
  });

  it("a plan alert shows with no sound under its own switch", () => {
    expect(outsideLine({ kind: "plan", label: "Claude Max", alert: { kind: "blocked" } }, { ...loud, notifyNeeds: "off", notifyDone: "off" })).toEqual({ title: "Claude Max reached its plan limit", body: "", show: true, sound: false });
    expect(outsideLine({ kind: "plan", label: "Claude Max", alert: { kind: "blocked" } }, { ...loud, planAlerts: false })).toBeUndefined();
  });

  it("a computer's setup says it failed or needs the person under the needs-you choice, and ready under the finished one", () => {
    expect(outsideLine({ kind: "setupFailed", computer: "spoo", said: "the base tools did not install:\n apt said no" }, DEFAULT_PREFERENCES)).toEqual({ title: "spoo: setup failed", body: "the base tools did not install: apt said no", show: true, sound: true });
    expect(outsideLine({ kind: "setupNeedsYou", computer: "spoo", what: "sign in to Claude Code" }, DEFAULT_PREFERENCES)).toEqual({ title: NEEDS_YOU, body: "spoo needs you: sign in to Claude Code", show: true, sound: true });
    expect(outsideLine({ kind: "setupReady", computer: "spoo" }, DEFAULT_PREFERENCES)).toEqual({ title: "spoo is ready", body: "", show: true, sound: false });
    expect(outsideLine({ kind: "setupReady", computer: "spoo" }, { ...loud, notifyDone: "off" })).toBeUndefined();
    expect(outsideLine({ kind: "setupReady", computer: "spoo", missed: "2 folders did not clone" }, loud)).toEqual({ title: "spoo is ready; 2 folders did not clone", body: "", show: true, sound: true });
    expect(outsideLine({ kind: "setupFailed", computer: "spoo", said: "x" }, { ...loud, notifyNeeds: "off" })).toBeUndefined();
  });

  it("a line keeps the page's id for the click to hand back, and drops an open an older page put on it", () => {
    const line = { title: "Fix login finished", body: "spoo", show: true, sound: false };
    expect(OutsideLine.parse({ ...line, id: "3" })).toEqual({ ...line, id: "3" });
    expect(OutsideLine.parse({ ...line, open: { computer: "spoo" } })).toEqual(line);
  });
});
