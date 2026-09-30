// SPDX-License-Identifier: AGPL-3.0-only
// Open in editor on this computer: the picker lists only the editors whose app
// is installed, each opens with its own program and the path as one argument,
// a path outside the workspace's folders or through a link out of them opens
// nothing, and a path full of shell words reaches the editor as those words.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorId, editorOpensHereLine } from "@wsp/protocol";
import { writeStub } from "../../protocol/test/stub-script.js";
import { EDITORS, editorHost, editorMissingLine, editorOutsideLine, NO_EDITOR_LINE, remoteExtensionLine, type EditorCommand } from "../src/editor.js";

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

/** A host on a Mac where the apps named are installed, which records what it would run. `extensions` names, by the
 * folder each editor keeps them in under the home, the extensions that editor lists as installed. */
function mac(apps: readonly string[], extensions: Readonly<Record<string, readonly string[]>> = {}, env: Readonly<Record<string, string | undefined>> = {}) {
  const ran: EditorCommand[] = [];
  const home = join(tmp, "home");
  for (const [folder, ids] of Object.entries(extensions)) writeExtensions(join(home, folder), ids);
  const host = editorHost({
    platform: "darwin",
    home,
    env,
    exists: path => apps.includes(path),
    run: async command => void ran.push(command),
  });
  return { host, ran, home };
}
/** The extensions.json an editor keeps in its extensions folder, listing these as installed. */
function writeExtensions(folder: string, ids: readonly string[]): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "extensions.json"), JSON.stringify(ids.map(id => ({ identifier: { id }, version: "1.0.0", relativeLocation: `${id}-1.0.0` }))));
}
/** Every VS Code family editor with its own Remote SSH extension installed. */
const REMOTE_SSH = {
  ".vscode/extensions": ["ms-vscode-remote.remote-ssh"],
  ".vscode-insiders/extensions": ["ms-vscode-remote.remote-ssh"],
  ".cursor/extensions": ["anysphere.remote-ssh"],
};

describe("the editor table", () => {
  it("names every editor the protocol does, once, in the picker's order", () => {
    expect(EDITORS.map(row => row.id)).toEqual(EditorId.options);
  });

  it("lists only what is installed, from /Applications or the home's own, and nothing on a computer that is not a Mac", async () => {
    const { host } = mac(["/Applications/Cursor.app", join(tmp, "home", "Applications", "IntelliJ IDEA Ultimate.app"), "/System/Library/CoreServices/Finder.app"], REMOTE_SSH);
    expect(await host.list()).toEqual([
      { id: "cursor", name: "Cursor", remote: true },
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
      "/Applications/Visual Studio Code - Insiders.app",
      "/Applications/Zed.app",
      "/Applications/WebStorm.app",
      "/System/Library/CoreServices/Finder.app",
    ]);
    for (const editor of ["vscode", "cursor", "vscode-insiders", "zed", "webstorm", "finder"] as const) expect(await host.open({ path: file, line: 12, inside: [work], editor })).toBe(editor);
    expect(ran).toEqual([
      { file: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", args: ["-g", `${file}:12`] },
      { file: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor", args: ["-g", `${file}:12`] },
      { file: "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code", args: ["-g", `${file}:12`] },
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

describe("opening a path inside a workspace on another computer", () => {
  const remote = { alias: "wsp-cart-rounding", folder: "/root/wsp-boat", name: "Cart rounding" };
  const all = [
    "/Applications/Visual Studio Code.app",
    "/Applications/Cursor.app",
    "/Applications/Visual Studio Code - Insiders.app",
    "/Applications/Zed.app",
    "/Applications/WebStorm.app",
    "/System/Library/CoreServices/Finder.app",
  ];

  it("hands each editor with a remote road the alias and the workspace's folder, the file at its line beside it", async () => {
    const { host, ran } = mac(all, REMOTE_SSH);
    const file = "/root/wsp-boat/src/cart.ts";
    for (const editor of ["vscode", "cursor", "vscode-insiders", "zed"] as const) expect(await host.open({ path: file, line: 12, inside: [], editor, remote })).toBe(editor);
    const code = (app: string, bin: string) => `/Applications/${app}/Contents/Resources/app/bin/${bin}`;
    expect(ran).toEqual([
      { file: code("Visual Studio Code.app", "code"), args: ["--remote", "ssh-remote+wsp-cart-rounding", "/root/wsp-boat", "--goto", `${file}:12`] },
      { file: code("Cursor.app", "cursor"), args: ["--remote", "ssh-remote+wsp-cart-rounding", "/root/wsp-boat", "--goto", `${file}:12`] },
      { file: code("Visual Studio Code - Insiders.app", "code"), args: ["--remote", "ssh-remote+wsp-cart-rounding", "/root/wsp-boat", "--goto", `${file}:12`] },
      { file: "/Applications/Zed.app/Contents/MacOS/cli", args: ["ssh://wsp-cart-rounding/root/wsp-boat", `ssh://wsp-cart-rounding${file}:12`] },
    ]);
  });

  it("opens the folder alone when the folder is what was asked for", async () => {
    const { host, ran } = mac(all, REMOTE_SSH);
    await host.open({ path: "/root/wsp-boat", line: 3, inside: [], editor: "vscode", remote });
    await host.open({ path: "/root/wsp-boat/", inside: [], editor: "zed", remote });
    expect(ran).toEqual([
      { file: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", args: ["--remote", "ssh-remote+wsp-cart-rounding", "/root/wsp-boat"] },
      { file: "/Applications/Zed.app/Contents/MacOS/cli", args: ["ssh://wsp-cart-rounding/root/wsp-boat"] },
    ]);
  });

  it("lists a VS Code family editor as remote only where its own Remote SSH extension is installed; Zed needs none", async () => {
    const { host } = mac(all, { ".vscode/extensions": ["ms-vscode-remote.remote-ssh"], ".vscode-insiders/extensions": ["ms-python.python"] });
    expect((await host.list()).filter(e => e.remote === true).map(e => e.id)).toEqual(["vscode", "zed"]);
  });

  it("lists Cursor as remote with its own Remote SSH extension", async () => {
    const { host } = mac(["/Applications/Cursor.app"], { ".cursor/extensions": ["anysphere.remote-ssh"] });
    expect(await host.list()).toEqual([{ id: "cursor", name: "Cursor", remote: true }]);
  });

  it("lists Cursor as remote with Microsoft's Remote SSH extension, which an older install carries", async () => {
    const { host, ran } = mac(["/Applications/Cursor.app"], { ".cursor/extensions": ["ms-vscode-remote.remote-ssh"] });
    expect(await host.list()).toEqual([{ id: "cursor", name: "Cursor", remote: true }]);
    expect(await host.open({ path: "/root/wsp-boat", inside: [], editor: "cursor", remote })).toBe("cursor");
    expect(ran.map(c => c.args[0])).toEqual(["--remote"]);
  });

  it("reads the extensions from the folder VSCODE_EXTENSIONS names, which the editor wsp launches reads before its own", async () => {
    const moved = join(tmp, "moved");
    writeExtensions(moved, ["ms-vscode-remote.remote-ssh"]);
    const found = mac(["/Applications/Visual Studio Code.app"], { ".vscode/extensions": [] }, { VSCODE_EXTENSIONS: moved });
    expect(await found.host.list()).toEqual([{ id: "vscode", name: "VS Code", remote: true }]);
    expect(await found.host.open({ path: "/root/wsp-boat", inside: [], editor: "vscode", remote })).toBe("vscode");
    // The default folder carrying it does not count when the named one does not.
    writeExtensions(moved, []);
    const missing = mac(["/Applications/Visual Studio Code.app"], { ".vscode/extensions": ["ms-vscode-remote.remote-ssh"] }, { VSCODE_EXTENSIONS: moved });
    expect(await missing.host.list()).toEqual([{ id: "vscode", name: "VS Code" }]);
    await expect(missing.host.open({ path: "/root/wsp-boat", inside: [], editor: "vscode", remote })).rejects.toThrow(remoteExtensionLine("VS Code", "code --install-extension ms-vscode-remote.remote-ssh"));
    expect(missing.ran).toEqual([]);
  });

  it("reads a portable install's extensions from the data folder beside its app, where that folder stands", async () => {
    const apps = join(tmp, "home", "Applications");
    const app = join(apps, "Visual Studio Code - Insiders.app");
    const portable = join(apps, "code-insiders-portable-data");
    writeExtensions(join(portable, "extensions"), ["ms-vscode-remote.remote-ssh"]);
    const found = mac([app, portable], { ".vscode-insiders/extensions": [] });
    expect(await found.host.list()).toEqual([{ id: "vscode-insiders", name: "VS Code Insiders", remote: true }]);
    expect(await found.host.open({ path: "/root/wsp-boat", inside: [], editor: "vscode-insiders", remote })).toBe("vscode-insiders");
    // A portable install reads nothing of the home's folder, which carrying it does not help.
    writeExtensions(join(portable, "extensions"), []);
    const missing = mac([app, portable], { ".vscode-insiders/extensions": ["ms-vscode-remote.remote-ssh"] });
    expect(await missing.host.list()).toEqual([{ id: "vscode-insiders", name: "VS Code Insiders" }]);
    await expect(missing.host.open({ path: "/root/wsp-boat", inside: [], editor: "vscode-insiders", remote })).rejects.toThrow(
      remoteExtensionLine("VS Code Insiders", "code-insiders --install-extension ms-vscode-remote.remote-ssh"),
    );
    expect(missing.ran).toEqual([]);
  });

  it("refuses to open a workspace on another computer in an editor missing that extension, naming the line that installs it", async () => {
    const { host, ran } = mac(all, { ".vscode-insiders/extensions": [] });
    await expect(host.open({ path: "/root/wsp-boat", inside: [], editor: "vscode-insiders", remote })).rejects.toThrow(
      remoteExtensionLine("VS Code Insiders", "code-insiders --install-extension ms-vscode-remote.remote-ssh"),
    );
    await expect(host.open({ path: "/root/wsp-boat", inside: [], editor: "cursor", remote })).rejects.toThrow(remoteExtensionLine("Cursor", "cursor --install-extension anysphere.remote-ssh"));
    expect(ran).toEqual([]);
    // A file on this computer opens in the same editor as it always did.
    expect(await host.open({ path: join(work, "src", "a.ts"), inside: [work], editor: "vscode-insiders" })).toBe("vscode-insiders");
  });

  it("keeps the sentence for an editor with no remote road, and opens nothing outside the workspace's folder", async () => {
    const { host, ran } = mac(all, REMOTE_SSH);
    for (const editor of ["webstorm", "finder"] as const) await expect(host.open({ path: "/root/wsp-boat/a.ts", inside: [], editor, remote })).rejects.toThrow(editorOpensHereLine("Cart rounding"));
    for (const path of ["/root/other/a.ts", "/root/wsp-boat/../x", "src/a.ts", "/root/wsp-boat-sibling/a.ts"]) {
      await expect(host.open({ path, inside: [], editor: "vscode", remote }), path).rejects.toThrow(editorOutsideLine(path));
    }
    expect(ran).toEqual([]);
  });
});
