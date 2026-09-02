// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { LOGIN_CHOICES, Manifest, ManifestEntry, RUNGS, parseManifest } from "../src/index.js";

const entry = {
  rung: "identity",
  id: "identity/git-user",
  label: "git name and email",
  paths: ["~/.gitconfig"],
  bytes: 512,
  default: "bring",
  required: true,
};

describe("manifest schema", () => {
  it("lists the seven rungs in ladder order and the three login choices", () => {
    expect(RUNGS).toEqual(["identity", "shell", "editors", "toolchains", "tools", "agents", "logins"]);
    expect(LOGIN_CHOICES).toEqual(["copy", "machine", "skip"]);
  });

  it("accepts a fresh entry and every recipe field wsp init writes back", () => {
    expect(ManifestEntry.parse(entry)).toEqual(entry);
    const answered = {
      rung: "logins",
      id: "logins/gh",
      label: "GitHub CLI login",
      paths: ["~/.config/gh/hosts.yml"],
      bytes: 200,
      default: "bring",
      group: "CLI logins",
      bring: true,
      choice: "copy",
    };
    expect(ManifestEntry.parse(answered)).toEqual(answered);
  });

  it.each([
    ["an unknown rung", { ...entry, rung: "fonts" }],
    ["an empty id", { ...entry, id: "" }],
    ["an id that does not start with its rung", { ...entry, id: "shell/git-user" }],
    ["a default outside bring or skip", { ...entry, default: "maybe" }],
    ["a negative size", { ...entry, bytes: -1 }],
    ["a non-integer size", { ...entry, bytes: 1.5 }],
    ["a choice outside copy, machine, skip", { ...entry, choice: "later" }],
    ["a choice on a row that is not a login", { ...entry, choice: "copy" }],
    ["a required row that defaults to skip", { ...entry, required: true, default: "skip" }],
  ])("rejects %s", (_name, bad) => {
    expect(ManifestEntry.safeParse(bad).success).toBe(false);
  });

  it("parses the envelope and reports the failing row", () => {
    expect(parseManifest({ entries: [entry] })).toEqual({ entries: [entry] });
    expect(() => parseManifest({ entries: [entry, { ...entry, rung: 3 }] })).toThrow(/entries\.1\.rung/);
    expect(() => parseManifest({ entries: "nope" })).toThrow(/entries/);
    expect(Manifest.safeParse(null).success).toBe(false);
  });

  it("rejects two rows with the same id", () => {
    expect(() => parseManifest({ entries: [entry, entry] })).toThrow(/duplicate id identity\/git-user/);
  });
});
