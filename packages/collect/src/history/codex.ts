// SPDX-License-Identifier: AGPL-3.0-only
// Codex keeps one rollout jsonl per thread under sessions/YYYY/MM/DD/. A
// response_item line whose payload is a function_call is a call: exec_command
// (and the older shell) carry the command in a JSON string of arguments.
import type { Host } from "../host.js";
import { type Call, type HistoryReader, isRecord, stem, tryJson } from "./reader.js";

const SHELLS = new Set(["exec_command", "shell", "container.exec", "local_shell"]);

export function codexCall(session: string, name: string, args: unknown): Call {
  const arg = isRecord(args) ? args : {};
  if (SHELLS.has(name)) {
    const cmd = arg["cmd"] ?? arg["command"];
    if (typeof cmd === "string") return { session, kind: "shell", line: cmd };
    if (Array.isArray(cmd) && cmd.every(w => typeof w === "string")) return { session, kind: "shell", line: cmd.join(" ") };
  }
  return { session, kind: "other", name };
}

export const codexReader: HistoryReader = {
  async *read(host: Host, root: string): AsyncIterable<Call> {
    for (const file of await host.fs.walk(root)) {
      if (!file.endsWith(".jsonl")) continue;
      const session = stem(file);
      for await (const line of host.fs.lines(file)) {
        if (!line.includes('"function_call"')) continue;
        const row = tryJson(line);
        if (!isRecord(row) || row["type"] !== "response_item" || !isRecord(row["payload"])) continue;
        const payload = row["payload"];
        if (payload["type"] !== "function_call" || typeof payload["name"] !== "string") continue;
        const args = typeof payload["arguments"] === "string" ? tryJson(payload["arguments"]) : payload["arguments"];
        yield codexCall(session, payload["name"], args);
      }
    }
  },
};
