// SPDX-License-Identifier: AGPL-3.0-only
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { mcpServer } from "../src/mcp.js";

async function toolNames(over: { scoped?: boolean; noSlate?: boolean }): Promise<string[]> {
  const server = mcpServer("/nonexistent/state.json", { env: {}, ...over });
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(toServer);
  await client.connect(toClient);
  const names = (await client.listTools()).tools.map(t => t.name);
  await client.close();
  await server.close();
  return names;
}

describe("a server for a thread with no slate", () => {
  it("lists none of the slate's tools, which would only answer Z803 and cost every turn their schemas", async () => {
    const slate = ["slate_catalog", "slate_write", "slate_state", "slate_read"];
    expect(await toolNames({ scoped: true })).toEqual(expect.arrayContaining(slate));
    expect((await toolNames({ scoped: true, noSlate: true })).filter(n => n.startsWith("slate_"))).toEqual([]);
  });
});
