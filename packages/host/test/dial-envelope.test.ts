// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { hostTokenPath, lockPathFor, type HostLock } from "../src/host-lock.js";
import { dialHost, type HostClient } from "../src/verbs.js";

let dir: string | undefined;
let server: WebSocketServer | undefined;
let client: HostClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

it("stamps its own id and op over any the caller's params carry, so a request cannot take another's reply", async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const frames: Record<string, unknown>[] = [];
  let release: () => void = () => {};
  server.on("connection", ws => {
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(frame);
      const reply = (): void => ws.send(JSON.stringify({ id: frame["id"], ok: true, answered: frame["op"] }));
      if (frame["op"] === "hold") release = reply;
      else reply();
    });
  });
  await new Promise<void>(r => server!.once("listening", () => r()));
  dir = mkdtempSync(join(tmpdir(), "wsp-dial-envelope-"));
  const statePath = join(dir, "state", "state.json");
  mkdirSync(join(dir, "state"), { recursive: true });
  const lock: HostLock = { pid: process.pid, port: 1, wsPort: (server.address() as { port: number }).port, startedAt: new Date().toISOString() };
  writeFileSync(lockPathFor(statePath), JSON.stringify(lock));
  writeFileSync(hostTokenPath(statePath), "host-token");

  client = await dialHost(statePath, { aim: { kind: "here" } });
  const held = client.request("hold");
  await expect.poll(() => frames.some(f => f["op"] === "hold")).toBe(true);
  const heldId = frames.find(f => f["op"] === "hold")!["id"];
  for (const params of [{ id: heldId }, { op: "workspaces.delete" }]) {
    const count = frames.length;
    const asking = client.request("capabilities.get", params);
    await expect.poll(() => frames.length > count).toBe(true);
    expect(frames[count]!["id"]).not.toBe(heldId);
    expect(frames[count]!["op"]).toBe("capabilities.get");
    expect((await asking)["answered"]).toBe("capabilities.get");
  }
  release();
  expect((await held)["answered"]).toBe("hold");
});
