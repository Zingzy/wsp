// SPDX-License-Identifier: AGPL-3.0-only
// Open in editor on this computer: the picker lists only the editors whose app
// is installed, each opens with its own program and the path as one argument,
// a path outside the workspace's folders or through a link out of them opens
// nothing, and a path full of shell words reaches the editor as those words.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorId } from "@wsp/protocol";
import { writeStub } from "../../protocol/test/stub-script.js";
import { EDITORS, editorHost, editorMissingLine, editorOutsideLine, NO_EDITOR_LINE, type EditorCommand } from "../src/editor.js";

let tmp: string;
let work: string;
let outside: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wsp-editor-"));
  work = join(tmp, "work");
  outside = join(tmp, "outside");
  mkdirSync(join(work, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(work, "src", "a.ts"), "export {};\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A host on a Mac where the apps named are installed, which records what it would run. */
function mac(apps: readonly string[]) {
  const ran: EditorCommand[] = [];
  const host = editorHost({
    platform: "darwin",
    home: "/Users/dev",
    exists: path => apps.includes(path),
    run: async command => void ran.push(command),
  });
  return { host, ran };
}

describe("the editor table", () => {
  it("names every editor the protocol does, once, in the picker's order", () => {
    expect(EDITORS.map(row => row.id)).toEqual(EditorId.options);
  });

  it("lists only what is installed, from /Applications or the home's own, and nothing on a computer that is not a Mac", async () => {
    const { host } = mac(["/Applications/Cursor.app", "/Users/dev/Applications/IntelliJ IDEA Ultimate.app", "/System/Library/CoreServices/Finder.app"]);
    expect(await host.list()).toEqual([
      { id: "cursor", name: "Cursor" },
      { id: "idea", name: "IntelliJ IDEA" },
      { id: "finder", name: "Finder" },
    ]);
    const linux = editorHost({ platform: "linux", exists: () => true, run: async () => undefined });
    expect(await linux.list()).toEqual([]);
  });
});

describe("opening a path", () => {
  it("runs each editor's own program with the path as one argument and the line in that editor's own form", async () => {
    const file = join(work, "src", "a.ts");
    const { host, ran } = mac([
      "/Applications/Visual Studio Code.app",
      "/Applications/Cursor.app",
      "/Applications/Zed.app",
      "/Applications/WebStorm.app",
      "/System/Library/CoreServices/Finder.app",
    ]);
    for (const editor of ["vscode", "cursor", "zed", "webstorm", "finder"] as const) expect(await host.open({ path: file, line: 12, inside: [work], editor })).toBe(editor);
    expect(ran).toEqual([
      { file: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", args: ["-g", `${file}:12`] },
      { file: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor", args: ["-g", `${file}:12`] },
      { file: "/Applications/Zed.app/Contents/MacOS/cli", args: [`${file}:12`] },
      { file: "/usr/bin/open", args: ["-na", "/Applications/WebStorm.app", "--args", "--line", "12", file] },
      { file: "/usr/bin/open", args: ["-R", file] },
    ]);
  });

  it("opens a folder as the folder, with no line, and a file with none at its top", async () => {
    const { host, ran } = mac(["/Applications/Visual Studio Code.app", "/System/Library/CoreServices/Finder.app"]);
    await host.open({ path: work, line: 3, inside: [work] });
    await host.open({ path: join(work, "src", "a.ts"), inside: [work] });
    await host.open({ path: work, inside: [work], editor: "finder" });
    expect(ran).toEqual([
      { file: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", args: [work] },
      { file: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", args: [join(work, "src", "a.ts")] },
      { file: "/usr/bin/open", args: [work] },
    ]);
  });

  it("takes the first installed editor with no pick, and refuses a pick that is not installed or a computer with none", async () => {
    const { host, ran } = mac(["/Applications/Zed.app"]);
    expect(await host.open({ path: work, inside: [work] })).toBe("zed");
    await expect(host.open({ path: work, inside: [work], editor: "cursor" })).rejects.toThrow(editorMissingLine("Cursor"));
    const none = mac([]);
    await expect(none.host.open({ path: work, inside: [work] })).rejects.toThrow(NO_EDITOR_LINE);
    expect(ran).toHaveLength(1);
  });

  it("opens nothing for a path outside the folders: another folder, a relative path, a way up, or a link out", async () => {
    symlinkSync(outside, join(work, "escape"));
    const { host, ran } = mac(["/Applications/Visual Studio Code.app"]);
    for (const path of [join(outside, "secret.txt"), "src/a.ts", "-g", join(work, "..", "outside", "secret.txt"), join(work, "escape", "secret.txt"), `${work}-sibling/a.ts`]) {
      await expect(host.open({ path, inside: [work] }), path).rejects.toThrow(editorOutsideLine(path));
    }
    expect(ran).toEqual([]);
  });

  it("hands a path full of shell words to the editor as those words, and no shell runs them", async () => {
    const home = join(tmp, "home");
    const cli = join(home, "Applications", "Zed.app", "Contents", "MacOS", "cli");
    mkdirSync(join(cli, ".."), { recursive: true });
    const said = join(tmp, "said.txt");
    writeStub(cli, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${said}'\n`);
    const weird = join(work, "x $(touch PWNED); `touch PWNED` && echo.ts");
    writeFileSync(weird, "");
    // Only the fake bundle counts as installed, so a real editor on the computer running the test is never started.
    const host = editorHost({ platform: "darwin", home, exists: path => path.startsWith(home) && existsSync(path) });
    expect(await host.open({ path: weird, line: 4, inside: [work], editor: "zed" })).toBe("zed");
    await expect.poll(() => (existsSync(said) ? readFileSync(said, "utf8") : "")).toBe(`${weird}:4\n`);
    expect(existsSync("PWNED")).toBe(false);
    expect(existsSync(join(work, "PWNED"))).toBe(false);
  });
});
