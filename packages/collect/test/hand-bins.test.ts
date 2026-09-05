// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { HAND_GROUP, detectTools, formatOf, handBins } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);
const text = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));

const HERMES = "#!/usr/bin/env bash\nunset PYTHONPATH\nexec ~/.hermes/run\n";

describe("hand-installed binaries", () => {
  it("reads the format out of the first bytes: Mach-O in either byte order or fat, ELF with its arch, a shebang's interpreter", () => {
    expect(formatOf(bytes(0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1))).toEqual({ kind: "mach-o" });
    expect(formatOf(bytes(0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0x0c))).toEqual({ kind: "mach-o" });
    expect(formatOf(bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2))).toEqual({ kind: "mach-o" });
    expect(formatOf(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0x3e, 0))).toEqual({ kind: "elf", arch: "x86_64" });
    expect(formatOf(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0xb7, 0))).toEqual({ kind: "elf", arch: "aarch64" });
    expect(formatOf(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0x03, 0))).toEqual({ kind: "elf", arch: "another arch" });
    expect(formatOf(text(HERMES))).toEqual({ kind: "script", interpreter: "bash" });
    expect(formatOf(text("#!/bin/sh\n# add binaries to PATH\n"))).toEqual({ kind: "script", interpreter: "sh" });
    expect(formatOf(text("#!/usr/bin/env -S python3 -u\nprint(1)\n"))).toEqual({ kind: "script", interpreter: "python3" });
    expect(formatOf(text("#!/opt/homebrew/bin/node\n"))).toEqual({ kind: "script", interpreter: "node" });
    expect(formatOf(text("echo hi\n"))).toEqual({ kind: "unknown" });
    expect(formatOf(bytes())).toEqual({ kind: "unknown" });
  });

  it("lists the executables in ~/.local/bin and ~/bin that no package manager owns: links into manager dirs or apps, files without the execute bit, directories and dangling links are left out", async () => {
    const host = fakeHost({
      bins: {
        "~/.local/bin/omp": { head: "mach-o", bytes: 122_000_000 },
        "~/.local/bin/hermes": { head: HERMES },
        "~/.local/bin/env": { head: "#!/bin/sh\n# add binaries to PATH\n", noexec: true },
        "~/.local/bin/bun": { link: "~/.local/lib/node_modules/bun/bin/bun.exe", head: "mach-o" },
        "~/.local/bin/ty": { link: "~/.local/share/uv/tools/ty/bin/ty", head: "mach-o" },
        "~/.local/bin/pre-commit": { link: "~/.local/share/uv/tools/pre-commit/bin/pre-commit", head: "#!/Users/dev/.local/share/uv/tools/pre-commit/bin/python\n" },
        "~/.local/bin/jcode": { link: "~/.jcode/builds/versions/0.76.0/jcode", head: "mach-o", bytes: 50_000_000 },
        "~/.local/bin/code": { link: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", head: "#!/usr/bin/env sh\n" },
        "~/.local/bin/gone": { link: "~/.nowhere/gone" },
        "~/bin/deploy": { head: "#!/bin/sh\nrsync .\n" },
        "~/bin/agent": { head: "elf-x86_64", bytes: 9_000_000 },
      },
      files: {
        "~/.local/lib/node_modules/bun/bin/bun.exe": 1,
        "~/.local/share/uv/tools/ty/bin/ty": 1,
        "~/.local/share/uv/tools/pre-commit/bin/pre-commit": 1,
        "~/.jcode/builds/versions/0.76.0/jcode": 50_000_000,
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code": 1,
        "~/.local/bin/scripts/helper.sh": 10,
      },
    });
    expect(await handBins(host)).toEqual([
      { name: "hermes", path: "~/.local/bin/hermes", format: { kind: "script", interpreter: "bash" }, bytes: HERMES.length },
      { name: "jcode", path: "~/.local/bin/jcode", target: "~/.jcode/builds/versions/0.76.0/jcode", format: { kind: "mach-o" }, bytes: 50_000_000 },
      { name: "omp", path: "~/.local/bin/omp", format: { kind: "mach-o" }, bytes: 122_000_000 },
      { name: "agent", path: "~/bin/agent", format: { kind: "elf", arch: "x86_64" }, bytes: 9_000_000 },
      { name: "deploy", path: "~/bin/deploy", format: { kind: "script", interpreter: "sh" }, bytes: 18 },
    ]);
  });

  it("each is a tools row under Installed by hand, unticked: a Mach-O is locked off as macOS only, a script or an ELF travels as a copy, an unrecognised file is locked off", async () => {
    const host = fakeHost({
      bins: {
        "~/.local/bin/omp": { head: "mach-o", bytes: 122_000_000 },
        "~/.local/bin/hermes": { head: HERMES },
        "~/.local/bin/jcode": { link: "~/.jcode/builds/versions/0.76.0/jcode", head: "mach-o", bytes: 50_000_000 },
        "~/.local/bin/blob": { head: "", bytes: 2_048 },
        "~/bin/agent": { head: "elf-aarch64", bytes: 9_000_000 },
      },
      files: { "~/.jcode/builds/versions/0.76.0/jcode": 50_000_000 },
    });
    expect(await detectTools(host)).toEqual([
      { rung: "tools", id: "tools/hand/blob", label: "blob", group: HAND_GROUP, paths: ["~/.local/bin/blob"], bytes: 2_048, default: "skip", reason: "installed by hand; no Linux build known", linux: "no", detail: "a file of 2.0 KB in ~/.local/bin of no recognised format, installed by hand; nothing can install it on the machine" },
      { rung: "tools", id: "tools/hand/hermes", label: "hermes", group: HAND_GROUP, paths: ["~/.local/bin/hermes"], bytes: HERMES.length, default: "skip", linux: "unknown", detail: `a bash script of ${HERMES.length} B in ~/.local/bin, installed by hand; travels as a copy into ~/.local/bin on the machine if ticked` },
      { rung: "tools", id: "tools/hand/jcode", label: "jcode", group: HAND_GROUP, paths: ["~/.local/bin/jcode"], bytes: 50_000_000, default: "skip", reason: "installed by hand; no Linux build known", linux: "no", detail: "a macOS binary (Mach-O) of 48 MB in ~/.local/bin, installed by hand; a Linux build has to be installed on the machine by hand; a link to ~/.jcode/builds/versions/0.76.0/jcode" },
      { rung: "tools", id: "tools/hand/omp", label: "omp", group: HAND_GROUP, paths: ["~/.local/bin/omp"], bytes: 122_000_000, default: "skip", reason: "installed by hand; no Linux build known", linux: "no", detail: "a macOS binary (Mach-O) of 116 MB in ~/.local/bin, installed by hand; a Linux build has to be installed on the machine by hand" },
      { rung: "tools", id: "tools/hand/agent", label: "agent", group: HAND_GROUP, paths: ["~/bin/agent"], bytes: 9_000_000, default: "skip", linux: "unknown", detail: "a Linux binary (ELF, aarch64) of 9 MB in ~/bin, installed by hand; travels as a copy into ~/bin on the machine if ticked, and ~/bin is not on the machine's PATH" },
    ]);
  });

  it("an empty or missing bin directory adds no rows and asks nothing else", async () => {
    const host = fakeHost({ files: { "~/.local/bin/": 0 } });
    expect(await detectTools(host)).toEqual([]);
    expect(host.calls).toEqual([]);
  });
});
