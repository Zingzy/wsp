// SPDX-License-Identifier: AGPL-3.0-only
// Every call the app makes outside the store whose failure used to go only to
// the console or nowhere: each now draws its own slot or says an error notice,
// and a page served on a ticket socket, which may not see a read, says nothing.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/markdownMath", () => {
  throw new Error("chunk markdownMath failed to load");
});
vi.mock("../src/lib/syntaxHighlighting", async importOriginal => {
  const real = await importOriginal<typeof import("../src/lib/syntaxHighlighting")>();
  // A grammar that will not load for anything but plain text, so a code block falls back to it.
  const highlighter = Promise.resolve({
    codeToHtml: (code: string, o: { lang: string }) => {
      if (o.lang !== "text") throw new Error(`no grammar for ${o.lang}`);
      return `<pre>${code}</pre>`;
    },
  });
  return { ...real, getSyntaxHighlighterPromise: () => highlighter };
});
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: class {} }));
vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: ({ children }: { children?: unknown }) => children,
  useWorkerPool: () => ({
    getDiffRenderOptions: () => ({ theme: "pierre-light" }),
    setRenderOptions: async () => Promise.reject(new Error("the diff worker stopped")),
  }),
}));

import { DEFAULT_PREFERENCES, type WorkspaceView } from "@wsp/protocol";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useNotices } from "../src/notices/store.js";
import { useSettingsReads } from "../src/settings/settingsReads.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { CopyRow } from "../src/settings/sheetParts.js";
import { useAccessPick } from "../src/components/chat/ComposerOptionPickers.js";
import { COMPOSER_WORDS } from "../src/components/chat/composerWords.js";
import { wireHostLive } from "../src/machine/hostLive.js";
import { resetLive, watchLive } from "../src/machine/live.js";
import { useCopyToClipboard } from "../src/hooks/useCopyToClipboard.js";
import { readTerminalFile } from "../src/components/ThreadTerminalDrawer.js";
import ChatMarkdown from "../src/components/ChatMarkdown.js";
import { DiffWorkerPoolProvider } from "../src/components/DiffWorkerPoolProvider.js";
import { BrowserSurface } from "../src/components/preview/BrowserSurface.js";
import { useBrowserTabs } from "../src/browser/tabs.js";
import { MessageCopyButton } from "../src/components/chat/MessageCopyButton.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { forgetHeld } from "../src/protocol/held.js";
import { noticeTexts } from "./notice-text.js";
import { settle } from "./settings-harness.js";

const refusal = (said: string): RequestError => new RequestError(said);
const ticket = (said: string): RequestError => new RequestError(said, "ticket");

const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function refuseClipboard(): void {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("Document is not focused.")) } });
}

beforeEach(() => {
  forgetHeld();
  resetLive();
  act(() => useNotices.getState().clear());
  useStore.setState({ api: null, conn: "live", workspaces: [], preferences: DEFAULT_PREFERENCES, settingsOpen: false });
  useSettingsStore.setState({ devicesAsked: 0 });
});

afterEach(() => {
  cleanup();
  if (realClipboard === undefined) Reflect.deleteProperty(navigator, "clipboard");
  else Object.defineProperty(navigator, "clipboard", realClipboard);
});

function Reads() {
  useSettingsReads();
  return null;
}

const folder = (id: string, name: string): WorkspaceView => ({ id, name, kind: "local", machineId: `m_${id}`, project: { id: "pr_1", name: "p", path: "/root", computer: "here" }, phase: "running", golden: "", createdAt: "2026-09-01T00:00:00Z" });

describe("the settings reads", () => {
  const reads = (answer: (what: string) => Promise<never>): Partial<Api> => ({
    subscribe: () => () => {},
    initGet: () => answer("setup"),
    hostTerminalConfig: () => answer("terminal"),
    editorList: () => answer("editors"),
    sshInclude: () => answer("ssh"),
    account: () => answer("account"),
    devicesList: () => answer("devices"),
    image: () => answer("image"),
    releaseCheck: () => answer("release"),
  });

  it("say each refused read as an error notice in its own words, the host's reason kept", async () => {
    useStore.setState({ api: reads(what => Promise.reject(refusal(`${what} is broken on the host`))) as Api });
    useSettingsStore.getState().go({ kind: "group", group: "general" });
    window.wsp = { loginStart: async () => Promise.reject(new Error("launchctl is not answering")) } as typeof window.wsp;
    render(<Reads />);
    await settle();
    delete window.wsp;
    expect(noticeTexts().sort()).toEqual(
      [
        "Account not read: account is broken on the host",
        "Devices not read: devices is broken on the host",
        "Editors not read: editors is broken on the host",
        "Image not read: image is broken on the host",
        "Newest release not read: release is broken on the host",
        "Start at login not read: launchctl is not answering",
        "Setup not read: setup is broken on the host",
        "Terminal config not read: terminal is broken on the host",
        "ssh config not read: ssh is broken on the host",
      ].sort(),
    );
    expect(useNotices.getState().notices.every(n => n.kind === "error")).toBe(true);
    expect(useSettingsStore.getState().reads.devicesRefused).toBe(false);
  });

  it("say nothing for a page served on a ticket socket, whose devices read says so in its own place", async () => {
    useStore.setState({ api: reads(what => Promise.reject(ticket(`${what} is not for this page`))) as Api });
    render(<Reads />);
    await settle();
    expect(noticeTexts()).toEqual([]);
    expect(useSettingsStore.getState().reads.devicesRefused).toBe(true);
  });
});

describe("a copy the clipboard refuses", () => {
  it("on a copy row says so as a notice and keeps the copy glyph", async () => {
    refuseClipboard();
    render(<CopyRow k="token" value="wsp_join_x" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(noticeTexts()).toEqual(["Not copied: Document is not focused."]));
  });

  it("through the clipboard hook is said for a caller that says nothing itself, and left to one that does", async () => {
    refuseClipboard();
    const onError = vi.fn();
    function Copy({ own }: { own: boolean }) {
      const { copyToClipboard } = useCopyToClipboard<null>(own ? { onError } : {});
      return <button type="button" data-own={own} onClick={() => copyToClipboard("text", null)} />;
    }
    render(
      <>
        <Copy own={false} />
        <Copy own />
      </>,
    );
    fireEvent.click(document.querySelector("[data-own=false]")!);
    await waitFor(() => expect(noticeTexts()).toHaveLength(1));
    expect(noticeTexts()[0]).toMatch(/^Not copied: /);
    fireEvent.click(document.querySelector("[data-own=true]")!);
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(noticeTexts()).toHaveLength(1);
  });

  it("in the browser pane's address bar says so as a notice", async () => {
    useStore.setState({ workspaces: [folder("ws_b", "the-project")] });
    useBrowserTabs.setState({ byWorkspaceId: {} });
    const tabId = useBrowserTabs.getState().createTab("ws_b", null);
    render(<BrowserSurface workspaceId="ws_b" surface={{ id: `browser:${tabId}`, kind: "preview", resourceId: tabId }} />);
    const bar = document.querySelector<HTMLInputElement>("[data-preview-url-input]")!;
    fireEvent.change(bar, { target: { value: "http://localhost:3000/" } });
    fireEvent.keyDown(bar, { key: "Enter" });
    const copy = await screen.findByRole("button", { name: "Copy URL" });
    refuseClipboard();
    fireEvent.click(copy);
    await waitFor(() => expect(noticeTexts()).toEqual(["Not copied: Document is not focused."]));
  });

  it("from the browser pane's more menu says so as a notice", async () => {
    useStore.setState({ workspaces: [folder("ws_m", "the-project")] });
    useBrowserTabs.setState({ byWorkspaceId: {} });
    const tabId = useBrowserTabs.getState().createTab("ws_m", null);
    render(<BrowserSurface workspaceId="ws_m" surface={{ id: `browser:${tabId}`, kind: "preview", resourceId: tabId }} />);
    const bar = document.querySelector<HTMLInputElement>("[data-preview-url-input]")!;
    fireEvent.change(bar, { target: { value: "http://localhost:3000/" } });
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByRole("button", { name: "Copy URL" });
    fireEvent.click(screen.getByRole("button", { name: "Preview menu" }));
    const item = await screen.findByRole("menuitem", { name: "Copy URL" });
    refuseClipboard();
    fireEvent.click(item);
    await waitFor(() => expect(noticeTexts()).toEqual(["Not copied: Document is not focused."]));
  });

  it("from a code block in a reply says so as a notice", async () => {
    render(<ChatMarkdown text={"```sh\necho hi\n```"} cwd={undefined} resolvedTheme="dark" />);
    const copy = await screen.findByRole("button", { name: "Copy code" });
    refuseClipboard();
    fireEvent.click(copy);
    await waitFor(() => expect(noticeTexts().filter(t => t.startsWith("Not copied"))).toEqual(["Not copied: Document is not focused."]));
  });

  it("from a message's copy button is said once, in the one copy sentence", async () => {
    refuseClipboard();
    render(
      <TooltipProvider>
        <MessageCopyButton text="the reply" />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(noticeTexts()).toHaveLength(1));
    expect(noticeTexts()[0]).toMatch(/^Not copied: /);
  });
});

describe("a code block whose language will not highlight", () => {
  it("draws as plain text and says so once, however often it draws", async () => {
    const view = render(<ChatMarkdown text={"```rust\nfn main() {}\n```"} cwd={undefined} resolvedTheme="dark" isStreaming />);
    await waitFor(() => expect(noticeTexts()).toEqual(["Code shown as plain text, rust not highlighted: no grammar for rust"]));
    expect(document.body.textContent).toContain("fn main() {}");
    view.rerender(<ChatMarkdown text={"```rust\nfn main() { loop {} }\n```"} cwd={undefined} resolvedTheme="dark" isStreaming />);
    await settle();
    expect(noticeTexts()).toHaveLength(1);
  });
});

describe("a read stamp the host refuses", () => {
  it("is said as a notice", async () => {
    useStore.setState({ api: { subscribe: () => () => {}, readThread: async () => Promise.reject(refusal("no thread th_9")) } as unknown as Api });
    await act(() => useStore.getState().readThread("th_9"));
    expect(noticeTexts()).toEqual(["Thread not marked read: no thread th_9"]);
  });
});

describe("an access pick the host will not take", () => {
  it("stands on the picker in the host's words for the turn it was picked on", async () => {
    const api = { subscribe: () => () => {}, setSessionAccess: async () => Promise.reject(refusal("that thread is gone")) } as unknown as Api;
    useStore.setState({ api, setPreferences: async () => DEFAULT_PREFERENCES } as never);
    const lines: (string | null)[] = [];
    function Access() {
      const access = useAccessPick("ws_a", { sessionId: "s1", turnId: "turn_1" }, "t1", true);
      lines.push(access.line);
      return <button type="button" onClick={() => access.pick("plan")} />;
    }
    render(<Access />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(lines.at(-1)).toBe(COMPOSER_WORDS.accessNotChanged("that thread is gone")));
    expect(noticeTexts()).toEqual([]);
  });
});

describe("the host's live readings", () => {

  it("say a refused watch once per workspace on the socket that refused it", async () => {
    const api = { subscribe: () => () => {}, watchSys: async () => Promise.reject(refusal("the sampler is not running")), unwatchSys: async () => {}, onSysSample: () => () => {} } as unknown as Api;
    useStore.setState({ api, workspaces: [folder("ws_h", "spoo")] });
    const unwire = wireHostLive(useStore);
    const release = watchLive("ws_h");
    await settle();
    expect(noticeTexts()).toEqual(["Live readings for spoo are not coming from the host: the sampler is not running"]);
    // A pane drawn again asks again, and the same refusal is not said twice.
    release();
    const again = watchLive("ws_h");
    await settle();
    expect(noticeTexts()).toHaveLength(1);
    again();
    unwire();
  });
});

describe("the reads a pane makes once", () => {
  it("a refused terminal config is said once, and the pane keeps its defaults", async () => {
    const read = async () => Promise.reject(refusal("the config file is not readable"));
    expect(await readTerminalFile(read, "dark")).toBeNull();
    expect(await readTerminalFile(read, "dark")).toBeNull();
    expect(noticeTexts()).toEqual(["Terminal config not read from the host: the config file is not readable. The pane keeps its defaults."]);
  });

  it("math whose renderer did not load is said, and the message still reads", async () => {
    render(<ChatMarkdown text={"The area is $$\\pi r^2$$ here."} cwd={undefined} resolvedTheme="dark" />);
    await waitFor(() => expect(noticeTexts()).toHaveLength(1));
    expect(noticeTexts()[0]).toMatch(/^Math not drawn: /);
    expect(document.body.textContent).toContain("The area is");
  });

  it("a diff worker that will not take the theme is said once", async () => {
    render(
      <DiffWorkerPoolProvider theme="dark">
        <span>diffs</span>
      </DiffWorkerPoolProvider>,
    );
    await waitFor(() => expect(noticeTexts()).toEqual(["Diffs are not highlighted: the diff worker stopped"]));
  });
});
