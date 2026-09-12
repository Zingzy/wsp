// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { EXIT_CODES, EXIT_WORDS, ExitClass, VerbFailure, authRefusal, exitClassOf, notFoundRefusal, usageRefusal, verbFailure } from "../src/index.js";

describe("the exit code every wsp verb answers with", () => {
  it("is one table: ok 0, provider 1, auth 2, usage 3, each class with its words", () => {
    expect(EXIT_CODES).toEqual({ ok: 0, provider: 1, auth: 2, usage: 3 });
    expect(ExitClass.options).toEqual(["ok", "provider", "auth", "usage"]);
    for (const cls of ExitClass.options) expect(EXIT_WORDS[cls], cls).toMatch(/\S/);
    expect(Object.values(EXIT_WORDS).join(" ")).not.toContain("\u2014");
  });

  it("classes an error by the kind stamped on it and never by its words: usage and invalid are usage, auth is auth, everything else is the provider's", () => {
    expect(exitClassOf(usageRefusal("wsp new takes one name.", "usage: wsp new <name>"))).toBe("usage");
    expect(exitClassOf(Object.assign(new Error("2x9 is not a size"), { kind: "invalid" }))).toBe("usage");
    expect(exitClassOf(authRefusal("unauthorized"))).toBe("auth");
    // A name this host holds nothing by is a value nothing takes, whichever door was typed and however far it got.
    expect(exitClassOf(notFoundRefusal("no workspace nope"))).toBe("usage");
    expect(exitClassOf(Object.assign(new Error("unauthorized"), { kind: "auth", status: 401 }))).toBe("auth");
    for (const kind of ["concurrency", "plan", "missing", "conflict", "exists", "transient", "unknown"]) expect(exitClassOf(Object.assign(new Error("no"), { kind })), kind).toBe("provider");
    expect(exitClassOf(new Error("Unknown option '--json'"))).toBe("provider");
    expect(exitClassOf(new Error("no host answered for /x within 20.0s"))).toBe("provider");
    expect(exitClassOf("a string")).toBe("provider");
    expect(exitClassOf(undefined)).toBe("provider");
  });

  it("the failure object is the message, the class and the code the class owns, and parses against its own schema", () => {
    const failure = verbFailure(usageRefusal("wsp forget takes one workspace.", "usage: wsp forget <workspace>"));
    expect(failure).toEqual({ error: "wsp forget takes one workspace. usage: wsp forget <workspace>", class: "usage", exit: 3 });
    expect(VerbFailure.parse(failure)).toEqual(failure);
    expect(verbFailure(authRefusal("the host's token file is missing: /x"))).toEqual({ error: "the host's token file is missing: /x", class: "auth", exit: 2 });
    expect(verbFailure(new Error("no workspace nope"))).toEqual({ error: "no workspace nope", class: "provider", exit: 1 });
    expect(verbFailure("plain")).toEqual({ error: "plain", class: "provider", exit: 1 });
    expect(VerbFailure.safeParse({ error: "x", class: "ok", exit: 0 }).success).toBe(false);
  });
});
