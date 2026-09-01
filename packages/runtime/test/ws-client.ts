import WebSocket from "ws";

export interface WireMsg {
  id?: string | number | null;
  ok?: boolean;
  type?: string;
  [k: string]: unknown;
}

/** Minimal protocol client for tests: auth via first message, then request/reply. */
export class WsClient {
  private nextId = 1;
  private pending = new Map<number, (m: WireMsg) => void>();
  readonly events: WireMsg[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as WireMsg;
      if (typeof m.id === "number" && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else if (m.type) {
        this.events.push(m);
      }
    });
  }

  static async connect(port: number, opts: { token?: string; ticket?: string } = {}): Promise<WsClient> {
    const qs = opts.ticket ? `/?ticket=${encodeURIComponent(opts.ticket)}` : "/";
    const ws = new WebSocket(`ws://127.0.0.1:${port}${qs}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const client = new WsClient(ws);
    if (opts.token !== undefined) {
      const res = await client.request("auth", { token: opts.token });
      if (!res.ok) throw new Error(`auth failed: ${String(res["error"])}`);
    }
    return client;
  }

  request(op: string, params: Record<string, unknown> = {}): Promise<WireMsg> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, op, ...params }));
    });
  }

  closed(): Promise<number> {
    return new Promise(resolve => this.ws.once("close", code => resolve(code)));
  }

  close(): void {
    this.ws.close();
  }
}

/** One-shot: connect, auth, send a single request, return the reply. */
export async function wsRequest(
  port: number,
  token: string,
  req: { op: string } & Record<string, unknown>,
): Promise<WireMsg> {
  const c = await WsClient.connect(port, { token });
  const { op, ...params } = req;
  const res = await c.request(op, params);
  c.close();
  return res;
}
