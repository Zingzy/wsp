// SPDX-License-Identifier: AGPL-3.0-only
// The relay is a directory, not a way in: the only credential it can hand out
// is a token for its own routes. This file holds the schema to that, so a
// column for a device token or a pairing code cannot be added quietly.
import { afterEach, describe, expect, it } from "vitest";
import { relayHarness, type RelayHarness } from "./relay.js";

let relay: RelayHarness | undefined;

afterEach(async () => {
  await relay?.dispose();
  relay = undefined;
});

async function columnsOf(r: RelayHarness, table: string): Promise<string[]> {
  const { results } = await r.db.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all<{ name: string }>();
  return results.map(row => row.name).sort();
}

describe("what the relay keeps", () => {
  it("has these tables and no others", async () => {
    relay = await relayHarness();
    const { results } = await relay.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>();
    expect(results.map(r => r.name).sort()).toEqual(["accounts", "clients", "hosts", "link_codes"]);
  });

  it("holds no device token and no pairing code in any column", async () => {
    relay = await relayHarness();
    expect(await columnsOf(relay, "accounts")).toEqual(["created_at", "id", "login", "provider", "provider_id"]);
    expect(await columnsOf(relay, "hosts")).toEqual(["account_id", "connector_version", "created_at", "hostname", "id", "last_seen", "name", "tunnel_id"]);
    expect(await columnsOf(relay, "link_codes")).toEqual(["account_id", "code", "created_at", "expires_at", "host_id", "kind", "name", "poll_hash", "state"]);
    expect(await columnsOf(relay, "clients")).toEqual(["account_id", "created_at", "id", "last_seen", "name"]);
  });

  it("keeps the poll token as a hash, never as itself", async () => {
    relay = await relayHarness();
    const { pollToken } = (await (await relay.fetch("/link/start", { method: "POST", body: JSON.stringify({ kind: "host", name: "box" }) })).json()) as { pollToken: string };
    const rows = await relay.db.prepare("SELECT * FROM link_codes").all();
    expect(JSON.stringify(rows.results)).not.toContain(pollToken);
  });
});
