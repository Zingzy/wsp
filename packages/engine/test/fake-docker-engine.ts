// SPDX-License-Identifier: AGPL-3.0-only
// A fake Docker Engine API in this process: a real HTTP server on a unix
// socket, so the dial, the request line, the query and the bodies are the ones
// a daemon would read. Shared by the backend's own tests and by the round trip
// that drives the same backend from another computer over a link.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  raw: Buffer;
}

/** One frame of Docker's multiplexed exec stream: the eight byte header then the payload. */
export function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

export type Answer = (seen: Seen, res: ServerResponse) => void;

export class FakeEngine {
  readonly seen: Seen[] = [];
  readonly routes: { match: RegExp; method: string; answer: Answer }[] = [];
  private server: Server | undefined;
  private dir = "";
  socketPath = "";

  on(method: string, match: RegExp, answer: Answer): this {
    this.routes.push({ method, match, answer });
    return this;
  }

  json(method: string, match: RegExp, value: unknown, status = 200): this {
    return this.on(method, match, (_seen, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    });
  }

  async start(): Promise<void> {
    this.dir = mkdtempSync(join(tmpdir(), "wsp-fake-docker-"));
    this.socketPath = join(this.dir, "docker.sock");
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url ?? "/", "http://docker");
        const path = url.pathname.replace(/^\/v[\d.]+/, "");
        let body: unknown;
        try {
          body = raw.length > 0 && req.headers["content-type"] === "application/json" ? JSON.parse(raw.toString("utf8")) : undefined;
        } catch {
          body = undefined;
        }
        const seen: Seen = { method: req.method ?? "", path, query: url.searchParams, body, raw };
        this.seen.push(seen);
        const route = this.routes.find(r => r.method === seen.method && r.match.test(path));
        if (route === undefined) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: `no such route ${seen.method} ${path}` }));
          return;
        }
        route.answer(seen, res);
      });
    });
    await new Promise<void>(done => this.server!.listen(this.socketPath, done));
  }

  async stop(): Promise<void> {
    await new Promise<void>(done => this.server?.close(() => done()));
    rmSync(this.dir, { recursive: true, force: true });
  }

  took(method: string, path: string): Seen | undefined {
    return this.seen.find(s => s.method === method && s.path === path);
  }
}

