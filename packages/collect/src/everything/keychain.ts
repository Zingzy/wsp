// SPDX-License-Identifier: AGPL-3.0-only
// Pass 5, macOS only. `security dump-keychain` on the login keychain prints
// item attributes and nothing else: with -d it would read every secret and
// raise one consent dialog per item. System.keychain holds Wi-Fi and Apple
// service items nobody signs in to, and an Electron app's Safe Storage item
// is its cookie key, so neither is a login. Only the service name and a count
// of accounts leave this pass; the keychain path and account names are dropped.
import type { Machine } from "./host.js";

export interface KeychainItem {
  service: string;
  accounts: number;
}

const APPLE_NAMESPACE = "com.apple.";
/** Apple's own items that carry no namespace prefix; nobody signs in to these. */
const APPLE_SERVICES = new Set(["MetadataKeychain", "TelephonyUtilities", "Apple Persistent State Encryption", "AirPlay Server Identity", "iCloud", "AirPort", "BluetoothGlobal", "MobileBluetooth", "WiFiAnalytics"]);
/** An app's own encryption key for its local store, not a login. */
const KEY_STORE = / Safe (Meeting )?Storage$/;
const LOGIN_KEYCHAIN = "Library/Keychains/login.keychain-db";

/** Groups `svce` (generic) and `srvr` (internet) attributes by service over login keychain blocks only. */
export function parseKeychainDump(text: string): KeychainItem[] {
  const counts = new Map<string, number>();
  for (const block of text.split(/^keychain: /m)) {
    if (!/^"[^"\n]*\/[^"\n/]*\.keychain-db"/.test(block) || /\/System\.keychain/.test(block.split("\n")[0] ?? "")) continue;
    const m = /^\s+"(?:svce|srvr)"<blob>="((?:[^"\\]|\\.)*)"/m.exec(block);
    const service = m?.[1];
    if (service === undefined || service === "" || service.startsWith(APPLE_NAMESPACE) || APPLE_SERVICES.has(service) || KEY_STORE.test(service)) continue;
    counts.set(service, (counts.get(service) ?? 0) + 1);
  }
  return [...counts.entries()].map(([service, accounts]) => ({ service, accounts })).sort((a, b) => a.service.localeCompare(b.service));
}

/** The login keychain as security reports it, falling back to the default location; the path stays inside this pass. */
async function loginKeychain(m: Machine): Promise<string> {
  const reported = (await m.exec.run("security", ["login-keychain"]))?.trim().replace(/^"|"$/g, "");
  return reported !== undefined && reported !== "" ? reported : `${m.home}/${LOGIN_KEYCHAIN}`;
}

export async function keychain(m: Machine): Promise<KeychainItem[]> {
  if (m.platform !== "darwin") return [];
  return parseKeychainDump((await m.exec.run("security", ["dump-keychain", await loginKeychain(m)])) ?? "");
}

/** The binary the service name points at: `gh:github.com` is gh's, `spoo-cli` is nobody's unless a binary has that exact name. */
export function serviceOwner(service: string, bins: ReadonlySet<string>): string | undefined {
  if (/^[a-z]+:\/\//i.test(service)) return undefined;
  const head = service.split(":")[0]?.toLowerCase();
  if (head !== undefined && bins.has(head)) return head;
  return undefined;
}
