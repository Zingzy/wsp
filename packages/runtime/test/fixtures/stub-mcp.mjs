// A tiny MCP server over stdio for the slate's tool runs: one read-only tool, one destructive tool, one resource.
// Every start appends a line to $STUB_STARTS, so a test can count connections.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.STUB_STARTS) appendFileSync(process.env.STUB_STARTS, `${process.pid}\n`);

const TOOLS = [
  {
    name: "list_items",
    title: "List items",
    description: "Lists the newest items in an account. Pages by limit.",
    annotations: { readOnlyHint: true },
    outputSchema: { type: "object", properties: { account: { type: "string" }, items: { type: "array" }, call: { type: "integer" }, key: { type: "string" } } },
    inputSchema: {
      type: "object",
      required: ["params"],
      properties: {
        params: {
          type: "object",
          required: ["account"],
          properties: { account: { type: "string", description: "The account's alias." }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
        },
        key: { type: "string", description: "An API key the stub echoes back." },
      },
    },
  },
  {
    name: "delete_item",
    description: "Deletes one item for good.",
    annotations: { destructiveHint: true, readOnlyHint: false },
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
  },
];

let calls = 0;
const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const answer = result => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "stub", version: "1" } });
    case "tools/list":
      return answer({ tools: TOOLS });
    case "tools/call": {
      calls += 1;
      const { name, arguments: args = {} } = msg.params;
      if (name === "list_items") {
        const items = Array.from({ length: args.params?.limit ?? 10 }, (_, i) => ({ id: i + 1, subject: `item ${i + 1} for ${args.params?.account}` }));
        return answer({ content: [{ type: "text", text: `listed ${items.length} with key ${args.key}` }], structuredContent: { account: args.params?.account, items, call: calls, key: args.key } });
      }
      if (name === "delete_item") return answer({ content: [{ type: "text", text: `deleted ${args.id}` }] });
      return answer({ content: [{ type: "text", text: `no tool ${name}` }], isError: true });
    }
    case "resources/list":
      return answer({ resources: [{ uri: "stub://status", name: "status", mimeType: "application/json", description: "The stub's own status." }] });
    case "resources/read":
      return answer({ contents: [{ uri: msg.params.uri, mimeType: "application/json", text: JSON.stringify({ ok: true, calls }) }] });
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
  }
});
