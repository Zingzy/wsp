// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attachmentRecord, type AdapterEvent, type Attachment, type EventUnion, type TurnImage, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, createOn } from "./stub-backend.js";
import { settle } from "./runtime-fixture.js";

const PNG: Attachment = { mediaType: "image/png", bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", name: "dot.png" };
const NOTES: Attachment = { mediaType: "text/plain", bytes: Buffer.from("notes").toString("base64"), name: "notes.txt" };

/** A harness that steers and reads images inline, whose turns run until the test ends them; `steersImages` says
 * whether its steer carries them too. */
const harness = (steersImages: boolean) => {
  const starts: { prompt: string; images?: readonly TurnImage[] }[] = [];
  const steered: { prompt: string; images?: readonly TurnImage[] }[] = [];
  const turns: { sessionId: string; onEvent: (e: AdapterEvent) => void; finish: (r: TurnResult) => void }[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    steers: true,
    attachments: "inline",
    ...(steersImages ? { steersImages: true as const } : {}),
    start: o => {
      starts.push({ prompt: o.prompt, ...(o.images !== undefined ? { images: o.images } : {}) });
      const sessionId = o.resume ?? randomUUID();
      let finish!: (r: TurnResult) => void;
      const finished = new Promise<TurnResult>(r => (finish = r));
      turns.push({ sessionId, onEvent: o.onEvent, finish });
      o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
      return {
        localId: sessionId,
        finished,
        interrupt: async () => {},
        steer: async (prompt: string, _id?: string, images?: readonly TurnImage[]) => {
          steered.push({ prompt, ...(images !== undefined && images.length > 0 ? { images } : {}) });
          return "accepted" as const;
        },
      };
    },
  });
  const end = (turn: number): void => {
    const t = turns[turn]!;
    t.onEvent({ type: "turn.done", sessionId: t.sessionId, result: { status: "completed", text: "ok" } });
    t.onEvent({ type: "session.end", sessionId: t.sessionId, exitCode: 0, sawResult: true });
    t.finish({ status: "completed", text: "ok" });
  };
  /** One tool call of the turn's that writes `text`, as a large file write does. */
  const write = (turn: number, text: string): void => {
    const t = turns[turn]!;
    t.onEvent({ type: "turn.delta", sessionId: t.sessionId, kind: "tool_use", text, toolName: "Write", toolUseId: `tu_${turn}` });
  };
  return { adapter, starts, steered, end, write };
};

const running = async (steersImages: boolean, store: Store = memoryStore()) => {
  const h = harness(steersImages);
  const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: h.adapter } });
  const events: EventUnion[] = [];
  rt.events.on("*", e => events.push(e));
  const ws = await createOn(rt, { golden: "snap_g", name: "a" });
  const first = await rt.sessions.start(ws.id, { prompt: "look around", requestId: "req_1" });
  const threadId = first.view().threadId!;
  return { h, rt, events, ws, first, threadId, steers: () => events.filter(e => e.type === "session.steer") };
};

describe("a steer that carries an image", () => {
  it("goes into the running turn with its bytes, the row records it, and the host keeps the image past a restart", async () => {
    const store = memoryStore();
    const { h, rt, ws, first, threadId, steers } = await running(true, store);
    expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!.steersImages).toBe(true);
    expect(await rt.sessions.steer(first.id, { prompt: "what is in this picture?", requestId: "req_2", attachments: [PNG] })).toEqual({ outcome: "accepted" });
    expect(h.steered).toEqual([{ prompt: "what is in this picture?", images: [{ mediaType: PNG.mediaType, bytes: PNG.bytes }] }]);
    expect(steers()).toMatchObject([{ prompt: "what is in this picture?", requestId: "req_2", attachments: [attachmentRecord(PNG)] }]);
    h.end(0);
    await first.finished;
    await rt.close();

    const again = createRuntime({ backend: stubBackend(), store, adapters: { claude: harness(true).adapter } });
    const history = await again.sessions.history(ws.id);
    expect(history.find(e => e.type === "session.steer")).toMatchObject({ requestId: "req_2", attachments: [attachmentRecord(PNG)] });
    expect(await again.sessions.attachment(ws.id, threadId, "req_2", 0)).toEqual({ mediaType: "image/png", bytes: PNG.bytes });
    await again.close();
  });

  it("goes when the steer that names it leaves the transcript, as a start's image does", async () => {
    const store = memoryStore();
    const { h, rt, ws, first, threadId } = await running(true, store);
    await rt.sessions.steer(first.id, { prompt: "look", requestId: "req_2", attachments: [PNG] });
    h.end(0);
    await first.finished;
    expect(await rt.sessions.attachment(ws.id, threadId, "req_2", 0)).toEqual({ mediaType: "image/png", bytes: PNG.bytes });
    const big = "w".repeat(256 * 1024);
    for (let i = 1; i <= 20; i++) {
      const next = await rt.sessions.start(ws.id, { thread: threadId, prompt: `write ${i}` });
      h.write(i, big);
      h.end(i);
      await next.finished;
    }
    expect((await rt.sessions.history(ws.id)).some(e => e.type === "session.steer")).toBe(false);
    await expect(rt.sessions.attachment(ws.id, threadId, "req_2", 0)).rejects.toMatchObject({ kind: "not-found" });
    expect(await store.getBlob("attachments", `${threadId}.req_2.0`)).toBeUndefined();
    await rt.close();
  });

  it("is refused on a harness whose steer reads no image, naming it, and nothing reaches the turn or the transcript", async () => {
    const { h, rt, first, steers } = await running(false);
    await expect(rt.sessions.steer(first.id, { prompt: "and this?", requestId: "req_2", attachments: [PNG] })).rejects.toThrow("claude takes no image into a running turn");
    await expect(rt.sessions.steer(first.id, { prompt: "and these?", requestId: "req_3", attachments: [NOTES] })).rejects.toThrow("a file that is not an image goes only with a message that starts a turn");
    expect(h.steered).toEqual([]);
    expect(steers()).toEqual([]);
    h.end(0);
    await first.finished;
    await rt.close();
  });
});

describe("a send with files to a thread whose turn is running", () => {
  it("steers its image into the turn where the harness's steer reads one", async () => {
    const { h, rt, ws, first, threadId, steers } = await running(true);
    const joined = await rt.sessions.start(ws.id, { prompt: "and this one", thread: threadId, requestId: "req_2", attachments: [PNG] });
    expect(joined.outcome).toBe("steered");
    expect(h.starts).toHaveLength(1);
    expect(h.steered).toEqual([{ prompt: "and this one", images: [{ mediaType: PNG.mediaType, bytes: PNG.bytes }] }]);
    expect(steers()).toMatchObject([{ requestId: "req_2", attachments: [attachmentRecord(PNG)] }]);
    expect(await rt.sessions.attachment(ws.id, threadId, "req_2", 0)).toEqual({ mediaType: "image/png", bytes: PNG.bytes });
    h.end(0);
    await first.finished;
    await rt.close();
  });

  it("waits for the turn to end and starts the next with its image where the steer reads none, and with a file that is not an image anywhere", async () => {
    for (const [steersImages, file] of [[false, PNG], [true, NOTES]] as const) {
      const { h, rt, ws, first, threadId, steers } = await running(steersImages);
      let outcome: string | undefined;
      const pending = rt.sessions.start(ws.id, { prompt: "with a file", thread: threadId, requestId: "req_2", attachments: [file] }).then(s => (outcome = s.outcome));
      await settle();
      expect(outcome).toBeUndefined();
      expect(h.steered).toEqual([]);
      h.end(0);
      await pending;
      expect(outcome).toBe("queued");
      expect(steers()).toEqual([]);
      expect(h.starts.map(s => s.prompt)).toEqual(["look around", expect.stringContaining("with a file")]);
      if (file === PNG) expect(h.starts[1]!.images).toEqual([{ mediaType: PNG.mediaType, bytes: PNG.bytes }]);
      h.end(1);
      await rt.close();
    }
  });
});
