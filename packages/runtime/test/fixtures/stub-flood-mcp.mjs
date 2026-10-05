// An MCP server over stdio that answers too much: a line with no end, an answer nested past any sane depth, the same
// inside a text, and one with too many entries. Each answer is written as raw text, never built as an object first.
import { createInterface } from "node:readline";

const TOOLS = ["endless", "deep", "deeptext", "wide"].map(name => ({ name, annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } }));
const DEPTH = 100_000;
const deep = `${'{"a":'.repeat(DEPTH)}1${"}".repeat(DEPTH)}`;

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const answer = result => send({ jsonrpc: "2.0", id: msg.id, result });
  const raw = result => process.stdout.write(`{"jsonrpc":"2.0","id":${msg.id},"result":${result}}\n`);
  switch (msg.method) {
    case "initialize":
      return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "flood", version: "1" } });
    case "tools/list":
      return answer({ tools: TOOLS });
    case "tools/call":
      switch (msg.params.name) {
        case "endless":
          return process.stdout.write("x".repeat(3 * 1024 * 1024));
        case "deep":
          return raw(`{"content":[],"structuredContent":${deep}}`);
        case "deeptext":
          return answer({ content: [{ type: "text", text: deep }] });
        case "wide":
          return raw(`{"content":[],"structuredContent":[${Array.from({ length: 200_000 }, () => "0").join(",")}]}`);
      }
      return;
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
  }
});
