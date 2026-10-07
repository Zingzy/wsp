// SPDX-License-Identifier: AGPL-3.0-only
// The desktop entry an AppImage launch writes before it names itself the
// wsp:// handler: written into the login's applications folder with the
// scheme and the icon before the call that reads it, and taken by the real
// xdg-settings where this computer has one.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeStub } from "../../../packages/protocol/test/stub-script.js";
import { appImageIcon, applicationsDir, claimWspLinks, desktopEntryText, DESKTOP_FILE, installDesktopEntry } from "../src/desktop-entry.js";

const has = (tool: string): boolean => spawnSync("/bin/sh", ["-c", `command -v ${tool}`]).status === 0;

describe("the desktop entry", () => {
  let home: string;
  let image: string;
  let kept: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-entry-"));
    image = join(home, "wsp-0.2.0.AppImage");
    writeStub(image, "#!/bin/sh\n");
    // The kept copy of the AppImage's files, laid out as electron-builder packs them.
    kept = join(home, ".wsp", "app", "0.2.0-abcd1234");
    mkdirSync(join(kept, "usr/share/icons/hicolor/512x512/apps"), { recursive: true });
    writeFileSync(join(kept, "usr/share/icons/hicolor/512x512/apps/wsp.png"), "png");
    symlinkSync("usr/share/icons/hicolor/512x512/apps/wsp.png", join(kept, ".DirIcon"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("is written with the wsp scheme and the icon before the protocol client call, which finds it there", () => {
    const dir = applicationsDir({}, home);
    expect(dir).toBe(join(home, ".local/share/applications"));
    let seen: string | undefined;
    const claimed = claimWspLinks({
      entry: { image, icon: appImageIcon(kept) },
      dir,
      claim: () => {
        seen = existsSync(join(dir, DESKTOP_FILE)) ? readFileSync(join(dir, DESKTOP_FILE), "utf8") : undefined;
        return true;
      },
      log: () => {},
    });
    expect(claimed).toBe(true);
    expect(seen).toBeDefined();
    expect(seen).toContain("MimeType=x-scheme-handler/wsp;\n");
    expect(seen).toContain(`Icon=${join(kept, "usr/share/icons/hicolor/512x512/apps/wsp.png")}\n`);
    expect(seen).toContain(`Exec=${image} --no-sandbox %U\n`);
  });

  it("writes nothing off an AppImage and still makes the call", () => {
    const dir = applicationsDir({}, home);
    let calls = 0;
    claimWspLinks({ dir, claim: () => (calls++, true), log: () => {} });
    expect(calls).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it("makes the call when the folder cannot be written, and says why", () => {
    writeFileSync(join(home, "file"), "");
    const said: string[] = [];
    let calls = 0;
    claimWspLinks({ entry: { image }, dir: join(home, "file", "applications"), claim: () => (calls++, true), log: line => said.push(line) });
    expect(calls).toBe(1);
    expect(said[0]).toMatch(/^desktop entry not written: /);
  });

  it("goes where XDG_DATA_HOME says when it names a folder", () => {
    expect(applicationsDir({ XDG_DATA_HOME: "/data" }, home)).toBe("/data/applications");
    expect(applicationsDir({ XDG_DATA_HOME: "relative" }, home)).toBe(join(home, ".local/share/applications"));
  });

  it("is rewritten when the image moved and kept when it says the same", () => {
    const dir = applicationsDir({}, home);
    expect(installDesktopEntry(dir, desktopEntryText({ image }))).toBe("written");
    expect(installDesktopEntry(dir, desktopEntryText({ image }))).toBe("kept");
    expect(installDesktopEntry(dir, desktopEntryText({ image: join(home, "moved.AppImage") }))).toBe("written");
  });

  it("names no icon where the copy holds none", () => {
    expect(appImageIcon(join(home, "nothing"))).toBeUndefined();
    expect(desktopEntryText({ image })).not.toContain("Icon=");
  });

  it("quotes an image path only where it must, as the spec asks", () => {
    expect(desktopEntryText({ image: "/home/a b/w$p \"1\" 100%.AppImage" })).toContain('Exec="/home/a b/w\\\\$p \\\\"1\\\\" 100%%.AppImage" --no-sandbox %U\n');
  });

  it.skipIf(!has("desktop-file-validate"))("passes desktop-file-validate", () => {
    const dir = applicationsDir({}, home);
    installDesktopEntry(dir, desktopEntryText({ image, icon: appImageIcon(kept) }));
    const ran = spawnSync("desktop-file-validate", [join(dir, DESKTOP_FILE)], { encoding: "utf8" });
    expect(ran.stdout + ran.stderr).toBe("");
    expect(ran.status).toBe(0);
  });

  // The call Electron makes on Linux, run for real against a fresh home: "file missing" (exit 2) with no entry, and
  // with the entry written the scheme's default is the app.
  it.skipIf(!has("xdg-settings") || !has("xdg-mime"))("lets xdg-settings name the app the wsp:// handler", () => {
    const env = { HOME: home, PATH: "/usr/bin:/bin", XDG_CURRENT_DESKTOP: "GNOME" };
    const set = () => spawnSync("xdg-settings", ["set", "default-url-scheme-handler", "wsp", DESKTOP_FILE], { env, encoding: "utf8" });
    expect(set().status).toBe(2);
    installDesktopEntry(applicationsDir({}, home), desktopEntryText({ image, icon: appImageIcon(kept) }));
    expect(set().status).toBe(0);
    expect(spawnSync("xdg-mime", ["query", "default", "x-scheme-handler/wsp"], { env, encoding: "utf8" }).stdout.trim()).toBe(DESKTOP_FILE);
  });
});
