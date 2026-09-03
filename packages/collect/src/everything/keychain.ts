// SPDX-License-Identifier: AGPL-3.0-only
// Pass 5, macOS only. `security dump-keychain` with no flags prints item
// attributes and nothing else: with -d it would read every secret and raise
// one consent dialog per item. Only the service name and a count of accounts
// leave this pass; the keychain path and account names are dropped.
import type { Machine } from "./host.js";

export interface KeychainItem {
  service: string;
  accounts: number;
}

const APPLE_NAMESPACE = "com.apple.";

/** Groups `svce` (generic) and `srvr` (internet) attributes by service; Apple's own namespace is left out. */
export function parseKeychainDump(text: string): KeychainItem[] {
  const counts = new Map<string, number>();
  for (const block of text.split(/^keychain: /m)) {
    const m = /^\s+"(?:svce|srvr)"<blob>="((?:[^"\\]|\\.)*)"/m.exec(block);
    const service = m?.[1];
    if (service === undefined || service === "" || service.startsWith(APPLE_NAMESPACE)) continue;
    counts.set(service, (counts.get(service) ?? 0) + 1);
  }
  return [...counts.entries()].map(([service, accounts]) => ({ service, accounts })).sort((a, b) => a.service.localeCompare(b.service));
}

export async function keychain(m: Machine): Promise<KeychainItem[]> {
  if (m.platform !== "darwin") return [];
  return parseKeychainDump((await m.exec.run("security", ["dump-keychain"])) ?? "");
}

/** The binary the service name points at: `gh:github.com` is gh's, `spoo-cli` is nobody's unless a binary has that exact name. */
export function serviceOwner(service: string, bins: ReadonlySet<string>): string | undefined {
  if (/^[a-z]+:\/\//i.test(service)) return undefined;
  const head = service.split(":")[0]?.toLowerCase();
  if (head !== undefined && bins.has(head)) return head;
  return undefined;
}
