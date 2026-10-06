// A tiny MCP server over stdio that writes for models: list_text answers markdown alone, count answers a structured
// result without declaring an outputSchema.
import { createInterface } from "node:readline";

const TOOLS = [
  { name: "list_text", description: "Lists the inbox as markdown.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
  { name: "count", description: "Counts the calls so far.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
];
const INBOX = "# Inbox\n- 1 | ann | Hello\n- 2 | bo | Invoice";

let calls = 0;
const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const answer = result => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1" } });
    case "tools/list":
      return answer({ tools: TOOLS });
    case "tools/call":
      calls += 1;
      if (msg.params.name === "list_text") return answer({ content: [{ type: "text", text: INBOX }] });
      return answer({ content: [{ type: "text", text: `${calls} calls` }], structuredContent: { n: calls } });
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
  }
});
