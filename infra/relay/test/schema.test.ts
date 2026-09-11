// SPDX-License-Identifier: AGPL-3.0-only
// The relay is a directory, not a way in: the only credential it can hand out
// is a token for its own routes. This file holds the schema to that, so a
// column for a device token or a pairing code cannot be added quietly.
import { describe, expect, it } from "vitest";
import { OWN_TABLES, relayHarness, type RelayHarness } from "./relay.js";

async function columnsOf(r: RelayHarness, table: string): Promise<string[]> {
  const { results } = await r.db.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all<{ name: string }>();
  return results.map(row => row.name).sort();
}

describe("what the relay keeps", () => {
  it("has these tables and no others", async () => {
    const relay = await relayHarness();
    const { results } = await relay.db.prepare(OWN_TABLES).all<{ name: string }>();
    expect(results.map(r => r.name).sort()).toEqual(["accounts", "clients", "hosts", "link_codes"]);
  });

  it("holds no device token and no pairing code in any column", async () => {
    const relay = await relayHarness();
    expect(await columnsOf(relay, "accounts")).toEqual(["created_at", "id", "login", "provider", "provider_id"]);
    expect(await columnsOf(relay, "hosts")).toEqual(["account_id", "connector_version", "created_at", "hostname", "id", "last_seen", "name", "tunnel_id"]);
    expect(await columnsOf(relay, "link_codes")).toEqual(["account_id", "code", "created_at", "expires_at", "host_id", "kind", "name", "poll_hash", "state"]);
    expect(await columnsOf(relay, "clients")).toEqual(["account_id", "created_at", "id", "last_seen", "name"]);
  });

  it("refuses a bound undefined the way D1 does, rather than writing the null JSON would make of it", async () => {
    const relay = await relayHarness();
    await relay.db
      .prepare("INSERT INTO hosts (id, account_id, name, hostname, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("h_1", "a_1", "box", "blue-sky-1234.trycloudflare.com", "2026-09-11T12:00:00.000Z")
      .run();
    // The relay's own statement for the name a box reports, on a column that takes a null: an undefined slipping
    // into that bind is the one value JSON would carry through as a row nobody could write against the real D1.
    const written = relay.db.prepare("UPDATE hosts SET hostname = ? WHERE id = ?").bind(undefined, "h_1").run();
    await expect(written).rejects.toThrow("D1_TYPE_ERROR");
    const row = (await relay.db.prepare("SELECT hostname FROM hosts WHERE id = ?").bind("h_1").first()) as Record<string, string>;
    expect(row["hostname"]).toBe("blue-sky-1234.trycloudflare.com");
  });

  it("keeps the poll token as a hash, never as itself", async () => {
    const relay = await relayHarness();
    const { pollToken } = (await (await relay.fetch("/link/start", { method: "POST", body: JSON.stringify({ kind: "host", name: "box" }) })).json()) as { pollToken: string };
    const rows = await relay.db.prepare("SELECT * FROM link_codes").all();
    expect(JSON.stringify(rows.results)).not.toContain(pollToken);
  });
});
