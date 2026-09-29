// SPDX-License-Identifier: AGPL-3.0-only
// The Browser pane's list of recent addresses and local servers: no helper sentence under it, sentence case
// headings, and one filter field at its top once it holds more than a handful of rows, matching port, address,
// process and page title, with a quiet line when nothing matches.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewableServer } from "../src/adapt/view-model.js";
import type { BrowserHistoryEntry } from "../src/browser/recents.js";
import { PREVIEW_FILTER, PREVIEW_NO_MATCH, PreviewEmptyState } from "../src/components/preview/PreviewEmptyState.js";

afterEach(cleanup);

const server = (port: number, processName: string): PreviewableServer => ({
  host: "localhost",
  port,
  url: `http://localhost:${port}/`,
  processName,
  pid: port,
  terminal: null,
  source: "scanner",
  requestedUrl: `http://localhost:${port}/`,
});

const recent = (url: string, title?: string): BrowserHistoryEntry => ({ url, lastVisitedAt: Date.now() - 60_000, ...(title === undefined ? {} : { title }) });

const draw = (servers: PreviewableServer[], recents: BrowserHistoryEntry[] = []) =>
  render(<PreviewEmptyState servers={servers} recentEntries={recents} onRemoveRecent={() => {}} onOpenUrl={() => {}} />);

const ports = (): string[] => [...document.querySelectorAll("[data-server-port], [data-recent-url]")].map(el => el.getAttribute("data-server-port") ?? el.getAttribute("data-recent-url") ?? "");
const filter = (): HTMLInputElement | null => screen.queryByRole("textbox", { name: PREVIEW_FILTER }) as HTMLInputElement | null;

describe("the Browser pane's list", () => {
  it("says nothing under the servers: the heading and the rows are enough", () => {
    draw([server(3000, "node"), server(8001, "python3")]);
    expect(document.body.textContent).not.toMatch(/Select a live local server/);
    const headings = [...document.querySelectorAll("h2")];
    expect(headings.map(h => h.textContent)).toEqual(["Local servers"]);
    for (const h of headings) expect(h.className).not.toMatch(/uppercase|font-mono|tracking/);
  });

  it("draws no filter over a handful of rows", () => {
    draw([server(3000, "node"), server(8001, "python3")], [recent("http://localhost:5173/")]);
    expect(filter()).toBeNull();
  });

  it("puts one filter at the list's top past a handful of rows, matching port, address, process and page title", () => {
    draw(
      [server(3000, "node"), server(8001, "python3"), server(5173, "vite"), server(4000, "ruby"), server(9229, "deno")],
      [recent("http://localhost:6006/?path=/story", "Storybook"), recent("http://localhost:8787/")],
    );
    const field = filter()!;
    expect(field).not.toBeNull();
    expect(field.compareDocumentPosition(document.querySelector("h2")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(field, { target: { value: "8001" } });
    expect(ports()).toEqual(["8001"]);
    fireEvent.change(field, { target: { value: "VITE" } });
    expect(ports()).toEqual(["5173"]);
    fireEvent.change(field, { target: { value: "storybook" } });
    expect(ports()).toEqual(["http://localhost:6006/?path=/story"]);
    fireEvent.change(field, { target: { value: "localhost:8787" } });
    expect(ports()).toEqual(["http://localhost:8787/"]);
    fireEvent.change(field, { target: { value: "nothing listens here" } });
    expect(ports()).toEqual([]);
    expect(screen.getByText(PREVIEW_NO_MATCH)).toBeDefined();
    expect(filter()).not.toBeNull();
    fireEvent.change(field, { target: { value: "" } });
    expect(ports()).toHaveLength(7);
  });
});
