// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtureCloud, fixtureState, threadId } from "./fixture-state.mjs";
import { indexMarkdown, readSurfaces, selectorFor, shotName, shotPlan, stepFor } from "./plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const list = (surfaces, rest = {}) => readSurfaces({ surfaces, ...rest });

describe("a click or wait word", () => {
  it("is the attribute alone where it names no value", () => {
    expect(selectorFor("agents-row")).toBe("[data-agents-row]");
  });

  it("keeps a value with a colon in it whole", () => {
    expect(selectorFor("row-id=thread:th_redirect")).toBe('[data-row-id="thread:th_redirect"]');
  });

  it("names a fixture's thread by the word that fixture calls it, since the id itself is a minted UUID", () => {
    expect(stepFor("row-id=thread:redirect", [1440])).toEqual({ click: `[data-row-id="thread:${threadId("redirect")}"]` });
    // A word that is not a thread is left whole, the way a workspace's row is.
    expect(stepFor("row-id=ws:ws_api", [1440])).toEqual({ click: '[data-row-id="ws:ws_api"]' });
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

  it("reads a focus: word as focus on a data attribute, with no click", () => {
    expect(stepFor("focus:surface-launcher-keys", [1440, 390])).toEqual({ focus: "[data-surface-launcher-keys]" });
    expect(stepFor("390:focus:row-id=thread:redirect", [1440, 390])).toEqual({ width: 390, focus: `[data-row-id="thread:${threadId("redirect")}"]` });
  });

  it("reads a menu: word as the right-click that opens a row's own menu", () => {
    expect(stepFor("menu:row-id=thread:redirect", [1440, 390])).toEqual({ menu: `[data-row-id="thread:${threadId("redirect")}"]` });
  });

  it("reads a hover: word as the pointer resting on a data attribute, for a control that only shows under it", () => {
    expect(stepFor("hover:k=rewind-to-here", [1440, 390])).toEqual({ hover: '[data-k="rewind-to-here"]' });
  });

  it("reads a file: word as a file of that name and size attached through the composer's picker", () => {
    expect(stepFor("file:manual.pdf:12582912", [1440, 390])).toEqual({ file: { name: "manual.pdf", bytes: 12582912 } });
    expect(stepFor("390:file:notes.md:40", [1440, 390])).toEqual({ width: 390, file: { name: "notes.md", bytes: 40 } });
  });

  it("reads a hover: word as the pointer resting on a data attribute, for what shows only under it", () => {
    expect(stepFor("hover:message-role=assistant", [1440, 390])).toEqual({ hover: '[data-message-role="assistant"]' });
    expect(stepFor("390:hover:row-id=thread:replies", [1440, 390])).toEqual({ width: 390, hover: `[data-row-id="thread:${threadId("replies")}"]` });
  });

  it("reads a type: word as typing into whatever the step before it focused", () => {
    expect(stepFor("type:/does/not/exist", [1440, 390])).toEqual({ type: "/does/not/exist" });
    expect(stepFor("390:type:/tmp", [1440, 390])).toEqual({ width: 390, type: "/tmp" });
  });

  it("reads a scroll: word as a scroll of the box around a data attribute by that many pixels", () => {
    expect(stepFor("scroll:22:sidebar-tree", [1440, 390])).toEqual({ scroll: { by: 22, within: "[data-sidebar-tree]" } });
    expect(stepFor("1440:scroll:40:row-id=settled", [1440, 390])).toEqual({ width: 1440, scroll: { by: 40, within: '[data-row-id="settled"]' } });
    expect(() => stepFor("scroll:22:Not An Attribute", [1440, 390])).toThrow(/not a data attribute name/);
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
    const read = list([{ name: "wide", at: "/", widths: [1440], reason: "A dialog of one width at every desktop size." }]);
    expect(shotPlan(read).map(s => s.width)).toEqual([1440, 1440]);
  });

  it("refuses a surface shot at fewer widths than the list with no reason why, so no width drops silently", () => {
    expect(() => list([{ name: "wide", at: "/", widths: [1440] }])).toThrow(/wide: .*"reason"/);
    expect(() => list([{ name: "wide", at: "/", widths: [1440], reason: "  " }])).toThrow(/wide: .*"reason"/);
  });

  it("refuses a reason on a surface shot at every width, where it would only go stale", () => {
    expect(() => list([{ name: "full", at: "/", reason: "Once narrowed." }])).toThrow(/full: .*"reason"/);
    expect(() => list([{ name: "full", at: "/", widths: [1440, 390], reason: "Once narrowed." }])).toThrow(/full: .*"reason"/);
  });

  it("carries the reason into the index under the surface it narrows", () => {
    const read = list([{ name: "wide", at: "/", widths: [1440], reason: "The dialog is 440px at every desktop width." }]);
    expect(read.surfaces[0].reason).toBe("The dialog is 440px at every desktop width.");
    const index = indexMarkdown(read, [shotName("wide", "light", 1440)], { at: "now", sha: "abc1234", branch: "main" });
    expect(index).toContain("Shot at 1440 alone: the dialog is 440px at every desktop width.");
  });

  it("refuses two surfaces of one name, whose files would overwrite each other", () => {
    expect(() => list([{ name: "sidebar", at: "/" }, { name: "sidebar", at: "/other" }])).toThrow(/two surfaces are called sidebar/);
  });

  it("refuses a route that is not one", () => {
    expect(() => list([{ name: "sidebar", at: "sidebar" }])).toThrow(/starting with \//);
    expect(() => list([{ name: "sidebar", at: "/", widths: [] }])).toThrow(/one or more/);
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
    expect(shotName("settings-computers", "dark", 390)).toBe("settings-computers-dark-390.png");
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

describe("every row the surfaces list aims at", () => {
  const SURFACES = JSON.parse(readFileSync(join(HERE, "surfaces.json"), "utf8")).surfaces;
  /** The rows the host draws for itself, by the id their rows carry: this computer's own, and the clouds once it
   * holds their key. */
  const HOST_ROWS = new Set(["here", "solari", "box"]);

  it("is a row the fixture that surface is served from really holds", () => {
    // The list names a workspace, a thread and a joined computer by id, and a fixture that stopped holding one
    // photographs a click that lands on nothing. Read here rather than in a browser, so a fixture reshaped for
    // one reason cannot quietly cost a shot.
    for (const surface of SURFACES) {
      const state = fixtureState(surface.fixture ?? "mac-in-use");
      const threads = new Set(Object.values(state.sessions).flatMap(doc => doc.sessions.map(row => row.threadId)));
      for (const step of surface.steps ?? []) {
        const word = step.includes(":") && !step.startsWith("row-id=") && !step.startsWith("place-row=") ? step.slice(step.indexOf(":") + 1) : step;
        // This computer's row and a cloud's are the host's own, so they are in no fixture's places collection.
        // A workspace is a tile of its own only while it holds no thread; one that does is reached by its threads.
        const held = word.startsWith("row-id=ws:")
          ? state.workspaces[word.slice("row-id=ws:".length)] !== undefined && (state.sessions[word.slice("row-id=ws:".length)]?.sessions.length ?? 0) === 0
          : word.startsWith("row-id=thread:")
            ? threads.has(threadId(word.slice("row-id=thread:".length)))
            : word.startsWith("place-row=")
              ? (state.places ?? {})[word.slice("place-row=".length)] !== undefined || HOST_ROWS.has(word.slice("place-row=".length))
              : true;
        expect([surface.name, word, held]).toEqual([surface.name, word, true]);
      }
    }
  });
});

describe("a surface that presses New thread on a project", () => {
  it("picks one of its fixture's projects first, since the sidebar draws the control only while a project is picked", () => {
    const SURFACES = JSON.parse(readFileSync(join(HERE, "surfaces.json"), "utf8")).surfaces;
    const press = steps => steps.findIndex(step => step === "k=new-workspace" || step === "menu-item=new-workspace");
    const pressing = SURFACES.filter(s => press(s.steps ?? []) >= 0);
    expect(pressing.length).toBeGreaterThan(0);
    for (const surface of pressing) {
      const steps = surface.steps;
      const projects = Object.keys(fixtureState(surface.fixture ?? "mac-in-use").projects ?? {});
      const picked = steps.slice(0, press(steps)).find(word => word.startsWith("switcher-option="));
      expect([surface.name, projects.includes(picked?.slice("switcher-option=".length))]).toEqual([surface.name, true]);
    }
  });
});

describe("a surface taller than its width's window", () => {
  it("takes the height it names, and every other surface its width's own", () => {
    const read = list([{ name: "tall", at: "/", height: 1100 }, { name: "plain", at: "/" }], { widths: [1440] });
    expect(shotPlan(read).map(s => [s.name, s.height])).toEqual([["tall", 1100], ["plain", 900], ["tall", 1100], ["plain", 900]]);
  });

  it("refuses a height that is not a whole count of pixels", () => {
    expect(() => list([{ name: "tall", at: "/", height: 0 }])).toThrow(/height/);
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
  // Every rule here is read off surfaces.json, so a surface added there is the whole of adding it: no list of names,
  // fixtures or widths is kept in this file for two branches to both edit.
  it("reads, and asks for one file per surface, width and theme", () => {
    const listed = JSON.parse(readFileSync(join(HERE, "surfaces.json"), "utf8"));
    // Reading it holds each surface to a name no other takes and to widths the list shoots.
    const read = readSurfaces(listed);
    expect(shotPlan(read)).toHaveLength(read.surfaces.reduce((n, s) => n + s.widths.length, 0) * 2);
    // Each fixture a surface names is one the state file serves.
    for (const s of read.surfaces) expect(() => fixtureState(s.fixture ?? "mac-in-use"), s.name).not.toThrow();
    // A surface that opens the cloud road is served from a fixture that names a cloud, since every other fixture's host
    // runs with the cloud off.
    for (const s of listed.surfaces.filter(s => (s.steps ?? []).some(word => word.endsWith("add-cloud-button")))) expect([s.name, fixtureCloud(s.fixture) !== undefined]).toEqual([s.name, true]);
    // The app's own default window is one of them, so a row that only breaks at 1280 is photographed.
    expect(read.widths).toContain(1280);
    expect(read.heights[1280]).toBe(800);
  });
});
