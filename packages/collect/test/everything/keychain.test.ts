// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { keychain, parseKeychainDump, serviceOwner } from "../../src/index.js";
import { KEYCHAIN_DUMP, LOGIN_KEYCHAIN, home, laptop } from "./fixture.js";

describe("pass 5: Keychain inventory", () => {
  it("groups login keychain items by service name, counts accounts, drops Apple's namespace, Electron Safe Storage, System.keychain items and items without a service", () => {
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
    expect(text).not.toContain("AirPort");
    expect(text).not.toContain("Safe Storage");
  });

  it("Apple's unprefixed items and Electron and Zoom key stores are left out", () => {
    const dump = ["MetadataKeychain", "TelephonyUtilities", "Apple Persistent State Encryption", "AirPlay Server Identity", "iCloud", "AirPort", "Zoom Safe Meeting Storage", "Chrome Safe Storage", "spoo-cli"].map(s => `keychain: "/Users/dev/Library/Keychains/login.keychain-db"\nclass: "genp"\nattributes:\n    "svce"<blob>="${s}"\n`).join("");
    expect(parseKeychainDump(dump).map(i => i.service)).toEqual(["spoo-cli"]);
  });

  it("dumps only the login keychain, at the path security reports, never with -d, and not at all on Linux", async () => {
    const mac = laptop(home());
    expect((await keychain(mac)).map(i => i.service)).toContain("gh:github.com");
    expect(mac.calls.filter(c => c.startsWith("run security"))).toEqual(["run security login-keychain", `run security dump-keychain ${LOGIN_KEYCHAIN}`]);
    const base = home();
    const moved = laptop({ ...base, exec: { ...base.exec, "security login-keychain": '    "/Users/dev/Library/Keychains/other.keychain-db"\n', "security dump-keychain /Users/dev/Library/Keychains/other.keychain-db": KEYCHAIN_DUMP.replace(/login\.keychain-db/g, "other.keychain-db") } });
    expect((await keychain(moved)).map(i => i.service)).toContain("gh:github.com");
    const { "security login-keychain": _reported, ...quiet } = base.exec ?? {};
    const silent = laptop({ ...base, exec: quiet });
    expect((await keychain(silent)).map(i => i.service)).toContain("gh:github.com");

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
