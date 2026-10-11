// SPDX-License-Identifier: AGPL-3.0-only
// wsp run --resume and --copy as the command line reads them: a conversation runs in the folder it ran in, so the
// words that say where a thread runs are refused beside it, and a copy goes with the conversation it copies; each a
// usage refusal in two halves, before the host is asked anything.
import { describe, expect, it } from "vitest";
import { COPY_ALONE_FIX, COPY_ALONE_LINE, exitClassOf, refusalParts, RESUME_WHERE_FIX, RESUME_WHERE_LINE } from "@wsp/protocol";
import { resumeAsked } from "../src/verbs/turns-help.js";

const refused = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return { ...refusalParts(e), class: exitClassOf(e) };
  }
  throw new Error("not refused");
};

describe("wsp run --resume", () => {
  it("reads the conversation and whether it runs on a copy", () => {
    expect(resumeAsked("7414323d-e71b-4957-8b56-eefdf6bfa350", false, {})).toEqual({ id: "7414323d-e71b-4957-8b56-eefdf6bfa350" });
    expect(resumeAsked("7414323d-e71b-4957-8b56-eefdf6bfa350", true, {})).toEqual({ id: "7414323d-e71b-4957-8b56-eefdf6bfa350", copy: true });
    expect(resumeAsked(undefined, false, { branch: "feat/x" })).toBeUndefined();
  });

  it("is a usage refusal beside --branch, --cwd or --beside", () => {
    for (const where of [{ branch: "feat/x" }, { cwd: "/work/acme/lab" }, { beside: "thread-7f" }]) {
      expect(refused(() => resumeAsked("7414323d-e71b-4957-8b56-eefdf6bfa350", false, where))).toEqual({ said: `${RESUME_WHERE_LINE}.`, fix: RESUME_WHERE_FIX, kind: "usage", class: "usage" });
    }
  });

  it("refuses --copy with no conversation to copy", () => {
    expect(refused(() => resumeAsked(undefined, true, {}))).toEqual({ said: `${COPY_ALONE_LINE}.`, fix: COPY_ALONE_FIX, kind: "usage", class: "usage" });
  });
});
