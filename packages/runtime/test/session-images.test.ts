// SPDX-License-Identifier: AGPL-3.0-only
// What a message's images come to on each of the two roads an adapter can
// declare, and what a message with an image to an agent that declares neither
// comes to. Nothing here is a cloud: the backend is the in-process stub, whose
// upload URLs point at a loopback server that records every body, so the file
// road can be read byte for byte.
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { imagePathOn, noImagesLine, type AdapterEvent, type AttachmentRoad, type TurnImage, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** One adapter that records what it was started with, on whichever road the case is about; no road at all when the
 * case is an agent that reads no image. */
function recording(road?: AttachmentRoad): { factory: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    ...(road !== undefined ? { attachments: road } : {}),
    start: (options: HarnessStartOptions) => {
      starts.push(options);
      const result: TurnResult = { status: "completed", text: "done" };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId: SESSION_ID },
          { type: "turn.done", sessionId: SESSION_ID, result },
          { type: "session.end", sessionId: SESSION_ID, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) options.onEvent(e);
        return result;
      })();
      return { localId: SESSION_ID, finished, interrupt: async () => {} };
    },
  });
  return { factory, starts };
}

const bytesOf = (fill: number, size = 64): string => Buffer.alloc(size, fill).toString("base64");
const png = (fill = 1, size = 64) => ({ mediaType: "image/png", bytes: bytesOf(fill, size) });

/** Every file in the tars the machine was sent, by path, so the file road can be read as the guest would read it. */
function landedFiles(puts: StubBackend["puts"]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const put of puts) {
    const tar = gunzipSync(put.body);
    for (let at = 0; at + 512 <= tar.length; ) {
      const name = tar.toString("utf8", at, at + 100).replace(/\0.*$/, "");
      if (name === "") break;
      const size = Number.parseInt(tar.toString("utf8", at + 124, at + 135).replace(/\0.*$/, "").trim() || "0", 8);
      files.set(`/${name}`, tar.subarray(at + 512, at + 512 + size));
      at += 512 + Math.ceil(size / 512) * 512;
    }
  }
  return files;
}

/** A workspace on the stub, with what the machine was already sent and told at create marked off: a create lands the
 * daemon, so what an image costs is only ever what came after. */
async function workspaceOn(adapters: Record<string, HarnessAdapterFactory>, backend = stubBackend()) {
  const rt = createRuntime({ backend, store: memoryStore(), adapters });
  const ws = await rt.workspaces.create({ golden: "snap_g", name: "shots" });
  const mark = { puts: backend.puts.length, execs: backend.machines[0]!.execLog.length };
  const since = () => ({ puts: backend.puts.slice(mark.puts), execs: backend.machines[0]!.execLog.slice(mark.execs) });
  return { rt, ws, backend, since };
}

describe("an image on the inline road", () => {
  it("reaches the adapter as bytes with its type, and nothing lands on the machine", async () => {
    const claude = recording("inline");
    const { rt, ws, since } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "what does this show?", attachments: [png(7)] })).finished;
    expect(claude.starts).toHaveLength(1);
    expect(claude.starts[0]!.images).toEqual([{ mediaType: "image/png", bytes: bytesOf(7) }]);
    // Nothing was written to the guest for it: an inline harness reads no file.
    expect(since().puts).toHaveLength(0);
    expect(since().execs.some(cmd => cmd.includes("/images"))).toBe(false);
  });

  it("carries every image of the message, in the order the person added them", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "these two", attachments: [png(1), { mediaType: "image/webp", bytes: bytesOf(2) }] })).finished;
    expect(claude.starts[0]!.images?.map(i => i.mediaType)).toEqual(["image/png", "image/webp"]);
    expect(claude.starts[0]!.images?.map(i => i.bytes)).toEqual([bytesOf(1), bytesOf(2)]);
  });

  it("a message with no image hands the adapter none, so a turn without one is the turn it always was", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "no image" })).finished;
    expect(claude.starts[0]!.images).toBeUndefined();
  });
});

describe("an image on the file road", () => {
  it("lands on the machine under the thread's own folder and the adapter is handed the path", async () => {
    const codex = recording("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    const handle = await rt.sessions.start(ws.id, { harness: "codex", prompt: "what is this?", attachments: [png(9)] });
    await handle.finished;
    const threadId = handle.view().threadId!;
    const path = imagePathOn(threadId, 0, "image/png");
    expect(path).toBe(`/root/.wsp/threads/${threadId}/images/1.png`);
    // The adapter reads a path, and the path it reads holds the bytes the person sent.
    expect(codex.starts[0]!.images?.map((i: TurnImage) => i.path)).toEqual([path]);
    expect(landedFiles(since().puts).get(path)).toEqual(Buffer.alloc(64, 9));
  });

  it("names each image by its place in the message and its own type", async () => {
    const codex = recording("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    const handle = await rt.sessions.start(ws.id, {
      harness: "codex",
      prompt: "these three",
      attachments: [png(1), { mediaType: "image/jpeg", bytes: bytesOf(2) }, { mediaType: "image/webp", bytes: bytesOf(3) }],
    });
    await handle.finished;
    const threadId = handle.view().threadId!;
    expect(codex.starts[0]!.images?.map((i: TurnImage) => i.path)).toEqual([
      `/root/.wsp/threads/${threadId}/images/1.png`,
      `/root/.wsp/threads/${threadId}/images/2.jpg`,
      `/root/.wsp/threads/${threadId}/images/3.webp`,
    ]);
    expect([...landedFiles(since().puts).keys()].filter(p => p.includes("/images/"))).toHaveLength(3);
  });

  it("empties the thread's folder first, so a thread holds the turn it is running and not every turn before it", async () => {
    const codex = recording("file");
    const { rt, ws, backend } = await workspaceOn({ codex: codex.factory });
    const handle = await rt.sessions.start(ws.id, { harness: "codex", prompt: "first", attachments: [png(1)] });
    await handle.finished;
    const threadId = handle.view().threadId!;
    await (await rt.sessions.start(ws.id, { harness: "codex", thread: threadId, prompt: "second", attachments: [png(2)] })).finished;
    const removals = backend.machines[0]!.execLog.filter(cmd => cmd.startsWith(`rm -rf '/root/.wsp/threads/${threadId}/images'`));
    expect(removals).toHaveLength(2);
  });

  it("a message with no image asks the machine for nothing", async () => {
    const codex = recording("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    await (await rt.sessions.start(ws.id, { harness: "codex", prompt: "no image" })).finished;
    expect(since().puts).toHaveLength(0);
    expect(codex.starts[0]!.images).toBeUndefined();
  });
});

describe("two sends with images on one thread", () => {
  /** An adapter whose turns end only when the case says so, so a second send is really waiting behind the first. */
  function heldAdapter(road: AttachmentRoad): { factory: HarnessAdapterFactory; starts: HarnessStartOptions[]; end: (nth: number) => void } {
    const starts: HarnessStartOptions[] = [];
    const ends: ((result: TurnResult) => void)[] = [];
    const factory: HarnessAdapterFactory = () => ({
      steers: false,
      attachments: road,
      start: (options: HarnessStartOptions) => {
        starts.push(options);
        options.onEvent({ type: "session.start", sessionId: SESSION_ID });
        const finished = new Promise<TurnResult>(resolve => {
          ends.push(result => {
            options.onEvent({ type: "turn.done", sessionId: SESSION_ID, result });
            options.onEvent({ type: "session.end", sessionId: SESSION_ID, exitCode: 0, sawResult: true });
            resolve(result);
          });
        });
        return { localId: SESSION_ID, finished, interrupt: async () => {} };
      },
    });
    return { factory, starts, end: nth => ends[nth]!({ status: "completed", text: "done" }) };
  }

  it("the second lands its images only once the first turn ended, so one thread's folder never holds two turns at once", async () => {
    const codex = heldAdapter("file");
    const { rt, ws, since } = await workspaceOn({ codex: codex.factory });
    const first = await rt.sessions.start(ws.id, { harness: "codex", prompt: "first", attachments: [png(1)] });
    const threadId = first.view().threadId!;
    const second = rt.sessions.start(ws.id, { harness: "codex", thread: threadId, prompt: "second", attachments: [png(2)] });
    await new Promise(resolve => setTimeout(resolve, 20));
    // The second is waiting: its images are not on the machine yet, and the first turn's are the ones there.
    expect(codex.starts).toHaveLength(1);
    expect(landedFiles(since().puts).get(imagePathOn(threadId, 0, "image/png"))).toEqual(Buffer.alloc(64, 1));
    codex.end(0);
    await second;
    expect(codex.starts).toHaveLength(2);
    expect(landedFiles(since().puts).get(imagePathOn(threadId, 0, "image/png"))).toEqual(Buffer.alloc(64, 2));
    codex.end(1);
  });
});

describe("an agent that reads no image", () => {
  it("refuses in that agent's name, before the machine is asked for anything", async () => {
    const gemini = recording();
    const { rt, ws, since } = await workspaceOn({ gemini: gemini.factory });
    await expect(rt.sessions.start(ws.id, { harness: "gemini", prompt: "look", attachments: [png()] })).rejects.toThrow(noImagesLine("gemini"));
    expect(gemini.starts).toHaveLength(0);
    expect(since().puts).toHaveLength(0);
    expect(since().execs).toEqual([]);
  });

  it("takes the same message without an image, since only the image was the trouble", async () => {
    const gemini = recording();
    const { rt, ws } = await workspaceOn({ gemini: gemini.factory });
    await (await rt.sessions.start(ws.id, { harness: "gemini", prompt: "look" })).finished;
    expect(gemini.starts).toHaveLength(1);
  });
});

describe("the caps, checked again before the machine is asked", () => {
  it("a 12 MB image is refused with the cap in the sentence and nothing is started", async () => {
    const claude = recording("inline");
    const { rt, ws, since } = await workspaceOn({ claude: claude.factory });
    await expect(
      rt.sessions.start(ws.id, { prompt: "big one", attachments: [{ mediaType: "image/png", bytes: bytesOf(1, 12 * 1024 * 1024) }] }),
    ).rejects.toThrow("over the 10.0 MB an image may be");
    expect(claude.starts).toHaveLength(0);
    expect(since().puts).toHaveLength(0);
  });

  it("six images are refused with both counts", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await expect(rt.sessions.start(ws.id, { prompt: "six", attachments: Array.from({ length: 6 }, (_, i) => png(i)) })).rejects.toThrow(
      "only 5 images fit one message; this one carries 6",
    );
    expect(claude.starts).toHaveLength(0);
  });
});

describe("what the transcript keeps of a message's images", () => {
  it("the records, never the pixels, so a transcript costs the same however large the image was", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "what is this?", attachments: [{ ...png(4, 1_258_291), name: "shot.png" }] })).finished;
    const events = await rt.sessions.history(ws.id);
    const start = events.find(e => e.type === "session.start")!;
    expect(start.attachments).toEqual([{ mediaType: "image/png", bytes: 1_258_291, name: "shot.png" }]);
    expect(JSON.stringify(events)).not.toContain(bytesOf(4, 1_258_291));
  });

  it("a turn without an image carries no records at all", async () => {
    const claude = recording("inline");
    const { rt, ws } = await workspaceOn({ claude: claude.factory });
    await (await rt.sessions.start(ws.id, { prompt: "plain" })).finished;
    expect((await rt.sessions.history(ws.id)).find(e => e.type === "session.start")!.attachments).toBeUndefined();
  });
});

describe("what the catalog says about an agent's images", () => {
  it("is the adapter's answer on the machine, one row per agent", async () => {
    const { rt, ws } = await workspaceOn({ claude: recording("inline").factory, codex: recording("file").factory, gemini: recording().factory });
    const rows = await rt.harnesses.list(ws.id);
    expect(Object.fromEntries(rows.filter(r => ["claude", "codex", "gemini"].includes(r.harness)).map(r => [r.harness, r.images]))).toEqual({
      claude: true,
      codex: true,
      gemini: false,
    });
  });
});
