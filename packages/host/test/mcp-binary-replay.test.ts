// SPDX-License-Identifier: AGPL-3.0-only
// Every answer the TypeScript server recorded, replayed through the line
// `wsp mcp` runs where this computer's binary carries the tool server: the
// binary, on the words toolServerLine gives it, against a host that answers
// each op with the frame it answered there. The line printed has to be the
// recorded one byte for byte, and the ops asked the recorded ones.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { mcpServerSpec, toolServerLine, type RunningWsp } from "../src/mcp-install.js";
import { ownEnv, served } from "./stdio-session.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ANSWERS = join(REPO, "daemon", "crates", "wsp-mcp", "tests", "answers");
const named = process.env["WSP_MCP_BIN"];
const MCP_BIN = named === undefined || named === "" ? undefined : resolve(REPO, named);
const suite = MCP_BIN !== undefined ? describe : describe.skip;
const TOKEN = "replay-token";
const STOPPING_CLOSE = 4001;

interface Case {
  case: string;
  arguments: Record<string, unknown>;
  replies: Record<string, string>;
  pushed?: Record<string, string[]>;
  closes?: string;
  env?: Record<string, string>;
  cloud?: true;
  platform?: string;
  wsp?: { argv: string[]; stdout: string; stderr: string; exit: number };
  line: string;
  asked: Record<string, unknown>[];
}

/** A host on loopback that takes the token and answers as the recording's host did: each op with its frame under the
 * id it was asked with, the frames pushed while it is under way before its reply, the stopping close after `closes`,
 * and an op no frame answers refused as that host refused one. Every op past the token and the events is noted. */
async function hostFor(c: Case): Promise<{ port: number; asked: Record<string, unknown>[]; close: () => Promise<void> }> {
  const asked: Record<string, unknown>[] = [];
  const http: Server = createServer((_, res) => res.end());
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", ws => {
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      const { id, op } = frame as { id: number; op: string };
      if (op !== "auth" && op !== "events.subscribe") {
        const { id: _id, ...fields } = frame;
        if ("requestId" in fields) fields["requestId"] = "<request id>";
        asked.push(fields);
      }
      for (const pushed of c.pushed?.[op] ?? []) ws.send(pushed);
      const recorded = c.replies[op];
      if (op === "auth") ws.send(JSON.stringify({ id, ok: frame["token"] === TOKEN }));
      else if (recorded !== undefined) ws.send(`{"id":${id},${recorded.slice('{"id":1,'.length)}`);
      else if (op === "events.subscribe") ws.send(JSON.stringify({ id, ok: true }));
      else ws.send(JSON.stringify({ id, ok: false, error: `${op} is not in this record` }));
      if (op === c.closes) ws.close(STOPPING_CLOSE);
    });
  });
  await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
  const close = async (): Promise<void> => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(done => wss.close(() => http.close(() => done())));
  };
  return { port: (http.address() as AddressInfo).port, asked, close };
}

const sorted = (frames: Record<string, unknown>[]): string[] => frames.map(f => JSON.stringify(f, Object.keys(f).sort())).sort();

suite(`every recorded answer through the line wsp mcp runs${MCP_BIN === undefined ? " (set WSP_MCP_BIN)" : ""}`, () => {
  const files = readdirSync(ANSWERS).filter(name => name.endsWith(".json"));

  it.each(files)("%s", async file => {
    const recorded = JSON.parse(readFileSync(join(ANSWERS, file), "utf8")) as { tool: string; cases: Case[] };
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    for (const c of recorded.cases.filter(c => c.platform === undefined || c.platform === platform)) {
      const dir = mkdtempSync(join(tmpdir(), "wsp-mcp-replay-"));
      const host = await hostFor(c);
      try {
        writeFileSync(join(dir, "host.lock"), JSON.stringify({ pid: process.pid, port: host.port, startedAt: "2026-09-27T00:00:00.000Z" }));
        writeFileSync(join(dir, "host-token"), `${TOKEN}\n`);
        // The wsp the tool server is handed: a recipe case's own, which writes down the words it was run with and
        // prints what the recorded one printed; nothing is run for any other case.
        const fake = join(dir, "wsp");
        if (c.wsp !== undefined) {
          writeFileSync(join(dir, "stdout"), c.wsp.stdout);
          writeFileSync(join(dir, "stderr"), c.wsp.stderr);
          writeStub(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\ncat '${dir}/stdout'\ncat '${dir}/stderr' >&2\nexit ${c.wsp.exit}\n`);
        }
        const run: RunningWsp = { execPath: "/bin/sh", execArgv: [], argv: ["/bin/sh", fake], version: "0.0.0", PATH: "", toolServer: MCP_BIN! };
        const state = join(dir, "state.json");
        const line = toolServerLine(state, {}, run)!;
        const env = { ...ownEnv(), ...c.env, WSP_HOME: join(dir, "home"), HOME: join(dir, "user"), TZ: "UTC", WSP_CLOUD: c.cloud === true ? "1" : "" };
        const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: recorded.tool, arguments: c.arguments } };
        const { out, code } = await served([line.command, ...line.args], env, [call], dir);
        expect(code, `${recorded.tool} ${c.case}`).toBe(0);
        expect(out[0], `${recorded.tool} ${c.case}`).toBe(c.line);
        expect(sorted(host.asked), `${recorded.tool} ${c.case}: what the host was asked`).toEqual(sorted(c.asked));
        if (c.wsp !== undefined) {
          const ran = readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
          expect(ran, `${recorded.tool} ${c.case}: the words wsp was run with`).toEqual(c.wsp.argv.map(w => w.replace("{state}", state)));
        }
      } finally {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("runs the recipe tools on the person's state through the line a thread on this computer is launched with", async () => {
    const recorded = JSON.parse(readFileSync(join(ANSWERS, "recipe_scan.json"), "utf8")) as { cases: Case[] };
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const c = recorded.cases.find(c => c.wsp !== undefined && c.platform === platform)!;
    const dir = mkdtempSync(join(tmpdir(), "wsp-mcp-thread-"));
    try {
      writeFileSync(join(dir, "stdout"), c.wsp!.stdout);
      writeFileSync(join(dir, "stderr"), c.wsp!.stderr);
      const fake = writeStub(join(dir, "wsp"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\ncat '${dir}/stdout'\ncat '${dir}/stderr' >&2\nexit ${c.wsp!.exit}\n`);
      const run: RunningWsp = { execPath: "/bin/sh", execArgv: [], argv: ["/bin/sh", fake], version: "0.0.0", PATH: "", toolServer: MCP_BIN! };
      const state = join(dir, "state.json");
      // The runtime launches a thread's tools on the command line's own line with the scope on the end.
      const line = mcpServerSpec(state, run);
      const env = { ...ownEnv(), WSP_HOME: join(dir, "home"), HOME: join(dir, "user"), WSP_HOST_URL: "http://127.0.0.1:9", WSP_HOST_TOKEN: "thread-token" };
      const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recipe_scan", arguments: c.arguments } };
      const { out, code } = await served([line.command, ...line.args, "--scoped"], env, [call], dir);
      expect(code).toBe(0);
      expect(out[0]).toBe(c.line);
      expect(readFileSync(join(dir, "argv"), "utf8").trim().split("\n")).toEqual(c.wsp!.argv.map(w => w.replace("{state}", state)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
