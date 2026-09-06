// SPDX-License-Identifier: AGPL-3.0-only
// The import dialog's pure parts: the step rows folded from project.import
// events, which events belong to one import, the consent defaults and the
// request they become, the secret offer wording as the tick changes it, and
// the landed line with what was cut.
import { describe, expect, it } from "vitest";
import type { ProjectImportEvent, ProjectSecret } from "@wsp/protocol";
import { IMPORT_STEPS, consentRequest, defaultConsent, isImportOf, landedLine, secretOffer, stepRows } from "../src/sidebar/importProject.js";

const ev = (over: Partial<ProjectImportEvent>): ProjectImportEvent => ({
  type: "project.import",
  workspaceId: "ws_a",
  source: "/Users/me/code/proj",
  dest: "/Users/me/code/proj",
  stage: "planned",
  message: "12 files, 3.0 KB and the repository; 2 secret-shaped files; 1 cache left behind.",
  elapsedMs: 10,
  ...over,
});

const env: ProjectSecret = { path: ".env", bytes: 120, signals: ["name", "keys"] };
const key: ProjectSecret = { path: "keys/id_ed25519", bytes: 400, signals: ["pem"] };
const config: ProjectSecret = { path: ".git/config", bytes: 300, signals: ["url"], rewrite: { urls: ["https://github.com/o/r"], drop: [] } };
const header: ProjectSecret = { path: "vendor/x/.git/config", bytes: 200, signals: ["keys"], rewrite: { urls: [], drop: ["http.extraheader"] } };

describe("step rows", () => {
  it("lists the six steps in order with no message before any event", () => {
    expect(IMPORT_STEPS).toEqual(["planned", "consented", "packing", "uploading", "landing", "done"]);
    expect(stepRows([])).toEqual(IMPORT_STEPS.map(stage => ({ stage, message: null, elapsedMs: null, fraction: null })));
  });

  it("keeps the last event per step, the upload fraction from bytes of total, and leaves failed out of the rows", () => {
    const rows = stepRows([
      ev({}),
      ev({ stage: "consented", message: "Carrying .env; cut keys/id_ed25519.", elapsedMs: 20 }),
      ev({ stage: "packing", message: "Packing 11 files.", elapsedMs: 30 }),
      ev({ stage: "uploading", message: "Uploading 2.8 KB.", elapsedMs: 40, bytes: 0, total: 2_800 }),
      ev({ stage: "uploading", message: "Part 1 of 2, 1.4 KB of 2.8 KB.", elapsedMs: 50, bytes: 1_400, total: 2_800 }),
      ev({ stage: "failed", message: "the machine went away", elapsedMs: 60 }),
    ]);
    expect(rows.map(r => [r.stage, r.message, r.elapsedMs, r.fraction])).toEqual([
      ["planned", "12 files, 3.0 KB and the repository; 2 secret-shaped files; 1 cache left behind.", 10, null],
      ["consented", "Carrying .env; cut keys/id_ed25519.", 20, null],
      ["packing", "Packing 11 files.", 30, null],
      ["uploading", "Part 1 of 2, 1.4 KB of 2.8 KB.", 50, 0.5],
      ["landing", null, null, null],
      ["done", null, null, null],
    ]);
  });
});

describe("which events belong to the import", () => {
  const plan = { source: "/private/var/proj", repo: true, files: 1, bytes: 1, secrets: [], excluded: [], skipped: [] };
  it("matches the workspace with the path as typed or the plan's realpath, nothing else", () => {
    expect(isImportOf(ev({ source: "/var/proj" }), "ws_a", "/var/proj", plan)).toBe(true);
    expect(isImportOf(ev({ source: "/private/var/proj" }), "ws_a", "/var/proj", plan)).toBe(true);
    expect(isImportOf(ev({ source: "/var/proj" }), "ws_a", "/var/proj", null)).toBe(true);
    expect(isImportOf(ev({ source: "/private/var/proj" }), "ws_a", "/var/proj", null)).toBe(false);
    expect(isImportOf(ev({ source: "/var/other" }), "ws_a", "/var/proj", plan)).toBe(false);
    expect(isImportOf(ev({ source: "/var/proj", workspaceId: "ws_b" }), "ws_a", "/var/proj", plan)).toBe(false);
  });
});

describe("consent", () => {
  it("ticks every rewrite offer by default and nothing that would travel as it is", () => {
    expect([...defaultConsent([env, config, key, header])].sort()).toEqual([".git/config", "vendor/x/.git/config"]);
    expect(defaultConsent([]).size).toBe(0);
  });

  it("turns the ticked paths into carry for plain files and rewrite for offered ones; unticked paths appear in neither", () => {
    expect(consentRequest([env, config, key, header], new Set([".env", ".git/config"]))).toEqual({ carry: [".env"], rewrite: [".git/config"] });
    expect(consentRequest([env, config, key, header], new Set())).toEqual({ carry: [], rewrite: [] });
    expect(consentRequest([env, config], new Set([".env", ".git/config", "gone"]))).toEqual({ carry: [".env"], rewrite: [".git/config"] });
  });

  it("words each row by its tick: unticked is cut; ticked travels as it is, or lands bare at the host without the dropped keys", () => {
    expect(secretOffer(env, false)).toEqual({ short: "cut", full: "cut" });
    expect(secretOffer(env, true)).toEqual({ short: "travels as it is", full: "travels as it is" });
    expect(secretOffer(config, false)).toEqual({ short: "cut", full: "cut" });
    expect(secretOffer(config, true)).toEqual({ short: "lands bare at github.com", full: "lands bare at https://github.com/o/r" });
    expect(secretOffer(header, true)).toEqual({ short: "lands without http.extraheader", full: "lands without http.extraheader" });
    expect(secretOffer({ ...config, rewrite: { urls: ["https://github.com/o/r", "https://gitlab.com/o/s", "https://github.com/o/t"], drop: ["http.extraheader"] } }, true)).toEqual({
      short: "lands bare at github.com, gitlab.com without http.extraheader",
      full: "lands bare at https://github.com/o/r, https://gitlab.com/o/s, https://github.com/o/t without http.extraheader",
    });
    expect(secretOffer({ ...config, rewrite: { urls: ["not a url"], drop: [] } }, true).short).toBe("lands bare at not a url");
  });
});

describe("the landed line", () => {
  it("names the folder, its path on the machine and the workspace, then what was cut", () => {
    const result = { dest: "/Users/me/code/proj", files: 11, bytes: 2_900, parts: 1, cut: [], rewritten: [".git/config"] };
    expect(landedLine(result, "/Users/me/code/proj", "api")).toBe("proj is at /Users/me/code/proj on api.");
    expect(landedLine(result, "/Users/me/code/proj/", "api")).toBe("proj is at /Users/me/code/proj on api.");
    expect(landedLine({ ...result, cut: ["keys/id_ed25519", ".env"] }, "/Users/me/code/proj", "api")).toBe("proj is at /Users/me/code/proj on api; cut keys/id_ed25519, .env.");
  });
});
