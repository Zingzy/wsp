// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { keychain, parseKeychainDump, serviceOwner } from "../../src/index.js";
import { KEYCHAIN_DUMP, home, laptop } from "./fixture.js";

describe("pass 5: Keychain inventory", () => {
  it("groups items by service name, counts accounts, drops Apple's own namespace and items without a service", () => {
    expect(parseKeychainDump(KEYCHAIN_DUMP)).toEqual([
      { service: "gh:github.com", accounts: 2 },
      { service: "github.com", accounts: 1 },
      { service: "glab:gitlab.com:token", accounts: 1 },
      { service: "Raycast", accounts: 1 },
    ]);
  });

  it("nothing in the output names the keychain file or an account", () => {
    const text = JSON.stringify(parseKeychainDump(KEYCHAIN_DUMP));
    expect(text).not.toContain("Keychains");
    expect(text).not.toContain("dev-work");
  });

  it("runs security dump-keychain with no flags on macOS and not at all on Linux", async () => {
    const mac = laptop(home());
    expect((await keychain(mac)).map(i => i.service)).toContain("gh:github.com");
    expect(mac.calls).toContain("run security dump-keychain");
    expect(mac.calls.some(c => c.startsWith("run security") && c.includes("-d"))).toBe(false);

    const linux = laptop({ ...home(), platform: "linux" });
    expect(await keychain(linux)).toEqual([]);
    expect(linux.calls.some(c => c.startsWith("run security"))).toBe(false);
  });

  it("a service belongs to the binary its first segment names", () => {
    const bins = new Set(["gh", "glab", "raycast"]);
    expect(serviceOwner("gh:github.com", bins)).toBe("gh");
    expect(serviceOwner("glab:gitlab.com:token", bins)).toBe("glab");
    expect(serviceOwner("Raycast", bins)).toBe("raycast");
    expect(serviceOwner("Slack Safe Storage", bins)).toBeUndefined();
    expect(serviceOwner("https://delta.dev", new Set(["https"]))).toBeUndefined();
  });
});
