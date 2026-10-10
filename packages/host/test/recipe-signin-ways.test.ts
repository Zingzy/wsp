// SPDX-License-Identifier: AGPL-3.0-only
// Claude Code's sign-in row on a box starts from how this computer bills it:
// a key the login shell exports or a settings helper names, a subscription
// login in the Keychain or the Linux credentials file, or neither. Each shape
// starts the row at its own way and offers all three.
import { describe, expect, it } from "vitest";
import { billedHere } from "@wsp/collect";
import { signinsOf } from "../src/recipe-options.js";
import { fakeHost } from "../../collect/test/fake-host.js";

const ALL = ["token", "key", "machine"];

describe("Claude Code's sign-in ways on a box, by what this computer holds", () => {
  it("starts at the key where the login shell exports it, ahead of a subscription login beside it", async () => {
    const billed = await billedHere(fakeHost({ platform: "darwin", files: { "~/.zshrc": "export ANTHROPIC_API_KEY=sk-ant-x\n" }, exec: { "security find-generic-password -s Claude Code-credentials": "keychain: login" } }));
    expect(billed).toEqual({ claude: "key" });
    expect(signinsOf("claude", billed["claude"])).toEqual(["key", "token", "machine"]);
  });

  it("starts at the key where Claude Code's settings name a helper for one", async () => {
    const billed = await billedHere(fakeHost({ files: { "~/.claude/settings.json": '{"apiKeyHelper": "security find-generic-password -s anthropic-api-key -w"}' } }));
    expect(signinsOf("claude", billed["claude"])).toEqual(["key", "token", "machine"]);
  });

  it("starts at the token where a subscription login stands: the Keychain item on a Mac, the credentials file on Linux", async () => {
    const mac = await billedHere(fakeHost({ platform: "darwin", exec: { "security find-generic-password -s Claude Code-credentials": "keychain: login" } }));
    const linux = await billedHere(fakeHost({ platform: "linux", files: { "~/.claude/.credentials.json": 800 } }));
    expect([mac, linux]).toEqual([{ claude: "login" }, { claude: "login" }]);
    expect(signinsOf("claude", mac["claude"])).toEqual(["token", "key", "machine"]);
  });

  it("starts at its own sign-in on the box where this computer holds neither", async () => {
    const billed = await billedHere(fakeHost({ platform: "darwin" }));
    expect(billed).toEqual({});
    expect(signinsOf("claude", billed["claude"])).toEqual(["machine", "token", "key"]);
  });

  it("offers every way in each shape, and leaves an agent with one secret its vault and login", () => {
    for (const billed of ["key", "login", undefined] as const) expect([...signinsOf("claude", billed)].sort()).toEqual([...ALL].sort());
    expect(signinsOf("codex")).toEqual(["vault", "machine"]);
  });
});
