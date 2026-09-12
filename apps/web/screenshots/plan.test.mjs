// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexMarkdown, readSurfaces, selectorFor, shotName, shotPlan, stepFor } from "./plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const list = (surfaces, rest = {}) => readSurfaces({ surfaces, ...rest });

describe("a click or wait word", () => {
  it("is the attribute alone where it names no value", () => {
    expect(selectorFor("cloud-setup-row")).toBe("[data-cloud-setup-row]");
  });

  it("keeps a value with a colon in it whole", () => {
    expect(selectorFor("row-id=thread:th_redirect")).toBe('[data-row-id="thread:th_redirect"]');
  });

  it("escapes a quote rather than ending the selector's string", () => {
    expect(selectorFor('label=say "no"')).toBe('[data-label="say \\"no\\""]');
  });

  it("refuses anything that is not a data attribute name", () => {
    expect(() => selectorFor(".sidebar button")).toThrow(/not a data attribute name/);
    expect(() => selectorFor("")).toThrow(/non-empty string/);
  });

  it("reads leading digits and a colon as the width it is kept for", () => {
    expect(stepFor("390:sidebar=trigger", [1440, 390])).toEqual({ width: 390, click: '[data-sidebar="trigger"]' });
  });

  it("leaves a value whose own text holds a colon alone", () => {
    expect(stepFor("row-id=ws:ws_api", [1440, 390])).toEqual({ click: '[data-row-id="ws:ws_api"]' });
  });

  it("reads a key: word as a press, kept for a width like any other step", () => {
    expect(stepFor("key:Escape", [1440, 390])).toEqual({ key: "Escape" });
    expect(stepFor("390:key:Escape", [1440, 390])).toEqual({ width: 390, key: "Escape" });
  });

  it("refuses a width the list never shoots, which would silently never run", () => {
    expect(() => stepFor("768:sidebar=trigger", [1440, 390])).toThrow(/does not shoot/);
  });
});

describe("a surfaces list", () => {
  it("takes the two widths and both themes when it names none", () => {
    const read = list([{ name: "sidebar", at: "/" }]);
    expect(read.widths).toEqual([1440, 390]);
    expect(shotPlan(read).map(s => s.file)).toEqual(["sidebar-light-1440.png", "sidebar-dark-1440.png", "sidebar-light-390.png", "sidebar-dark-390.png"]);
  });

  it("gives a shot only the steps its own width keeps, in the order the list wrote them", () => {
    const read = list([{ name: "sidebar", at: "/", steps: ["390:key:Escape", "390:sidebar=trigger", "row-id=ws:ws_api"] }]);
    const at = width => shotPlan(read).find(s => s.width === width).steps;
    expect(at(1440)).toEqual([{ click: '[data-row-id="ws:ws_api"]' }]);
    expect(at(390)).toEqual([{ key: "Escape" }, { click: '[data-sidebar="trigger"]' }, { click: '[data-row-id="ws:ws_api"]' }]);
  });

  it("leaves a surface out of a width it does not name", () => {
    const read = list([{ name: "wide", at: "/", widths: [1440] }]);
    expect(shotPlan(read).map(s => s.width)).toEqual([1440, 1440]);
  });

  it("refuses two surfaces of one name, whose files would overwrite each other", () => {
    expect(() => list([{ name: "sidebar", at: "/" }, { name: "sidebar", at: "/other" }])).toThrow(/two surfaces are called sidebar/);
  });

  it("refuses a route that is not one", () => {
    expect(() => list([{ name: "sidebar", at: "sidebar" }])).toThrow(/starting with \//);
  });

  it("refuses a width with no height, which the browser could not be sized to", () => {
    expect(() => list([{ name: "sidebar", at: "/" }], { widths: [1024] })).toThrow(/width 1024 has no height/);
  });

  it("refuses a list that names no surfaces", () => {
    expect(() => readSurfaces({ surfaces: [] })).toThrow(/names no surfaces/);
  });
});

describe("the folder a run leaves", () => {
  it("names a file after its surface, theme and width", () => {
    expect(shotName("cloud-setup", "dark", 390)).toBe("cloud-setup-dark-390.png");
  });

  it("lists only the files that were written, so a missed shot is not reviewed from a stale one", () => {
    const read = list([{ name: "sidebar", at: "/" }, { name: "machine", at: "/", steps: ["surface-launch=machine"] }]);
    const index = indexMarkdown(read, ["sidebar-light-1440.png"], { at: "2026-09-12T00:00:00Z", sha: "abc1234", branch: "ticket/629-ui-harness" });
    expect(index).toContain("[sidebar-light-1440.png](sidebar-light-1440.png)");
    expect(index).not.toContain("sidebar-dark-1440.png");
    expect(index).not.toContain("## machine");
    expect(index).toContain("1 of 8 files");
  });

  it("says which steps a surface was reached by, and which of them only a narrow window takes", () => {
    const read = list([{ name: "machine", at: "/", steps: ["390:key:Escape", "390:sidebar=trigger", "surface-launch=machine"] }]);
    const index = indexMarkdown(read, ["machine-dark-390.png"], { at: "now", sha: "abc1234", branch: "main" });
    expect(index).toContain("the Escape key (at 390 only)");
    expect(index).toContain('`[data-sidebar="trigger"]` (at 390 only)');
    expect(index).toContain('`[data-surface-launch="machine"]`');
  });
});

describe("a surface that names its own fixture", () => {
  it("carries the name onto every shot, and says so in the index", () => {
    const read = list([{ name: "image", at: "/", fixture: "image-built" }]);
    expect(shotPlan(read).every(s => s.fixture === "image-built")).toBe(true);
    expect(indexMarkdown(read, [shotName("image", "light", 1440)], { at: "now", sha: "abc1234", branch: "main" })).toContain("served from the image-built fixture");
  });

  it("refuses a fixture word that is not a name", () => {
    expect(() => list([{ name: "image", at: "/", fixture: "../etc" }])).toThrow(/fixture/);
  });

  it("leaves a surface that names none without one, so it is served the run's own state", () => {
    expect(shotPlan(list([{ name: "image", at: "/" }])).every(s => s.fixture === undefined)).toBe(true);
  });
});

describe("the surfaces list this repo ships", () => {
  it("reads, and asks for one file per surface, width and theme", () => {
    const read = readSurfaces(JSON.parse(readFileSync(join(HERE, "surfaces.json"), "utf8")));
    expect(read.surfaces.map(s => s.name)).toEqual(["sidebar", "workspace", "composer-thread", "composer-slash-menu", "composer-slash-filtered", "machine", "cloud-setup", "spawned-thread", "host-asleep", "settings-where", "add-computer", "settings-image-fresh", "settings-image-built", "settings-image-sheet"]);
    // The one surface shot as a window on another computer, which is the only state the asleep line is drawn in.
    expect(read.surfaces.filter(s => s.remote).map(s => s.name)).toEqual(["host-asleep"]);
    // The two served from a state of their own, since an image that is built cannot stand in the same state file
    // as one that never was.
    expect(read.surfaces.filter(s => s.fixture !== undefined).map(s => s.fixture)).toEqual(["image-built", "image-built"]);
    expect(shotPlan(read)).toHaveLength(read.surfaces.length * read.widths.length * 2);
    // The app's own default window is one of them, so a row that only breaks at 1280 is photographed.
    expect(read.widths).toContain(1280);
    expect(read.heights[1280]).toBe(800);
  });
});
