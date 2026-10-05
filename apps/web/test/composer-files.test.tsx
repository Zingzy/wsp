// SPDX-License-Identifier: AGPL-3.0-only
// A file into the composer by paste, by drop and by the picker: the row above
// the text, a thumbnail per image and a tile per other file, the x on each, a
// long paste landing as a file, the caps in words in the one line the composer
// keeps for a refusal, and the bytes on the send. The same
// fixture shape as chat-composer.test.tsx; no live daemon and no host.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { noImagesLine, sendRefusal, type EventUnion, type KeptAttachment, type SessionEvent, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import { DisconnectedError, RequestError, type Api, type ProtocolEvent, type StartSessionOptions } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerFilesStore } from "../src/components/chat/composerFiles.js";
import { usePromptStashStore } from "../src/components/chat/promptStashStore.js";
import { COMPOSER_WORDS } from "../src/components/chat/composerWords.js";
import { clearNotices, lastNotice } from "./notice-text.js";
import { CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

let restoreLayout: () => void = () => {};
const urls: string[] = [];
const revoked: string[] = [];
beforeAll(() => {
  restoreLayout = installFakeLayout();
  // jsdom has no object URLs; the composer's thumbnails only need one string per image and one revoke per removal.
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:wsp/${urls.length}`;
    urls.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => revoked.push(url));
});
afterAll(() => restoreLayout());
beforeEach(() => {
  urls.length = 0;
  revoked.length = 0;
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  useComposerFilesStore.setState({ pending: {}, refused: {}, queued: {}, sent: {} });
  localStorage.clear();
  usePromptStashStore.getState().reload();
});
afterEach(() => useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, sessions: {}, harnesses: [], harnessesByWorkspace: {} }));

const WS = CHAT_WS;
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file whose first bytes are a real PNG head, since the composer types an image off its bytes and not its name. */
function pngFile(name: string, bytes = 1024, fill = 5): File {
  return new File([new Uint8Array([...PNG_HEAD, ...Array.from({ length: bytes - PNG_HEAD.length }, () => fill)])], name, { type: "image/png" });
}

const base64Of = (bytes: number, fill = 5): string => Buffer.from(new Uint8Array([...PNG_HEAD, ...Array.from({ length: bytes - PNG_HEAD.length }, () => fill)])).toString("base64");

function fixtureApi(history: Record<string, SessionEvent[]> = {}, statuses: WorkspaceStatus[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: StartSessionOptions[] = [];
  /** What the host keeps of a message's images, by workspace, thread, request id and place. */
  const kept = new Map<string, KeptAttachment>();
  const workspaces = [workspace];
  const api: Api = {
    interruptSession: async () => "accepted",
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => (caps()),
    listSessions: async () => [],
    listHarnesses: async () => [TABLE_CATALOG],
    watchStatuses: async () => statuses,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
    sessionAttachment: async (workspaceId, threadId, requestId, index) => {
      const image = kept.get(`${workspaceId}/${threadId}/${requestId}/${index}`);
      if (image === undefined) throw new RequestError(`no image ${index + 1} kept on that message`, "not-found");
      return image;
    },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, emit, kept };
}

async function setup(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, harnesses: [], harnessesByWorkspace: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  await whenAgentsAnswered();
  const view = render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const surface = (): HTMLElement => document.querySelector<HTMLElement>("[data-chat-composer-surface]")!;
const thumbs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-composer-files] [data-chat-image]")];
const tiles = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-composer-files] [data-chat-file]")];
/** A file the composer turned away: its chip, with the sentence why on its hover. */
const refused = (name: string) => document.querySelector<HTMLElement>(`[data-composer-files] [data-composer-refused-file="${CSS.escape(name)}"]`);
const refusedWhy = (name: string): string | null => refused(name)?.getAttribute("title") ?? null;
/** The composer has no line above its box, in any state. */
const noLineAbove = () => {
  expect(document.querySelector("[data-composer-refusal]")).toBeNull();
  expect(document.querySelector("[data-chat-composer] span[role='status']")).toBeNull();
};

const paste = (files: File[]) => fireEvent.paste(surface(), { clipboardData: { files, items: [], getData: () => "" } });
const pasteText = (text: string) => fireEvent.paste(surface(), { clipboardData: { files: [], items: [], getData: (type: string) => (type === "text/plain" ? text : "") } });
const drop = (files: File[]) => fireEvent.drop(surface(), { dataTransfer: { files, items: [], types: ["Files"], getData: () => "" } });

describe("an image into the composer", () => {
  it("a pasted PNG becomes one thumbnail above the text, and the text is untouched", async () => {
    const { api } = fixtureApi();
    await setup(api);
    await typeInto(composerEditor(), "what does this show?");
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("shot.png");
    expect(composerEditor().textContent).toBe("what does this show?");
    noLineAbove();
  });

  it("a dropped image lands the same way, and the drop is taken from the page rather than opening the file", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void drop([pngFile("dropped.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("dropped.png");
  });

  it("the paperclip beside send opens the file input and what it takes lands the same way", async () => {
    const { api } = fixtureApi();
    await setup(api);
    const input = document.querySelector<HTMLInputElement>("[data-composer-file-input]")!;
    const clicked = vi.spyOn(input, "click");
    const attach = screen.getByRole("button", { name: "Attach" });
    expect(attach.closest('[data-chat-composer-actions="right"]')).not.toBeNull();
    expect(attach.querySelector("svg.lucide-paperclip")).not.toBeNull();
    fireEvent.click(attach);
    expect(clicked).toHaveBeenCalledOnce();
    // The picker only opens the input; what the person chose arrives on its change, which is what this drives.
    act(() => void fireEvent.change(input, { target: { files: [pngFile("picked.png")] } }));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("picked.png");
  });

  it("each thumbnail has its own remove, and removing one leaves the rest and lets go of its url", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste([pngFile("one.png"), pngFile("two.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Remove image 1" }));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("two.png");
    expect(revoked).toEqual([urls[0]]);
  });

  it("the thumbnail opens the image at full size", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    const thumbSrc = thumbs()[0]!.querySelector("img")!.getAttribute("src");
    fireEvent.click(screen.getByRole("button", { name: "Open image 1 at full size" }));
    // The same bytes, unscaled, in the dialog over the page: the thumbnail is a way in, not a smaller copy.
    await waitFor(() => expect(document.querySelector("[data-slot=dialog-popup] img")).not.toBeNull());
    const full = document.querySelector<HTMLImageElement>("[data-slot=dialog-popup] img")!;
    expect(full.getAttribute("src")).toBe(thumbSrc);
    expect(full.getAttribute("alt")).toBe("shot.png");
    expect(full.className).toContain("object-contain");
  });
});

describe("a file that is not an image", () => {
  const pdf = () => new File([new TextEncoder().encode("%PDF-1.7 Quarterly report")], "report.pdf", { type: "application/pdf" });

  it("becomes a tile with its name and weight, and rides the send under its own name and type", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    await typeInto(composerEditor(), "what is the first heading?");
    act(() => void paste([pdf()]));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(tiles()[0]!.dataset["chatFile"]).toBe("report.pdf");
    expect(tiles()[0]!.textContent).toBe("report.pdf25 B");
    expect(thumbs()).toHaveLength(0);
    // No object URL: a file that is not an image has nothing to draw.
    expect(urls).toEqual([]);
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.attachments).toEqual([{ mediaType: "application/pdf", bytes: Buffer.from("%PDF-1.7 Quarterly report").toString("base64"), name: "report.pdf" }]);
  });

  it("goes to an agent that reads no image, since it lands in the thread's folder", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() =>
      useStore.setState({
        harnessesByWorkspace: {
          [WS]: [{ harness: "claude", label: "Claude Code", source: "harness", version: "2.1.263", models: [], efforts: [], contextWindows: [], permissionModes: [], steers: true, renames: true, images: false }],
        },
      }),
    );
    act(() => void paste([pdf()]));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    noLineAbove();
  });
});

describe("a file named as an image", () => {
  it("travels as a file when its bytes are not one, so no agent is handed a broken picture", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    act(() => void paste([new File([new TextEncoder().encode("not a png")], "shot.png", { type: "image/png" })]));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(thumbs()).toHaveLength(0);
    await typeInto(composerEditor(), "what is this");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.attachments?.[0]?.mediaType).toBe("application/octet-stream");
  });
});

describe("a long paste", () => {
  const log = (lines: number) => Array.from({ length: lines }, (_, i) => `commit ${i + 1}`).join("\n");

  it("of 200 lines becomes a pasted-text file chip, and the box keeps the words typed", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    await typeInto(composerEditor(), "count the commits");
    act(() => void pasteText(log(200)));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(tiles()[0]!.dataset["chatFile"]).toBe("pasted-text-1.txt");
    expect(composerEditor().textContent).toBe("count the commits");
    act(() => void pasteText(log(300)));
    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(tiles()[1]!.dataset["chatFile"]).toBe("pasted-text-2.txt");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.attachments?.map(a => [a.name, a.mediaType, Buffer.from(a.bytes, "base64").toString().split("\n").length])).toEqual([
      ["pasted-text-1.txt", "text/plain", 200],
      ["pasted-text-2.txt", "text/plain", 300],
    ]);
  });

  it("of one line past 32 KiB becomes a file too, and 199 short lines stay in the box", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void pasteText("x".repeat(32 * 1024)));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    act(() => void pasteText(log(199)));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(tiles()).toHaveLength(1);
  });
});

describe("the prompt stash", () => {
  const stashWord = () => document.querySelector<HTMLElement>("[data-composer-stash-word]");

  it("takes half a prompt and its files off the composer, counts it as a word, and brings both back after another send", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    const editor = composerEditor();
    act(() => useComposerDraftStore.getState().setDraft(WS, { prompt: "compare @src/app.ts with", cursor: 3 }));
    await waitFor(() => expect(editor.querySelector("[data-composer-mention-chip]")).not.toBeNull());
    act(() => void paste([new File([new TextEncoder().encode("%PDF-1.7 spec")], "spec.pdf", { type: "application/pdf" })]));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(stashWord()).toBeNull();
    await press(editor, "s", { ctrlKey: true });
    await waitFor(() => expect(stashWord()?.textContent).toBe("Stashed 1"));
    expect(useComposerDraftStore.getState().drafts[WS]?.prompt ?? "").toBe("");
    expect(tiles()).toHaveLength(0);
    // A stash that survives a reload: the bytes are in local storage.
    expect(localStorage.getItem("wsp:prompt-stash")).toContain(Buffer.from("%PDF-1.7 spec").toString("base64"));
    await typeInto(editor, "something else first");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.attachments).toBeUndefined();
    fireEvent.click(stashWord()!);
    const restore = await screen.findByRole("button", { name: /^Restore stashed prompt: compare @src\/app\.ts with/ });
    fireEvent.click(restore);
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("compare @src/app.ts with"));
    await waitFor(() => expect(editor.querySelector("[data-composer-mention-chip]")?.textContent).toBe("app.ts"));
    expect(tiles().map(t => t.dataset["chatFile"])).toEqual(["spec.pdf"]);
    expect(stashWord()).toBeNull();
  });

  it("brings the one stashed prompt back into an empty box with the same keys, and a restore over a draft stashes that draft first", async () => {
    const { api } = fixtureApi();
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "first draft");
    await press(editor, "s", { metaKey: true });
    await waitFor(() => expect(stashWord()?.textContent).toBe("Stashed 1"));
    await press(editor, "s", { metaKey: true });
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("first draft"));
    expect(stashWord()).toBeNull();
    await press(editor, "s", { metaKey: true });
    await typeInto(editor, "second draft");
    fireEvent.click(stashWord()!);
    fireEvent.click(await screen.findByRole("button", { name: "Restore stashed prompt: first draft" }));
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("first draft"));
    expect(stashWord()?.textContent).toBe("Stashed 1");
    expect(usePromptStashStore.getState().entries.map(e => e.prompt)).toEqual(["second draft"]);
  });
});

describe("a stash this browser cannot write", () => {
  it("leaves the draft and its files where they were and says so in a flyout, not above the box", async () => {
    const { api } = fixtureApi();
    await setup(api);
    const stash = usePromptStashStore.getState().stash;
    usePromptStashStore.setState({ stash: () => false });
    try {
      clearNotices();
      await typeInto(composerEditor(), "keep me");
      act(() => void paste([new File([new TextEncoder().encode("%PDF-1.7 spec")], "spec.pdf", { type: "application/pdf" })]));
      await waitFor(() => expect(tiles()).toHaveLength(1));
      await press(composerEditor(), "s", { ctrlKey: true });
      await waitFor(() => expect(lastNotice()).toBe(COMPOSER_WORDS.stashNotWritten));
      expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("keep me");
      expect(tiles()).toHaveLength(1);
      noLineAbove();
    } finally {
      usePromptStashStore.setState({ stash });
    }
  });
});

describe("a restore over a full stash", () => {
  it("takes the entry before the draft goes onto the stash, so the one restored is never the one dropped", async () => {
    const { api } = fixtureApi();
    await setup(api);
    for (let n = 19; n >= 0; n--) usePromptStashStore.getState().stash({ id: `e${n}`, createdAt: "2026-09-27T10:00:00Z", prompt: `stashed ${n}`, files: [], dropped: [] });
    expect(usePromptStashStore.getState().entries).toHaveLength(20);
    await typeInto(composerEditor(), "the draft in the box");
    fireEvent.click(document.querySelector<HTMLElement>("[data-composer-stash-word]")!);
    fireEvent.click(await screen.findByRole("button", { name: "Restore stashed prompt: stashed 19" }));
    await waitFor(() => expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("stashed 19"));
    expect(usePromptStashStore.getState().entries.map(e => e.prompt).slice(0, 2)).toEqual(["the draft in the box", "stashed 0"]);
    expect(usePromptStashStore.getState().entries).toHaveLength(20);
  });
});

describe("what the composer will not take at all", () => {
  it("paste and drop answer to the same state the picker does: nothing is taken while a send is blocked", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => useStore.getState().setConn("closed"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Attach" }) as HTMLButtonElement).disabled).toBe(true));
    act(() => void paste([pngFile("shot.png")]));
    act(() => void drop([pngFile("dropped.png")]));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(thumbs()).toHaveLength(0);
    // The held send says why; nothing about the image is added anywhere.
    expect(document.querySelector("[data-send-held]")?.getAttribute("data-send-held")).toBe(sendRefusal("closed"));
    expect(document.querySelector("[data-composer-refused-file]")).toBeNull();
  });
});

describe("what the composer refuses, in words, before anything leaves", () => {
  it("a file over its cap is refused in one sentence naming it, and it is never read whole", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste([new File([new Uint8Array(12 * 1024 * 1024)], "manual.pdf", { type: "application/pdf" })]));
    await waitFor(() => expect(refusedWhy("manual.pdf")).toBe("manual.pdf is 12 MB, over the 10 MB a file may be"));
    expect(refused("manual.pdf")!.textContent).toContain(COMPOSER_WORDS.fileRefused);
    expect(tiles()).toHaveLength(0);
    noLineAbove();
  });

  it("a 12 MB image is refused with the cap in the sentence, and it is never read whole to refuse it", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste([pngFile("huge.png", 12 * 1024 * 1024)]));
    await waitFor(() => expect(refusedWhy("huge.png")).toBe("huge.png is 12 MB, over the 10 MB an image may be"));
    expect(thumbs()).toHaveLength(0);
    // The bytes go to an object URL only once the caps have passed, so no url means the file was never read whole.
    expect(urls).toEqual([]);
  });

  it("a sixth image is refused with both counts and the five already there stay", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste(Array.from({ length: 5 }, (_, i) => pngFile(`n${i}.png`))));
    await waitFor(() => expect(thumbs()).toHaveLength(5));
    act(() => void paste([pngFile("sixth.png")]));
    await waitFor(() => expect(refusedWhy("sixth.png")).toBe("only 5 files fit one message; this one carries 6"));
    expect(thumbs()).toHaveLength(5);
  });

  it("a file over its own cap in a batch is refused alone, under its own sentence, and the rest of the batch is taken", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste([new File(["# notes"], "notes.md", { type: "text/markdown" }), new File([new Uint8Array(12 * 1024 * 1024)], "manual.pdf", { type: "application/pdf" })]));
    await waitFor(() => expect(refusedWhy("manual.pdf")).toBe("manual.pdf is 12 MB, over the 10 MB a file may be"));
    await waitFor(() => expect(tiles().map(t => t.dataset["chatFile"])).toEqual(["notes.md"]));
    expect(refused("notes.md")).toBeNull();
  });

  it("the count cap turns the whole batch away, each file under the count's sentence", async () => {
    const { api } = fixtureApi();
    await setup(api);
    act(() => void paste(Array.from({ length: 4 }, (_, i) => pngFile(`n${i}.png`))));
    await waitFor(() => expect(thumbs()).toHaveLength(4));
    act(() => void paste([pngFile("fifth.png"), pngFile("sixth.png")]));
    await waitFor(() => expect(refusedWhy("sixth.png")).toBe("only 5 files fit one message; this one carries 6"));
    expect(refusedWhy("fifth.png")).toBe("only 5 files fit one message; this one carries 6");
    expect(thumbs()).toHaveLength(4);
  });

  it("a refused chip goes on its own remove, and a send carries none of it and clears it", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    act(() => void paste([new File([new Uint8Array(12 * 1024 * 1024)], "manual.pdf", { type: "application/pdf" })]));
    await waitFor(() => expect(refused("manual.pdf")).not.toBeNull());
    fireEvent.click(within(refused("manual.pdf")!).getByRole("button", { name: "Remove manual.pdf" }));
    expect(refused("manual.pdf")).toBeNull();
    act(() => void paste([new File([new Uint8Array(12 * 1024 * 1024)], "big.zip", { type: "application/zip" })]));
    await waitFor(() => expect(refused("big.zip")).not.toBeNull());
    await typeInto(composerEditor(), "go");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.attachments).toBeUndefined();
    expect(refused("big.zip")).toBeNull();
  });
});

describe("an agent that reads no image", () => {
  it("is named on the image's refused chip, and the person's file is never read", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    act(() =>
      useStore.setState({
        harnessesByWorkspace: {
          [WS]: [{ harness: "claude", label: "Claude Code", source: "harness", version: "2.1.263", models: [], efforts: [], contextWindows: [], permissionModes: [], steers: true, renames: true, images: false }],
        },
      }),
    );
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(refusedWhy("shot.png")).toBe(noImagesLine("claude")));
    expect(thumbs()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });
});

describe("what a tab holds of the images it has sent", () => {
  it("the last ten sends and no more: the oldest let go of their bytes rather than growing with the tab", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    for (let nth = 0; nth < 12; nth++) {
      act(() => void paste([pngFile(`n${nth}.png`, 128)]));
      await waitFor(() => expect(thumbs()).toHaveLength(1));
      await typeInto(composerEditor(), `send ${nth}`);
      await press(composerEditor(), "Enter");
      await waitFor(() => expect(started).toHaveLength(nth + 1));
      // Each send is its own turn, so the next one is not queued behind this one.
      emit({ type: "session.start", workspaceId: WS, sessionId: `sess_${nth}`, turnId: `turn_${nth}`, prompt: `send ${nth}` });
      emit({ type: "session.done", workspaceId: WS, sessionId: `sess_${nth}`, turnId: `turn_${nth}`, result: { status: "completed", text: "ok" } });
      emit({ type: "session.end", workspaceId: WS, sessionId: `sess_${nth}`, turnId: `turn_${nth}`, exitCode: 0, sawResult: true });
    }
    const sent = useComposerFilesStore.getState().sent;
    expect(Object.keys(sent)).toHaveLength(10);
    // The two oldest sends let their bytes go; every image still held keeps its url.
    expect(revoked).toHaveLength(2);
    const held = new Set(Object.values(sent).flat().map(i => i.url));
    for (const url of revoked) expect(held.has(url)).toBe(false);
  });
});

/** One finished turn on thread thr_1 whose message carried one PNG of 2048 bytes, as the transcript keeps it. */
function sentTurn(requestId: string, prompt: string): SessionEvent[] {
  const turn = { workspaceId: WS, sessionId: "sess_1", turnId: "turn_1", threadId: "thr_1" };
  return [
    { type: "session.start", ...turn, prompt, requestId, attachments: [{ mediaType: "image/png", bytes: 2048, name: "shot.png" }] },
    { type: "session.done", ...turn, result: { status: "completed", text: "a cat" } },
    { type: "session.end", ...turn, exitCode: 0, sawResult: true },
  ];
}

const imageRow = (): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>("[data-chat-image-row=true] [data-chat-image='shot.png'] img");
    expect(found).not.toBeNull();
    return found!.closest<HTMLElement>("[data-chat-image-row=true]")!;
  });

describe("the images on the send", () => {
  it("ride the start as bytes with their type, and the composer opens empty", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "what does this show?");
    act(() => void paste([pngFile("shot.png", 2048, 3)]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.attachments).toEqual([{ mediaType: "image/png", bytes: base64Of(2048, 3), name: "shot.png" }]);
    expect(started[0]!.prompt).toBe("what does this show?");
    await waitFor(() => expect(thumbs()).toHaveLength(0));
  });

  it("the person's own row carries its thumbnails at the click, not a roundtrip later", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    await typeInto(composerEditor(), "what does this show?");
    act(() => void paste([pngFile("shot.png", 2048, 3)]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    // Nothing came back from the runtime; the row is drawn from the records the send already held.
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-chat-image-row=true]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(row.querySelectorAll("[data-chat-image='shot.png'] img")).toHaveLength(1);
    expect(row.textContent).not.toContain("[image");
  });

  it("the person's row draws its image again after the app restarts, read back from the host", async () => {
    const { api, started, kept } = fixtureApi();
    const first = await setup(api);
    await typeInto(composerEditor(), "what does this show?");
    act(() => void paste([pngFile("shot.png", 2048, 3)]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    const { requestId } = started[0]!;
    first.unmount();
    // A restart: nothing this tab held in memory is left, and the thread comes back from the runtime's transcript.
    useComposerFilesStore.setState({ pending: {}, refused: {}, queued: {}, sent: {} });
    kept.set(`${WS}/thr_1/${requestId}/0`, { mediaType: "image/png", bytes: base64Of(2048, 3) });
    api.sessionHistory = async () => sentTurn(requestId!, "what does this show?");
    render(<WorkspaceThread workspaceId={WS} />);
    const row = await imageRow();
    expect(row.parentElement!.textContent).not.toContain("[image");
  });

  it("a message sent from the command line draws its image from the host, which this tab never held", async () => {
    const { api, kept } = fixtureApi();
    kept.set(`${WS}/thr_1/req_cli/0`, { mediaType: "image/png", bytes: base64Of(512, 9) });
    api.sessionHistory = async () => sentTurn("req_cli", "look at this");
    await setup(api);
    const row = await imageRow();
    expect(row.parentElement!.textContent).not.toContain("[image");
  });

  it("a read the socket dropped is asked again when the row next draws, since the host still has the image", async () => {
    const { api, kept } = fixtureApi();
    kept.set(`${WS}/thr_1/req_drop/0`, { mediaType: "image/png", bytes: base64Of(512, 9) });
    const answer = api.sessionAttachment!;
    let asked = 0;
    api.sessionAttachment = async (...at) => (++asked === 1 ? Promise.reject(new DisconnectedError("closed")) : answer(...at));
    api.sessionHistory = async () => sentTurn("req_drop", "look at this");
    const first = await setup(api);
    await waitFor(() => expect(asked).toBe(1));
    expect(document.querySelector("[data-chat-image] img")).toBeNull();
    first.unmount();
    render(<WorkspaceThread workspaceId={WS} />);
    await imageRow();
    expect(asked).toBe(2);
  });

  it("a message whose image the host no longer keeps draws the record's words", async () => {
    const { api } = fixtureApi();
    api.sessionHistory = async () => sentTurn("req_gone", "look at this");
    await setup(api);
    await waitFor(() => expect(document.body.textContent).toContain("[image 2 KB png]"));
    expect(document.querySelector("[data-chat-image] img")).toBeNull();
  });

  it("a message with no image sends no attachments field at all", async () => {
    const { api, started } = fixtureApi();
    await setup(api);
    await typeInto(composerEditor(), "plain");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.attachments).toBeUndefined();
  });

  it("a message with an image sent during a running turn queues with its image on its card, and the image rides its start", async () => {
    const { api, started, emit } = fixtureApi();
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "first");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    emit({ type: "session.start", workspaceId: WS, sessionId: "sess_0001", turnId: "turn_0001", prompt: "first" });
    emit({ type: "session.delta", workspaceId: WS, sessionId: "sess_0001", turnId: "turn_0001", kind: "text", text: "on it" });
    await typeInto(editor, "and this?");
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await press(editor, "Enter");
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-queued-id]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(card.querySelector('[data-queued-file="shot.png"]')).not.toBeNull();
    expect(thumbs()).toHaveLength(0);
    expect(started).toHaveLength(1);
    noLineAbove();
    emit({ type: "session.done", workspaceId: WS, sessionId: "sess_0001", turnId: "turn_0001", result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    emit({ type: "session.end", workspaceId: WS, sessionId: "sess_0001", turnId: "turn_0001", exitCode: 0, sawResult: true });
    await waitFor(() => expect(started).toHaveLength(2));
    expect(started[1]).toMatchObject({ prompt: "and this?" });
    expect(started[1]!.attachments?.map(a => a.name)).toEqual(["shot.png"]);
  });

  it("a refused send hands the images back rather than losing them", async () => {
    const { api, started } = fixtureApi();
    const refusing: Api = { ...api, startSession: async opts => { started.push(opts); throw new Error("the runtime said no"); } };
    await setup(refusing);
    await typeInto(composerEditor(), "look");
    act(() => void paste([pngFile("shot.png")]));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    expect(thumbs()[0]!.dataset["chatImage"]).toBe("shot.png");
  });
});
